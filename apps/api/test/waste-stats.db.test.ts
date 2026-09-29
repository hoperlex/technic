import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyticsCountsAsFact,
  type AnalyticsSummaryDto,
  type WasteStatsDto,
  type WasteStatsFigures,
  type WasteStatsRowDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';

/**
 * Waste removal statistics for a reporting month (plan `docs/waste-stats-tab-plan.md`, three-volume
 * rework — ADR 0209).
 *
 * Why a database. Everything this file checks lives in SQL and only there: the attribution day, the
 * month filter, the sum of confirmed tickets, the ordered volume, the status that makes a request
 * "removed", the site scope. Stub the query and the stub would be tested; the question is exactly
 * what the real query answers on rows lying in the database.
 *
 * A separate check is the RECONCILIATION WITH THE BOOK. The tab and the Excel book must give the
 * same answer to "how much was removed in March" because they count the same atoms (R1); the test
 * compares them directly — only the figures that have a pair in the book (removed volume, removals,
 * fact money); the ordered and confirmed volumes are guarded by internal equalities instead.
 *
 * Three sites. A holds the original ADR 0193 cases and keeps its expectations, which now guard the
 * deprecated combined fields; B holds only scrap metal and a container operation and must not
 * appear; C holds the cases of the three-volume rework (rollback, no ordered volume, tickets above
 * the completion, completion without a sum, "done" without a completion) and a month with unfinished
 * requests only. C is not assigned to the site account, so the scope checks do not see it.
 *
 * The month is far away (`2031-03`): the admin sees every site, and only a month of its own lets the
 * test say something about the TOTAL and not only about its own row.
 *
 * Run like the other db tests:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test waste-stats
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const ADMIN_EMAIL = `db-waste-stats-admin-${RUN}@example.invalid`;
const SITE_EMAIL = `db-waste-stats-site-${RUN}@example.invalid`;
const EMPTY_EMAIL = `db-waste-stats-empty-${RUN}@example.invalid`;
const OPERATOR_EMAIL = `db-waste-stats-oper-${RUN}@example.invalid`;
const PASSWORD = 'db-test-password-123';
/** «яя» в начале кода — требование соседства: половина db-тестов берёт объект `ORDER BY … LIMIT 1`. */
const OBJECT_CODE = `яя-waste-stats-a-${RUN}`;
const OTHER_CODE = `яя-waste-stats-b-${RUN}`;
const THIRD_CODE = `яя-waste-stats-c-${RUN}`;
const KEY_PREFIX = `db-waste-stats-${RUN}/`;

/** Отчётный месяц теста и соседний — в него уезжает заявка, закрытая позже. */
const MONTH = '2031-03';
const NEXT_MONTH = '2031-04';
/** A month of site C with unfinished requests only: the plan exists, nothing is removed yet. */
const OPEN_MONTH = '2031-05';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  siteAuth: { authorization: string };
  /** Роль отдела, которой не назначено ни одной площадки: её ответ обязан быть пустым. */
  emptyScopeAuth: { authorization: string };
  operatorAuth: { authorization: string };
  adminId: string;
  objectId: string;
  otherObjectId: string;
  thirdObjectId: string;
  typeMixedId: string;
  typeFreeId: string;
  typeRowsId: string;
  typePartialId: string;
  /** Waste types of site C, one per case, so every case is its own position. */
  typeC: Record<'rollback' | 'noOrder' | 'over' | 'noSum' | 'noClose', string>;
  containerTypeId: string;
  range: { from: string; to: string };
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

/** Заявка прямой вставкой: предмет теста — расчёт статистики, а не форма заведения. */
async function newRequest(input: {
  objectId?: string;
  requestType?: 'waste_removal' | 'metal_removal' | 'container_install';
  wasteTypeId?: string | null;
  volumeM3?: number | null;
  deliveryDay: string;
  status?: 'new' | 'confirmed' | 'done' | 'completed' | 'cancelled';
  pricePerM3?: string;
  wasteTariffId?: string;
  containerTypeId?: string;
  deleted?: boolean;
}): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.wasteRequests)
    .values({
      objectId: input.objectId ?? ctx.objectId,
      requestType: input.requestType ?? 'waste_removal',
      wasteTypeId: input.wasteTypeId ?? null,
      volumeM3: input.volumeM3 ?? null,
      containerTypeId: input.containerTypeId ?? null,
      pricePerM3: input.pricePerM3 ?? null,
      wasteTariffId: input.wasteTariffId ?? null,
      // Полдень МСК: у московской полуночи день отнесения зависел бы от пояса сессии.
      deliveryAt: new Date(`${input.deliveryDay}T09:00:00Z`),
      status: input.status ?? 'completed',
      createdBy: ctx.adminId,
      comment: 'ТЕСТОВЫЕ ДАННЫЕ: статистика вывоза',
      deletedAt: input.deleted ? new Date() : null,
    })
    .returning({ id: ctx.schema.wasteRequests.id });
  return row!.id;
}

