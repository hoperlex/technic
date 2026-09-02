import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DIRECTORY_DATA_SHEET,
  DIRECTORY_KEYS,
  type DirectoryKey,
  directoryTitles,
  isValidInn,
  isValidSnils,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type { AnyDirectory } from '../src/services/directory-transfer/types';

/**
 * Обмен справочниками (ADR 0073) на живой схеме и настоящих данных.
 *
 * Юнит-тесты описаний проверяют правила по одной строке, но главное свойство обмена они поймать не
 * могут: **выгруженный файл обязан загружаться без единой правки**. Оно держится не на одном
 * модуле, а на совпадении трёх вещей — как строка справочника превращается в модель, как модель
 * печатается в ячейку и как ячейка разбирается обратно. Разойтись им достаточно в одном знаке:
 * лишний ноль в цене, «C1E» вместо «c1e», дата в другом порядке — и человек, ничего не менявший,
 * видит отчёт «изменим 240 строк» и не понимает, чему верить.
 *
 * Справочники здесь настоящие — те, что наполнили миграции: типы ТС, ТТХ, категории, парк,
 * прайс. Заводить их руками бессмысленно: проверяется как раз согласие описаний с тем, что
 * реально лежит в проде.
 *
 * **Чего файл не проверяет.** База у db-тестов общая и живёт между прогонами, а соседние файлы
 * заводят своих людей и контрагентов прямым SQL — минуя и форму, и загрузку справочника. Так в
 * ней накопились водители без СНИЛС и контрагенты с ИНН, не сходящимся по контрольной сумме:
 * порталом такую строку не завести (`createDriverSchema`, `routes/counterparties.ts`), а прямая
 * вставка её пропускает — CHECK таблицы смотрит только на длину. Обмен о них говорит верно: строка
 * негодна, файл не принят. Но сказано это о чужом мусоре, а не о согласии описаний с базой, и
 * поэтому такие строки из файла убираются до загрузки (`unfitIds`). Убираются поимённо — тем же
 * `isValidInn`/`isValidSnils`, которым проверяет их загрузка, — а не «замечания разрешены»: сломай
 * кто-нибудь печать ИНН, замечание придёт на каждую годную строку, и файл упадёт, как и должен.
 *
 * Запуск (база пустая или уже промигрированная — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test directory-transfer.db
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

interface Ctx {
  db: typeof AppDb;
  directories: (typeof import('../src/services/directory-transfer/registry'))['directories'];
  engine: typeof import('../src/services/directory-transfer/engine');
  xlsx: typeof import('../src/lib/xlsx');
}

let ctx: Ctx;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  // Ключи подписи конфиг требует при импорте, хотя обмену они не нужны: вход в портал здесь не
  // участвует — файл собирает и разбирает сервис, а не маршрут.
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
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

beforeAll(async () => {
  if (!DB_URL) return;
  prepareEnv(DB_URL);
  await migrate(DB_URL);
  const { db } = await import('../src/db/client');
  ctx = {
    db,
    directories: (await import('../src/services/directory-transfer/registry')).directories,
    engine: await import('../src/services/directory-transfer/engine'),
    xlsx: await import('../src/lib/xlsx'),
  };
}, 60_000);

const suite = DB_URL ? describe : describe.skip;

/**
 * Идентификаторы строк, негодных ещё в базе, — тех, что положены туда мимо портала.
 *
 * Проверка ровно та же, какой их встретит загрузка: у контрагента ключ — ИНН (`parseInn`), у
 * водителя — СНИЛС (`check()` описания). Второго мнения о том, какой номер верен, здесь нет и быть
 * не должно: разойдись эта выборка с загрузкой хоть на одну строку — файл либо унесёт негодную,
 * либо потеряет годную, и обе беды тест обязан показать, а не спрятать.
 *
 * Справочники, где такого мусора не встречалось, отдают пустой набор: появится — придёт замечание
 * загрузки с номером строки, и разбираться будут по нему, а не гадать, что тест молча выкинул.
 */
