import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';

/**
 * Обратный прогон истории назначения — целиком, как его запускает оператор
 * ([scripts/assignment-rollback.ts](../scripts/assignment-rollback.ts); план
 * `docs/assignment-periods-plan.md`, этап 4 волна 4.2, Д3, Е4, §10).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ — пять обещаний отката, и каждое такое, что нарушение видно не сразу:
 *
 * 1. **без заморозки прогон не идёт.** Откат под живой записью бессмысленен: заявка, признанная
 *    обратимой, получает решение человека через секунду после проверки (Е4);
 * 2. **чистая заявка откатывается** — строки удалены, состояние вернулось в `empty`; и это
 *    круговая проверка: историю ей записал настоящий бэкфилл, а не тестовый INSERT;
 * 3. **заявка с человеческим следом не откатывается** — по каждому виду следа отдельно:
 *    отменённая человеком строка (Д3: отмена живёт НА САМОЙ backfill-строке и потомка не имеет),
 *    вписанная человеком строка, операция `crew`, и — главное — операция `assignment_tail` БЕЗ
 *    единой строки истории (`tail_decision`, первичный `history_wins` Р31): по строкам такую
 *    заявку не отличить от нетронутой вовсе;
 * 4. **решение, легшее МЕЖДУ отбором и удалением, ловится повторной проверкой** — настоящей
 *    гонкой на двух соединениях: одно держит строку заявки и пишет отмену, второе (прогон) ждёт
 *    на той же блокировке, а дождавшись, видит уже закоммиченное решение и уходит в отчёт;
 * 5. **отчёт называет, что именно удержало заявку** — чью отмену, какую операцию, какую связь.
 *
 * ПОЧЕМУ ГОНКА НАСТОЯЩАЯ, А НЕ ИМИТАЦИЯ. Никакого «подождём секунду и понадеемся» здесь нет:
 * порядок держит сам PostgreSQL. Соединение B открывает транзакцию, берёт `FOR UPDATE` по строке
 * заявки (ту же блокировку, что берут все двери истории) и пишет отмену, **не коммитя**. Прогон
 * стартует после этого: его выборка идёт своим снимком и видит заявку обратимой (чужое
 * незакоммиченное ей не видно), а дойдя до неё, упирается в блокировку. Третье соединение ждёт,
 * пока в `pg_stat_activity` не появится ожидание на `Lock` — то есть пока прогон действительно не
 * встанет, — и только тогда коммитит B. Ожидание блокировки и есть доказательство, что решение
 * легло именно между отбором и удалением: не встань прогон на замке, гонки бы не было.
 *
 * ФАЙЛ ЗАВОДИТ СОБСТВЕННУЮ БАЗУ И СНОСИТ ЕЁ ЗА СОБОЙ — по той же причине, что и тест бэкфилла:
 * прогон это отдельный процесс, идущий по **всей** базе, и на общей `TEST_DATABASE_URL` он стёр бы
 * историю заявок соседних файлов.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_rb \
 *     npx vitest run test/assignment-rollback.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: своя база на каждый прогон, чтобы два одновременных не встретились в одной. */
const RUN = Date.now().toString(36).slice(-6);

const TODAY = moscowDateKeyOf(new Date());
const WEEK_NOW = weekStartKey(TODAY);
const WEEK_PREV = shiftDateKey(WEEK_NOW, -7);
const sunday = (monday: string): string => shiftDateKey(monday, 6);

const ROLLBACK = resolve(
  fileURLToPath(new URL('../scripts/assignment-rollback.ts', import.meta.url)),
);
const BACKFILL = resolve(
  fileURLToPath(new URL('../scripts/assignment-backfill.ts', import.meta.url)),
);
const TSX = resolve(fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)));
const API_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Коды возврата прогона — те же, что описаны в его шапке. */
const EXIT_CLEAN = 0;
const EXIT_USAGE = 2;
const EXIT_HELD = 3;
const EXIT_NOT_FROZEN = 4;

type Case = 'clean' | 'cancelled' | 'humanRow' | 'crewOp' | 'tailOnly' | 'race';