/** Закрытие заявки: вывезенный объём, цена-снимок и день фактического вывоза. */
async function close(
  requestId: string,
  input: { volumeM3?: string; weightTons?: string; price?: string | null; removedOn: string },
): Promise<void> {
  const price = input.price === undefined ? '100.00' : input.price;
  const volume = input.volumeM3 ?? null;
  await ctx.db.insert(ctx.schema.wasteRequestCompletions).values({
    requestId,
    volumeM3: volume,
    weightTons: input.weightTons ?? null,
    pricePerM3: volume && price ? price : null,
    totalCost: volume && price ? String(Number(volume) * Number(price)) : null,
    completedBy: ctx.adminId,
    removedOn: input.removedOn,
    removedOnSource: 'entered',
  });
}

let ticketNo = 0;

/**
 * Талон заявки. Номер своей серией на каждый вызов: подтверждённый номер уникален в пределах
 * перевозчика (ADR 0114, Р17), а исполнителя тестовым заявкам не назначают — область у них общая.
 */
async function seedTicket(
  requestId: string,
  input: {
    volumeM3: string | null;
    status?: 'unconfirmed' | 'confirmed' | 'dismissed';
    workKind?: 'removal' | 'idle' | 'other';
    /** The recognised page the ticket was read from; only machine readings have one. */
    pageId?: string;
  },
): Promise<void> {
  ticketNo += 1;
  const number = `${RUN}-${ticketNo}`;
  const status = input.status ?? 'confirmed';
  await ctx.db.insert(ctx.schema.wasteTickets).values({
    requestId,
    seq: 1,
    numberRaw: `№ ${number}`,
    numberKey: number,
    numberFuzzy: number,
    volumeM3: input.volumeM3,
    workKind: input.workKind ?? 'removal',
    /*
     * Ручной талон заводится сразу подтверждённым (CHECK `waste_tickets_manual_confirmed_check`):
     * его ввёл человек, и ждать, пока он подтвердит сам себя, не за чем. Неразобранная бумага
     * бывает только машинной — ею и заводится.
     */
    origin: status === 'unconfirmed' || input.pageId ? 'ocr' : 'manual',
    pageId: input.pageId ?? null,
    status,
    confirmedBy: status === 'confirmed' ? ctx.adminId : null,
    confirmedAt: status === 'confirmed' ? new Date() : null,
  });
}

/**
 * A ticket scan of the request with its recognition row (ADR 0213). A read file gets one page;
 * `found: 'dismissed'` puts a ticket on it that a person dismissed — the file was read and
 * reviewed, so it is not "no tickets found".
 */
async function seedScan(
  requestId: string,
  status: 'pending' | 'done' | 'failed' | 'unsupported',
  found: 'none' | 'dismissed' = 'none',
): Promise<void> {
  const [file] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey: `${KEY_PREFIX}${randomUUID()}.pdf`,
      filename: 'talon.pdf',
      contentType: 'application/pdf',
      size: 1024,
      status: 'active',
      uploadedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.files.id });
  const fileId = file!.id;
  await ctx.db.insert(ctx.schema.requestFiles).values({ requestId, fileId, kind: 'ticket' });
  await ctx.db.insert(ctx.schema.wasteTicketFiles).values({ fileId, requestId, status });
  if (status !== 'done') return;
  const [page] = await ctx.db
    .insert(ctx.schema.wasteTicketPages)
    .values({
      requestId,
      fileId,
      pageNo: 1,
      pageSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      status: 'done',
      ticketsFound: found === 'none' ? 0 : 1,
    })
    .returning({ id: ctx.schema.wasteTicketPages.id });
  if (found === 'dismissed') {
    await seedTicket(requestId, { volumeM3: '3.000', status: 'dismissed', pageId: page!.id });
  }
}

