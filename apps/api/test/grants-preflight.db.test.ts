import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_ASSIGNED_GRANTS } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type * as PreflightModule from '../src/check-grants-preflight';

/**
 * Preflight перед этапом 1б фичи «полномочия назначаются в окне учётки»
 * (`src/check-grants-preflight.ts`, план §7.1) — на живой схеме.
 *
 * **Зачем база.** Предмет скрипта и есть база: обе выборки — это соединение трёх таблиц с
 * группировкой, и всё, ради чего preflight написан, живёт в их условиях. Мягко удалённый набор,
 * выпадающий из списка держателей; архивная учётка, которая из него, наоборот, не выпадает; две
 * архивные строки с одинаковым адресом, законные только потому, что `users_email_unique`
 * частичный, — ни одно из этих свойств на подменах не существует, а промах в любом из них меняет
 * вердикт перед выкатом.
 *
 * **Почему транзакция с откатом, а не уборка за собой.** Вердикт скрипта — про всю базу, области у
 * него нет, а база у db-тестов общая и файлы vitest гоняет параллельно. Проверка «предел превышен»
 * требует учётки с `MAX_ASSIGNED_GRANTS + 1` назначением, то есть состояния, в котором вердикт
 * базы — отказ; закоммить мы его, и соседний файл, спросивший в те же секунды тот же вердикт,
 * увидел бы чужой отказ. Внутри незакоммиченной транзакции этих строк не видит никто, кроме нас,
 * а после отката их нет и у нас. Читает скрипт через параметр `Reader` — тем же кодом, что в
 * проде, только транзакцией вместо пула.
 *
 * **Что здесь не утверждается.** «Держателей ровно N» и «максимум ровно M» — утверждения про чужие
 * строки: соседний файл заводит свои назначения когда угодно. Проверяется своё: наши учётки в
 * списке, наши коды при них, наш признак архива — и вердикт, который наши же данные определяют
 * однозначно (33 назначения делают отказ отказом при любом содержимом базы).
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/grants-preflight.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: коды наборов уникальны глобально и навсегда — освободить их нельзя. */
const RUN = randomUUID().slice(0, 8);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  preflight: typeof PreflightModule;
}

let ctx: Ctx;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
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

/** Единственный способ выйти из транзакции теста: исход проверок от него не зависит. */
class Rollback extends Error {}

type Tx = Parameters<Parameters<typeof AppDb.transaction>[0]>[0];