const CASES: readonly Case[] = ['clean', 'cancelled', 'humanRow', 'crewOp', 'tailOnly', 'race'];

interface Ctx {
  client: pg.Client;
  ownUrl: string;
  workDir: string;
  /** Номера заведённых заявок: отчёт называет их людям именно так. */
  num: Record<Case, number>;
  id: Record<Case, string>;
  userId: string;
  userName: string;
  driverId: string;
}

let ctx: Ctx;

/**
 * Имя и адрес заведённой базы — **вне** `ctx` намеренно: собранная сцена появляется последней, а
 * снести базу надо и тогда, когда сцена не собралась.
 */
let created: { dbName: string; adminUrl: string } | null = null;

beforeAll(async () => {
  if (!DB_URL) return;
  const base = new URL(DB_URL);
  const dbName = `${base.pathname.slice(1)}_rb_${RUN}`.slice(0, 63);
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
    ownUrl: own.toString(),
    workDir: mkdtempSync(join(tmpdir(), 'assignment-rollback-')),
    num: {} as Record<Case, number>,
    id: {} as Record<Case, string>,
    userId: '',
    userName: '',
    driverId: '',
  };
  await buildScene();
  // История заводится НАСТОЯЩИМ бэкфиллом, а не тестовым INSERT: проверяется пара «прямой прогон —
  // обратный», и подсунутые руками строки доказывали бы только то, что мы умеем их подсунуть.
  const backfill = runScript(BACKFILL, ['--apply', `--asof=${TODAY}`, '--progress=0']);
  expect(backfill.status).toBe(EXIT_CLEAN);
  await addHumanTraces();
}, 240_000);

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
 * Шесть одинаковых заявок: прошедший недельный срок, назначенная своя машина, листов нет. Бэкфилл
 * даёт каждой ровно две строки — машину из назначения и `unknown` вместо машиниста (§6 п. 4), — и
 * состояние `ready`, потому что изменяемых дней у прошедшего срока нет.
 *
 * Одинаковые они намеренно: различать заявки будет ТОЛЬКО человеческий след, который ляжет на них
 * следующим шагом. Всё остальное у них совпадает, и предикату не за что зацепиться, кроме него.
 */
async function buildScene(): Promise<void> {
  const obj = await one<{ id: string }>('SELECT id FROM construction_objects LIMIT 1');
  const vehicle = await one<{ id: string; vehicle_type_id: string }>(
    "SELECT id, vehicle_type_id FROM vehicles WHERE ownership = 'own' AND deleted_at IS NULL ORDER BY id LIMIT 1",
  );
  const user = await one<{ id: string; full_name: string }>(
    `INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
     VALUES ($1, 'Откатов', 'Обр', 'x', 'admin', false) RETURNING id, full_name`,
    [`ap-rollback-${RUN}@example.invalid`],
  );
  const driver = await one<{ id: string }>(
    "INSERT INTO persons (last_name, first_name) VALUES ('Машинистов', 'Обр') RETURNING id",
  );
  ctx.userId = user.id;
  ctx.userName = user.full_name;
  ctx.driverId = driver.id;

  for (const key of CASES) {
    const request = await one<{ id: string; num: number }>(
      `INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
       VALUES ('special_equipment', $1, $2, 'confirmed', $3) RETURNING id, num`,
      [obj.id, vehicle.vehicle_type_id, user.id],
    );
    await ctx.client.query(
      'INSERT INTO special_equipment_request_details (request_id, date_from, date_to) VALUES ($1, $2, $3)',
      [request.id, WEEK_PREV, sunday(WEEK_PREV)],
    );
    await ctx.client.query(
      `INSERT INTO vehicle_request_assignments
         (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
       VALUES ($1, $2, $3, $3, $4)`,
      [request.id, vehicle.id, vehicle.vehicle_type_id, user.id],
    );
    ctx.id[key] = request.id;
    ctx.num[key] = request.num;
  }
}