async function unfitIds(key: DirectoryKey): Promise<ReadonlySet<string>> {
  if (key === 'counterparties') {
    const rows = await ctx.db.execute<{ id: string; inn: string }>(
      sql`SELECT id, inn FROM counterparties WHERE deleted_at IS NULL`,
    );
    return new Set(rows.rows.filter((r) => !isValidInn(r.inn)).map((r) => r.id));
  }
  if (key === 'drivers') {
    // Строка водителя — это человек: `id(row)` у описания возвращает `persons.id`.
    const rows = await ctx.db.execute<{ id: string; snils: string }>(
      sql`SELECT id, coalesce(snils, '') AS snils FROM persons WHERE deleted_at IS NULL`,
    );
    return new Set(rows.rows.filter((r) => !isValidSnils(r.snils)).map((r) => r.id));
  }
  return new Set();
}

/** Лист «Данные» выгрузки без строк, негодных ещё в базе, и сколько их выкинуто. */
async function exportFit(
  def: AnyDirectory,
): Promise<{ rows: string[][]; kept: number; dropped: number }> {
  const { bytes } = await ctx.engine.exportDirectory(def);
  const sheet = ctx.xlsx.readWorkbook(bytes).find((s) => s.name === DIRECTORY_DATA_SHEET)!;
  const unfit = await unfitIds(def.key);
  // Служебная колонка идентификатора у выгрузки всегда первая (`engine.exportDirectory`).
  const rows = sheet.rows.filter((row, index) => index === 0 || !unfit.has((row[0] ?? '').trim()));
  return { rows, kept: rows.length - 1, dropped: sheet.rows.length - rows.length };
}

/** Книга из одного листа данных: загрузка читает только его, «Справку» она и не открывает. */
function bookOf(rows: string[][]): Uint8Array {
  return ctx.xlsx.writeWorkbook([{ name: DIRECTORY_DATA_SHEET, rows }]);
}