/** Сценарий в откатываемой транзакции: строки видит только он сам и только пока идёт. */
async function inRollback<T>(scenario: (tx: Tx) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await ctx.db.transaction(async (tx) => {
      result = await scenario(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return result as T;
}

interface UserSeed {
  email: string;
  lastName: string;
  role?: DbSchema.UserRow['role'];
  archived?: boolean;
}

async function makeUser(tx: Tx, seed: UserSeed): Promise<string> {
  const [row] = await tx
    .insert(ctx.schema.users)
    .values({
      email: seed.email,
      lastName: seed.lastName,
      firstName: 'Зонд',
      // Входа в этом файле нет: проверяются выборки, а не аутентификация.
      passwordHash: 'db-test-not-a-hash',
      role: seed.role ?? null,
      isActive: false,
      deletedAt: seed.archived ? new Date() : null,
    })
    .returning({ id: ctx.schema.users.id });
  return row!.id;
}

async function makeGrant(tx: Tx, code: string, deleted = false): Promise<string> {
  const [row] = await tx
    .insert(ctx.schema.grants)
    .values({
      code,
      name: `Зонд ${code}`,
      deletedAt: deleted ? new Date() : null,
    })
    .returning({ id: ctx.schema.grants.id });
  return row!.id;
}

async function assign(tx: Tx, userId: string, grantIds: string[]): Promise<void> {
  await tx.insert(ctx.schema.userGrants).values(grantIds.map((grantId) => ({ userId, grantId })));
}

describe.skipIf(!DB_URL)('preflight полномочий перед этапом 1б (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const preflight = await import('../src/check-grants-preflight');
    ctx = { db, closeDb, schema, preflight };
  }, 180_000);

  afterAll(async () => {
    await ctx?.closeDb();
  });

  /**
   * Первая выборка (§7.1): держатели живых назначений — строка на учётку, с кодами наборов, ролью
   * и признаком архива. Четыре свойства проверяются разом, и каждое из них — отдельное решение
   * плана:
   *
   *   1. держатель нескольких наборов даёт **одну** строку, а не по строке на набор;
   *   2. архивная учётка из списка не выпадает: восстановление вернёт её назначения в действие;
   *   3. две архивные учётки с одинаковым адресом различаются только `id` — ради этого он и
   *      печатается (`users_email_unique` частичный, ADR 0063);
   *   4. держатель одного лишь мягко удалённого набора держателем не считается: прав по нему нет,
   *      и форма его не показывает.
   */
  it('держатели живых назначений: одна строка на учётку, архив виден, удалённый набор не в счёт', async () => {
    await inRollback(async (tx) => {
      // Коды нарочно в алфавитном порядке «a» → «b»: выборка обязана вернуть их так же независимо
      // от порядка выдачи, поэтому выдаются они в обратном.
      const codeA = `db-preflight-a-${RUN}`;
      const codeB = `db-preflight-b-${RUN}`;
      const grantA = await makeGrant(tx, codeA);
      const grantB = await makeGrant(tx, codeB);
      const grantDead = await makeGrant(tx, `db-preflight-dead-${RUN}`, true);

      const holderId = await makeUser(tx, {
        email: `db-preflight-holder-${RUN}@example.invalid`,
        lastName: 'Держателев',
        role: 'shtab',
      });
      await assign(tx, holderId, [grantB, grantA]);

      // Один адрес на две архивные строки — состояние законное, и различает их только `id`.
      const twinEmail = `db-preflight-twin-${RUN}@example.invalid`;
      const twinFirst = await makeUser(tx, {
        email: twinEmail,
        lastName: 'Архивов',
        role: 'site',
        archived: true,
      });
      const twinSecond = await makeUser(tx, {
        email: twinEmail,
        lastName: 'Архивов',
        role: 'site',
        archived: true,
      });
      await assign(tx, twinFirst, [grantA]);
      await assign(tx, twinSecond, [grantA]);

      const deadOnlyId = await makeUser(tx, {
        email: `db-preflight-dead-${RUN}@example.invalid`,
        lastName: 'Удалённов',
        role: 'shtab',
      });
      await assign(tx, deadOnlyId, [grantDead]);

      const report = await ctx.preflight.collectPreflight(tx);
      const holders = new Map(report.holders.map((holder) => [holder.id, holder]));

      const holder = holders.get(holderId);
      expect(holder, 'держатель двух наборов обязан быть в списке').toBeDefined();
      expect(holder!.codes).toEqual([codeA, codeB]);
      expect(holder!.role).toBe('shtab');
      expect(holder!.archived).toBe(false);
      expect(holder!.fullName).toBe('Держателев Зонд');
      expect(report.holders.filter((row) => row.id === holderId)).toHaveLength(1);

      for (const twinId of [twinFirst, twinSecond]) {
        const twin = holders.get(twinId);
        expect(twin, 'архивная учётка из отбора не выбрасывается').toBeDefined();
        expect(twin!.archived).toBe(true);
        expect(twin!.email).toBe(twinEmail);
      }
      expect(twinFirst).not.toBe(twinSecond);

      expect(
        holders.has(deadOnlyId),
        'держатель одного лишь мягко удалённого набора держателем не считается',
      ).toBe(false);
      // Строка при этом никуда не делась — вторая выборка её видит и объясняет разницу.
      expect(report.staleAssignments).toBeGreaterThanOrEqual(1);
    });
  });

  /**
   * Вторая выборка (§7.1) и вердикт «всё в порядке»: факт ниже предела, отказа нет.
   *
   * Утверждение про максимум здесь одностороннее (`>=`), и это не слабость проверки, а её область:
   * сколько назначений у самой нагруженной учётки базы, решают все файлы разом, а вот «не меньше
   * наших двух» верно при любом их содержимом. Сам вердикт «отказа нет» — про всю базу, и держится
   * он на том, что перегруженную учётку заводит только проверка ниже, внутри откатываемой
   * транзакции: снаружи её не видит никто и никогда.
   */
  it('вердикт «предел годится»: факт ниже MAX_ASSIGNED_GRANTS, отказа нет', async () => {
    await inRollback(async (tx) => {
      const grantA = await makeGrant(tx, `db-preflight-ok-a-${RUN}`);
      const grantB = await makeGrant(tx, `db-preflight-ok-b-${RUN}`);
      const userId = await makeUser(tx, {
        email: `db-preflight-ok-${RUN}@example.invalid`,
        lastName: 'Нагрузкин',
        role: 'shtab',
      });
      await assign(tx, userId, [grantA, grantB]);

      const report = await ctx.preflight.collectPreflight(tx);
      expect(report.limit).toBe(MAX_ASSIGNED_GRANTS);
      expect(report.maxAssigned).toBeGreaterThanOrEqual(2);
      expect(report.maxAssigned).toBeLessThanOrEqual(MAX_ASSIGNED_GRANTS);
      expect(report.limitExceeded).toBe(false);
      expect(report.load.length).toBeGreaterThan(0);

      const lines = capture(() => ctx.preflight.printReport(report));
      expect(lines).toContain('Итог: предел годится');
      expect(lines).not.toContain('ОТКАЗ');
    });
  });

  /**
   * Вердикт «предел превышен»: учётка с `MAX_ASSIGNED_GRANTS + 1` назначением — ровно то
   * состояние, ради которого preflight и стоит перед выкатом. Такую карточку сервер этапа 1б
   * перестанет сохранять вовсе, включая правку телефона, поэтому код возврата обязан быть
   * ненулевым, а отчёт — называть виновника поимённо.
   */
  it('вердикт «предел ниже факта»: перегруженная учётка даёт отказ и стоит первой в топе', async () => {
    await inRollback(async (tx) => {
      const overloadedId = await makeUser(tx, {
        email: `db-preflight-over-${RUN}@example.invalid`,
        lastName: 'Перегрузов',
        role: 'shtab',
      });
      const count = MAX_ASSIGNED_GRANTS + 1;
      const grantIds: string[] = [];
      for (let i = 0; i < count; i += 1) {
        grantIds.push(await makeGrant(tx, `db-preflight-over-${RUN}-${i}`));
      }
      await assign(tx, overloadedId, grantIds);

      const report = await ctx.preflight.collectPreflight(tx);
      expect(report.limitExceeded).toBe(true);
      expect(report.maxAssigned).toBe(count);
      expect(report.load[0]!.id).toBe(overloadedId);
      expect(report.load[0]!.live).toBe(count);
      expect(report.load[0]!.total).toBe(count);
      expect(report.holders.find((holder) => holder.id === overloadedId)!.codes).toHaveLength(
        count,
      );

      const lines = capture(() => ctx.preflight.printReport(report));
      expect(lines).toContain('ОТКАЗ');
      expect(lines).toContain('Перегрузов Зонд');
      expect(lines).toContain(String(count));
    });
  });
});

/** Отчёт скрипта одной строкой: печать перехватывается, чтобы прогон не утонул в полотне. */
function capture(print: () => void): string {
  const lines: string[] = [];
  const sink = (...args: unknown[]): void => void lines.push(args.map(String).join(' '));
  const log = vi.spyOn(console, 'log').mockImplementation(sink);
  const error = vi.spyOn(console, 'error').mockImplementation(sink);
  try {
    print();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return lines.join('\n');
}