/** Операция журнала коррекций — та самая запись, которую оставляют двери истории (Р32). */
async function insertOperation(kind: 'crew' | 'assignment_tail', requestId: string) {
  const correction = await one<{ id: string }>(
    `INSERT INTO waybill_corrections (operation_id, fingerprint, kind, reason, actor_user_id,
                                      authorization_scope)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, '{"test": true}'::jsonb) RETURNING id`,
    [`fp-${kind}-${RUN}`, kind, `проверка отката: операция ${kind}`, ctx.userId],
  );
  await ctx.client.query(
    'INSERT INTO vehicle_request_corrections (correction_id, request_id) VALUES ($1, $2)',
    [correction.id, requestId],
  );
  return correction.id;
}

/**
 * Человеческие следы — по одному виду на заявку. `clean` и `race` не получают ничего: первая
 * обязана откатиться, вторая получит своё решение прямо во время прогона.
 */
async function addHumanTraces(): Promise<void> {
  // Д3, главный случай: отмена записана НА САМОЙ backfill-строке, потомка у неё нет.
  await ctx.client.query(
    `UPDATE vehicle_request_assignment_changes
        SET superseded_at = now(), superseded_by_user = $2, superseded_kind = 'cancelled'
      WHERE request_id = $1 AND dimension = 'driver'`,
    [ctx.id.cancelled, ctx.userId],
  );

  // Строка, которую вписал человек: из бумаги она не выводится ничем.
  await ctx.client.query(
    `INSERT INTO vehicle_request_assignment_changes
       (request_id, effective_date, dimension, driver_person_id, driver_state, origin, created_by)
     VALUES ($1, $2, 'driver', $3, 'set', 'machinist_change', $4)`,
    [ctx.id.humanRow, shiftDateKey(WEEK_PREV, 2), ctx.driverId, ctx.userId],
  );

  // Операция `crew` со своей строкой — обычная смена машиниста задним числом.
  const crew = await insertOperation('crew', ctx.id.crewOp);
  await ctx.client.query(
    `INSERT INTO vehicle_request_assignment_changes
       (request_id, effective_date, dimension, driver_person_id, driver_state, origin, created_by,
        correction_id)
     VALUES ($1, $2, 'driver', $3, 'set', 'machinist_change', $4, $5)`,
    [ctx.id.crewOp, shiftDateKey(WEEK_PREV, 3), ctx.driverId, ctx.userId, crew],
  );

  // Решение хвоста БЕЗ строк (Р31, `tail_decision`): в истории не появляется ничего, и увидеть
  // такое решение можно только со стороны журнала коррекций.
  await insertOperation('assignment_tail', ctx.id.tailOnly);
}

// ── Запуск прогонов ──

interface RunResult {
  status: number;
  stdout: string;
}

function scriptEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_MAINTENANCE_URL: ctx.ownUrl,
    // Прикладной URL прогону не нужен и не должен подставляться (П7): пусть его тут не будет.
    DATABASE_URL: undefined,
    DATABASE_MIGRATION_URL: undefined,
  };
}

function runScript(script: string, args: readonly string[]): RunResult {
  const result = spawnSync(TSX, [script, ...args], {
    cwd: API_DIR,
    encoding: 'utf8',
    timeout: 180_000,
    env: scriptEnv(),
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: `${result.stdout}${result.stderr}` };
}

function runRollback(args: readonly string[]): RunResult {
  return runScript(ROLLBACK, args);
}

/** Тот же прогон, но не блокируя тест: он нужен живым, пока соседнее соединение держит строку. */
function startRollback(args: readonly string[]): Promise<RunResult> {
  const child = spawn(TSX, [ROLLBACK, ...args], { cwd: API_DIR, env: scriptEnv() });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  return new Promise((resolveRun, rejectRun) => {
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ status: code ?? -1, stdout: out }));
  });
}

/**
 * Режим модуля правится прямо в управляющей строке: дверь `setModuleMode` тут не нужна — сцене
 * важно состояние, а не путь к нему, и guard-триггер в тестовом кластере дремлет (роли
 * `technic_maintenance` в нём нет). Включение чтения из истории требует поколения сверки
 * (`assignment_periods_control_cutover_check`), поэтому его заводим тут же.
 */
