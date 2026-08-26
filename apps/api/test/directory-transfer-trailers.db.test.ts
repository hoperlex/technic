import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DIRECTORY_DATA_SHEET,
  DIRECTORY_ID_COLUMN,
  vehicleStatusLabels,
  type DirectoryImportReportDto,
  type DirectoryKey,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type { importDirectory } from '../src/services/directory-transfer/engine';
import type { directoryFor } from '../src/services/directory-transfer/registry';
import type { writeWorkbook } from '../src/lib/xlsx';

/**
 * ПЯТАЯ ДВЕРЬ К ПРИВЯЗКАМ ПРИЦЕПОВ: обмен справочниками файлом
 * (план `docs/vehicle-trailers-plan.md`, §4.2.3).
 *
 * §4.2.3 перечисляет четыре двери, и все четыре заперты в ручках. Пятой в плане нет: справочник
 * техники правится ещё и **файлом** (ADR 0073), и описания обмена пишут те же поля — `status` и
 * `vehicle_type_id` у машины, `waybill_form_code` у типа — мимо маршрутов, своей транзакцией.
 * Дверь хуже разобранных по объёму: файл правит справочник пачкой, и одна строка «Форма № 3» у
 * типа осиротит привязки у всего его парка разом.
 *
 * ЗАЧЕМ БАЗА. Проверяемое здесь — свойство пары «запись + транзакция», и в чистых функциях
 * описания его не видно вовсе: `directory-transfer-vehicles.test.ts` собирает окружение руками и
 * до `update()` не доходит никогда. Снятие живёт именно в `update()`, считает привязки запросом и
 * берёт строки под блокировку — на подменённой базе от этой проверки осталась бы её тень.
 *
 * ЧТО ПРОВЕРЯЕТСЯ: три события таблицы §4.2.3, доступные файлу (перевод типа на «форму № 3»,
 * списание машины, смена типа машины на тип «формы № 3»), обратный случай — загрузка, которая ни
 * одного из них не делает, — и предпросмотр, который не пишет ничего. Плюс замечание строки:
 * человеку о снятии говорится **до** записи, и это единственное место отчёта, где обещание §7
 * «портал говорит, сколько сняло» у этой двери выполнимо (форма отчёта объявлена в контрактах).
 *
 * ЧЕГО ФАЙЛ НЕ ПРОВЕРЯЕТ: порядка захвата строк — он не свойство описания, а свойство
 * `services/vehicle-trailer-hitch.ts`, и проверяется там, где живёт (`vehicle-trailers.db.test.ts`).
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_xfer_probe \
 *     npx vitest run --maxWorkers=1 test/directory-transfer-trailers.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Метка прогона. Префикс латинский и начинается на `ZZ` не для красоты: госномера портала пишут
 * кириллицей, и буквы `Z` в разрешённом наборе нет вовсе, — значит `LIKE 'ZZXFR%'` не заденет ни
 * одной настоящей записи. Соседний файл прицепов метит своё как `ZZTRL`, и пересечься нам негде.
 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const MARK = 'ZZXFR';
/** Метка техники этого файла: по ней уборка находит свои машины. */
const VEHICLE_MARK = `${MARK}-TEST`;

/**
 * Кто грузит файл. Описания техники `actorUserId` не читают вовсе (авторство пишут справочники
 * людей и организаций), поэтому заводить учётку ради загрузки незачем — движку нужен сам аргумент.
 */
const ACTOR = randomUUID();

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  importDirectory: typeof importDirectory;
  directoryFor: typeof directoryFor;
  writeWorkbook: typeof writeWorkbook;
  /** Вид ТС, к которому цепляются заведённые здесь типы: свой заводить незачем. */
  kindId: string;
}

let ctx: Ctx;

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
function prepareEnv(databaseUrl: string): void {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PUBLIC_KEY_PEM ??= '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----';
  // S3 в этом сценарии не участвует, но конфиг обязателен — заглушки заведомо нерабочие.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

/** Счётчик реквизитов: каждый тип, машина и прицеп получают свой номер в пределах прогона. */
let serial = 0;
function nextTag(): string {
  serial += 1;
  return `${MARK}${RUN}${serial.toString().padStart(2, '0')}`;
}

/**
 * Свой тип техники на каждый случай, а не общий из миграций: проверки ниже **переводят тип на
 * форму № 3**, и сделать это с `tractor_trailers` значило бы оставить всей базе — и соседним
 * db-тестам — легковой бланк у тягачей, если прогон упадёт на середине.
 */
async function makeType(form: '4p' | 'leg3'): Promise<{ id: string; code: string }> {
  const code = nextTag().toLowerCase();
  const rows = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicle_types (kind_id, code, name, waybill_form_code)
    VALUES (${ctx.kindId}, ${code}, ${`Тип обмена ${code}`}, ${form})
    RETURNING id`);
  return { id: rows.rows[0]!.id, code };
}

/**
 * Машина строкой, а не маршрутом: файл проверяет обмен, и полный путь заведения техники со всеми
 * ветками принадлежности здесь ничего не добавил бы.
 */
async function makeVehicle(typeId: string): Promise<string> {
  const rows = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicles (ownership, vehicle_type_id, registration_number, status, source_name)
    VALUES ('own', ${typeId}, ${nextTag()}, 'active', ${VEHICLE_MARK})
    RETURNING id`);
  return rows.rows[0]!.id;
}

