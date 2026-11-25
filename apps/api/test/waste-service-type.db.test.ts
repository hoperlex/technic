import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  containerKindLabels,
  DIRECTORY_DATA_SHEET,
  DIRECTORY_ID_COLUMN,
  type DirectoryImportReportDto,
  type DirectoryKey,
  isValidInn,
  SNOW_COST_AT_COMPLETION_MESSAGE,
  SNOW_WASTE_TYPE_CODE,
  SNOW_WASTE_TYPE_ID,
  SNOW_WASTE_TYPE_NAME,
  type WasteTariffDto,
  type WasteTypeDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values of these modules are loaded with `await import` after the environment is
// set, because the config validates it at import time.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as WasteTypesNs from '../src/services/waste-types';
import type * as EngineNs from '../src/services/directory-transfer/engine';
import type * as XlsxNs from '../src/lib/xlsx';
import type { AnyDirectory } from '../src/services/directory-transfer/types';

/**
 * The reserved service waste type «Снег» at the directory entry points (snow-removal plan, §3.2,
 * §4 «Directory and DB»; migration 0429).
 *
 * WHY A DATABASE. The point of these entry points is to refuse BEFORE the database does, in field
 * words, and to keep the database as the backstop. Both halves are only visible against the real
 * schema: the seeded row, `waste_type_name_key`, and the CHECKs and trigger of migration 0429.
 *
 * ISOLATION. Everything this file creates carries the run suffix `RUN` (codes, names, emails, the
 * operator's name) and `afterAll` removes exactly that. The reserved row is only read.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:55961/technic_test \
 *     pnpm check:db waste-service-type
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
/** Code prefix of this run's waste types: `afterAll` finds its own rows by it. */
const CODE = `wst_${RUN.replace(/[^a-z0-9]/gu, '')}`;
const EMAIL = (tag: string) => `db-waste-service-${tag}-${RUN}@example.invalid`;

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  /** Administrator: directory write, purge, import and export. */
  admin: Auth;
  adminId: string;
  engine: typeof EngineNs;
  xlsx: typeof XlsxNs;
  directoryFor: (key: DirectoryKey) => AnyDirectory | undefined;
  /** This run's operator: tariffs belong to an operator (ADR 0026). */
  operator: { id: string; inn: string };
  /** This run's container type: the exact-type branch of tariff resolution needs one. */
  containerTypeId: string;
  messages: Pick<
    typeof WasteTypesNs,
    'SERVICE_WASTE_TYPE_LOCKED_MESSAGE' | 'RESERVED_WASTE_TYPE_NAME_MESSAGE'
  >;
}

/** The reserved id as an old tab or a hand-written client may spell it. */
const SNOW_ID_UPPER = SNOW_WASTE_TYPE_ID.toUpperCase();

/**
 * Spellings whose database key is the reserved one: case, spaces, «ё», separators and punctuation
 * do not matter to `waste_type_name_key` (migration 0036).
 */
const RESERVED_SPELLINGS = ['Снег', 'снег', '  СНЕГ  ', 'Снёг', 'С-н-е-г', 'снег!', 'С Н Е Г'];

/** Waste types created through the API by this run: their codes come from names, not `CODE`. */
const createdTypeIds: string[] = [];

/** A random INN with a valid checksum: the counterparty CHECK and the exchange both verify it. */
function randomInn(): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  for (;;) {
    const digits = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
    const check = (weights.reduce((sum, w, i) => sum + w * digits[i]!, 0) % 11) % 10;
    const inn = [...digits, check].join('');
    if (isValidInn(inn) && !inn.startsWith('00')) return inn;
  }
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