suite('обмен справочниками на живой схеме', () => {
  it('обменом охвачены все справочники, объявленные порталу', () => {
    expect(ctx.directories.map((d) => d.key)).toEqual([...DIRECTORY_KEYS]);
  });

  it.each(DIRECTORY_KEYS)(
    '«%s»: выгруженный файл загружается без единой правки',
    /**
     * Повтор — не борьба с плавающим дефектом, а различение двух разных вещей. База у db-тестов
     * общая, файлы vitest идут параллельно, и соседний тест вправе завести и удалить человека
     * ровно между выгрузкой и загрузкой — тогда строка файла ссылается на исчезнувшую запись.
     * Настоящее расхождение описаний с базой воспроизводится каждый раз и переживёт любой повтор,
     * а гонка со вставкой соседа — нет.
     */
    { timeout: 30_000, retry: 2 },
    async (key) => {
      const def = ctx.directories.find((d) => d.key === key);
      expect(def, `нет описания справочника ${key}`).toBeDefined();

      const { rows, kept, dropped } = await exportFit(def!);
      const report = await ctx.engine.importDirectory(def!, bookOf(rows), {
        dryRun: true,
        actorUserId: '00000000-0000-0000-0000-000000000000',
      });

      // Отчёт печатается в сообщение теста целиком: «изменим 12 строк» без перечня правок
      // заставило бы искать расхождение руками по всему справочнику. Рядом — сколько строк
      // выкинуто негодными: без этого числа «сверено 40 строк из 58» выглядело бы как сверка всего.
      const detail = [
        `строк в файле: ${kept}, выкинуто негодными в базе: ${dropped}`,
        JSON.stringify(
          { created: report.created, updated: report.updated, problems: report.problems },
          null,
          2,
        ),
      ].join('\n');
      expect(report.problems, detail).toEqual([]);
      expect(report.created, detail).toEqual([]);
      expect(report.updated, detail).toEqual([]);
      expect(report.unchanged, detail).toBe(kept);
    },
  );

  it('«Контрагенты»: общий email выгружается и принимается обратно', async () => {
    const def = ctx.directories.find((d) => d.key === 'counterparties')!;
    const { rows } = await exportFit(def);
    const header = rows[0]!;
    const emailAt = header.indexOf('Email для заявок');
    expect(emailAt, 'в выгрузке контрагентов нет общего email').toBeGreaterThan(0);

    const target = rows[1];
    expect(target, 'в справочнике нет годного контрагента для проверки email').toBeDefined();
    const nextEmail = `directory-${randomUUID()}@example.invalid`;
    const edited = rows.map((row, index) =>
      index === 1 ? row.map((cell, at) => (at === emailAt ? nextEmail : cell)) : row,
    );

    const report = await ctx.engine.importDirectory(def, bookOf(edited), {
      dryRun: true,
      actorUserId: '00000000-0000-0000-0000-000000000000',
    });
    expect(report.problems).toEqual([]);
    expect(report.updated).toHaveLength(1);
    expect(report.updated[0]!.changes).toContainEqual({
      column: 'Email для заявок',
      from: target![emailAt] ?? '',
      to: nextEmail,
    });
  });

  it(
    'правка ячейки доезжает до базы, а неизменённые строки остаются нетронутыми',
    { timeout: 30_000 },
    async () => {
      const def = ctx.directories.find((d) => d.key === 'objects')!;
      const { rows } = await exportFit(def);

      const nameAt = rows[0]!.indexOf('Наименование');
      const idAt = 0;
      const target = rows[1];
      expect(target, 'в справочнике объектов нет ни одной записи — проверять нечего').toBeDefined();
      const objectId = target![idAt]!;
      const before = target![nameAt]!;
      const after = `${before} (сверка обмена)`;

      const edited = rows.map((row, index) =>
        index === 1 ? row.map((cell, at) => (at === nameAt ? after : cell)) : row,
      );
      const editedBytes = bookOf(edited);

      const preview = await ctx.engine.importDirectory(def, editedBytes, {
        dryRun: true,
        actorUserId: '00000000-0000-0000-0000-000000000000',
      });
      expect(preview.updated).toHaveLength(1);
      expect(preview.updated[0]!.changes).toEqual([
        { column: 'Наименование', from: before, to: after },
      ]);

      try {
        await ctx.engine.importDirectory(def, editedBytes, {
          dryRun: false,
          actorUserId: '00000000-0000-0000-0000-000000000000',
        });
        const res = await ctx.db.execute<{ name: string }>(
          sql`SELECT name FROM construction_objects WHERE id = ${objectId}::uuid`,
        );
        expect(res.rows[0]?.name).toBe(after);
      } finally {
        // Справочник возвращается в исходное состояние: база у db-тестов общая, и следующий прогон
        // не должен находить в ней следы предыдущего.
        await ctx.db.execute(
          sql`UPDATE construction_objects SET name = ${before} WHERE id = ${objectId}::uuid`,
        );
      }
    },
  );

  it(
    'негодная строка отменяет весь файл — в базе не остаётся половины загрузки',
    { timeout: 30_000 },
    async () => {
      const def = ctx.directories.find((d) => d.key === 'objects')!;
      const { rows: fit } = await exportFit(def);
      const nameAt = fit[0]!.indexOf('Наименование');

      // Первая строка меняется законно, вторая — с пустым обязательным наименованием у новой записи.
      const rows = fit.map((row, index) =>
        index === 1 ? row.map((cell, at) => (at === nameAt ? `${cell} (сверка)` : cell)) : row,
      );
      rows.push(['', ...fit[0]!.slice(1).map(() => '')].map((c, at) => (at === 1 ? 'zz_new' : c)));
      const broken = bookOf(rows);

      await expect(
        ctx.engine.importDirectory(def, broken, {
          dryRun: false,
          actorUserId: '00000000-0000-0000-0000-000000000000',
        }),
      ).rejects.toThrow();

      const check = await ctx.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM construction_objects WHERE code = 'zz_new'`,
      );
      expect(check.rows[0]?.n).toBe('0');
      expect(directoryTitles.objects).toBe('Объекты');
    },
  );

  it(
    'удостоверение тракториста по одним реквизитам, без категорий, доезжает до базы',
    { timeout: 30_000 },
    async () => {
      /**
       * Синтетический СНИЛС: блок «9xx» ПФР не выдаёт, и живому человеку такой номер не
       * принадлежит. Контрольная сумма у него при этом настоящая — иначе строку отвергнет
       * `check()`: девять цифр 900 000 000 на позициях 9…1 дают 9×9 = 81, и последние две цифры
       * номера её повторяют.
       */
      const snils = '900-000-000 81';
      const snilsDigits = '90000000081';
      /** Номер удостоверения — единственный реквизит, по которому документ обязан завестись. */
      const number = '112233';

      const def = ctx.directories.find((d) => d.key === 'drivers')!;
      // Загрузка здесь настоящая, и негодная строка отменила бы весь файл — включая ту, ради
      // которой тест и написан: справочник берётся без строк, испорченных в базе мимо портала.
      const { rows } = await exportFit(def);
      const header = rows[0]!;
      const at = (column: string): number => {
        const index = header.indexOf(column);
        expect(index, `в выгрузке водителей нет колонки «${column}»`).toBeGreaterThan(0);
        return index;
      };

      // Строка дописывается новой: колонка идентификатора пуста, по СНИЛС человек в справочнике не
      // найдётся — загрузка заведёт его. Ячейки ставятся по именам колонок, а не по местам: блоки
      // документов собираются перечнем видов, и порядок колонок меняется вместе с ним.
      const added = header.map(() => '');
      added[at('ФИО')] = 'Тестовый Обмен Механизаторович';
      added[at('СНИЛС')] = snils;
      added[at('Должность')] = 'Машинист экскаватора';
      added[at('Номер УТМ')] = number;
      added[at('Выдано УТМ')] = '05.04.2023';
      // «Категории УТМ» остаются пустыми: ровно эту строку файл прежде и терял — документ по ней
      // не заводился вовсе, и загруженные реквизиты удостоверения молча пропадали.
      const editedBytes = bookOf([...rows, added]);

      // Автор записи проставляется и человеку, и документу, а `persons.created_by` смотрит в
      // `users`: вымышленный ноль-UUID соседних тестов внешний ключ не пропустит. Учётка заводится
      // ради одного этого поля — войти по ней нельзя — и убирается вместе с человеком.
      const actor = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, password_hash)
        VALUES (${`directory-transfer-${randomUUID()}@example.invalid`},
                'Обменов', 'Тест', 'не пароль: учётка нужна только как автор записи')
        RETURNING id`);
      const actorUserId = actor.rows[0]!.id;

      try {
        const report = await ctx.engine.importDirectory(def, editedBytes, {
          dryRun: false,
          actorUserId,
        });
        expect(report.created, JSON.stringify(report.problems)).toHaveLength(1);

        const document = await ctx.db.execute<{
          id: string;
          number: string;
          issued_on: string;
        }>(sql`
          SELECT pc.id, pc.number, pc.issued_on::text AS issued_on
            FROM person_credentials pc
            JOIN credential_types ct ON ct.id = pc.credential_type_id
            JOIN persons p ON p.id = pc.person_id
           WHERE p.snils = ${snilsDigits} AND ct.code = 'tractor_license'`);
        expect(document.rows, 'документ УТМ по одним реквизитам до базы не доехал').toHaveLength(1);
        expect(document.rows[0]!.number).toBe(number);
        expect(document.rows[0]!.issued_on).toBe('2023-04-05');

        const categories = await ctx.db.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM person_credential_categories
               WHERE credential_id = ${document.rows[0]!.id}::uuid`,
        );
        expect(categories.rows[0]?.n).toBe('0');

        // Обратная половина того же правила: пустой блок ВУ документа не заводит — иначе первая же
        // загрузка выдала бы каждому машинисту по пустому водительскому удостоверению.
        const empty = await ctx.db.execute<{ n: string }>(sql`
          SELECT count(*)::text AS n
            FROM person_credentials pc
            JOIN credential_types ct ON ct.id = pc.credential_type_id
            JOIN persons p ON p.id = pc.person_id
           WHERE p.snils = ${snilsDigits} AND ct.code = 'driver_license'`);
        expect(empty.rows[0]?.n).toBe('0');
      } finally {
        // База у db-тестов общая, и человек с персональными данными в ней не остаётся ни в каком
        // виде: удаляется всё, что завела строка, — снизу вверх по внешним ключам.
        const person = sql`(SELECT id FROM persons WHERE snils = ${snilsDigits})`;
        await ctx.db.execute(
          sql`DELETE FROM person_credential_categories WHERE credential_id IN
                (SELECT id FROM person_credentials WHERE person_id IN ${person})`,
        );
        await ctx.db.execute(sql`DELETE FROM person_credentials WHERE person_id IN ${person}`);
        await ctx.db.execute(sql`DELETE FROM person_employments WHERE person_id IN ${person}`);
        await ctx.db.execute(sql`DELETE FROM person_specializations WHERE person_id IN ${person}`);
        await ctx.db.execute(sql`DELETE FROM persons WHERE snils = ${snilsDigits}`);
        await ctx.db.execute(sql`DELETE FROM users WHERE id = ${actorUserId}::uuid`);
      }
    },
  );
});