/**
 * Прицеп сразу закреплённым — строкой, а не командой привязки: команду проверяет свой файл
 * (`vehicle-trailers.db.test.ts`), а здесь она лишь готовит обстановку.
 */
async function makeHitchedTrailer(vehicleId: string, position: 1 | 2): Promise<string> {
  const rows = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicle_trailers
      (kind, model, registration_number, hitched_vehicle_id, hitch_position)
    VALUES ('semi_trailer', 'ШМИТЦ SPR-24', ${nextTag()}, ${vehicleId}, ${position})
    RETURNING id`);
  return rows.rows[0]!.id;
}

/** Где стоит прицеп — прямо из базы: показ и его соединения здесь ни при чём. */
async function hitchOf(
  trailerId: string,
): Promise<{ vehicleId: string | null; position: number | null }> {
  const rows = await ctx.db.execute<{ v: string | null; p: number | null }>(sql`
    SELECT hitched_vehicle_id AS v, hitch_position AS p
      FROM vehicle_trailers WHERE id = ${trailerId}`);
  const row = rows.rows[0]!;
  return { vehicleId: row.v, position: row.p };
}

/**
 * Книга из одного листа «Данные» — ровно та, какую портал принимает от человека. Колонок в ней
 * столько, сколько правит проверка: движок читает известные колонки и не требует остальных
 * («человек вправе удалить то, чего не правит», `engine.ts`), а строка ищется по служебному
 * идентификатору — тому же, что стоит первым в выгрузке.
 */
async function importFile(
  key: DirectoryKey,
  columns: readonly string[],
  rows: readonly (readonly string[])[],
  opts: { dryRun?: boolean } = {},
): Promise<DirectoryImportReportDto> {
  const def = ctx.directoryFor(key);
  if (!def) throw new Error(`описание справочника «${key}» не заведено`);
  const bytes = ctx.writeWorkbook([
    {
      name: DIRECTORY_DATA_SHEET,
      rows: [[DIRECTORY_ID_COLUMN, ...columns], ...rows.map((r) => [...r])],
    },
  ]);
  return ctx.importDirectory(def, bytes, {
    dryRun: opts.dryRun ?? false,
    actorUserId: ACTOR,
  });
}

/** Замечания отчёта одной строкой: движок приписывает к каждому номер строки листа. */
const warningsText = (report: DirectoryImportReportDto): string => report.warnings.join('\n');

describe.skipIf(!DB_URL)('обмен справочниками снимает привязки прицепов (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { importDirectory } = await import('../src/services/directory-transfer/engine');
    const { directoryFor } = await import('../src/services/directory-transfer/registry');
    const { writeWorkbook } = await import('../src/lib/xlsx');

    const kind = await db.execute<{ id: string }>(
      sql`SELECT id FROM vehicle_kinds WHERE is_active ORDER BY id LIMIT 1`,
    );
    if (!kind.rows[0]) throw new Error('В базе нет видов ТС: справочники миграций не наполнены');

    ctx = {
      db,
      closeDb,
      importDirectory,
      directoryFor,
      writeWorkbook,
      kindId: kind.rows[0].id,
    };
  }, 180_000);

  afterAll(async () => {
    if (ctx?.db) {
      /*
       * Файл убирает за собой полностью: база у db-тестов общая и живёт между прогонами, а
       * прицепы с техникой видны всем соседям — оставленная привязка увела бы чужую проверку
       * «за машиной ничего не закреплено» в ложное падение.
       *
       * Порядок обратен ссылкам: прицеп держит машину (`ON DELETE RESTRICT`), поэтому реестр
       * сносится первым, техника — второй, а типы — последними, и только те, за которыми не
       * осталось ни одной машины.
       */
      await ctx.db.execute(
        sql`DELETE FROM vehicle_trailers WHERE registration_number LIKE 'ZZXFR%'`,
      );
      await ctx.db.execute(sql`
        DELETE FROM vehicles
         WHERE source_name = ${VEHICLE_MARK}
           AND id NOT IN (SELECT vehicle_id FROM waybills)
           AND id NOT IN (SELECT vehicle_id FROM vehicle_routes)
           AND id NOT IN (SELECT vehicle_id FROM vehicle_request_assignments)
           AND id NOT IN (SELECT hitched_vehicle_id FROM vehicle_trailers
                           WHERE hitched_vehicle_id IS NOT NULL)`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_types
         WHERE code LIKE 'zzxfr%'
           AND id NOT IN (SELECT vehicle_type_id FROM vehicles)`);
    }
    await ctx?.closeDb();
  });

  // ── Тип: одна ячейка файла снимает привязки у всего парка ──

  it('перевод типа на «форму № 3» файлом снимает привязки у машин типа', async () => {
    const type = await makeType('4p');
    const first = await makeVehicle(type.id);
    const second = await makeVehicle(type.id);
    // Три привязки у двух машин: у одной заняты оба слота бланка — иначе «привязок N у M машин»
    // проверялось бы на числах, которые совпадают между собой.
    const hitched = [
      { id: await makeHitchedTrailer(first, 1), vehicleId: first, position: 1 },
      { id: await makeHitchedTrailer(first, 2), vehicleId: first, position: 2 },
      { id: await makeHitchedTrailer(second, 1), vehicleId: second, position: 1 },
    ];

    // Предпросмотр говорит о снятии заранее и не пишет ни строки: замечание видно там, где его и
    // читают, — до применения.
    const preview = await importFile(
      'vehicle-types',
      ['Бланк путевого листа'],
      [[type.id, 'Форма № 3']],
      { dryRun: true },
    );
    expect(preview.dryRun).toBe(true);
    expect(warningsText(preview)).toContain('привязок: 3, машин: 2');
    for (const trailer of hitched) {
      expect(await hitchOf(trailer.id)).toEqual({
        vehicleId: trailer.vehicleId,
        position: trailer.position,
      });
    }

    const report = await importFile(
      'vehicle-types',
      ['Бланк путевого листа'],
      [[type.id, 'Форма № 3']],
    );
    expect(report.problems).toEqual([]);
    expect(report.updated).toHaveLength(1);
    // Отчёт применения повторяет отчёт предпросмотра — иначе предпросмотр не имел бы смысла.
    expect(warningsText(report)).toContain('привязок: 3, машин: 2');

    for (const trailer of hitched) {
      expect(await hitchOf(trailer.id)).toEqual({ vehicleId: null, position: null });
    }
  });

  // ── Машина: списание и переезд в легковой тип ──

  it('списание машины файлом снимает её привязки', async () => {
    const type = await makeType('4p');
    const retired = await makeVehicle(type.id);
    const kept = await makeVehicle(type.id);
    const trailer = await makeHitchedTrailer(retired, 1);
    // Контрольная привязка: списывается одна машина, а не файл целиком.
    const untouched = await makeHitchedTrailer(kept, 1);

    const report = await importFile(
      'vehicles',
      ['Статус'],
      [[retired, vehicleStatusLabels.retired]],
    );
    expect(report.problems).toEqual([]);
    expect(report.updated).toHaveLength(1);
    expect(warningsText(report)).toContain('привязок: 1');

    expect(await hitchOf(trailer)).toEqual({ vehicleId: null, position: null });
    expect(await hitchOf(untouched)).toEqual({ vehicleId: kept, position: 1 });
  });

  it('смена типа машины на тип «формы № 3» файлом снимает её привязки', async () => {
    // Третье событие таблицы §4.2.3, доступное файлу: сама машина не менялась, но графы, из
    // которых жила привязка, исчезли вместе с бланком (ADR 0071).
    const tractors = await makeType('4p');
    const cars = await makeType('leg3');
    const vehicle = await makeVehicle(tractors.id);
    const trailer = await makeHitchedTrailer(vehicle, 1);

    const report = await importFile('vehicles', ['Тип ТС (код)'], [[vehicle, cars.code]]);
    expect(report.problems).toEqual([]);
    expect(report.updated).toHaveLength(1);
    expect(warningsText(report)).toContain('граф прицепа не имеет');

    expect(await hitchOf(trailer)).toEqual({ vehicleId: null, position: null });
  });

  // ── Обратный случай ──

  it('загрузка без списания и без смены бланка привязок не трогает', async () => {
    const type = await makeType('4p');
    const vehicle = await makeVehicle(type.id);
    const trailer = await makeHitchedTrailer(vehicle, 1);

    const vehicles = await importFile(
      'vehicles',
      ['Примечание'],
      [[vehicle, 'Правка обмена без последствий']],
    );
    expect(vehicles.problems).toEqual([]);
    expect(vehicles.updated).toHaveLength(1);
    expect(warningsText(vehicles)).not.toContain('полуприцеп');
    expect(await hitchOf(trailer)).toEqual({ vehicleId: vehicle, position: 1 });

    const types = await importFile(
      'vehicle-types',
      ['Описание'],
      [[type.id, 'Правка обмена без последствий']],
    );
    expect(types.problems).toEqual([]);
    expect(types.updated).toHaveLength(1);
    expect(warningsText(types)).not.toContain('полуприцеп');
    expect(await hitchOf(trailer)).toEqual({ vehicleId: vehicle, position: 1 });
  });
});