/** A distinct address per request: the shared rate limiter counts requests per address. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url,
    headers: auth,
    remoteAddress: nextAddress(),
    ...(payload ? { payload } : {}),
  });
}

let typeNo = 0;
/** An ordinary waste type of this run, created by SQL: the form is not what is tested here. */
async function ordinaryType(isActive = true): Promise<{ id: string; code: string; name: string }> {
  typeNo += 1;
  const code = `${CODE}_${typeNo}`;
  const name = `Тестовый мусор ${RUN} ${typeNo}`;
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO waste_types (code, name, is_active) VALUES (${code}, ${name}, ${isActive})
    RETURNING id`);
  return { id: res.rows[0]!.id, code, name };
}

/** Every page of `GET /waste-types` with the given filter. */
async function listTypes(query: string): Promise<WasteTypeDto[]> {
  const res = await inject('GET', `/api/v1/waste-types?pageSize=200&${query}`, ctx.admin);
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json<{ items: WasteTypeDto[]; total: number }>();
  expect(body.total, 'the test reads one page: the directory must fit in it').toBe(
    body.items.length,
  );
  return body.items;
}

describe.skipIf(!DB_URL)('служебный тип «Снег» в справочниках', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const passwordHash = await hashPassword(PASSWORD);
    const admin = await db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${EMAIL('admin')}, 'Тестовый', 'Администратор', 'Снегович', ${passwordHash},
              'admin'::role, true, now())
      RETURNING id`);
    expect(admin.rows).toHaveLength(1);

    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: EMAIL('admin'), password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    expect(login.statusCode, login.body).toBe(200);

    const inn = randomInn();
    const operator = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('operator', ${`Оператор снега ${RUN}`}, ${inn})
      RETURNING id`);

    const container = await db.execute<{ id: string }>(sql`
      INSERT INTO container_types (code, name, type, volume_m3)
      VALUES (${`${CODE}_cont`}, ${`Контейнер снега ${RUN}`}, 'cont', 8)
      RETURNING id`);

    const waste = await import('../src/services/waste-types');
    ctx = {
      app,
      db,
      admin: { authorization: `Bearer ${login.json().accessToken}` },
      adminId: admin.rows[0]!.id,
      engine: await import('../src/services/directory-transfer/engine'),
      xlsx: await import('../src/lib/xlsx'),
      directoryFor: (await import('../src/services/directory-transfer/registry')).directoryFor,
      operator: { id: operator.rows[0]!.id, inn },
      containerTypeId: container.rows[0]!.id,
      messages: {
        SERVICE_WASTE_TYPE_LOCKED_MESSAGE: waste.SERVICE_WASTE_TYPE_LOCKED_MESSAGE,
        RESERVED_WASTE_TYPE_NAME_MESSAGE: waste.RESERVED_WASTE_TYPE_NAME_MESSAGE,
      },
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx?.db) return;
    await ctx.app?.close();
    if (ctx.operator) {
      await ctx.db.execute(
        sql`DELETE FROM waste_tariffs WHERE operator_counterparty_id = ${ctx.operator.id}`,
      );
    }
    await ctx.db.execute(sql`DELETE FROM waste_types WHERE code LIKE ${`${CODE}%`}`);
    for (const id of createdTypeIds) {
      await ctx.db.execute(sql`DELETE FROM waste_types WHERE id = ${id}`);
    }
    if (ctx.operator) {
      await ctx.db.execute(sql`DELETE FROM counterparties WHERE id = ${ctx.operator.id}`);
    }
    await ctx.db.execute(sql`DELETE FROM container_types WHERE code LIKE ${`${CODE}%`}`);
    const users = sql`SELECT id FROM users WHERE email LIKE ${EMAIL('%')}`;
    // The audit log first: `audit_log.actor_user_id` is RESTRICT.
    await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL('%')}`);
    const { closeDb } = await import('../src/db/client');
    await closeDb();
  });

  it('миграция завела служебную строку с закреплёнными id, кодом и названием', async () => {
    const res = await ctx.db.execute<{ id: string; code: string; name: string; active: boolean }>(
      sql`SELECT id, code, name, is_active AS active FROM waste_types WHERE code = 'snow'`,
    );
    expect(res.rows).toEqual([
      {
        id: SNOW_WASTE_TYPE_ID,
        code: SNOW_WASTE_TYPE_CODE,
        name: SNOW_WASTE_TYPE_NAME,
        active: true,
      },
    ]);
  });

  // ── 1. Lists ──

  it('список типов не отдаёт служебный тип ни прайсу, ни выбору в заявке', async () => {
    const own = await ordinaryType();
    // The tariff editor and the registry filter read the whole directory; the garbage request
    // picker reads active types with an active tariff. Neither may offer «Снег».
    const all = await listTypes('');
    expect(all.map((t) => t.id)).toContain(own.id);
    expect(all.find((t) => t.id === SNOW_WASTE_TYPE_ID || t.code === 'snow')).toBeUndefined();

    const active = await listTypes('isActive=true');
    expect(active.find((t) => t.id === SNOW_WASTE_TYPE_ID)).toBeUndefined();

    const searched = await listTypes(`search=${encodeURIComponent('снег')}`);
    expect(searched.find((t) => t.id === SNOW_WASTE_TYPE_ID)).toBeUndefined();

    const withoutTariff = await listTypes('hasActiveTariff=false');
    expect(withoutTariff.find((t) => t.id === SNOW_WASTE_TYPE_ID)).toBeUndefined();
    expect(withoutTariff.map((t) => t.id)).toContain(own.id);
  });
  // ── 2. Edits and purge of the service row, reserved code and name ──

  /** The reserved row as the database holds it: every refusal below must leave it untouched. */
  async function serviceRow(): Promise<Record<string, unknown>> {
    const res = await ctx.db.execute(sql`
      SELECT id, code, name, description, sort_order, is_active, updated_at
        FROM waste_types WHERE id = ${SNOW_WASTE_TYPE_ID}`);
    expect(res.rows, 'the reserved row is gone').toHaveLength(1);
    return res.rows[0]!;
  }

  it.each([SNOW_WASTE_TYPE_ID, SNOW_ID_UPPER])(
    'правка служебной строки %s отвергается словами по каждому присланному полю',
    async (id) => {
      const before = await serviceRow();
      const bodies: Record<string, unknown>[] = [
        { name: 'Снег зимний' },
        { isActive: false },
        { name: 'Снег', isActive: true },
        { description: 'Пояснение' },
        { sortOrder: 1 },
      ];
      for (const body of bodies) {
        const res = await inject('PATCH', `/api/v1/waste-types/${id}`, ctx.admin, body);
        expect(res.statusCode, `${JSON.stringify(body)}: ${res.body}`).toBe(400);
        const fields = res.json<{ fields: Record<string, string> }>().fields;
        expect(Object.keys(fields).sort()).toEqual(Object.keys(body).sort());
        for (const message of Object.values(fields)) {
          expect(message).toBe(ctx.messages.SERVICE_WASTE_TYPE_LOCKED_MESSAGE);
        }
      }
      expect(await serviceRow()).toEqual(before);
    },
  );

  it('код через правку не меняется ни у какой строки: поля «Код» в правке нет', async () => {
    const before = await serviceRow();
    const res = await inject('PATCH', `/api/v1/waste-types/${SNOW_ID_UPPER}`, ctx.admin, {
      code: 'sneg',
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(await serviceRow()).toEqual(before);
  });

  it.each([SNOW_WASTE_TYPE_ID, SNOW_ID_UPPER])(
    'удаление насовсем служебной строки %s отвергается до базы',
    async (id) => {
      const res = await inject('DELETE', `/api/v1/waste-types/${id}/purge`, ctx.admin);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json<{ message: string }>().message).toBe(
        ctx.messages.SERVICE_WASTE_TYPE_LOCKED_MESSAGE,
      );
      await serviceRow();
    },
  );

  it('обычный тип не переименовать в «Снег» ни в каком написании', async () => {
    const own = await ordinaryType();
    for (const name of RESERVED_SPELLINGS) {
      const res = await inject('PATCH', `/api/v1/waste-types/${own.id}`, ctx.admin, { name });
      expect(res.statusCode, `«${name}»: ${res.body}`).toBe(400);
      expect(res.json<{ fields: Record<string, string> }>().fields).toEqual({
        name: ctx.messages.RESERVED_WASTE_TYPE_NAME_MESSAGE,
      });
    }
    const after = await ctx.db.execute<{ name: string }>(
      sql`SELECT name FROM waste_types WHERE id = ${own.id}`,
    );
    expect(after.rows[0]!.name).toBe(own.name);

    // An ordinary rename still works: the refusal is about the reserved key, not about edits.
    const renamed = await inject('PATCH', `/api/v1/waste-types/${own.id}`, ctx.admin, {
      name: `${own.name} (переименован)`,
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
  });

  it('новый тип с названием «Снег» через прайс не заводится: стоимость снега — при закрытии', async () => {
    for (const name of RESERVED_SPELLINGS) {
      const res = await inject('POST', '/api/v1/waste-tariffs', ctx.admin, {
        operatorCounterpartyId: ctx.operator.id,
        wasteTypeName: name,
        containerKind: 'truck',
        pricePerM3: 500,
      });
      expect(res.statusCode, `«${name}»: ${res.body}`).toBe(400);
      expect(res.json<{ fields: Record<string, string> }>().fields).toEqual({
        wasteTypeName: SNOW_COST_AT_COMPLETION_MESSAGE,
      });
    }
    const tariffs = await ctx.db.execute(
      sql`SELECT id FROM waste_tariffs WHERE operator_counterparty_id = ${ctx.operator.id}`,
    );
    expect(tariffs.rows).toEqual([]);
  });

  it('тип «Snow» латиницей — другое название, и зарезервированного кода он не получает', async () => {
    const res = await inject('POST', '/api/v1/waste-tariffs', ctx.admin, {
      operatorCounterpartyId: ctx.operator.id,
      wasteTypeName: 'Snow',
      containerKind: 'truck',
      pricePerM3: 500,
    });
    expect(res.statusCode, res.body).toBe(201);
    const tariff = res.json<WasteTariffDto>();
    createdTypeIds.push(tariff.wasteTypeId);
    const type = await ctx.db.execute<{ code: string }>(
      sql`SELECT code FROM waste_types WHERE id = ${tariff.wasteTypeId}`,
    );
    expect(type.rows[0]!.code).not.toBe(SNOW_WASTE_TYPE_CODE);
    expect(type.rows[0]!.code).toMatch(/^snow_\d+$/u);
  });
  // ── 3. Tariffs and tariff resolution ──

  /** An ordinary priced position of this run's operator: the baseline every refusal is held to. */
  async function ordinaryTariff(): Promise<{ tariff: WasteTariffDto; typeId: string }> {
    const own = await ordinaryType();
    const res = await inject('POST', '/api/v1/waste-tariffs', ctx.admin, {
      operatorCounterpartyId: ctx.operator.id,
      wasteTypeId: own.id,
      containerKind: 'truck',
      pricePerM3: 700,
    });
    expect(res.statusCode, res.body).toBe(201);
    return { tariff: res.json<WasteTariffDto>(), typeId: own.id };
  }

  it.each([SNOW_WASTE_TYPE_ID, SNOW_ID_UPPER])(
    'цена на служебный тип %s не заводится: поле объясняет, что стоимость — при закрытии',
    async (id) => {
      for (const target of [
        { containerKind: 'truck', pricePerM3: 500 },
        { containerTypeId: ctx.containerTypeId, pricePerM3: 500 },
        // An inactive position is refused too: the CHECK forbids it, and a fallback that read
        // inactive prices would price snow by it.
        { containerKind: 'cont', pricePerM3: 500, isActive: false },
      ]) {
        const res = await inject('POST', '/api/v1/waste-tariffs', ctx.admin, {
          operatorCounterpartyId: ctx.operator.id,
          wasteTypeId: id,
          ...target,
        });
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json<{ fields: Record<string, string> }>().fields).toEqual({
          wasteTypeId: SNOW_COST_AT_COMPLETION_MESSAGE,
        });
      }
      const tariffs = await ctx.db.execute(
        sql`SELECT id FROM waste_tariffs WHERE waste_type_id = ${SNOW_WASTE_TYPE_ID}`,
      );
      expect(tariffs.rows).toEqual([]);
    },
  );

  it.each([SNOW_WASTE_TYPE_ID, SNOW_ID_UPPER])(
    'правка цены не переводит её на служебный тип %s',
    async (id) => {
      const { tariff, typeId } = await ordinaryTariff();
      const res = await inject('PATCH', `/api/v1/waste-tariffs/${tariff.id}`, ctx.admin, {
        wasteTypeId: id,
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json<{ fields: Record<string, string> }>().fields).toEqual({
        wasteTypeId: SNOW_COST_AT_COMPLETION_MESSAGE,
      });
      const after = await ctx.db.execute<{ waste_type_id: string }>(
        sql`SELECT waste_type_id FROM waste_tariffs WHERE id = ${tariff.id}`,
      );
      expect(after.rows[0]!.waste_type_id).toBe(typeId);

      // The same position is still editable as an ordinary price.
      const price = await inject('PATCH', `/api/v1/waste-tariffs/${tariff.id}`, ctx.admin, {
        pricePerM3: 750,
      });
      expect(price.statusCode, price.body).toBe(200);
      expect(price.json<WasteTariffDto>().pricePerM3).toBe(750);
    },
  );

  it.each([SNOW_WASTE_TYPE_ID, SNOW_ID_UPPER])(
    'подбор тарифа для служебного типа %s отказывает полем, а не отвечает «тарифа нет»',
    async (id) => {
      for (const target of [
        'containerKind=truck',
        `containerTypeId=${ctx.containerTypeId}`,
        `containerKind=truck&operatorCounterpartyId=${ctx.operator.id}`,
      ]) {
        const res = await inject(
          'GET',
          `/api/v1/waste-tariffs/resolve?wasteTypeId=${id}&${target}`,
          ctx.admin,
        );
        expect(res.statusCode, `${target}: ${res.body}`).toBe(400);
        expect(res.json<{ fields: Record<string, string> }>().fields).toEqual({
          wasteTypeId: SNOW_COST_AT_COMPLETION_MESSAGE,
        });
      }
    },
  );

  it('подбор тарифа для обычного типа работает как прежде', async () => {
    const { tariff, typeId } = await ordinaryTariff();
    const res = await inject(
      'GET',
      `/api/v1/waste-tariffs/resolve?wasteTypeId=${typeId}&containerKind=truck`,
      ctx.admin,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ tariff: { tariffId: string } | null }>().tariff?.tariffId).toBe(tariff.id);
  });
  // ── 4. Excel exchange (ADR 0073) ──

  /** The data sheet of a fresh export: the file a person downloads and edits. */
  async function exportSheet(key: DirectoryKey): Promise<string[][]> {
    const { bytes } = await ctx.engine.exportDirectory(ctx.directoryFor(key)!);
    return ctx.xlsx.readWorkbook(bytes).find((sheet) => sheet.name === DIRECTORY_DATA_SHEET)!.rows;
  }

  function bookOf(rows: string[][]): Uint8Array {
    return ctx.xlsx.writeWorkbook([{ name: DIRECTORY_DATA_SHEET, rows }]);
  }

  function preview(key: DirectoryKey, rows: string[][]): Promise<DirectoryImportReportDto> {
    return ctx.engine.importDirectory(ctx.directoryFor(key)!, bookOf(rows), {
      dryRun: true,
      actorUserId: ctx.adminId,
    });
  }

  /** Apply must refuse the same file as a whole, with a person's text, writing nothing. */
  async function expectApplyRefused(key: DirectoryKey, rows: string[][]): Promise<string> {
    const error = await ctx.engine
      .importDirectory(ctx.directoryFor(key)!, bookOf(rows), {
        dryRun: false,
        actorUserId: ctx.adminId,
      })
      .then(
        () => {
          throw new Error('the file was applied');
        },
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(ctx.engine.DirectoryFileError);
    return (error as Error).message;
  }

  const TYPE_HEADER = [
    DIRECTORY_ID_COLUMN,
    'Код',
    'Наименование',
    'Описание',
    'Порядок',
    'Активен',
  ];

  /** The waste type directory as the database holds it, for «nothing was written» checks. */
  async function typesSnapshot(): Promise<unknown[]> {
    const res = await ctx.db.execute(sql`
      SELECT id, code, name, description, sort_order, is_active, updated_at
        FROM waste_types ORDER BY id`);
    return res.rows;
  }

  const isServiceCell = (row: string[]) =>
    (row[0] ?? '').toLowerCase() === SNOW_WASTE_TYPE_ID ||
    row.some((cell) => cell === SNOW_WASTE_TYPE_CODE || cell === SNOW_WASTE_TYPE_NAME);

  it('выгрузка типов мусора и прайса не несёт служебного типа, а чистый файл грузится без правок', async () => {
    const own = await ordinaryType();
    await ordinaryTariff();

    const types = await exportSheet('waste-types');
    expect(types[0]).toEqual(TYPE_HEADER);
    expect(types.slice(1).filter(isServiceCell)).toEqual([]);
    expect(types.slice(1).map((row) => row[0])).toContain(own.id);

    const tariffs = await exportSheet('waste-tariffs');
    expect(tariffs.slice(1).filter((row) => row.includes(SNOW_WASTE_TYPE_CODE))).toEqual([]);

    for (const [key, rows] of [
      ['waste-types', types],
      ['waste-tariffs', tariffs],
    ] as const) {
      const report = await preview(key, rows);
      expect(report.problems, key).toEqual([]);
      expect(report.created, key).toEqual([]);
      expect(report.updated, key).toEqual([]);
      expect(report.unchanged, key).toBe(rows.length - 1);
    }

    // Applying the unchanged file writes nothing and refuses nothing.
    const before = await typesSnapshot();
    const applied = await ctx.engine.importDirectory(
      ctx.directoryFor('waste-types')!,
      bookOf(types),
      {
        dryRun: false,
        actorUserId: ctx.adminId,
      },
    );
    expect(applied.problems).toEqual([]);
    expect(await typesSnapshot()).toEqual(before);
  });

  it.each([SNOW_WASTE_TYPE_ID, SNOW_ID_UPPER])(
    'строка с идентификатором служебного типа %s отвергается, даже если код и название в ней переписаны',
    async (id) => {
      const before = await typesSnapshot();
      const variants: string[][] = [
        // The reserved row as it is: nothing to edit, and still not the file's business.
        [id, SNOW_WASTE_TYPE_CODE, SNOW_WASTE_TYPE_NAME, '', '1000', 'да'],
        // Deactivation only.
        [id, SNOW_WASTE_TYPE_CODE, SNOW_WASTE_TYPE_NAME, '', '1000', 'нет'],
        // UUID intact, name AND code changed: imports match the id before the code, so this would
        // be a rename of the reserved row, or — after clearing the id — a brand-new type.
        [id, `${CODE}_renamed`, `Сугробы ${RUN}`, 'Переименован файлом', '5', 'да'],
      ];
      for (const row of variants) {
        const rows = [TYPE_HEADER, row];
        const report = await preview('waste-types', rows);
        expect(report.problems, row.join(' | ')).toHaveLength(1);
        expect(report.problems[0]).toMatch(/^строка 2: строка ссылается на служебный тип «Снег»/u);
        expect(report.created).toEqual([]);
        expect(report.updated).toEqual([]);
        expect(await expectApplyRefused('waste-types', rows)).toMatch(/служебный тип «Снег»/u);
      }
      expect(await typesSnapshot()).toEqual(before);
    },
  );

  it.each(['snow', 'SNOW'])(
    'новая строка с кодом %s или названием «Снег» в любом написании отвергается',
    async (reservedCode) => {
      const before = await typesSnapshot();
      // One row per reserved spelling: two rows with the same code would also be reported as one
      // record described twice, which is the engine's rule, not this one.
      const rows = [
        TYPE_HEADER,
        ['', reservedCode, `Сугробы ${RUN}`, '', '100', 'да'],
        ...RESERVED_SPELLINGS.map((name, i) => ['', `${CODE}_x${i}`, name, '', '100', 'да']),
      ];
      const report = await preview('waste-types', rows);
      expect(report.problems).toHaveLength(1 + RESERVED_SPELLINGS.length);
      expect(report.problems[0]).toBe(
        'строка 2: код «snow» принадлежит служебному типу «Снег» заявок «Вывоз снега» — выберите другой',
      );
      for (const problem of report.problems.slice(1)) {
        expect(problem).toMatch(/совпадает со служебным типом «Снег»/u);
      }
      await expectApplyRefused('waste-types', rows);
      expect(await typesSnapshot()).toEqual(before);
    },
  );

  it('заведённый тип не переименовать в «Снег» и не перекодировать в snow файлом', async () => {
    const own = await ordinaryType();
    const before = await typesSnapshot();
    const files: { rows: string[][]; problem: RegExp }[] = [
      {
        rows: [TYPE_HEADER, [own.id, own.code, 'Снёг', '', '100', 'да']],
        problem: /наименование «Снёг» совпадает со служебным типом/u,
      },
      {
        rows: [TYPE_HEADER, [own.id.toUpperCase(), 'snow', own.name, '', '100', 'да']],
        problem: /код «snow» принадлежит служебному типу/u,
      },
      // Matched by code, without the id column: the name is still asked of the database.
      {
        rows: [
          ['Код', 'Наименование'],
          [own.code, 'с н е г'],
        ],
        problem: /наименование «с н е г» совпадает со служебным типом/u,
      },
    ];
    for (const { rows, problem } of files) {
      const report = await preview('waste-types', rows);
      expect(report.problems).toHaveLength(1);
      expect(report.problems[0]).toMatch(problem);
      await expectApplyRefused('waste-types', rows);
    }
    expect(await typesSnapshot()).toEqual(before);
  });

  it('прайс со служебным кодом отвергается в предпросмотре и применении', async () => {
    const { tariff } = await ordinaryTariff();
    const sheet = await exportSheet('waste-tariffs');
    const header = sheet[0]!;
    const ownRow = sheet.find((row) => row[0] === tariff.id)!;
    expect(ownRow, 'the own tariff is exported').toBeDefined();
    const codeAt = header.indexOf('Тип мусора (код)');
    const kindAt = header.indexOf('Вид техники');
    expect(ownRow[kindAt]).toBe(containerKindLabels.truck);

    const newRow = (code: string) => {
      const row = header.map(() => '');
      row[header.indexOf('Оператор (ИНН)')] = ctx.operator.inn;
      row[codeAt] = code;
      row[kindAt] = containerKindLabels.cont;
      row[header.indexOf('Цена за м³')] = '500';
      row[header.indexOf('Считать за контейнер')] = 'нет';
      row[header.indexOf('Активен')] = 'нет';
      return row;
    };
    const moved = [...ownRow];
    moved[codeAt] = 'SNOW';

    for (const row of [newRow('snow'), newRow('SNOW'), moved]) {
      const rows = [header, row];
      const report = await preview('waste-tariffs', rows);
      expect(report.problems).toEqual([
        `строка 2: тип мусора «snow» — служебный тип «Снег». ${SNOW_COST_AT_COMPLETION_MESSAGE}`,
      ]);
      expect(await expectApplyRefused('waste-tariffs', rows)).toMatch(/служебный тип «Снег»/u);
    }
    const snowTariffs = await ctx.db.execute(
      sql`SELECT id FROM waste_tariffs WHERE waste_type_id = ${SNOW_WASTE_TYPE_ID}`,
    );
    expect(snowTariffs.rows).toEqual([]);
  });

  it('чистый файл обычных данных применяется: новый тип заводится, заведённый правится по UUID прописными', async () => {
    const own = await ordinaryType();
    const code = `${CODE}_file`;
    const rows = [
      TYPE_HEADER,
      ['', code, `Мусор из файла ${RUN}`, 'Заведён файлом', '150', 'да'],
      [own.id.toUpperCase(), own.code, `${own.name} (файл)`, '', '100', 'да'],
    ];
    const report = await preview('waste-types', rows);
    expect(report.problems).toEqual([]);
    expect(report.created).toHaveLength(1);
    expect(report.updated).toHaveLength(1);

    await ctx.engine.importDirectory(ctx.directoryFor('waste-types')!, bookOf(rows), {
      dryRun: false,
      actorUserId: ctx.adminId,
    });
    const saved = await ctx.db.execute<{ code: string; name: string }>(sql`
      SELECT code, name FROM waste_types WHERE code IN (${code}, ${own.code})`);
    expect(new Map(saved.rows.map((row) => [row.code, row.name]))).toEqual(
      new Map([
        [code, `Мусор из файла ${RUN}`],
        [own.code, `${own.name} (файл)`],
      ]),
    );
  });
  // ── 5. The database backstop and its translation ──

  /** Runs a write the entry points would have refused and returns what the database threw. */
  async function databaseRefusal(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (e) {
      return e;
    }
    throw new Error('the database accepted a write migration 0429 forbids');
  }

  it('сторожа базы держат служебную строку сами, а их отказ переводится в 4xx со словами', async () => {
    const { asServiceWasteTypeRefusal } = await import('../src/services/waste-types');
    const { AppError } = await import('../src/lib/errors');
    const own = await ordinaryType();
    const cases: { write: () => Promise<unknown>; field: string; status: number; text: string }[] =
      [
        {
          write: () =>
            ctx.db.execute(sql`UPDATE waste_types SET name = 'Снег зимний'
                                WHERE id = ${SNOW_WASTE_TYPE_ID}`),
          field: 'name',
          status: 400,
          text: ctx.messages.SERVICE_WASTE_TYPE_LOCKED_MESSAGE,
        },
        {
          write: () =>
            ctx.db.execute(sql`UPDATE waste_types SET is_active = false
                                WHERE id = ${SNOW_WASTE_TYPE_ID}`),
          field: 'isActive',
          status: 400,
          text: ctx.messages.SERVICE_WASTE_TYPE_LOCKED_MESSAGE,
        },
        {
          write: () =>
            ctx.db.execute(sql`UPDATE waste_types SET code = 'snow' WHERE id = ${own.id}`),
          field: 'code',
          status: 400,
          text: ctx.messages.SERVICE_WASTE_TYPE_LOCKED_MESSAGE,
        },
        {
          write: () =>
            ctx.db.execute(sql`
              INSERT INTO waste_tariffs (operator_counterparty_id, waste_type_id, container_kind,
                                         price_per_m3, is_active)
              VALUES (${ctx.operator.id}, ${SNOW_WASTE_TYPE_ID}, 'truck', 500, false)`),
          field: 'wasteTypeId',
          status: 400,
          text: SNOW_COST_AT_COMPLETION_MESSAGE,
        },
        {
          write: () =>
            ctx.db.execute(sql`DELETE FROM waste_types WHERE id = ${SNOW_WASTE_TYPE_ID}`),
          field: 'id',
          status: 409,
          text: ctx.messages.SERVICE_WASTE_TYPE_LOCKED_MESSAGE,
        },
      ];
    for (const { write, field, status, text } of cases) {
      const translated = asServiceWasteTypeRefusal(await databaseRefusal(write), field);
      expect(translated).toBeInstanceOf(AppError);
      const e = translated as InstanceType<typeof AppError>;
      expect(e.statusCode).toBe(status);
      if (status === 400) expect(e.fields).toEqual({ [field]: text });
      else expect(e.message).toBe(text);
    }
    await serviceRowStillSeeded();
  });

  /** The reserved row survived every refused write above, unchanged. */
  async function serviceRowStillSeeded(): Promise<void> {
    const res = await ctx.db.execute(sql`
      SELECT code, name, is_active FROM waste_types WHERE id = ${SNOW_WASTE_TYPE_ID}`);
    expect(res.rows).toEqual([
      { code: SNOW_WASTE_TYPE_CODE, name: SNOW_WASTE_TYPE_NAME, is_active: true },
    ]);
  }

  it('запись файла, дошедшая до сторожей базы, отменяет загрузку словами, а не 500', async () => {
    const types = ctx.directoryFor('waste-types')!;
    const tariffs = ctx.directoryFor('waste-tariffs')!;
    // `check()` is skipped on purpose: this is the write a racing file would reach.
    const typeRefusal = await databaseRefusal(() =>
      ctx.db.transaction((tx) =>
        types.create(
          tx,
          { code: 'snow', name: `Сугробы ${RUN}`, description: '', sortOrder: 100, isActive: true },
          { reservedNames: new Set<string>() },
          ctx.adminId,
        ),
      ),
    );
    expect(typeRefusal).toBeInstanceOf(ctx.engine.DirectoryFileError);
    expect((typeRefusal as Error).message).toMatch(/служебный тип «Снег»/u);

    const tariffRefusal = await databaseRefusal(() =>
      ctx.db.transaction((tx) =>
        tariffs.create(
          tx,
          {
            operatorInn: ctx.operator.inn,
            wasteTypeCode: SNOW_WASTE_TYPE_CODE,
            containerTypeCode: '',
            containerKind: 'truck',
            pricePerM3: '500',
            pricePerContainer: '',
            isPerContainer: false,
            note: '',
            isActive: false,
          },
          {
            operators: new Map([[ctx.operator.inn, { id: ctx.operator.id, isOperator: true }]]),
            wasteTypeIds: new Map([[SNOW_WASTE_TYPE_CODE, SNOW_WASTE_TYPE_ID]]),
            containers: new Map(),
          },
          ctx.adminId,
        ),
      ),
    );
    expect(tariffRefusal).toBeInstanceOf(ctx.engine.DirectoryFileError);
    expect((tariffRefusal as Error).message).toContain(SNOW_COST_AT_COMPLETION_MESSAGE);

    await serviceRowStillSeeded();
    const snowTariffs = await ctx.db.execute(
      sql`SELECT id FROM waste_tariffs WHERE waste_type_id = ${SNOW_WASTE_TYPE_ID}`,
    );
    expect(snowTariffs.rows).toEqual([]);
  });
});