async function setMode(writeMode: string, readMode: 'legacy' | 'history'): Promise<void> {
  if (readMode === 'history') {
    const run = await one<{ run_id: string }>(
      `INSERT INTO assignment_shadow_runs (status, as_of, algo_version, build_version,
                                           expected_checks, finished_at)
       VALUES ('completed', $1, '1', 'test', 0, now()) RETURNING run_id`,
      [TODAY],
    );
    await ctx.client.query(
      'UPDATE assignment_periods_control SET write_mode = $1, read_mode = $2, cutover_run_id = $3',
      [writeMode, readMode, run.run_id],
    );
    return;
  }
  await ctx.client.query('UPDATE assignment_periods_control SET write_mode = $1, read_mode = $2', [
    writeMode,
    readMode,
  ]);
}

/** Состояние готовности и число строк истории — по каждой заявке сцены. */
async function statesOf(): Promise<Record<string, { state: string; rows: number }>> {
  const { rows } = await ctx.client.query<{ num: number; state: string; rows: number }>(`
    SELECT r.num, r.assignment_history_state AS state, count(c.id)::int AS rows
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

/** Кусок отчёта про одну заявку: её строка и все строки объяснения под ней. */
function reportBlock(text: string, num: number): string {
  const lines = text.split('\n');
  // Номер сравнивается целиком: `ТС-12` не должен находиться в строке заявки `ТС-123`.
  const head = new RegExp(`^\\s*ТС-${num}(?!\\d)`, 'u');
  const start = lines.findIndex((line) => head.test(line));
  if (start < 0) return '';
  const block = [lines[start]!];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.startsWith('      ')) break;
    block.push(line);
  }
  return block.join('\n');
}

// ── Проверки ──

describe('предпосылки прогона', () => {
  it('без заморозки модуля не работает вовсе (Е4)', async () => {
    if (!DB_URL) return;
    const run = runRollback(['--progress=0']);
    expect(run.status).toBe(EXIT_NOT_FROZEN);
    expect(run.stdout).toContain('модуль периодов назначения не заморожен');
    expect(run.stdout).toContain('write_mode = normal');
    // И ни одной строки при этом не тронуто: прогон не начинался.
    const states = await statesOf();
    expect(states.clean).toEqual({ state: 'ready', rows: 2 });
  }, 120_000);

  it('не удаляет историю, из которой уже читает портал', async () => {
    if (!DB_URL) return;
    await setMode('history_frozen', 'history');
    const run = runRollback(['--progress=0']);
    expect(run.status).toBe(EXIT_NOT_FROZEN);
    expect(run.stdout).toContain('read_mode = history');
    await setMode('history_frozen', 'legacy');
  }, 120_000);

  it('неизвестный флаг — отказ, а не молчаливый прогон по всей базе', async () => {
    if (!DB_URL) return;
    const run = runRollback(['--aply']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stdout).toContain('Неизвестный флаг --aply');
  }, 60_000);

  it('без своего URL прогон не идёт вовсе (П7)', async () => {
    if (!DB_URL) return;
    const result = spawnSync(TSX, [ROLLBACK], {
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
  }, 60_000);
});

describe('dry-run', () => {
  it('считает и показывает отчёт, не удаляя ни строки', async () => {
    if (!DB_URL) return;
    const before = await statesOf();
    const run = runRollback(['--progress=0']);

    expect(run.status).toBe(EXIT_HELD);
    expect(run.stdout).toContain('dry-run (ничего не удаляется)');
    // Две чистые заявки (`clean` и `race`) и четыре удержанные.
    expect(run.stdout).toMatch(/обработано заявок\s+6/u);
    expect(run.stdout).toMatch(/удержано предикатом\s+4/u);
    // Таблица популяции считает тот же предикат — и в прямом виде, и под отрицанием. Проверка не
    // лишняя: `NOT` связывает в SQL сильнее `AND`, и предикат без скобок дал бы здесь тихо
    // неверное число, не соврав ни в одном другом месте отчёта.
    expect(run.stdout).toMatch(/из них обратимых\s+2\s+2/u);
    expect(run.stdout).toMatch(/из них удержанных\s+4\s+4/u);

    // Главное свойство режима проверяется базой, а не отчётом.
    expect(await statesOf()).toEqual(before);
  }, 120_000);
});

describe('удаление под заморозкой', () => {
  /**
   * Один прогон — и в нём же настоящая гонка. Порядок держит PostgreSQL, а не таймеры:
   *
   *   B: BEGIN; SELECT … FOR UPDATE (заявка `race`); UPDATE … отмена строки; ← НЕ коммитит
   *   прогон: стартует, отбирает страницу (видит `race` обратимой), доходит до неё и ВСТАЁТ
   *   наблюдатель: дождался ожидания на `Lock` в pg_stat_activity → B: COMMIT
   *   прогон: получил блокировку, ПОВТОРНО проверил предикат, увидел отмену → отчёт
   */
  it('откатывает чистую заявку, удерживает все следы человека и ловит гонку', async () => {
    if (!DB_URL) return;
    const report = join(ctx.workDir, 'apply.txt');

    const racer = new pg.Client({ connectionString: ctx.ownUrl });
    await racer.connect();
    let sawLockWait = false;
    let running: Promise<RunResult> | null = null;
    try {
      // 1. Человек берёт строку заявки той же блокировкой, что и двери истории, и отменяет
      //    восстановленную бэкфиллом строку. Транзакция остаётся открытой.
      await racer.query('BEGIN');
      await racer.query('SELECT id FROM vehicle_requests WHERE id = $1 FOR UPDATE', [ctx.id.race]);
      await racer.query(
        `UPDATE vehicle_request_assignment_changes
            SET superseded_at = now(), superseded_by_user = $2, superseded_kind = 'cancelled'
          WHERE request_id = $1 AND dimension = 'driver'`,
        [ctx.id.race, ctx.userId],
      );

      // 2. Прогон стартует ПОСЛЕ этого: его выборка идёт своим снимком и незакоммиченного не
      //    видит — заявка `race` попадает в работу как обратимая.
      running = startRollback(['--apply', '--progress=0', `--report=${report}`]);

      // 3. Ждём, пока прогон действительно упрётся в блокировку. Это и есть доказательство
      //    гонки: не встань он на замке, отмена легла бы либо до отбора, либо после удаления.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const { rows } = await ctx.client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`,
        );
        if ((rows[0]?.n ?? 0) > 0) {
          sawLockWait = true;
          break;
        }
        await new Promise((wait) => setTimeout(wait, 100));
      }
      expect(sawLockWait).toBe(true);

      // 4. Решение человека становится видимым — ровно между отбором и удалением.
      await racer.query('COMMIT');

      const run = await running;
      expect(run.status).toBe(EXIT_HELD);

      const text = readFileSync(report, 'utf8');

      // Чистая заявка откатилась; все следы человека — на месте, вместе со своими строками.
      expect(await statesOf()).toEqual({
        clean: { state: 'empty', rows: 0 },
        cancelled: { state: 'ready', rows: 2 },
        humanRow: { state: 'ready', rows: 3 },
        crewOp: { state: 'ready', rows: 3 },
        // Заявка, у которой в истории нет ни одного человеческого следа: удержала её ОДНА
        // только связь с операцией `assignment_tail` (Р31, безстрочное решение хвоста).
        tailOnly: { state: 'ready', rows: 2 },
        race: { state: 'ready', rows: 2 },
      });

      // Гонка названа гонкой и стоит в отчёте первой строкой удержанных.
      const raceBlock = reportBlock(text, ctx.num.race);
      expect(raceBlock).toContain('решение легло между отбором и удалением (гонка)');
      expect(raceBlock).toContain('отменил');
      expect(raceBlock).toContain(ctx.userName);
      expect(run.stdout).toMatch(/из них повторной проверкой\s+1/u);

      // Отчёт называет по каждой удержанной заявке, что именно её удержало.
      expect(reportBlock(text, ctx.num.cancelled)).toContain(`отменил(а) ${ctx.userName}`);
      expect(reportBlock(text, ctx.num.humanRow)).toContain(`вписал(а) ${ctx.userName}`);
      expect(reportBlock(text, ctx.num.crewOp)).toContain('операция «crew»');
      expect(reportBlock(text, ctx.num.tailOnly)).toContain('операция «assignment_tail»');
      // …и не приписывает безстрочному решению хвоста ничего сверх того, что есть.
      expect(reportBlock(text, ctx.num.tailOnly)).not.toContain('вписал(а)');

      expect(text).toMatch(/откачено в empty\s+1/u);
      expect(text).toMatch(/строк истории удалено\s+2/u);
      expect(text).toMatch(/удержано предикатом\s+5/u);
    } finally {
      // Упавшая проверка не должна оставить ни открытую транзакцию, ни живой процесс прогона:
      // база сносится в `afterAll`, и брошенное соединение помешало бы её удалить.
      await racer.query('ROLLBACK').catch(() => undefined);
      await racer.end();
      await running?.catch(() => undefined);
    }
  }, 180_000);

  it('повторный прогон не находит работы: откатывать больше нечего', async () => {
    if (!DB_URL) return;
    const before = await statesOf();
    const run = runRollback(['--apply', '--progress=0']);
    expect(run.status).toBe(EXIT_HELD);
    expect(run.stdout).toMatch(/обработано заявок\s+5/u);
    expect(run.stdout).toMatch(/удержано предикатом\s+5/u);
    // Теперь и `race` удержана уже на отборе: её решение давно закоммичено, гонки больше нет.
    expect(run.stdout).toMatch(/из них повторной проверкой\s+0/u);
    expect(await statesOf()).toEqual(before);
  }, 120_000);

  it('снятая человеком отмена возвращает заявку в обратимые', async () => {
    if (!DB_URL) return;
    // Единственный способ вернуть заявку в откат — убрать сам человеческий след. Проверка не
    // про сценарий (руками так не делают), а про то, что предикат считает состояние, а не
    // помнит прошлое: заявка, которую он держал, откатывается, как только держать нечего.
    await ctx.client.query(
      `UPDATE vehicle_request_assignment_changes
          SET superseded_at = NULL, superseded_by_user = NULL, superseded_kind = NULL
        WHERE request_id = $1`,
      [ctx.id.race],
    );
    const run = runRollback(['--apply', '--progress=0']);
    expect(run.status).toBe(EXIT_HELD);
    const states = await statesOf();
    expect(states.race).toEqual({ state: 'empty', rows: 0 });
    expect(states.cancelled).toEqual({ state: 'ready', rows: 2 });
  }, 120_000);
});

describe('возобновление', () => {
  it('прерванный прогон продолжается с места обрыва', async () => {
    if (!DB_URL) return;
    const statePath = join(ctx.workDir, 'resume.json');
    const first = runRollback(['--apply', '--progress=0', `--state=${statePath}`, '--limit=2']);
    expect(first.stdout).toMatch(/обработано заявок\s+2/u);
    expect(first.stdout).toContain('остановлен пределом --limit');

    const second = runRollback(['--apply', '--progress=0', `--state=${statePath}`]);
    expect(second.stdout).toContain('продолжение с');
    expect(second.stdout).toMatch(/обработано заявок\s+4/u);

    const third = runRollback(['--apply', '--progress=0', `--state=${statePath}`]);
    expect(third.stdout).toContain('работы нет');
  }, 180_000);

  it('не продолжает удаление файлом состояния от dry-run', async () => {
    if (!DB_URL) return;
    const statePath = join(ctx.workDir, 'mode.json');
    runRollback(['--progress=0', `--state=${statePath}`, '--limit=1']);
    const again = runRollback(['--apply', '--progress=0', `--state=${statePath}`]);
    expect(again.status).toBe(1);
    expect(again.stdout).toContain('принадлежит прогону «dry-run»');
  }, 120_000);
});
