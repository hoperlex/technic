import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';

/**
 * Массовый бэкфилл истории назначения — прогон целиком, как его запускает оператор
 * ([scripts/assignment-backfill.ts](../scripts/assignment-backfill.ts); план
 * `docs/assignment-periods-plan.md`, §6 «Бэкфилл», Г2, Р20, Р26–Р28, Р30).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ — четыре обещания прогона, и каждое из них такое, что нарушение видно не
 * сразу:
 *
 * 1. **dry-run не пишет.** Обещание режима по умолчанию: оператор запускает его на живой базе,
 *    чтобы посмотреть отчёт. Проверяется не «в отчёте написано 0», а состоянием базы после;
 * 2. **запись даёт ожидаемые состояния** — по одному случаю §6 на заявку: без листов, с будущим
 *    сроком без машиниста, неоднозначные листы, пересекающиеся периоды, отсутствующее назначение,
 *    расхождение хвоста, линейная заявка;
 * 3. **невосстановимое попадает в блокирующий отчёт** — с номером заявки и причиной, а не молча
 *    в счётчик;
 * 4. **повторный прогон ничего не меняет** — история не пересобирается (Д3), в том числе у заявки,
 *    у которой к тому моменту появился новый лист: пересборка потеряла бы идентификаторы строк и
 *    отмены, записанные человеком.
 *
 * Плюс возобновление: прогон, оборванный на середине, продолжается и даёт то же состояние базы,
 * что и непрерывный.
 *
 * ФАЙЛ ЗАВОДИТ СОБСТВЕННУЮ БАЗУ И СНОСИТ ЕЁ ЗА СОБОЙ. Иначе никак: прогон — это отдельный процесс,
 * который идёт по **всей** базе, и на общей `TEST_DATABASE_URL` он материализовал бы историю
 * заявок соседних файлов. Откатываемой транзакцией сцену тоже не обойтись — дочерний процесс ходит
 * своим соединением и незакоммиченного не видит. База создаётся из `TEST_DATABASE_URL` заменой
 * имени, мигрируется тем же раннером, что и все прочие, и удаляется в `afterAll`.
 *
 * Запуск (база из переменной может быть любой — своя всё равно создаётся рядом):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/assignment-backfill.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: своя база на каждый прогон, чтобы два одновременных не встретились в одной. */
const RUN = Date.now().toString(36).slice(-6);

const TODAY = moscowDateKeyOf(new Date());
const WEEK_NOW = weekStartKey(TODAY);
const WEEK_PREV = shiftDateKey(WEEK_NOW, -7);
const WEEK_PREV2 = shiftDateKey(WEEK_NOW, -14);
const sunday = (monday: string): string => shiftDateKey(monday, 6);

const SCRIPT = resolve(
  fileURLToPath(new URL('../scripts/assignment-backfill.ts', import.meta.url)),
);
const TSX = resolve(fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)));
const API_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Коды возврата прогона — те же, что описаны в его шапке. */
const EXIT_CLEAN = 0;
const EXIT_BLOCKING = 3;
const EXIT_USAGE = 2;

interface Ctx {
  client: pg.Client;
  dbName: string;
  ownUrl: string;
  adminUrl: string;
  workDir: string;
  /** Номера заведённых заявок: отчёт называет их людям именно так. */
  num: Record<Case, number>;
  id: Record<Case, string>;
}

type Case =
  | 'noSheets'
  | 'futureUnknown'
  | 'ambiguous'
  | 'overlapping'
  | 'noAssignment'
  | 'tailMismatch'
  | 'linear'
  /** ЭСМ2-РАЗРЕЗ: неделя, разрезанная сменой машины, — два листа подряд, стык день-в-день. */
  | 'splitWeek';

let ctx: Ctx;

/**
 * Имя и адрес заведённой базы — **вне** `ctx` намеренно: собранная сцена в `ctx` появляется
 * последней, а снести базу надо и тогда, когда сцена не собралась. Иначе упавший `beforeAll`
 * оставляет на кластере брошенную базу, и находят её через неделю по списку.
 */
