import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import * as schema from '../src/db/schema';
import { ASSIGNMENT_HISTORY_ALGO_VERSION, setModuleMode } from '../src/services/assignment-mode';
import type { CutoverObstacleKind } from '../src/services/assignment-readiness';

/**
 * Сводка готовности модуля истории назначения — целиком, как её запускает человек
 * ([scripts/assignment-report.ts](../scripts/assignment-report.ts); план
 * `docs/assignment-periods-plan.md`, этап 4, волна 4.2; Р20, Р26–Р28, М1).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ — три обещания сводки, и каждое из них такое, что нарушение молчит:
 *
 * 1. **вердикт называет препятствия поимённо.** «Не готов» без перечня — это то же, что не
 *    запускать команду вовсе: человек всё равно пойдёт собирать числа глазами по четырём местам.
 *    Проверяется не текст, а машинный ответ `--json`: виды препятствий, числа и номера заявок;
 * 2. **зелёный вердикт означает, что дверь пропустит.** Ложный зелёный дороже задержки (риск §11
 *    п. 17): сводка, сказавшая «можно», а следом отказ двери в окне выката — это потерянное окно.
 *    Проверяется тем, что после зелёного вердикта `setModuleMode` действительно переключает
 *    чтение, и тем, что поднятая метка загрязнения красит **и** сводку, и дверь;
 * 3. **два яруса разведены.** `--data` отвечает про готовность истории и не требует ни поколения,
 *    ни аттестации, ни заморозки: вопрос «сколько ещё чинить» задают в любой день, и красный
 *    ответ на него в обычный вторник обесценил бы команду.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Правил восстановления истории: состояние заявки — поддерживаемый инвариант
 * (Р26), а не результат прогона, и сводка читает **колонку**. Как колонка получила своё значение,
 * проверяют `assignment-ensure`, `assignment-repair` и прогон бэкфилла — своими файлами. Поэтому
 * сцена ставит состояния прямо: иначе тест сводки проверял бы бэкфилл.
 *
 * ФАЙЛ ЗАВОДИТ СОБСТВЕННУЮ БАЗУ И СНОСИТ ЕЁ ЗА СОБОЙ. Иначе никак: сводка считает по **всей**
 * базе, и на общей `TEST_DATABASE_URL` в её числа попали бы заявки соседних файлов — а половина
 * проверок здесь про точные числа. Плюс она меняет режим модуля, то есть закрывает двери всем
 * соседям сразу.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/assignment-report.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = Date.now().toString(36).slice(-6);
const TODAY = moscowDateKeyOf(new Date());
const BUILD = `report-build-${RUN}`;

const SCRIPT = resolve(fileURLToPath(new URL('../scripts/assignment-report.ts', import.meta.url)));
const TSX = resolve(fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)));
const API_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Коды возврата сводки — те же, что описаны в её шапке. */
const EXIT_READY = 0;
const EXIT_BLOCKING = 3;

type Case = 'ready' | 'materialized' | 'emptyWithVehicle' | 'emptyNoVehicle';

interface Ctx {
  client: pg.Client;
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: pg.Pool;
  ownUrl: string;
  userId: string;
  num: Record<Case, number>;
  id: Record<Case, string>;
}

let ctx: Ctx;
/** Имя базы держится вне `ctx`: снести её надо и тогда, когда сцена не собралась. */
let created: { dbName: string; adminUrl: string } | null = null;

beforeAll(async () => {
  if (!DB_URL) return;
  const base = new URL(DB_URL);
  const dbName = `${base.pathname.slice(1)}_rep_${RUN}`.slice(0, 63);
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

  const pool = new pg.Pool({ connectionString: own.toString(), max: 2 });
  ctx = {
    client,
    pool,
    db: drizzle(pool, { schema, casing: 'snake_case' }),
    ownUrl: own.toString(),
    userId: '',
    num: {} as Record<Case, number>,
    id: {} as Record<Case, string>,
  };
  await buildScene();
}, 180_000);