async function stats(
  auth: { authorization: string } = ctx.auth,
  month: string = MONTH,
): Promise<WasteStatsDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waste-requests/stats?month=${month}`,
    headers: auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as WasteStatsDto;
}

function rowOf(dto: WasteStatsDto, objectId: string): WasteStatsRowDto | undefined {
  return dto.rows.find((r) => r.objectId === objectId);
}

/** Position of site C by the tail of its waste type name — one case per position. */
function caseOf(row: WasteStatsRowDto | undefined, label: string): WasteStatsFigures | undefined {
  return row?.positions.find((p) => p.label.includes(label));
}

describe.skipIf(!DB_URL)('вывоз: статистика за отчётный месяц', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { hashPassword } = await import('../src/auth/password');

    const passwordHash = await hashPassword(PASSWORD);
    const user = async (email: string, role: string, extra = ''): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at${sql.raw(extra ? ', counterparty_id' : '')})
        VALUES (${email}, 'Тестовый', 'Пользователь', 'Статистика', ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now()${sql.raw(extra ? `, '${extra}'::uuid` : '')})
        RETURNING id`);
      return res.rows[0]!.id;
    };

    const objects = await db
      .insert(schema.constructionObjects)
      .values([
        { code: OBJECT_CODE, name: `Площадка статистики А ${RUN}`, address: 'г. Москва, тест, 1' },
        { code: OTHER_CODE, name: `Площадка статистики Б ${RUN}`, address: 'г. Москва, тест, 2' },
        { code: THIRD_CODE, name: `Площадка статистики В ${RUN}`, address: 'г. Москва, тест, 3' },
      ])
      .returning({ id: schema.constructionObjects.id });

    const types = await db
      .insert(schema.wasteTypes)
      .values([
        // Код справочника — латиницей и с подчёркиваниями (CHECK `waste_types_code_format_check`).
        { code: `test_mixed_${RUN}`, name: `ТЕСТ смешанный ${RUN}` },
        { code: `test_free_${RUN}`, name: `ТЕСТ бесценный ${RUN}` },
        { code: `test_rows_${RUN}`, name: `ТЕСТ самосвалами ${RUN}` },
        { code: `test_part_${RUN}`, name: `ТЕСТ частично ${RUN}` },
        { code: `test_rollback_${RUN}`, name: `ТЕСТ откат ${RUN}` },
        { code: `test_noorder_${RUN}`, name: `ТЕСТ без объёма ${RUN}` },
        { code: `test_over_${RUN}`, name: `ТЕСТ талоны сверх ${RUN}` },
        { code: `test_nosum_${RUN}`, name: `ТЕСТ без суммы ${RUN}` },
        { code: `test_noclose_${RUN}`, name: `ТЕСТ без закрытия ${RUN}` },
      ])
      .returning({ id: schema.wasteTypes.id });

    const [counterparty] = await db
      .insert(schema.counterparties)
      .values({
        type: 'operator',
        name: `Оператор статистики ${RUN}`,
        inn: String(7_700_000_000 + Math.floor(Math.random() * 99_999_999)).slice(0, 10),
      })
      .returning({ id: schema.counterparties.id });

    const adminId = await user(ADMIN_EMAIL, 'admin');
    const siteId = await user(SITE_EMAIL, 'shtab');
    // Роль площадочной оси, которой не назначено ни одного объекта: пустой список области — не
    // «без ограничения», и это самый дорогой промах волны (план, §3.3).
    await user(EMPTY_EMAIL, 'shtab');
    await user(OPERATOR_EMAIL, 'operator', counterparty!.id);
    // Учётка площадки видит один объект — свой: вторая площадка теста ей недоступна.
    await db
      .insert(schema.userConstructionObjects)
      .values({ userId: siteId, constructionObjectId: objects[0]!.id });

    const app = await buildApp();
    await app.ready();
    const login = async (email: string): Promise<{ authorization: string }> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    };

    ctx = {
      app,
      db,
      schema,
      closeDb,
      auth: await login(ADMIN_EMAIL),
      siteAuth: await login(SITE_EMAIL),
      emptyScopeAuth: await login(EMPTY_EMAIL),
      operatorAuth: await login(OPERATOR_EMAIL),
      adminId,
      objectId: objects[0]!.id,
      otherObjectId: objects[1]!.id,
      thirdObjectId: objects[2]!.id,
      typeMixedId: types[0]!.id,
      typeFreeId: types[1]!.id,
      typeRowsId: types[2]!.id,
      typePartialId: types[3]!.id,
      typeC: {
        rollback: types[4]!.id,
        noOrder: types[5]!.id,
        over: types[6]!.id,
        noSum: types[7]!.id,
        noClose: types[8]!.id,
      },
      containerTypeId: '',
      range: { from: `${MONTH}-01`, to: `${MONTH}-31` },
    };

    const [containerType] = await db
      .insert(schema.containerTypes)
      .values({
        code: `test_cont_${RUN}`,
        name: `ТЕСТ контейнер ${RUN}`,
        type: 'cont',
        volumeM3: 8,
      })
      .returning({ id: schema.containerTypes.id });
    ctx.containerTypeId = containerType!.id;

    // Прайс нужен ровно одной заявке — незакрытой: её деньги-оценка считаются снимком цены.
    const [tariff] = await db
      .insert(schema.wasteTariffs)
      .values({
        operatorCounterpartyId: counterparty!.id,
        wasteTypeId: ctx.typeMixedId,
        containerKind: 'truck',
        pricePerM3: '100.00',
      })
      .returning({ id: schema.wasteTariffs.id });

    // ── Площадка А, отчётный месяц ──
    // Закрытая с двумя принятыми талонами: 12 + 8 = 20 м³ подтверждено ровно на вывезенное.
    const r1 = await newRequest({
      wasteTypeId: ctx.typeMixedId,
      volumeM3: 20,
      deliveryDay: `${MONTH}-09`,
    });
    await close(r1, { volumeM3: '20.000', removedOn: `${MONTH}-10` });
    await seedTicket(r1, { volumeM3: '12.000' });
    await seedTicket(r1, { volumeM3: '8.000' });

    // Закрытая, у которой из бумаги нечего сложить: простой, непрочитанная графа, неразобранный и
    // отклонённый талоны. Подтверждённого объёма 0 при вывезенных 10 м³.
    const r2 = await newRequest({
      wasteTypeId: ctx.typeMixedId,
      volumeM3: 10,
      deliveryDay: `${MONTH}-14`,
    });
    await close(r2, { volumeM3: '10.000', removedOn: `${MONTH}-15` });
    await seedTicket(r2, { volumeM3: '5.000', workKind: 'idle' });
    await seedTicket(r2, { volumeM3: null });
    await seedTicket(r2, { volumeM3: '10.000', status: 'unconfirmed' });
    await seedTicket(r2, { volumeM3: '7.000', status: 'dismissed' });

    // Незакрытая: заказанный объём и деньги-оценка, дня вывоза ещё нет — относится по доставке.
    await newRequest({
      wasteTypeId: ctx.typeMixedId,
      volumeM3: 15,
      deliveryDay: `${MONTH}-20`,
      status: 'new',
      pricePerM3: '100.00',
      wasteTariffId: tariff!.id,
    });

    // Закрытая без цены: талон предъявил кубы, а умножать их не на что.
    const r4 = await newRequest({
      wasteTypeId: ctx.typeFreeId,
      volumeM3: 5,
      deliveryDay: `${MONTH}-21`,
    });
    await close(r4, { volumeM3: '5.000', price: null, removedOn: `${MONTH}-22` });
    await seedTicket(r4, { volumeM3: '5.000' });

    /*
     * СМЕШАННАЯ ПОЗИЦИЯ (Р5): в одном виде отходов заявка с ценой закрытия стоит рядом с заявкой
     * без цены. Стоимость подтверждённого тут не прочерк, а ЧИСЛО — и оно занижено, о чём обязана
     * сказать подпись «без цены 4 м³».
     */
    const priced = await newRequest({
      wasteTypeId: ctx.typePartialId,
      volumeM3: 10,
      deliveryDay: `${MONTH}-23`,
    });
    await close(priced, { volumeM3: '10.000', removedOn: `${MONTH}-23` });
    await seedTicket(priced, { volumeM3: '10.000' });
    const unpriced = await newRequest({
      wasteTypeId: ctx.typePartialId,
      volumeM3: 4,
      deliveryDay: `${MONTH}-24`,
    });
    await close(unpriced, { volumeM3: '4.000', price: null, removedOn: `${MONTH}-24` });
    await seedTicket(unpriced, { volumeM3: '4.000' });

    // Вывезена в апреле — это апрельский вывоз, хотя доставку ждали в марте.
    const r5 = await newRequest({
      wasteTypeId: ctx.typeMixedId,
      volumeM3: 30,
      deliveryDay: `${MONTH}-30`,
    });
    await close(r5, { volumeM3: '30.000', removedOn: `${NEXT_MONTH}-02` });

    // Отменённая и мягко удалённая не считаются нигде.
    await newRequest({
      wasteTypeId: ctx.typeMixedId,
      volumeM3: 40,
      deliveryDay: `${MONTH}-11`,
      status: 'cancelled',
    });
    const deleted = await newRequest({
      wasteTypeId: ctx.typeMixedId,
      volumeM3: 50,
      deliveryDay: `${MONTH}-12`,
      deleted: true,
    });
    await close(deleted, { volumeM3: '50.000', removedOn: `${MONTH}-12` });

    /*
     * Незакрытая заявка СО СТРОКАМИ САМОСВАЛОВ (план, Р3 и §3.2): заказанный объём обязан прийти
     * из строк — 6 × 2 + 4 (живые), — а не из `waste_requests.volume_m3` (там 99). Третья строка
     * помечена удалённой и не считается нигде, четвёртая — без цены: объём она даёт, а деньги у
     * такой заявки отсутствуют целиком.
     */
    const withRows = await newRequest({
      wasteTypeId: ctx.typeRowsId,
      volumeM3: 99,
      deliveryDay: `${MONTH}-25`,
      // «В работе»: заявка ещё не закрыта, значит несёт заказанное и оценку (Р3).
      status: 'confirmed',
    });
    await ctx.db.insert(ctx.schema.wasteRequestVehicles).values([
      {
        requestId: withRows,
        containerTypeId: ctx.containerTypeId,
        volumeM3: '6.000',
        count: 2,
        pricePerM3: '100.00',
        wasteTariffId: tariff!.id,
      },
      {
        requestId: withRows,
        containerTypeId: ctx.containerTypeId,
        volumeM3: '4.000',
        count: 1,
        pricePerM3: '100.00',
        wasteTariffId: tariff!.id,
      },
      {
        requestId: withRows,
        containerTypeId: ctx.containerTypeId,
        volumeM3: '50.000',
        count: 1,
        pricePerM3: '100.00',
        wasteTariffId: tariff!.id,
        deletedAt: new Date(),
        deletedBy: adminId,
      },
    ]);

    // ── Площадка Б: только лом и контейнерная операция ──
    const metal = await newRequest({
      objectId: ctx.otherObjectId,
      requestType: 'metal_removal',
      deliveryDay: `${MONTH}-18`,
    });
    await close(metal, { weightTons: '12.500', price: null, removedOn: `${MONTH}-18` });
    await newRequest({
      objectId: ctx.otherObjectId,
      requestType: 'container_install',
      containerTypeId: ctx.containerTypeId,
      deliveryDay: `${MONTH}-19`,
      status: 'done',
    });

    // ── Site C: the three-volume cases (ADR 0209) ──
    const priced100 = { pricePerM3: '100.00', wasteTariffId: tariff!.id };
    /*
     * Rolled back "done -> in progress": the completion (12 m3, 1200 RUB) and a confirmed ticket
     * stay, but the request is no longer removed. It is ordered only — 10 m3, 1000 RUB by the
     * request's own price snapshot.
     */
    const rollback = await newRequest({
      objectId: ctx.thirdObjectId,
      wasteTypeId: ctx.typeC.rollback,
      volumeM3: 10,
      deliveryDay: `${MONTH}-04`,
      status: 'confirmed',
      ...priced100,
    });
    await close(rollback, { volumeM3: '12.000', removedOn: `${MONTH}-05` });
    await seedTicket(rollback, { volumeM3: '12.000' });
    // Old request filed without an ordered volume: the plan falls back to the completion, 6 m3 / 600.
    const noOrder = await newRequest({
      objectId: ctx.thirdObjectId,
      wasteTypeId: ctx.typeC.noOrder,
      volumeM3: null,
      deliveryDay: `${MONTH}-06`,
    });
    await close(noOrder, { volumeM3: '6.000', removedOn: `${MONTH}-06` });
    // Tickets above the completion (Z4): 5 + 5 confirmed against 8 removed — the sum as it is.
    const over = await newRequest({
      objectId: ctx.thirdObjectId,
      wasteTypeId: ctx.typeC.over,
      volumeM3: 8,
      deliveryDay: `${MONTH}-07`,
      ...priced100,
    });
    await close(over, { volumeM3: '8.000', removedOn: `${MONTH}-07` });
    await seedTicket(over, { volumeM3: '5.000' });
    await seedTicket(over, { volumeM3: '5.000' });
    /*
     * Scans of the same request (ADR 0213): two the recognition could not read, one read without a
     * ticket, one read and reviewed (its only reading dismissed — 3 m3 that must not reach the sum)
     * and one still in the queue. Only the first three are "not recognised".
     */
    await seedScan(over, 'failed');
    await seedScan(over, 'unsupported');
    await seedScan(over, 'done');
    await seedScan(over, 'done', 'dismissed');
    await seedScan(over, 'pending');
    // A rolled-back request is not removed, so its unreadable scan warns about nothing.
    await seedScan(rollback, 'failed');
    // Completion saved without a sum: its removed volume has no money — a dash, not zero.
    const noSum = await newRequest({
      objectId: ctx.thirdObjectId,
      wasteTypeId: ctx.typeC.noSum,
      volumeM3: 4,
      deliveryDay: `${MONTH}-08`,
      ...priced100,
    });
    await close(noSum, { volumeM3: '4.000', price: null, removedOn: `${MONTH}-08` });
    // "Done" without a completion (old data): one removal with no volume and no money.
    await newRequest({
      objectId: ctx.thirdObjectId,
      wasteTypeId: ctx.typeC.noClose,
      volumeM3: 3,
      deliveryDay: `${MONTH}-09`,
      status: 'done',
      ...priced100,
    });
    // A month with unfinished requests only: 7 m3 / 700 RUB planned, nothing removed.
    await newRequest({
      objectId: ctx.thirdObjectId,
      wasteTypeId: ctx.typeC.rollback,
      volumeM3: 7,
      deliveryDay: `${OPEN_MONTH}-10`,
      status: 'new',
      ...priced100,
    });
  }, 90_000);

  afterAll(async () => {
    if (!ctx) return;
    const emails = sql`(${ADMIN_EMAIL}, ${SITE_EMAIL}, ${EMPTY_EMAIL}, ${OPERATOR_EMAIL})`;
    await ctx.db.execute(sql`
      DELETE FROM waste_requests WHERE created_by IN (SELECT id FROM users WHERE email IN ${emails})`);
    await ctx.db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${KEY_PREFIX}%`}`);
    await ctx.db.execute(sql`DELETE FROM waste_tariffs WHERE waste_type_id IN
      (SELECT id FROM waste_types WHERE name LIKE ${`%${RUN}`})`);
    await ctx.db.execute(sql`DELETE FROM waste_types WHERE name LIKE ${`%${RUN}`}`);
    await ctx.db.execute(sql`DELETE FROM container_types WHERE name LIKE ${`%${RUN}`}`);
    await ctx.db.execute(sql`
      DELETE FROM user_construction_objects WHERE user_id IN
        (SELECT id FROM users WHERE email IN ${emails})`);
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code IN
      (${OBJECT_CODE}, ${OTHER_CODE}, ${THIRD_CODE})`);
    // Учётки раньше контрагента: на нём висит учётка исполнителя (`users_counterparty_id_fkey`).
    await ctx.db.execute(sql`DELETE FROM users WHERE email IN ${emails}`);
    await ctx.db.execute(sql`DELETE FROM counterparties WHERE name LIKE ${`%${RUN}`}`);
    await ctx.app.close();
    await ctx.closeDb();
  });

  it('месяц берёт вывезенное по дню вывоза, а незакрытое — по дню доставки', async () => {
    const dto = await stats();
    const row = rowOf(dto, ctx.objectId);
    // Вывезено 20 + 10 + 5 + 10 + 4 = 49 м³, заказано ещё 15 + 16: в колонке они вместе (Р3).
    expect(row?.volumeM3).toBe(80);
    expect(row?.volumeOrderedM3).toBe(31);
    // Вывозов пять: заявка, вывезенная в апреле, сюда не идёт — как и отменённая с удалённой.
    expect(row?.removals).toBe(5);
    expect(row?.requests).toBe(7);

    // Апрельский вывоз нашёлся в апреле — целиком, а не половиной.
    const next = await stats(ctx.auth, NEXT_MONTH);
    expect(rowOf(next, ctx.objectId)?.volumeM3).toBe(30);
  });

  it('деньги считают факт закрытий вместе с оценкой незакрытой заявки', async () => {
    const row = rowOf(await stats(), ctx.objectId);
    // Факт: (20 + 10 + 10) × 100 = 4000. Оценка: заявка без строк 15 × 100 и строки самосвалов
    // 6 × 2 × 100 + 4 × 100 = 1600, итого 3100. Две бесценные заявки — ноль.
    expect(row?.totalCost).toBe(7100);
    expect(row?.costEstimated).toBe(3100);
    // Заявка без цены закрытия — это заявка, которую не удалось оценить, а не бесплатная работа.
    expect(row?.unpricedRequests).toBe(2);
  });

  it('по талонам — все неотклонённые талоны, и неподтверждённые названы отдельно', async () => {
    const row = rowOf(await stats(), ctx.objectId);
    /*
     * 12 + 8 at the first request, 10 unconfirmed at the second, 5 at the unpriced one, 10 + 4 at
     * the partly priced position (ADR 0213): the unreviewed reading is in the figure now. The idle
     * ticket and the dismissed one stay out.
     */
    expect(row?.ticketVolumeM3).toBe(49);
    expect(row?.ticketsUnconfirmed).toBe(1);
    expect(row?.ticketVolumeUnconfirmedM3).toBe(10);
    // A ticket with an unread field is not zero but unknown: it is counted separately.
    expect(row?.ticketsWithoutVolume).toBe(1);
    // The deprecated name carries the same figure for tabs of an older build.
    expect(row?.confirmedVolumeM3).toBe(row?.ticketVolumeM3);
    expect(row?.confirmedCost).toBe(row?.ticketCost);
  });

  it('талоны в деньгах считаются ценой закрытия, а без цены — прочерком', async () => {
    const row = rowOf(await stats(), ctx.objectId);
    const mixed = row?.positions.find((p) => p.label.includes('смешанный'));
    const free = row?.positions.find((p) => p.label.includes('бесценный'));
    const partial = row?.positions.find((p) => p.label.includes('частично'));
    // 20 accepted and 10 unconfirmed cubic metres at the completion price of 100 RUB.
    expect(mixed?.ticketVolumeM3).toBe(30);
    expect(mixed?.ticketCost).toBe(3000);
    expect(mixed?.ticketVolumeUnpricedM3).toBe(0);
    // Кубы предъявлены, а цены у закрытия нет НИ У ОДНОЙ заявки позиции: прочерк, а не ноль.
    expect(free?.ticketVolumeM3).toBe(5);
    expect(free?.ticketVolumeUnpricedM3).toBe(5);
    expect(free?.ticketCost).toBeNull();
    /*
     * The mixed case: part of the volume cannot be priced. The cost is a NUMBER (10 × 100), but it
     * is understated, and the neighbouring field says exactly that: an understated sum without a
     * mark looks calculated.
     */
    expect(partial?.ticketVolumeM3).toBe(14);
    expect(partial?.ticketVolumeUnpricedM3).toBe(4);
    expect(partial?.ticketCost).toBe(1000);
  });

  it('лом и контейнерные операции в статистику не попадают вовсе', async () => {
    const dto = await stats();
    // У площадки Б за месяц только они — значит её в ответе нет (Р6).
    expect(rowOf(dto, ctx.otherObjectId)).toBeUndefined();
  });

  it('область та же, что у списка: площадка видит своё, исполнителю вывоза отказ', async () => {
    const own = await stats(ctx.siteAuth);
    expect(own.rows.map((r) => r.objectId)).toEqual([ctx.objectId]);

    /*
     * Учётка площадочной оси БЕЗ единой площадки обязана получить пустой ответ, а не полный:
     * пустой список области легче всего принять за «без ограничения», и это самый дорогой промах
     * волны (план, §3.3).
     */
    const empty = await stats(ctx.emptyScopeAuth);
    expect(empty.rows).toEqual([]);
    expect(empty.totals.volumeM3).toBe(0);
    expect(empty.totals.plannedVolumeM3).toBe(0);
    expect(empty.totals.requests).toBe(0);

    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waste-requests/stats?month=${MONTH}`,
      headers: ctx.operatorAuth,
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().message).toContain('область ограничена');
  });

  it('заказанный объём берётся у строк самосвалов, а не у заявки', async () => {
    const row = rowOf(await stats(), ctx.objectId);
    const rows = row?.positions.find((p) => p.label.includes('самосвалами'));
    /*
     * В заявке стоит 99 м³, в живых строках — 6 × 2 + 4 × 1 = 16, и удалённая строка на 50 м³ не
     * в счёт. Деньги посчитаны по тем же строкам (1600 ₽), и если бы объём пришёл из заявки, две
     * соседние колонки описывали бы разные вывозы — ровно та беда, ради которой принято Р3.
     */
    expect(rows?.volumeM3).toBe(16);
    expect(rows?.volumeOrderedM3).toBe(16);
    expect(rows?.totalCost).toBe(1600);
    expect(rows?.costEstimated).toBe(1600);
    // Заявок без строк это не касается: у них заказанное по-прежнему из самой заявки.
    const mixed = row?.positions.find((p) => p.label.includes('смешанный'));
    expect(mixed?.volumeOrderedM3).toBe(15);
  });

  it('сумма позиций равна строке, сумма строк равна итогу', async () => {
    const dto = await stats();
    for (const row of dto.rows) {
      const sum = (pick: (p: (typeof row.positions)[number]) => number): number =>
        Number(row.positions.reduce((acc, p) => acc + pick(p), 0).toFixed(3));
      expect(sum((p) => p.volumeM3)).toBe(row.volumeM3);
      expect(sum((p) => p.totalCost)).toBe(row.totalCost);
      expect(sum((p) => p.ticketVolumeM3)).toBe(row.ticketVolumeM3);
      expect(sum((p) => p.ticketFilesUnread)).toBe(row.ticketFilesUnread);
      expect(sum((p) => p.plannedVolumeM3)).toBe(row.plannedVolumeM3);
      expect(sum((p) => p.doneVolumeM3)).toBe(row.doneVolumeM3);
    }
    const total = (pick: (r: WasteStatsRowDto) => number): number =>
      Number(dto.rows.reduce((acc, r) => acc + pick(r), 0).toFixed(3));
    expect(dto.totals.volumeM3).toBe(total((r) => r.volumeM3));
    expect(dto.totals.plannedVolumeM3).toBe(total((r) => r.plannedVolumeM3));
    expect(dto.totals.doneVolumeM3).toBe(total((r) => r.doneVolumeM3));
    expect(dto.totals.ticketVolumeM3).toBe(total((r) => r.ticketVolumeM3));
    expect(dto.totals.ticketsUnconfirmed).toBe(total((r) => r.ticketsUnconfirmed));
    expect(dto.totals.requests).toBe(dto.rows.reduce((acc, r) => acc + r.requests, 0));
  });

  it('сужение выборки не испортило книгу: без него загрузчик отдаёт прежний набор', async () => {
    /*
     * Вторая половина сверки Р1, и без неё первая тавтологична: складывать один массив двумя
     * способами можно и после того, как загрузчик начал отдавать НЕ ТОТ массив, — а правится этой
     * волной именно загрузчик.
     *
     * Проверяется два утверждения: без `opts` набор тот же, каким его видит книга (заявки всех
     * площадок и всех типов, включая лом и контейнерные операции), а с `opts` он — ровно
     * подмножество: заявки видимых площадок и типа «вывоз мусора».
     */
    const { loadWasteFacts, VOLUME_REQUEST_TYPES } =
      await import('../src/services/analytics/facts-waste');
    const sites = [ctx.objectId, ctx.thirdObjectId];
    const full = await loadWasteFacts(ctx.range);
    const narrowed = await loadWasteFacts(ctx.range, {
      objectIds: sites,
      requestTypes: VOLUME_REQUEST_TYPES,
    });

    const mine = full.atoms.filter((a) => sites.includes(a.customerId));
    const others = full.atoms.filter((a) => a.customerId === ctx.otherObjectId);
    // Лом и контейнерная операция площадки Б в полном наборе есть — их убирает только сужение.
    expect(others.length).toBe(2);
    expect(narrowed.atoms.map((a) => a.requestId).sort()).toEqual(
      mine.map((a) => a.requestId).sort(),
    );
    // Atom figures did not move with the narrowing: it is the same atom, not a recalculated one.
    const byId = new Map(full.atoms.map((a) => [a.requestId, a]));
    const fields = [
      'volumeM3',
      'weightTons',
      'removals',
      'moneyFact',
      'volumeTicketsM3',
      'volumeTicketsUnconfirmedM3',
      'ticketsUnconfirmed',
      'ticketFilesUnread',
      'ticketFilesWithoutTickets',
      'volumePlannedM3',
      'moneyPlanned',
      'volumePlannedUnpricedM3',
      'volumeFactUnpricedM3',
    ] as const;
    for (const atom of narrowed.atoms) {
      for (const field of fields) {
        expect(atom[field], `${atom.requestLabel}: ${field}`).toBe(
          byId.get(atom.requestId)?.[field],
        );
      }
    }
    /*
     * The plan is tied to the book by an equality on atoms: for a request that is not done and has
     * an ordered volume, the planned money is exactly the book estimate — both are the request
     * amount or its truck rows.
     */
    for (const atom of mine) {
      if (analyticsCountsAsFact(atom.requestStatus) || atom.volumeOrderedM3 === 0) continue;
      expect(atom.moneyPlanned, atom.requestLabel).toBe(atom.moneyLow);
    }
  });

  it('вкладка и книга аналитики отвечают одинаково про вывезенное, вывозы и деньги-факт', async () => {
    const dto = await stats();
    const book = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/analytics/summary?from=${dto.from}&to=${dto.to}&step=month`,
      headers: ctx.auth,
    });
    expect(book.statusCode, book.body).toBe(200);
    const customers = (book.json() as AnalyticsSummaryDto).rows;
    /*
     * Only figures with a pair in the book are reconciled: the removed volume, the removal counter
     * and the fact money. The book has no ordered or confirmed volume at all — those are guarded by
     * the internal equalities above. Neither site A nor site C has scrap metal, so the tab's type
     * filter does not affect this comparison; site C adds the rollback and the "done" without a
     * completion, i.e. the status rule on both sides.
     */
    for (const objectId of [ctx.objectId, ctx.thirdObjectId]) {
      const row = rowOf(dto, objectId)!;
      const customer = customers.find((r) => r.id === objectId);
      expect(customer?.byModule.waste.volumeM3).toBe(row.doneVolumeM3);
      expect(customer?.byModule.waste.removals).toBe(row.removals);
      expect(customer?.money.fact).toBe(row.doneCost ?? 0);
      // The deprecated combined figures still decompose into the book's removed volume and fact.
      expect(customer?.byModule.waste.volumeM3).toBe(row.volumeM3 - row.volumeOrderedM3);
      expect(customer?.money.fact).toBe(row.totalCost - row.costEstimated);
    }
  });

  it('site A: ordered, removed and ticket volumes with their money', async () => {
    const row = rowOf(await stats(), ctx.objectId);
    // Ordered: closed requests keep their order — 20 + 10 + 5 + 10 + 4, the open one 15, the truck
    // rows 16 (not the 99 of the request).
    expect(row?.plannedVolumeM3).toBe(80);
    /*
     * Only the open request (1500) and the truck rows (1600) carry a price snapshot; the closed ones
     * were filed without it. 49 m3 of the plan has no money, so the planned cost is a number that
     * the portal signs "без цены 49 м³", not a dash.
     */
    expect(row?.plannedCost).toBe(3100);
    expect(row?.plannedVolumeUnpricedM3).toBe(49);
    // Removed: five completions in a fact status; two of them have no price (5 + 4 m3).
    expect(row?.doneVolumeM3).toBe(49);
    expect(row?.doneCost).toBe(4000);
    expect(row?.doneVolumeUnpricedM3).toBe(9);
    expect(row?.ticketVolumeM3).toBe(49);
  });

  it('site C: a rolled-back request is only ordered, even with its completion and tickets', async () => {
    const rollback = caseOf(rowOf(await stats(), ctx.thirdObjectId), 'откат');
    expect(rollback).toMatchObject({
      plannedVolumeM3: 10,
      plannedCost: 1000,
      doneVolumeM3: 0,
      doneCost: 0,
      ticketVolumeM3: 0,
      ticketsWithoutVolume: 0,
      ticketFilesUnread: 0,
      removals: 0,
      requests: 1,
    });
  });

  it('site C: a request without an ordered volume takes the plan and its money from the completion', async () => {
    const noOrder = caseOf(rowOf(await stats(), ctx.thirdObjectId), 'без объёма');
    expect(noOrder).toMatchObject({
      plannedVolumeM3: 6,
      plannedCost: 600,
      plannedVolumeUnpricedM3: 0,
      doneVolumeM3: 6,
      doneCost: 600,
    });
  });

  it('site C: tickets are summed as they are, above the removed volume (Z4)', async () => {
    const over = caseOf(rowOf(await stats(), ctx.thirdObjectId), 'талоны сверх');
    expect(over).toMatchObject({
      doneVolumeM3: 8,
      doneCost: 800,
      // The dismissed reading on the reviewed scan (3 m3) is not in the sum.
      ticketVolumeM3: 10,
      ticketCost: 1000,
    });
  });

  it('site C: unreadable scans and scans without tickets are counted, queued and reviewed ones not', async () => {
    const row = rowOf(await stats(), ctx.thirdObjectId);
    expect(caseOf(row, 'талоны сверх')).toMatchObject({
      ticketFilesUnread: 2,
      ticketFilesWithoutTickets: 1,
    });
    // The rolled-back request's failed scan stays out, like its tickets.
    expect(row).toMatchObject({ ticketFilesUnread: 2, ticketFilesWithoutTickets: 1 });
  });

  it('site C: removed volume without a completion sum is a dash, not zero', async () => {
    const row = rowOf(await stats(), ctx.thirdObjectId);
    // The whole position has no money: a dash.
    expect(caseOf(row, 'без суммы')).toMatchObject({
      doneVolumeM3: 4,
      doneVolumeUnpricedM3: 4,
      doneCost: null,
      plannedCost: 400,
    });
    // The row has priced removals too: a number, understated by the 4 m3 the portal names.
    expect(row?.doneVolumeM3).toBe(18);
    expect(row?.doneCost).toBe(1400);
    expect(row?.doneVolumeUnpricedM3).toBe(4);
  });

  it('site C: "done" without a completion is one removal with nothing in it', async () => {
    const row = rowOf(await stats(), ctx.thirdObjectId);
    expect(caseOf(row, 'без закрытия')).toMatchObject({
      plannedVolumeM3: 3,
      plannedCost: 300,
      doneVolumeM3: 0,
      doneCost: 0,
      removals: 1,
    });
    expect(row).toMatchObject({
      plannedVolumeM3: 31,
      plannedCost: 3100,
      ticketVolumeM3: 10,
      removals: 4,
      requests: 5,
      // The completion without a sum and the "done" without a completion could not be priced.
      unpricedRequests: 2,
    });

    const { loadWasteFacts, VOLUME_REQUEST_TYPES } =
      await import('../src/services/analytics/facts-waste');
    const { quality } = await loadWasteFacts(ctx.range, {
      objectIds: [ctx.thirdObjectId],
      requestTypes: VOLUME_REQUEST_TYPES,
    });
    const entry = (key: string) => quality.find((q) => q.key === key);
    expect(entry('waste.done_without_completion')).toMatchObject({ value: 1, outOf: 4 });
    expect(entry('waste.requests_without_ordered_volume')).toMatchObject({ value: 1, outOf: 5 });
  });

  it('a month with unfinished requests only has a plan and nothing removed', async () => {
    const row = rowOf(await stats(ctx.auth, OPEN_MONTH), ctx.thirdObjectId);
    expect(row).toMatchObject({
      plannedVolumeM3: 7,
      plannedCost: 700,
      doneVolumeM3: 0,
      doneCost: 0,
      ticketVolumeM3: 0,
      removals: 0,
      requests: 1,
    });
  });
});