let created: { dbName: string; adminUrl: string } | null = null;

beforeAll(async () => {
  if (!DB_URL) return;
  const base = new URL(DB_URL);
  const dbName = `${base.pathname.slice(1)}_bf_${RUN}`.slice(0, 63);
  const admin = new URL(DB_URL);
  admin.pathname = '/postgres';
  const own = new URL(DB_URL);
  own.pathname = `/${dbName}`;
  created = { dbName, adminUrl: admin.toString() };

  const adminClient = new pg.Client({ connectionString: admin.toString() });
  await adminClient.connect();
  try {
    await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminClient.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminClient.end();
  }

  const client = new pg.Client({ connectionString: own.toString() });
  await client.connect();
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query('CREATE EXTENSION IF NOT EXISTS citext');
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await applyMigrations(client);

  ctx = {
    client,
    dbName,
    ownUrl: own.toString(),
    adminUrl: admin.toString(),
    workDir: mkdtempSync(join(tmpdir(), 'assignment-backfill-')),
    num: {} as Record<Case, number>,
    id: {} as Record<Case, string>,
  };
  await buildScene();
}, 180_000);

afterAll(async () => {
  if (ctx) {
    await ctx.client.end();
    rmSync(ctx.workDir, { recursive: true, force: true });
  }
  if (!created) return;
  const adminClient = new pg.Client({ connectionString: created.adminUrl });
  await adminClient.connect();
  try {
    await adminClient.query(`DROP DATABASE IF EXISTS "${created.dbName}" WITH (FORCE)`);
  } finally {
    await adminClient.end();
  }
}, 60_000);

// ── Сцена ──

async function one<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  const { rows } = await ctx.client.query<T>(text, values);
  const row = rows[0];
  if (!row) throw new Error(`запрос не вернул строки: ${text}`);
  return row;
}

/**
 * Семь заявок — по одной на правило §6, которое обязано быть видно в отчёте.
 *
 * Справочники берутся из сида миграций (машины, объекты, организация, серия ЭСМ-2): база своя, и
 * никакой сосед из-под неё их не удалит. Линейный тип заводится свой — линейных в сиде нет.
 */