afterAll(async () => {
  if (ctx) {
    await ctx.client.end();
    await ctx.pool.end();
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
 * Четыре заявки популяции Р20 — по одной на каждое препятствие яруса данных, плюс одна готовая.
 *
 * Пятая заявка — грузоперевозка: она в предикат не входит, и её присутствие доказывает, что
 * популяция считается предикатом, а не «всеми заявками в работе».
 */
async function buildScene(): Promise<void> {
  const obj = await one<{ id: string }>('SELECT id FROM construction_objects LIMIT 1');
  const vehicle = await one<{ id: string; vehicle_type_id: string }>(
    "SELECT id, vehicle_type_id FROM vehicles WHERE ownership = 'own' AND deleted_at IS NULL ORDER BY id LIMIT 1",
  );
  const user = await one<{ id: string }>(
    `INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
     VALUES ($1, 'Сводкин', 'Пров', 'x', 'admin', false) RETURNING id`,
    [`ap-report-${RUN}@example.invalid`],
  );
  ctx.userId = user.id;

  const makeRequest = async (
    key: Case,
    spec: { state: string; validatedOn: string | null; withVehicle: boolean },
  ): Promise<void> => {
    const request = await one<{ id: string; num: number }>(
      `INSERT INTO vehicle_requests
         (request_type, object_id, vehicle_type_id, status, created_by,
          assignment_history_state, assignment_history_validated_on)
       VALUES ('special_equipment', $1, $2, 'confirmed', $3, $4, $5) RETURNING id, num`,
      [obj.id, vehicle.vehicle_type_id, user.id, spec.state, spec.validatedOn],
    );
    await ctx.client.query(
      'INSERT INTO special_equipment_request_details (request_id, date_from, date_to) VALUES ($1, $2, $3)',
      [request.id, shiftDateKey(TODAY, -14), shiftDateKey(TODAY, -7)],
    );
    if (spec.withVehicle) {
      await ctx.client.query(
        `INSERT INTO vehicle_request_assignments
           (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
         VALUES ($1, $2, $3, $3, $4)`,
        [request.id, vehicle.id, vehicle.vehicle_type_id, user.id],
      );
    }
    ctx.id[key] = request.id;
    ctx.num[key] = request.num;
  };

  await makeRequest('ready', { state: 'ready', validatedOn: TODAY, withVehicle: true });
  await makeRequest('materialized', {
    state: 'materialized',
    validatedOn: TODAY,
    withVehicle: true,
  });
  await makeRequest('emptyWithVehicle', { state: 'empty', validatedOn: null, withVehicle: true });
  await makeRequest('emptyNoVehicle', { state: 'empty', validatedOn: null, withVehicle: false });

  // Грузоперевозка в работе: в предикат Р20 не входит вовсе — считается только спецтехника.
  const freight = await one<{ id: string }>(
    `INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
     VALUES ('freight_transport', $1, $2, 'confirmed', $3) RETURNING id`,
    [obj.id, vehicle.vehicle_type_id, user.id],
  );
  await ctx.client.query(
    'INSERT INTO freight_transport_request_details (request_id, scheduled_at) VALUES ($1, now())',
    [freight.id],
  );
}

// ── Запуск команды ──

interface ReportJson {
  asOf: string;
  population: {
    total: number;
    empty: number;
    materialized: number;
    ready: number;
    emptyWithoutAssignment: number;
    dirty: number;
    stale: number;
  };
  mode: { writeMode: string; readMode: string } | null;
  dataReady: boolean;
  switchable: boolean;
  ready: boolean;
  obstacles: {
    kind: CutoverObstacleKind;
    tier: 'data' | 'window';
    count: number;
    samples: string[];
  }[];
}

function run(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: 'utf8',
    // Прикладного `DATABASE_URL` команде не даётся намеренно: административный путь ходит своими
    // кредами (П7), и молчаливого отката на прикладные у него нет.
    env: { ...process.env, DATABASE_URL: '', DATABASE_MAINTENANCE_URL: ctx.ownUrl },
    timeout: 120_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runJson(args: readonly string[] = []): { status: number; json: ReportJson } {
  const out = run(['--json', ...args]);
  if (!out.stdout.trim()) throw new Error(`сводка ничего не напечатала: ${out.stderr}`);
  return { status: out.status, json: JSON.parse(out.stdout) as ReportJson };
}

function kinds(json: ReportJson, tier?: 'data' | 'window'): CutoverObstacleKind[] {
  return json.obstacles.filter((o) => !tier || o.tier === tier).map((o) => o.kind);
}

/** Довести все заявки популяции до `ready` — «данные готовы» без прогона бэкфилла. */
async function makeEverythingReady(): Promise<void> {
  await ctx.client.query(
    `UPDATE vehicle_requests
        SET assignment_history_state = 'ready',
            assignment_history_validated_on = $1,
            assignment_history_dirty = false
      WHERE request_type = 'special_equipment'`,
    [TODAY],
  );
}

/** Поколение, которое дверь примет: сегодняшний день, полный manifest, ноль расхождений. */
async function seedRun(): Promise<string> {
  const run_ = await one<{ run_id: string }>(
    `INSERT INTO assignment_shadow_runs
       (status, as_of, algo_version, build_version, expected_checks, finished_at)
     VALUES ('completed', $1, $2, $3, 2, now()) RETURNING run_id`,
    [TODAY, ASSIGNMENT_HISTORY_ALGO_VERSION, BUILD],
  );
  for (let i = 0; i < 2; i += 1) {
    await ctx.client.query(
      `INSERT INTO assignment_shadow_checks
         (run_id, request_id, scope_fingerprint, status, evaluation_fingerprint, checked_at)
       VALUES ($1, gen_random_uuid(), $2, 'match', $3, now())`,
      [run_.run_id, `scope-${i}`, `ev-${i}`],
    );
  }
  return run_.run_id;
}

async function seedAttestation(): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO assignment_deploy_attestations
       (active_build_shas, algo_version, legacy_client_calls)
     VALUES (ARRAY[$1]::text[], $2, 0) RETURNING id`,
    [BUILD, ASSIGNMENT_HISTORY_ALGO_VERSION],
  );
  return row.id;
}

async function forceWriteMode(mode: string): Promise<void> {
  await ctx.client.query('UPDATE assignment_periods_control SET write_mode = $1 WHERE id = true', [
    mode,
  ]);
}

// ── Проверки ──

describe.skipIf(!DB_URL)('сводка готовности: препятствия названы поимённо', () => {
  it('неготовые заявки разложены по видам, с числами и номерами', () => {
    const { status, json } = runJson();

    expect(status).toBe(EXIT_BLOCKING);
    expect(json.asOf).toBe(TODAY);
    // Популяция — предикат Р20, а не «все заявки в работе»: грузоперевозка в счёт не идёт.
    expect(json.population.total).toBe(4);
    expect(json.population).toMatchObject({
      ready: 1,
      materialized: 1,
      empty: 2,
      emptyWithoutAssignment: 1,
      dirty: 0,
      stale: 0,
    });

    // Каждое препятствие — своё: заявка без машины отделена от заявки, до которой не дошёл
    // прогон, потому что чинят их разные люди.
    expect(kinds(json, 'data').sort()).toEqual(
      ['history_empty', 'history_empty_without_assignment', 'history_materialized'].sort(),
    );
    const empty = json.obstacles.find((o) => o.kind === 'history_empty');
    expect(empty?.count).toBe(1);
    expect(empty?.samples).toEqual([`ТС-${ctx.num.emptyWithVehicle}`]);
    const noVehicle = json.obstacles.find((o) => o.kind === 'history_empty_without_assignment');
    expect(noVehicle?.samples).toEqual([`ТС-${ctx.num.emptyNoVehicle}`]);
    expect(json.obstacles.find((o) => o.kind === 'history_materialized')?.samples).toEqual([
      `ТС-${ctx.num.materialized}`,
    ]);

    expect(json.dataReady).toBe(false);
    expect(json.switchable).toBe(false);
  });

  it('человеку то же самое словами: вердикт, число и куда идти', () => {
    const out = run([]);

    expect(out.status).toBe(EXIT_BLOCKING);
    expect(out.stdout).toContain('данные                  : НЕ ГОТОВЫ');
    expect(out.stdout).toContain('переключение            : НЕЛЬЗЯ СЕЙЧАС');
    expect(out.stdout).toContain('ЧТО МЕШАЕТ');
    // Адрес починки — часть отказа: без него человек ищет дверь и находит не ту.
    expect(out.stdout).toContain('assignment:backfill --apply');
    expect(out.stdout).toContain(`ТС-${ctx.num.emptyNoVehicle}`);
  });

  it('ярус данных спрашивается отдельно: окно выката ему не нужно', () => {
    const { json } = runJson(['--data']);

    // В `--data` не попадает ни одного препятствия окна — иначе вопрос «сколько ещё чинить» был
    // бы красным в любой обычный день, и его перестали бы задавать.
    expect(kinds(json, 'window')).toEqual([]);
    expect(json.obstacles.every((o) => o.tier === 'data')).toBe(true);
  });
});

describe.skipIf(!DB_URL)('сводка готовности: зелёный вердикт означает, что дверь пропустит', () => {
  it('готовые данные + поколение + аттестация + заморозка → «можно», и дверь переключает', async () => {
    await makeEverythingReady();
    const runId = await seedRun();
    const attestationId = await seedAttestation();

    // Ещё не заморожено: данные готовы, окно закрыто — ровно то различие, ради которого ярусов два.
    const beforeFreeze = runJson();
    expect(beforeFreeze.json.dataReady).toBe(true);
    expect(beforeFreeze.json.switchable).toBe(false);
    expect(kinds(beforeFreeze.json, 'window')).toContain('write_not_frozen');
    expect(runJson(['--data']).status).toBe(EXIT_READY);

    await forceWriteMode('all_frozen');

    const green = runJson([`--build=${BUILD}`]);
    expect(green.json.obstacles).toEqual([]);
    expect(green.json.switchable).toBe(true);
    expect(green.status).toBe(EXIT_READY);

    // И то же самое дверью: сводка, сказавшая «можно», обязана совпасть с той, кто разрешает.
    const record = await setModuleMode(
      {
        targetWriteMode: 'all_frozen',
        targetReadMode: 'history',
        actorUserId: ctx.userId,
        reason: 'проверка согласия сводки и двери',
        buildSha: BUILD,
        runId,
        attestationId,
      },
      ctx.db,
    );
    expect(record.to.readMode).toBe('history');

    // После переключения сводка отвечает про сегодняшний режим, а не зовёт переключать снова.
    const after = runJson();
    expect(after.json.mode?.readMode).toBe('history');
    expect(after.status).toBe(EXIT_READY);
  }, 120_000);

  it('метка загрязнения красит и сводку, и дверь — одним и тем же числом', async () => {
    // Возврат к legacy той же дверью: сцена следующего случая начинается с рабочего состояния.
    await setModuleMode(
      {
        targetWriteMode: 'all_frozen',
        targetReadMode: 'legacy',
        actorUserId: ctx.userId,
        reason: 'возврат перед проверкой метки загрязнения',
        buildSha: BUILD,
      },
      ctx.db,
    );
    await ctx.client.query(
      'UPDATE vehicle_requests SET assignment_history_dirty = true WHERE id = $1',
      [ctx.id.ready],
    );

    const { json } = runJson();
    expect(json.population.dirty).toBe(1);
    expect(kinds(json, 'data')).toContain('history_dirty');
    expect(json.dataReady).toBe(false);

    // Дверь считает ту же метку и отказывает тем же числом — сводка не выдумывает своей проверки.
    const refusal = await setModuleMode(
      {
        targetWriteMode: 'all_frozen',
        targetReadMode: 'history',
        actorUserId: ctx.userId,
        reason: 'должна отказать: метка загрязнения',
        buildSha: BUILD,
        runId: await seedRun(),
        attestationId: await seedAttestation(),
      },
      ctx.db,
    ).catch((e: unknown) => e as Error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toMatch(/у 1 заявок поднята метка загрязнения/u);

    await ctx.client.query(
      'UPDATE vehicle_requests SET assignment_history_dirty = false WHERE id = $1',
      [ctx.id.ready],
    );
  }, 120_000);
});