async function buildScene(): Promise<void> {
  const obj = await one<{ id: string }>('SELECT id FROM construction_objects LIMIT 1');
  const org = await one<{ id: string }>(
    'SELECT id FROM organizations WHERE is_active ORDER BY name LIMIT 1',
  );
  const series = await one<{ id: string }>("SELECT id FROM waybill_series WHERE code = 'esm2'");
  const { rows: own } = await ctx.client.query<{ id: string; vehicle_type_id: string }>(
    "SELECT id, vehicle_type_id FROM vehicles WHERE ownership = 'own' AND deleted_at IS NULL ORDER BY id LIMIT 2",
  );
  const [ownA, ownB] = own;
  if (!ownA || !ownB) throw new Error('в парке меньше двух собственных машин: сцену не собрать');
  const kind = await one<{ id: string }>('SELECT id FROM vehicle_kinds ORDER BY code LIMIT 1');
  const user = await one<{ id: string }>(
    `INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
     VALUES ($1, 'Прогонов', 'Пров', 'x', 'admin', false) RETURNING id`,
    [`ap-backfill-${RUN}@example.invalid`],
  );
  const driver = await one<{ id: string }>(
    "INSERT INTO persons (last_name, first_name) VALUES ('Машинистов', 'Пров') RETURNING id",
  );
  const linearType = await one<{ id: string }>(
    `INSERT INTO vehicle_types (kind_id, code, name, waybill_form_code, is_linear)
     VALUES ($1, $2, 'Линейный (прогон)', 'esm2', true) RETURNING id`,
    [kind.id, `ap_backfill_lin_${RUN}`],
  );

  let sheetNumber = 700_000_000 + Math.floor(Math.random() * 90_000_000);

  const makeRequest = async (
    key: Case,
    spec: { dateFrom: string; dateTo: string; vehicleId: string | null; linear?: boolean },
  ): Promise<void> => {
    const typeId = spec.linear ? linearType.id : ownA.vehicle_type_id;
    const request = await one<{ id: string; num: number }>(
      `INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
       VALUES ('special_equipment', $1, $2, 'confirmed', $3) RETURNING id, num`,
      [obj.id, typeId, user.id],
    );
    await ctx.client.query(
      'INSERT INTO special_equipment_request_details (request_id, date_from, date_to) VALUES ($1, $2, $3)',
      [request.id, spec.dateFrom, spec.dateTo],
    );
    if (spec.vehicleId) {
      // Тип назначенной машины берётся у неё самой: составной ключ `(vehicle_id, vehicle_type_id)`
      // ведёт в справочник, и «тип заказанный» здесь не подходит.
      const vehicleType = spec.vehicleId === ownB.id ? ownB.vehicle_type_id : ownA.vehicle_type_id;
      await ctx.client.query(
        `INSERT INTO vehicle_request_assignments
           (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [request.id, spec.vehicleId, vehicleType, typeId, user.id],
      );
    }
    ctx.id[key] = request.id;
    ctx.num[key] = request.num;
  };

  /*
   * ЭСМ2-РАЗРЕЗ. Умолчание `to` — воскресенье той же недели, то есть лист-неделя. Оно оставлено,
   * потому что почти все сцены файла проверяют не разрез, а причины невосстановимости; сцены
   * разреза передают `to` явно.
   *
   * Что здесь важно после переключения чтения (этап 5): два листа одной календарной недели у одной
   * заявки — **норма**, а не аномалия, если у них разные `period_from` (внутри срока сменился
   * состав). Аномалией остаётся совпадение `(period_from, vehicle_id)` и пересечение периодов —
   * из них одной временной шкалы не построить. Проверено сценой `splitWeek` ниже.
   */
  const issueSheet = async (
    key: Case,
    spec: { from: string; to?: string; vehicleId: string },
  ): Promise<void> => {
    sheetNumber += 1;
    await ctx.client.query(
      `INSERT INTO waybills (series_id, number, form_code, status, organization_id, vehicle_id,
                             driver_person_id, issued_for_date, source_request_id, period_from,
                             period_to, issued_by)
       VALUES ($1, $2, 'esm2', 'issued', $3, $4, $5, $6, $7, $6, $8, $9)`,
      [
        series.id,
        sheetNumber,
        org.id,
        spec.vehicleId,
        driver.id,
        spec.from,
        ctx.id[key],
        spec.to ?? sunday(spec.from),
        user.id,
      ],
    );
  };

  // §6 п. 4: заявка без листов на прошедшем сроке — машина из назначения и `unknown` вместо
  // машиниста; изменяемых дней нет, значит `ready`.
  await makeRequest('noSheets', {
    dateFrom: WEEK_PREV2,
    dateTo: sunday(WEEK_PREV),
    vehicleId: ownA.id,
  });
  // Тот же случай, но срок захватывает сегодня: `unknown` лёг на изменяемые дни — `materialized`.
  await makeRequest('futureUnknown', {
    dateFrom: WEEK_NOW,
    dateTo: sunday(WEEK_NOW),
    vehicleId: ownA.id,
  });
  // §6 п. 0: два действующих листа с одним `period_from` и разными машинами.
  await makeRequest('ambiguous', {
    dateFrom: WEEK_PREV,
    dateTo: sunday(WEEK_PREV),
    vehicleId: ownA.id,
  });
  await issueSheet('ambiguous', { from: WEEK_PREV, vehicleId: ownA.id });
  await issueSheet('ambiguous', { from: WEEK_PREV, vehicleId: ownB.id });
  // §6 п. 0: периоды пересекаются, начала разные — одной шкалы из них не построить.
  await makeRequest('overlapping', {
    dateFrom: WEEK_PREV,
    dateTo: sunday(WEEK_PREV),
    vehicleId: ownA.id,
  });
  await issueSheet('overlapping', { from: WEEK_PREV, vehicleId: ownA.id });
  await issueSheet('overlapping', {
    from: shiftDateKey(WEEK_PREV, 2),
    to: sunday(WEEK_PREV),
    vehicleId: ownA.id,
  });
  /*
   * ЭСМ2-РАЗРЕЗ. Неделя, разрезанная сменой техники: понедельник — среда на одной машине, четверг —
   * воскресенье на другой. Это **не** аномалия: начала разные, периоды не пересекаются, шкала
   * строится однозначно. Бэкфилл обязан дать два vehicle-изменения с границей на четверге, а не
   * одно на начало срока и не отказ `ambiguous_sheets`.
   *
   * До разреза такой сцены не бывало: неделя была одним листом, и «два листа недели» означало
   * ровно неоднозначность.
   */
  await makeRequest('splitWeek', {
    dateFrom: WEEK_PREV,
    dateTo: sunday(WEEK_PREV),
    vehicleId: ownB.id,
  });
  await issueSheet('splitWeek', {
    from: WEEK_PREV,
    to: shiftDateKey(WEEK_PREV, 2),
    vehicleId: ownA.id,
  });
  await issueSheet('splitWeek', {
    from: shiftDateKey(WEEK_PREV, 3),
    to: sunday(WEEK_PREV),
    vehicleId: ownB.id,
  });

  // Назначения нет вовсе: восстанавливать не от чего.
  await makeRequest('noAssignment', {
    dateFrom: WEEK_PREV,
    dateTo: sunday(WEEK_PREV),
    vehicleId: null,
  });
  // Р30: последний лист на одной машине, назначение — на другой, свободного дня внутри срока нет.
  await makeRequest('tailMismatch', {
    dateFrom: WEEK_PREV,
    dateTo: sunday(WEEK_PREV),
    vehicleId: ownB.id,
  });
  await issueSheet('tailMismatch', { from: WEEK_PREV, vehicleId: ownA.id });
  // §6 п. 1: линейная заявка из листов не восстанавливается — одна строка из назначения.
  await makeRequest('linear', {
    dateFrom: WEEK_PREV,
    dateTo: sunday(WEEK_PREV),
    vehicleId: ownA.id,
    linear: true,
  });
}

// ── Запуск прогона и чтение состояния ──

interface RunResult {
  status: number;
  stdout: string;
}

function runBackfill(args: readonly string[]): RunResult {
  const result = spawnSync(TSX, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_MAINTENANCE_URL: ctx.ownUrl,
      // Прикладной URL прогону не нужен и не должен подставляться (П7): пусть его тут не будет.
      DATABASE_URL: undefined,
      DATABASE_MIGRATION_URL: undefined,
    },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: `${result.stdout}${result.stderr}` };
}

/** Состояние готовности и число действующих строк истории — по каждой заявке сцены. */
async function statesOf(): Promise<Record<string, { state: string; rows: number }>> {
  const { rows } = await ctx.client.query<{ num: number; state: string; rows: number }>(`
    SELECT r.num,
           r.assignment_history_state AS state,
           count(c.id) FILTER (WHERE c.superseded_at IS NULL)::int AS rows
      FROM vehicle_requests r
      LEFT JOIN vehicle_request_assignment_changes c ON c.request_id = r.id
     GROUP BY r.num, r.assignment_history_state`);
  const byKey: Record<string, { state: string; rows: number }> = {};
  for (const [key, num] of Object.entries(ctx.num)) {
    const row = rows.find((candidate) => candidate.num === num);
    byKey[key] = { state: row?.state ?? '?', rows: row?.rows ?? 0 };
  }
  return byKey;
}

/** Содержание истории без идентификаторов: чем заявка работала и с кем, по дням. */
async function historyShape(): Promise<string[]> {
  return (await historyFingerprint()).map((line) => line.slice(line.indexOf(' ') + 1));
}

/** Отпечаток истории: идентификаторы строк и их содержание. Пересборка меняет его целиком. */
async function historyFingerprint(): Promise<string[]> {
  const { rows } = await ctx.client.query<{ line: string }>(`
    SELECT c.id || ' ' || r.num || ' ' || c.effective_date || ' ' || c.dimension || ' '
           || coalesce(c.vehicle_id::text, c.driver_state, '-') || ' ' || c.origin AS line
      FROM vehicle_request_assignment_changes c
      JOIN vehicle_requests r ON r.id = c.request_id
     WHERE c.superseded_at IS NULL
     ORDER BY r.num, c.effective_date, c.dimension`);
  return rows.map((row) => row.line);
}

async function resetHistory(): Promise<void> {
  await ctx.client.query('DELETE FROM vehicle_request_assignment_changes');
  await ctx.client.query(`UPDATE vehicle_requests
     SET assignment_history_state = 'empty', assignment_history_validated_on = NULL,
         assignment_history_dirty = false`);
}

// ── Проверки ──

describe('dry-run', () => {
  it('считает и показывает отчёт, не записывая ни строки', async () => {
    if (!DB_URL) return;
    const run = runBackfill([`--asof=${TODAY}`, '--progress=0']);

    // Три невосстановимые заявки и одна с блокерами — прогон обязан сказать об этом кодом возврата.
    expect(run.status).toBe(EXIT_BLOCKING);
    expect(run.stdout).toContain('dry-run (ничего не пишется)');
    expect(run.stdout).toContain('обработано заявок                            8');
    expect(run.stdout).toContain('осталось empty (не восстановимо)             3');

    // Главное свойство режима проверяется базой, а не отчётом.
    const { rows } = await ctx.client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM vehicle_request_assignment_changes',
    );
    expect(rows[0]?.n).toBe(0);
    const states = await statesOf();
    expect(new Set(Object.values(states).map((value) => value.state))).toEqual(new Set(['empty']));
  }, 120_000);
});

describe('запись', () => {
  it('даёт каждому случаю §6 его состояние и его строки', async () => {
    if (!DB_URL) return;
    const run = runBackfill(['--apply', `--asof=${TODAY}`, '--progress=0']);
    expect(run.status).toBe(EXIT_BLOCKING);

    expect(await statesOf()).toEqual({
      // Прошедший срок без листов: машина из назначения + `unknown` вместо машиниста, блокеров нет.
      noSheets: { state: 'ready', rows: 2 },
      // Тот же расклад на изменяемых днях — валидности нет.
      futureUnknown: { state: 'materialized', rows: 2 },
      // Неоднозначная и пересекающаяся бумага: ни строки, ни состояния.
      ambiguous: { state: 'empty', rows: 0 },
      overlapping: { state: 'empty', rows: 0 },
      noAssignment: { state: 'empty', rows: 0 },
      // Хвост разошёлся с назначением — это предупреждение, а не блокер (Р30).
      tailMismatch: { state: 'ready', rows: 2 },
      // Линейной заявке пишется одно vehicle-изменение и ни слова о человеке.
      linear: { state: 'ready', rows: 1 },
      /*
       * ЭСМ2-РАЗРЕЗ. Разрезанная неделя восстанавливается, а не отвергается. Строк три, а не
       * четыре: два vehicle-изменения (начало срока и граница смены машины) и **одно**
       * driver-изменение — машинист на обоих отрезках один, и второй строки о нём быть не должно.
       * Изменение пишется там, где меняется значение шкалы (§6 п. 2), а не на каждой границе
       * бумаги. Если бы бэкфилл принял неделю за неоднозначную, здесь стояло бы `empty` и ноль.
       */
      splitWeek: { state: 'ready', rows: 3 },
    });

    const { rows } = await ctx.client.query<{ origin: string; created_by: string | null }>(
      'SELECT DISTINCT origin, created_by FROM vehicle_request_assignment_changes',
    );
    expect(rows).toEqual([{ origin: 'backfill', created_by: null }]);

    /*
     * ЭСМ2-РАЗРЕЗ. Число строк само по себе слабое утверждение: три строки дала бы и история,
     * поставившая границу не туда. Поэтому у разрезанной недели проверяются **даты**: смена машины
     * приходится ровно на первый день второго листа (четверг), а не на начало срока и не на конец
     * первого отрезка.
     */
    const split = await ctx.client.query<{ dimension: string; effective_date: string }>(
      `SELECT dimension, to_char(effective_date, 'YYYY-MM-DD') AS effective_date
         FROM vehicle_request_assignment_changes
        WHERE request_id = $1 AND superseded_at IS NULL
        ORDER BY effective_date, dimension`,
      [ctx.id.splitWeek],
    );
    expect(split.rows).toEqual([
      { dimension: 'driver', effective_date: WEEK_PREV },
      { dimension: 'vehicle', effective_date: WEEK_PREV },
      { dimension: 'vehicle', effective_date: shiftDateKey(WEEK_PREV, 3) },
    ]);
  }, 120_000);

  it('называет в блокирующем отчёте номер заявки и причину', async () => {
    if (!DB_URL) return;
    await resetHistory();
    const report = join(ctx.workDir, 'report.txt');
    const run = runBackfill(['--apply', `--asof=${TODAY}`, '--progress=0', `--report=${report}`]);
    expect(run.status).toBe(EXIT_BLOCKING);

    const text = readFileSync(report, 'utf8');
    expect(text).toContain('БЛОКИРУЮЩИЙ ОТЧЁТ');
    expect(text).toMatch(
      new RegExp(`ТС-${ctx.num.noAssignment}\\s+заявке не назначена техника`, 'u'),
    );
    expect(text).toMatch(
      new RegExp(`ТС-${ctx.num.ambiguous}\\s+на ${WEEK_PREV} действуют два путевых листа`, 'u'),
    );
    expect(text).toMatch(
      new RegExp(
        `ТС-${ctx.num.overlapping}\\s+периоды действующих путевых листов пересекаются`,
        'u',
      ),
    );
    // Заявка с блокерами — тоже строка для человека: историю ей записали, но валидности у неё нет.
    expect(text).toMatch(
      new RegExp(`ТС-${ctx.num.futureUnknown}\\s+нет машиниста на изменяемых днях`, 'u'),
    );
    // Расхождение хвоста стоит отдельно от блокирующих: заявка `ready` и cutover ей не мешает.
    expect(text).toContain('Предупреждения (Р30');
    expect(text).toContain(`ТС-${ctx.num.tailMismatch}: хвост истории`);
    // Заявки, которые прогон довёл до `ready`, в блокирующем отчёте не упоминаются вовсе.
    expect(text).not.toMatch(new RegExp(`ТС-${ctx.num.noSheets}\\s`, 'u'));
  }, 120_000);
});

describe('повторный прогон', () => {
  it('не пересобирает историю — даже там, где с прошлого раза появился новый лист', async () => {
    if (!DB_URL) return;
    const before = await historyFingerprint();
    expect(before.length).toBeGreaterThan(0);

    // Новый лист на другой машине: пересборка увидела бы его и переписала бы шкалу заявки.
    await ctx.client.query(
      `INSERT INTO waybills (series_id, number, form_code, status, organization_id, vehicle_id,
                             driver_person_id, issued_for_date, source_request_id, period_from,
                             period_to, issued_by)
       SELECT w.series_id, 799999999, 'esm2', 'issued', w.organization_id,
              (SELECT id FROM vehicles WHERE ownership = 'own' AND deleted_at IS NULL
                ORDER BY id OFFSET 1 LIMIT 1),
              w.driver_person_id, $2, $1, $2, $3, w.issued_by
         FROM waybills w LIMIT 1`,
      [ctx.id.noSheets, WEEK_PREV2, sunday(WEEK_PREV2)],
    );

    const run = runBackfill(['--apply', `--asof=${TODAY}`, '--progress=0']);
    expect(run.status).toBe(EXIT_BLOCKING);
    // Обработаны только те три, у кого истории нет: остальные в выборку не попадают вовсе.
    expect(run.stdout).toContain('обработано заявок                            3');
    expect(await historyFingerprint()).toEqual(before);
  }, 120_000);
});

describe('возобновление', () => {
  it('прерванный прогон продолжается и даёт то же, что непрерывный', async () => {
    if (!DB_URL) return;
    // Эталон снимается здесь же и на текущих данных: соседний случай успел добавить заявке лист,
    // и история, построенная до него, была бы эталоном другой сцены.
    await resetHistory();
    expect(runBackfill(['--apply', `--asof=${TODAY}`, '--progress=0']).status).toBe(EXIT_BLOCKING);
    const reference = await historyShape();
    await resetHistory();

    const statePath = join(ctx.workDir, 'resume.json');
    const first = runBackfill([
      '--apply',
      `--asof=${TODAY}`,
      '--progress=0',
      `--state=${statePath}`,
      '--limit=3',
    ]);
    expect(first.status).toBeGreaterThanOrEqual(0);
    expect(first.stdout).toContain('обработано заявок                            3');
    expect(first.stdout).toContain('остановлен пределом --limit');

    const second = runBackfill([
      '--apply',
      `--asof=${TODAY}`,
      '--progress=0',
      `--state=${statePath}`,
    ]);
    expect(second.status).toBe(EXIT_BLOCKING);
    expect(second.stdout).toContain('продолжение с');
    expect(second.stdout).toContain('обработано заявок                            8');
    // Сравнивается содержание, а не идентификаторы: сцену перед отрезками сбрасывали, и новые
    // строки законно получили новые `id`. Неизменность самих идентификаторов — предмет соседнего
    // случая, где истории никто не сбрасывал.
    expect(await historyShape()).toEqual(reference);

    // Третий запуск по тому же файлу работы уже не находит и говорит об этом прямо.
    const third = runBackfill([
      '--apply',
      `--asof=${TODAY}`,
      '--progress=0',
      `--state=${statePath}`,
    ]);
    expect(third.stdout).toContain('работы нет');
  }, 180_000);

  it('не продолжает вчерашний прогон сегодняшним днём', async () => {
    if (!DB_URL) return;
    const statePath = join(ctx.workDir, 'asof.json');
    runBackfill([`--asof=${WEEK_PREV}`, '--progress=0', `--state=${statePath}`, '--limit=1']);
    const again = runBackfill([`--asof=${TODAY}`, '--progress=0', `--state=${statePath}`]);
    expect(again.status).toBe(1);
    expect(again.stdout).toContain('cutover требует одной');
  }, 120_000);
});

describe('аргументы', () => {
  it('неизвестный флаг — отказ, а не молчаливый прогон по всей базе', async () => {
    if (!DB_URL) return;
    const run = runBackfill(['--aply']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stdout).toContain('Неизвестный флаг --aply');
  }, 60_000);

  it('без своего URL прогон не идёт вовсе (П7)', async () => {
    if (!DB_URL) return;
    const result = spawnSync(TSX, [SCRIPT], {
      cwd: API_DIR,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        DATABASE_URL: DB_URL,
        DATABASE_MAINTENANCE_URL: undefined,
        DATABASE_MIGRATION_URL: undefined,
      },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('не ходит прикладными кредами');
    // И чистый прогон без блокирующих строк отличим от прочих: код 0 (EXIT_CLEAN) занят только им.
    expect(EXIT_CLEAN).toBe(0);
  }, 60_000);
});
