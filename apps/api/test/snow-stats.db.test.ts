import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SNOW_WASTE_TYPE_ID,
  SNOW_WASTE_TYPE_NAME,
  WASTE_REQUEST_CAPABILITY_HEADER,
  WASTE_REQUEST_CAPABILITY_SNOW,
  type AnalyticsCustomerRow,
  type AnalyticsQualityEntry,
  type AnalyticsSummaryDto,
  type WasteStatsDto,
  type WasteStatsRowDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { readWorkbook, type SheetOutput } from '../src/lib/xlsx';
// Types only: the values are imported with `await import` after the environment is set — the
// config validates it on import and fails without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';

/**
 * Monthly waste statistics with the snow kind (snow-removal plan, S7, S8, §3.4).
 *
 * One month and shared sites carry BOTH kinds, so every check also says that the other kind stayed
 * out: site A has garbage and every snow case (a priced, a zero and an unpaid removal, a rolled-back
 * and an unfinished request, cancelled and deleted ones, one removed next month); B is snow only
 * with large legal amounts and one missing; C is snow with no amount at all; D is snow not removed
 * yet. A is the only site of the site account. The month is far away (`2041-11`) so that the
 * admin's TOTAL belongs to this file alone.
 *
 * Run on a fresh database like the other db tests:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:55961/technic_test \
 *     pnpm check:db snow-stats
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const ADMIN_EMAIL = `db-snow-stats-admin-${RUN}@example.invalid`;
const SITE_EMAIL = `db-snow-stats-site-${RUN}@example.invalid`;
const EMPTY_EMAIL = `db-snow-stats-empty-${RUN}@example.invalid`;
const OPERATOR_EMAIL = `db-snow-stats-oper-${RUN}@example.invalid`;
const PASSWORD = 'db-test-password-123';
/** «яя» first: half of the db tests take an object `ORDER BY … LIMIT 1`, and these must not win. */
const CODE = {
  a: `яя-snow-stats-a-${RUN}`,
  b: `яя-snow-stats-b-${RUN}`,
  c: `яя-snow-stats-c-${RUN}`,
  d: `яя-snow-stats-d-${RUN}`,
};
const KEY_PREFIX = `db-snow-stats-${RUN}/`;

const MONTH = '2041-11';
const NEXT_MONTH = '2041-12';
/** A month with garbage only: the snow answer must be empty, not garbage relabelled. */
const GARBAGE_MONTH = '2042-01';
/** A month of its own for the queue payload cases: they would move the figures of `MONTH`. */
const QUEUE_MONTH = '2043-03';

/** Just below the completion ceiling of 999 999 999 ₽ (`MAX_FACT_COST`): large and still legal. */
const LARGE_1 = '999999998.99';
const LARGE_2 = '999999997.37';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  siteAuth: { authorization: string };
  emptyScopeAuth: { authorization: string };
  operatorAuth: { authorization: string };
  adminId: string;
  site: Record<'a' | 'b' | 'c' | 'd', string>;
  garbageTypeId: string;
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

type Status = 'new' | 'confirmed' | 'done' | 'completed' | 'cancelled';

/**
 * A request by direct insert: the subject is the statistics, not the form. A snow row has the shape
 * the SQL guard demands (`waste_requests_snow_subject_check`): the reserved type, an ordered volume
 * of at least 8 m³ and no price snapshot.
 */
async function newRequest(input: {
  site: keyof Ctx['site'];
  type: 'waste_removal' | 'snow_removal';
  volumeM3: number;
  deliveryDay: string;
  status: Status;
  /** Garbage only: a price snapshot of 100 ₽/m³ gives the request its estimate. */
  priced?: boolean;
  deleted?: boolean;
}): Promise<string> {
  const snow = input.type === 'snow_removal';
  const tariffId = input.priced ? await tariff() : null;
  const [row] = await ctx.db
    .insert(ctx.schema.wasteRequests)
    .values({
      objectId: ctx.site[input.site],
      requestType: input.type,
      wasteTypeId: snow ? SNOW_WASTE_TYPE_ID : ctx.garbageTypeId,
      volumeM3: input.volumeM3,
      pricePerM3: tariffId ? '100.00' : null,
      wasteTariffId: tariffId,
      // Noon in Moscow: at Moscow midnight the attribution day would depend on the session zone.
      deliveryAt: new Date(`${input.deliveryDay}T09:00:00Z`),
      status: input.status,
      createdBy: ctx.adminId,
      comment: 'ТЕСТОВЫЕ ДАННЫЕ: статистика вывоза снега',
      deletedAt: input.deleted ? new Date() : null,
    })
    .returning({ id: ctx.schema.wasteRequests.id });
  return row!.id;
}

let tariffId: string | null = null;

async function tariff(): Promise<string> {
  if (tariffId) return tariffId;
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO waste_tariffs (operator_counterparty_id, waste_type_id, container_kind, price_per_m3)
    SELECT id, ${ctx.garbageTypeId}::uuid, 'truck', 100.00 FROM counterparties
     WHERE name = ${`Оператор снега ${RUN}`}
    RETURNING id`);
  tariffId = res.rows[0]!.id;
  return tariffId;
}

/**
 * A completion. Garbage is priced by its snapshot (100 ₽/m³); snow has no price per cubic metre and
 * carries the amount entered by hand — or none (`null`).
 */
async function close(
  requestId: string,
  input: { volumeM3: string; removedOn: string; totalCost?: string | null; garbage?: boolean },
): Promise<void> {
  await ctx.db.insert(ctx.schema.wasteRequestCompletions).values({
    requestId,
    volumeM3: input.volumeM3,
    pricePerM3: input.garbage ? '100.00' : null,
    totalCost: input.garbage
      ? String(Number(input.volumeM3) * 100)
      : input.totalCost === undefined
        ? null
        : input.totalCost,
    completedBy: ctx.adminId,
    removedOn: input.removedOn,
    removedOnSource: 'entered',
  });
}

let ticketNo = 0;

/** A ticket; its number is a series of its own per call (confirmed numbers are unique, ADR 0114). */
async function seedTicket(
  requestId: string,
  input: {
    volumeM3: string | null;
    status?: 'unconfirmed' | 'confirmed' | 'dismissed';
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
    workKind: 'removal',
    // A manual ticket is confirmed at once (`waste_tickets_manual_confirmed_check`); unreviewed
    // paper is always a machine reading.
    origin: status === 'unconfirmed' || input.pageId ? 'ocr' : 'manual',
    pageId: input.pageId ?? null,
    status,
    confirmedBy: status === 'confirmed' ? ctx.adminId : null,
    confirmedAt: status === 'confirmed' ? new Date() : null,
  });
}

/**
 * A ticket scan with its recognition rows: the file status, its pages and, optionally, the job of
 * its latest attempt. Returns the page ids so a ticket can be put on a read page.
 */
async function seedScan(
  requestId: string,
  input: {
    status: 'pending' | 'done' | 'failed' | 'unsupported';
    pages?: ('done' | 'failed')[];
    job?: 'dead' | 'pending';
  },
): Promise<string[]> {
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
  let activeJobId: string | null = null;
  if (input.job) {
    const [job] = await ctx.db
      .insert(ctx.schema.jobs)
      .values({
        type: 'recognize_waste_ticket_file',
        payload: { fileId, marker: KEY_PREFIX },
        status: input.job,
      })
      .returning({ id: ctx.schema.jobs.id });
    activeJobId = job!.id;
  }
  await ctx.db.insert(ctx.schema.requestFiles).values({ requestId, fileId, kind: 'ticket' });
  await ctx.db
    .insert(ctx.schema.wasteTicketFiles)
    .values({ fileId, requestId, status: input.status, activeJobId });
  const pageIds: string[] = [];
  for (const [index, status] of (input.pages ?? []).entries()) {
    const [page] = await ctx.db
      .insert(ctx.schema.wasteTicketPages)
      .values({
        requestId,
        fileId,
        pageNo: index + 1,
        pageSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        status,
      })
      .returning({ id: ctx.schema.wasteTicketPages.id });
    pageIds.push(page!.id);
  }
  return pageIds;
}

/**
 * The snow kind is served only to a client that declares the capability (plan §3.5); the garbage
 * kind and a bare `?month=` need no header, and a few calls below go without it on purpose.
 */
async function stats(
  query: string,
  auth: { authorization: string } = ctx.auth,
): Promise<WasteStatsDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waste-requests/stats?${query}`,
    headers: query.includes('kind=snow')
      ? { ...auth, [WASTE_REQUEST_CAPABILITY_HEADER]: WASTE_REQUEST_CAPABILITY_SNOW }
      : auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as WasteStatsDto;
}

function rowOf(dto: WasteStatsDto, site: keyof Ctx['site']): WasteStatsRowDto | undefined {
  return dto.rows.find((r) => r.objectId === ctx.site[site]);
}

function qualityOf(dto: { quality: AnalyticsQualityEntry[] }, key: string): AnalyticsQualityEntry {
  const entry = dto.quality.find((q) => q.key === key);
  if (!entry) throw new Error(`Строки качества ${key} нет`);
  return entry;
}

describe.skipIf(!DB_URL)('вывоз снега: статистика за отчётный месяц', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { hashPassword } = await import('../src/auth/password');

    const passwordHash = await hashPassword(PASSWORD);
    const user = async (email: string, role: string, counterpartyId = ''): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', 'Снег', ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now(),
                ${counterpartyId === '' ? null : counterpartyId}::uuid)
        RETURNING id`);
      return res.rows[0]!.id;
    };

    const objects = await db
      .insert(schema.constructionObjects)
      .values(
        (['a', 'b', 'c', 'd'] as const).map((key) => ({
          code: CODE[key],
          name: `Площадка снега ${key.toUpperCase()} ${RUN}`,
          address: `г. Москва, тест снега, ${key}`,
        })),
      )
      .returning({ id: schema.constructionObjects.id, code: schema.constructionObjects.code });
    const idOf = (code: string): string => objects.find((o) => o.code === code)!.id;

    const [garbageType] = await db
      .insert(schema.wasteTypes)
      .values({ code: `test_snowstats_${RUN}`, name: `ТЕСТ мусор рядом со снегом ${RUN}` })
      .returning({ id: schema.wasteTypes.id });

    const [counterparty] = await db
      .insert(schema.counterparties)
      .values({
        type: 'operator',
        name: `Оператор снега ${RUN}`,
        inn: String(7_700_000_000 + Math.floor(Math.random() * 99_999_999)).slice(0, 10),
      })
      .returning({ id: schema.counterparties.id });

    const adminId = await user(ADMIN_EMAIL, 'admin');
    const siteId = await user(SITE_EMAIL, 'shtab');
    // An object-axis role with no site at all: an empty scope list is not "unrestricted".
    await user(EMPTY_EMAIL, 'shtab');
    await user(OPERATOR_EMAIL, 'operator', counterparty!.id);
    await db
      .insert(schema.userConstructionObjects)
      .values({ userId: siteId, constructionObjectId: idOf(CODE.a) });

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
      site: { a: idOf(CODE.a), b: idOf(CODE.b), c: idOf(CODE.c), d: idOf(CODE.d) },
      garbageTypeId: garbageType!.id,
    };

    // ── Site A, garbage: one removal priced by its snapshot and one open request ──
    const g1 = await newRequest({
      site: 'a',
      type: 'waste_removal',
      volumeM3: 20,
      deliveryDay: `${MONTH}-04`,
      status: 'completed',
      priced: true,
    });
    await close(g1, { volumeM3: '20.000', removedOn: `${MONTH}-05`, garbage: true });
    await seedTicket(g1, { volumeM3: '20.000' });
    await newRequest({
      site: 'a',
      type: 'waste_removal',
      volumeM3: 10,
      deliveryDay: `${MONTH}-06`,
      status: 'new',
      priced: true,
    });

    // ── Site A, snow ──
    /*
     * Removed with an entered amount, and every kind of paper warning on it: an accepted ticket on
     * a scan whose second page failed, an unreviewed reading, an unreviewed one without a volume, a
     * scan with two failed pages, a scan whose latest attempt died, a rejected scan and a scan read
     * without a single ticket. Each failed scan counts once, and none of them is "read without a
     * ticket".
     */
    const s1 = await newRequest({
      site: 'a',
      type: 'snow_removal',
      volumeM3: 10,
      deliveryDay: `${MONTH}-09`,
      status: 'done',
    });
    await close(s1, { volumeM3: '12.000', removedOn: `${MONTH}-10`, totalCost: '1500.00' });
    const [readPage] = await seedScan(s1, { status: 'done', pages: ['done', 'failed'] });
    await seedTicket(s1, { volumeM3: '7.000', pageId: readPage });
    await seedTicket(s1, { volumeM3: '5.000', status: 'unconfirmed' });
    await seedTicket(s1, { volumeM3: null, status: 'unconfirmed' });
    await seedScan(s1, { status: 'done', pages: ['failed', 'failed'] });
    await seedScan(s1, { status: 'pending', job: 'dead' });
    await seedScan(s1, { status: 'failed' });
    await seedScan(s1, { status: 'done', pages: ['done'] });
    // A scan queued for recognition is not late yet: neither unread nor read without a ticket.
    await seedScan(s1, { status: 'pending', job: 'pending' });

    // Completed with a recorded zero: a known amount, not a missing one.
    const s2 = await newRequest({
      site: 'a',
      type: 'snow_removal',
      volumeM3: 8,
      deliveryDay: `${MONTH}-11`,
      status: 'completed',
    });
    await close(s2, { volumeM3: '8.000', removedOn: `${MONTH}-11`, totalCost: '0.00' });
    await seedTicket(s2, { volumeM3: '8.000' });

    // Removed and unpaid: the invoice amount is still missing — «без цены».
    const s3 = await newRequest({
      site: 'a',
      type: 'snow_removal',
      volumeM3: 9,
      deliveryDay: `${MONTH}-12`,
      status: 'done',
    });
    await close(s3, { volumeM3: '9.000', removedOn: `${MONTH}-12`, totalCost: null });

    /*
     * Rolled back «Выполнена → В работе»: the completion (no amount yet), an accepted ticket and an
     * unreadable scan stay, but the request is ordered only — and missing nothing yet.
     */
    const s4 = await newRequest({
      site: 'a',
      type: 'snow_removal',
      volumeM3: 8,
      deliveryDay: `${MONTH}-13`,
      status: 'confirmed',
    });
    await close(s4, { volumeM3: '6.000', removedOn: `${MONTH}-13`, totalCost: null });
    await seedTicket(s4, { volumeM3: '6.000' });
    await seedScan(s4, { status: 'failed' });

    // Not removed yet: ordered only, and its cost is entered only at completion.
    await newRequest({
      site: 'a',
      type: 'snow_removal',
      volumeM3: 15,
      deliveryDay: `${MONTH}-20`,
      status: 'new',
    });

    // Cancelled and deleted requests count nowhere.
    const cancelled = await newRequest({
      site: 'a',
      type: 'snow_removal',
      volumeM3: 40,
      deliveryDay: `${MONTH}-14`,
      status: 'cancelled',
    });
    await close(cancelled, { volumeM3: '40.000', removedOn: `${MONTH}-14`, totalCost: '4000.00' });
    const deleted = await newRequest({
      site: 'a',
      type: 'snow_removal',
      volumeM3: 50,
      deliveryDay: `${MONTH}-15`,
      status: 'done',
      deleted: true,
    });
    await close(deleted, { volumeM3: '50.000', removedOn: `${MONTH}-15`, totalCost: '5000.00' });

    // Delivered on the last day, removed on the first of the next month: the next month's removal.
    const late = await newRequest({
      site: 'a',
      type: 'snow_removal',
      volumeM3: 11,
      deliveryDay: `${MONTH}-30`,
      status: 'done',
    });
    await close(late, { volumeM3: '11.000', removedOn: `${NEXT_MONTH}-01`, totalCost: '1100.00' });

    // ── Site B: large legal amounts and one missing ──
    const b1 = await newRequest({
      site: 'b',
      type: 'snow_removal',
      volumeM3: 10,
      deliveryDay: `${MONTH}-03`,
      status: 'done',
    });
    await close(b1, { volumeM3: '10.000', removedOn: `${MONTH}-03`, totalCost: LARGE_1 });
    const b2 = await newRequest({
      site: 'b',
      type: 'snow_removal',
      volumeM3: 10,
      deliveryDay: `${MONTH}-04`,
      status: 'completed',
    });
    await close(b2, { volumeM3: '10.000', removedOn: `${MONTH}-04`, totalCost: LARGE_2 });
    const b3 = await newRequest({
      site: 'b',
      type: 'snow_removal',
      volumeM3: 8,
      deliveryDay: `${MONTH}-05`,
      status: 'done',
    });
    await close(b3, { volumeM3: '5.000', removedOn: `${MONTH}-05`, totalCost: null });

    // ── Site C: removed snow with no amount at all — a dash, not zero ──
    const c1 = await newRequest({
      site: 'c',
      type: 'snow_removal',
      volumeM3: 10,
      deliveryDay: `${MONTH}-07`,
      status: 'done',
    });
    await close(c1, { volumeM3: '10.000', removedOn: `${MONTH}-07`, totalCost: null });

    // ── Site D: snow not removed yet ──
    await newRequest({
      site: 'd',
      type: 'snow_removal',
      volumeM3: 12,
      deliveryDay: `${MONTH}-21`,
      status: 'new',
    });

    // ── A garbage-only month ──
    const g3 = await newRequest({
      site: 'a',
      type: 'waste_removal',
      volumeM3: 8,
      deliveryDay: `${GARBAGE_MONTH}-10`,
      status: 'done',
      priced: true,
    });
    await close(g3, { volumeM3: '8.000', removedOn: `${GARBAGE_MONTH}-10`, garbage: true });
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const emails = sql`(${ADMIN_EMAIL}, ${SITE_EMAIL}, ${EMPTY_EMAIL}, ${OPERATOR_EMAIL})`;
    await ctx.db.execute(sql`
      DELETE FROM waste_requests WHERE created_by IN (SELECT id FROM users WHERE email IN ${emails})`);
    await ctx.db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${KEY_PREFIX}%`}`);
    await ctx.db.execute(sql`DELETE FROM jobs WHERE payload->>'marker' = ${KEY_PREFIX}`);
    await ctx.db.execute(sql`DELETE FROM waste_tariffs WHERE waste_type_id = ${ctx.garbageTypeId}`);
    await ctx.db.execute(sql`DELETE FROM waste_types WHERE id = ${ctx.garbageTypeId}`);
    await ctx.db.execute(sql`
      DELETE FROM user_construction_objects WHERE user_id IN
        (SELECT id FROM users WHERE email IN ${emails})`);
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code IN
      (${CODE.a}, ${CODE.b}, ${CODE.c}, ${CODE.d})`);
    // Accounts before the counterparty: the operator account references it.
    await ctx.db.execute(sql`DELETE FROM users WHERE email IN ${emails}`);
    await ctx.db.execute(sql`DELETE FROM counterparties WHERE name = ${`Оператор снега ${RUN}`}`);
    await ctx.app.close();
    await ctx.closeDb();
  });

  describe('вид статистики (S8)', () => {
    it('запрос с одним месяцем — прежний мусор, как и kind=waste', async () => {
      const legacy = await stats(`month=${MONTH}`);
      const waste = await stats(`month=${MONTH}&kind=waste`);
      expect(legacy).toEqual(waste);
      expect(legacy.kind).toBe('waste');
      // Only garbage: the snow-only sites are absent, and site A counts its two garbage requests.
      expect(legacy.rows.map((r) => r.objectId)).toEqual([ctx.site.a]);
      const a = rowOf(legacy, 'a')!;
      expect(a.positions.map((p) => p.label)).toEqual([`ТЕСТ мусор рядом со снегом ${RUN}`]);
      expect(a).toMatchObject({
        requests: 2,
        removals: 1,
        plannedVolumeM3: 30,
        plannedCost: 3000,
        plannedVolumeUnpricedM3: 0,
        doneVolumeM3: 20,
        doneCost: 2000,
        ticketVolumeM3: 20,
        ticketCost: 2000,
        unpricedRequests: 0,
      });
    });

    it('kind=snow отвечает снегом и называет вид в ответе', async () => {
      const dto = await stats(`month=${MONTH}&kind=snow`);
      expect(dto.kind).toBe('snow');
      expect(dto.month).toBe(MONTH);
      expect(dto.rows.map((r) => r.code)).toEqual([CODE.a, CODE.b, CODE.c, CODE.d]);
      // One position per site, the reserved type: garbage never leaks into the snow table.
      for (const row of dto.rows) {
        expect(row.positions.map((p) => p.label)).toEqual([SNOW_WASTE_TYPE_NAME]);
      }
      // Five snow requests at A: cancelled, deleted and next month's are out.
      expect(rowOf(dto, 'a')?.requests).toBe(5);
      expect(dto.totals.requests).toBe(10);
    });

    it('отбор по типу стоит до подсчёта качества: строки качества того же вида', async () => {
      const snow = await stats(`month=${MONTH}&kind=snow`);
      const waste = await stats(`month=${MONTH}&kind=waste`);
      expect(qualityOf(snow, 'waste.requests_without_ordered_volume').outOf).toBe(10);
      expect(qualityOf(waste, 'waste.requests_without_ordered_volume').outOf).toBe(2);
      expect(qualityOf(snow, 'waste.removals_without_ticket')).toMatchObject({
        // Removed snow: A (3), B (3), C (1); without an accepted ticket — all but A's first two.
        value: 5,
        outOf: 7,
      });
    });

    it('месяц снега — месяц дня вывоза, как у мусора', async () => {
      const next = await stats(`month=${NEXT_MONTH}&kind=snow`);
      expect(rowOf(next, 'a')).toMatchObject({ requests: 1, removals: 1, doneVolumeM3: 11 });
      expect(rowOf(await stats(`month=${NEXT_MONTH}&kind=waste`), 'a')).toBeUndefined();
    });

    it('месяц без снега даёт пустой ответ снега, а не мусор', async () => {
      const dto = await stats(`month=${GARBAGE_MONTH}&kind=snow`);
      expect(dto.kind).toBe('snow');
      expect(dto.rows).toEqual([]);
      expect(dto.totals).toMatchObject({ requests: 0, plannedVolumeM3: 0, doneVolumeM3: 0 });
      expect(rowOf(await stats(`month=${GARBAGE_MONTH}`), 'a')?.doneVolumeM3).toBe(8);
    });

    it('снег без заявленной возможности клиента — 426, мусор и голый месяц — без заголовка', async () => {
      const bare = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/waste-requests/stats?month=${MONTH}&kind=snow`,
        headers: ctx.auth,
      });
      expect(bare.statusCode, bare.body).toBe(426);
      expect((await stats(`month=${MONTH}`)).kind).toBe('waste');
      expect((await stats(`month=${MONTH}&kind=waste`)).kind).toBe('waste');
    });

    it('чужой вид отвергается проверкой запроса', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/waste-requests/stats?month=${MONTH}&kind=metal`,
        headers: ctx.auth,
      });
      expect(res.statusCode, res.body).toBe(400);
    });
  });

  describe('деньги и талоны снега (S6, S7)', () => {
    it('площадка A: вывезенное — внесённые суммы с нулём, без цены — только вывезенное без суммы', async () => {
      const a = rowOf(await stats(`month=${MONTH}&kind=snow`), 'a');
      expect(a).toMatchObject({
        requests: 5,
        removals: 3,
        // Ordered by every valid request, the rolled-back and the unfinished ones included.
        plannedVolumeM3: 50,
        // No estimate at all: a dash, and nothing is "unpriced" in the plan.
        plannedCost: null,
        plannedVolumeUnpricedM3: 0,
        // 12 + 8 + 9 removed; 1500 + 0 entered, the unpaid 9 m³ flagged.
        doneVolumeM3: 29,
        doneCost: 1500,
        doneVolumeUnpricedM3: 9,
        // Only the removed request without an amount; the open and rolled-back ones miss nothing.
        unpricedRequests: 1,
      });
    });

    it('площадка A: талоны снега по правилам мусора, а денег по талонам нет', async () => {
      const a = rowOf(await stats(`month=${MONTH}&kind=snow`), 'a');
      expect(a).toMatchObject({
        // 7 accepted + 5 unreviewed at the first request, 8 at the second; the rolled-back
        // request's ticket is out with it.
        ticketVolumeM3: 20,
        ticketVolumeUnconfirmedM3: 5,
        ticketsUnconfirmed: 2,
        ticketsWithoutVolume: 1,
        // The scan with a failed page, the one with two failed pages, the one whose latest attempt
        // died and the rejected one — each once; the queued scan is neither.
        ticketFilesUnread: 4,
        // Only the scan read in full without a ticket; the broken ones are not counted here too.
        ticketFilesWithoutTickets: 1,
        ticketCost: null,
        ticketVolumeUnpricedM3: 0,
      });
    });

    it('площадка A: устаревшие поля для старой вкладки согласованы с новыми', async () => {
      const a = rowOf(await stats(`month=${MONTH}&kind=snow`), 'a');
      expect(a).toMatchObject({
        // Removed 29 + ordered-not-removed 8 (rolled back) + 15 (open).
        volumeM3: 52,
        volumeOrderedM3: 23,
        totalCost: 1500,
        costEstimated: 0,
        confirmedVolumeM3: 20,
        confirmedVolumeUnpricedM3: 0,
        confirmedCost: null,
      });
    });

    it('окно площадки: позиция «Снег» несёт те же числа, что строка', async () => {
      const dto = await stats(`month=${MONTH}&kind=snow`);
      for (const row of dto.rows) {
        const [position] = row.positions;
        const { objectId, code, name, isActive, positions, ...figures } = row;
        void [objectId, code, name, isActive, positions];
        expect(position, row.code).toMatchObject(figures);
      }
    });

    it('площадки B, C, D: крупные суммы точно, без суммы — прочерк, незакрытая — ноль', async () => {
      const dto = await stats(`month=${MONTH}&kind=snow`);
      expect(rowOf(dto, 'b')).toMatchObject({
        removals: 3,
        doneVolumeM3: 25,
        // 999 999 998.99 + 999 999 997.37, exactly; the third removal has no amount yet.
        doneCost: 1_999_999_996.36,
        doneVolumeUnpricedM3: 5,
        unpricedRequests: 1,
        plannedCost: null,
      });
      expect(rowOf(dto, 'c')).toMatchObject({
        doneVolumeM3: 10,
        doneCost: null,
        doneVolumeUnpricedM3: 10,
        unpricedRequests: 1,
      });
      expect(rowOf(dto, 'd')).toMatchObject({
        plannedVolumeM3: 12,
        plannedCost: null,
        doneVolumeM3: 0,
        doneCost: 0,
        unpricedRequests: 0,
        removals: 0,
      });
    });

    it('итог из тех же атомов: суммы точны, без цены — по вывезенному', async () => {
      const dto = await stats(`month=${MONTH}&kind=snow`);
      expect(dto.totals).toMatchObject({
        requests: 10,
        removals: 7,
        plannedVolumeM3: 100,
        plannedCost: null,
        doneVolumeM3: 64,
        doneCost: 2_000_001_496.36,
        doneVolumeUnpricedM3: 24,
        unpricedRequests: 3,
        ticketVolumeM3: 20,
        ticketCost: null,
        ticketFilesUnread: 4,
        ticketFilesWithoutTickets: 1,
      });
      // The price-quality row: snow removed without an amount, out of every request of the set.
      expect(qualityOf(dto, 'waste.requests_without_price')).toMatchObject({ value: 3, outOf: 10 });
    });

    it('пустой ответ снега — без плана и денег по талонам, ноль вывезенного', async () => {
      for (const dto of [
        await stats(`month=${GARBAGE_MONTH}&kind=snow`),
        await stats(`month=${MONTH}&kind=snow`, ctx.emptyScopeAuth),
      ]) {
        expect(dto.totals).toMatchObject({ plannedCost: null, doneCost: 0, ticketCost: null });
      }
    });
  });

  describe('круг читателей и область', () => {
    it('исполнителю вывоза отказ при любом виде', async () => {
      for (const kind of ['', '&kind=snow', '&kind=waste']) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/waste-requests/stats?month=${MONTH}${kind}`,
          headers: ctx.operatorAuth,
        });
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().message).toContain('область ограничена');
      }
    });

    it('площадка видит только свой снег, учётка без площадок — ничего', async () => {
      const own = await stats(`month=${MONTH}&kind=snow`, ctx.siteAuth);
      expect(own.rows.map((r) => r.objectId)).toEqual([ctx.site.a]);
      expect(own.totals.requests).toBe(5);
      // Quality is counted inside the same scope.
      expect(qualityOf(own, 'waste.requests_without_ordered_volume').outOf).toBe(5);

      const empty = await stats(`month=${MONTH}&kind=snow`, ctx.emptyScopeAuth);
      expect(empty.rows).toEqual([]);
      expect(empty.totals.requests).toBe(0);
    });
  });

  /*
   * The ticket-scan counters read the recognition queue by the file id inside the job payload,
   * which is free text. Three claims, each about a value the column never has:
   *
   *   · an UPPERCASE id (a route accepts one) is the same file as the lowercase column;
   *   · a malformed value neither matches a file nor makes the statement fail — a plain
   *     `::uuid` cast of the payload would raise 22P02 for the whole monthly book;
   *   · the payload names the request, which the seeded jobs of the other cases do not (they are
   *     reached through the file row's active job), so these jobs are the only ones that go through
   *     the payload lookup at all.
   */
  describe('очередь распознавания: идентификатор файла в нагрузке задачи', () => {
    async function closedSnow(site: keyof Ctx['site'], day: string): Promise<string> {
      const id = await newRequest({
        site,
        type: 'snow_removal',
        volumeM3: 10,
        deliveryDay: `${QUEUE_MONTH}-${day}`,
        status: 'done',
      });
      await close(id, {
        volumeM3: '10.000',
        removedOn: `${QUEUE_MONTH}-${day}`,
        totalCost: '1000.00',
      });
      return id;
    }

    async function fileOf(requestId: string): Promise<string> {
      const res = await ctx.db.execute<{ file_id: string }>(
        sql`SELECT file_id FROM request_files WHERE request_id = ${requestId} AND kind = 'ticket'`,
      );
      return res.rows[0]!.file_id;
    }

    /** A job of the queue as `enqueueTicketRecognition` writes it, with a payload of our choosing. */
    async function queueJob(
      payload: Record<string, unknown>,
      status: 'pending' | 'running' | 'failed' | 'dead',
    ): Promise<void> {
      await ctx.db.insert(ctx.schema.jobs).values({
        type: 'recognize_waste_ticket_file',
        payload: { ...payload, marker: KEY_PREFIX },
        status,
      });
    }

    async function counters(site: keyof Ctx['site']): Promise<WasteStatsRowDto | undefined> {
      return rowOf(await stats(`month=${QUEUE_MONTH}&kind=snow`), site);
    }

    it('живая задача с id заглавными буквами держит прочитанный без талонов скан «живым»', async () => {
      // A read scan with no ticket on it is "read without tickets" — unless a rerun is in flight.
      const quiet = await closedSnow('a', '03');
      await seedScan(quiet, { status: 'done', pages: ['done'] });
      expect(await counters('a')).toMatchObject({
        ticketFilesUnread: 0,
        ticketFilesWithoutTickets: 1,
      });

      const requestId = await closedSnow('b', '04');
      await seedScan(requestId, { status: 'done', pages: ['done'] });
      const fileId = await fileOf(requestId);
      await queueJob({ requestId, fileId: fileId.toUpperCase() }, 'pending');
      expect(await counters('b')).toMatchObject({
        ticketFilesUnread: 0,
        ticketFilesWithoutTickets: 0,
      });

      // The same job with the lowercase id, the way the API writes it now, reads the same.
      const lower = await closedSnow('c', '05');
      await seedScan(lower, { status: 'done', pages: ['done'] });
      await queueJob({ requestId: lower, fileId: await fileOf(lower) }, 'running');
      expect(await counters('c')).toMatchObject({
        ticketFilesUnread: 0,
        ticketFilesWithoutTickets: 0,
      });
    });

    it('умершая задача с id заглавными буквами у файла без строки обработки — нечитанный скан', async () => {
      // The job died before its first write: the file has no recognition row, only the queue knows.
      const requestId = await closedSnow('d', '06');
      const [file] = await ctx.db
        .insert(ctx.schema.files)
        .values({
          bucket: 'test',
          objectKey: `${KEY_PREFIX}${randomUUID()}`,
          filename: 'талон.pdf',
          contentType: 'application/pdf',
          size: 1024,
          status: 'active',
          uploadedBy: ctx.adminId,
        })
        .returning({ id: ctx.schema.files.id });
      await ctx.db
        .insert(ctx.schema.requestFiles)
        .values({ requestId, fileId: file!.id, kind: 'ticket' });
      await queueJob({ requestId, fileId: file!.id.toUpperCase() }, 'dead');
      expect(await counters('d')).toMatchObject({ ticketFilesUnread: 1 });
    });

    it('битые значения нагрузки не роняют статистику и не засчитываются как файлы', async () => {
      const requestId = await closedSnow('a', '07');
      await seedScan(requestId, { status: 'done', pages: ['done'] });
      const before = await counters('a');
      const fileId = await fileOf(requestId);
      const malformed: unknown[] = [
        'not-a-uuid',
        '',
        // Thirty-six characters of the right shape, none of them hex digits.
        'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
        // A uuid in braces and without hyphens: valid for `::uuid`, never what a route writes.
        `{${fileId}}`,
        fileId.replace(/-/g, ''),
        `${fileId} `,
        null,
        123,
        { nested: fileId },
      ];
      for (const bad of malformed) {
        await queueJob({ requestId, fileId: bad }, 'dead');
      }
      // A payload without the key at all.
      await queueJob({ requestId }, 'dead');

      const after = await counters('a');
      expect(after).toBeDefined();
      expect({
        unread: after?.ticketFilesUnread,
        withoutTickets: after?.ticketFilesWithoutTickets,
      }).toEqual({
        unread: before?.ticketFilesUnread,
        withoutTickets: before?.ticketFilesWithoutTickets,
      });
    });
  });

  describe('сводная книга: «Снег» в «Вывозе мусора» (S9)', () => {
    const period = `from=${MONTH}-01&to=${MONTH}-30&step=month`;

    async function summary(): Promise<AnalyticsSummaryDto> {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/analytics/summary?${period}`,
        headers: ctx.auth,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as AnalyticsSummaryDto;
    }

    /** The ACTUAL workbook the route sends, read back the way the portal reads foreign books. */
    async function workbook(): Promise<SheetOutput[]> {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/analytics/export?${period}`,
        headers: ctx.auth,
      });
      expect(res.statusCode, res.body).toBe(200);
      return readWorkbook(new Uint8Array(res.rawPayload));
    }

    function sheet(sheets: SheetOutput[], name: string): string[][] {
      const found = sheets.find((item) => item.name === name);
      if (!found) throw new Error(`Лист «${name}» не найден`);
      return found.rows;
    }

    function customer(dto: AnalyticsSummaryDto, site: keyof Ctx['site']): AnalyticsCustomerRow {
      const row = dto.rows.find((r) => r.kind === 'object' && r.id === ctx.site[site]);
      if (!row) throw new Error(`Площадки ${site} в своде нет`);
      return row;
    }

    const label = (site: keyof Ctx['site']): string =>
      `${CODE[site]} Площадка снега ${site.toUpperCase()} ${RUN}`;

    /**
     * Rows of one customer block of «Детализация», keyed by their first cell: the block starts with
     * its header row and ends with the blank row before the next customer.
     */
    function detailBlock(rows: string[][], site: keyof Ctx['site']): Map<string, string[]> {
      const start = rows.findIndex((row) => row[0]?.startsWith(`Объект ${label(site)} ·`));
      if (start === -1) throw new Error(`Блока площадки ${site} нет`);
      const block = new Map<string, string[]>();
      for (const row of rows.slice(start + 1)) {
        if ((row[0] ?? '') === '') break;
        block.set(row[0]!, row);
      }
      return block;
    }

    it('сумма двух видов вкладки равна разряду вывоза в своде — по каждой площадке и в итоге', async () => {
      const [dto, waste, snow] = await Promise.all([
        summary(),
        stats(`month=${MONTH}&kind=waste`),
        stats(`month=${MONTH}&kind=snow`),
      ]);
      for (const site of ['a', 'b', 'c', 'd'] as const) {
        const w = rowOf(waste, site);
        const sn = rowOf(snow, site);
        const book = customer(dto, site).byModule.waste;
        const both = (pick: (r: WasteStatsRowDto) => number | null): number =>
          (w ? (pick(w) ?? 0) : 0) + (sn ? (pick(sn) ?? 0) : 0);
        expect(book.volumeM3, site).toBe(both((r) => r.doneVolumeM3));
        expect(book.removals, site).toBe(both((r) => r.removals));
        expect(book.requests, site).toBe(both((r) => r.requests));
        expect(book.money.fact, site).toBe(both((r) => r.doneCost));
        expect(book.money.unpriced, site).toBe(both((r) => r.unpricedRequests));
      }
      expect(dto.totals.waste).toMatchObject({
        volumeM3: waste.totals.doneVolumeM3 + snow.totals.doneVolumeM3,
        removals: waste.totals.removals + snow.totals.removals,
        requests: 12,
        money: { fact: 2_000_003_496.36, low: 1000, high: 1000, unpriced: 3 },
      });
      // The price-quality row: snow removed without an amount; all requests of the set below.
      const price = qualityOf(dto, 'waste.requests_without_price');
      expect(price).toMatchObject({ value: 3, outOf: 12 });
      expect(price.value).toBe(
        qualityOf(waste, 'waste.requests_without_price').value +
          qualityOf(snow, 'waste.requests_without_price').value,
      );
    });

    it('в книге Excel позиция «Снег» отдельно от мусора и несёт числа вкладки', async () => {
      const [sheets, snow] = await Promise.all([workbook(), stats(`month=${MONTH}&kind=snow`)]);
      const detail = sheet(sheets, 'Детализация');
      const titles = detail[2] ?? [];
      const col = (title: string): number => {
        const index = titles.indexOf(title);
        if (index === -1) throw new Error(`Колонки «${title}» нет`);
        return index;
      };
      const numberAt = (row: string[] | undefined, title: string): number =>
        Number(row?.[col(title)]);

      for (const site of ['a', 'b', 'c', 'd'] as const) {
        const block = detailBlock(detail, site);
        const position = block.get(SNOW_WASTE_TYPE_NAME);
        const tab = rowOf(snow, site)!;
        expect(position, site).toBeDefined();
        expect(numberAt(position, 'м³'), site).toBe(tab.doneVolumeM3);
        expect(numberAt(position, 'Вывозов'), site).toBe(tab.removals);
        expect(numberAt(position, 'Заявок'), site).toBe(tab.requests);
        // A dash in the tab is "no amount known"; the book's fact column sums what is known.
        expect(numberAt(position, '₽ факт'), site).toBe(tab.doneCost ?? 0);
        expect(numberAt(position, 'Без цены'), site).toBe(tab.unpricedRequests);
        // Snow has no estimate at all.
        expect(numberAt(position, '₽ оц. ниж.'), site).toBe(0);
      }

      // Site A keeps garbage as its own position beside «Снег», and the module row sums both.
      const a = detailBlock(detail, 'a');
      const garbage = a.get(`ТЕСТ мусор рядом со снегом ${RUN}`);
      expect(numberAt(garbage, 'м³')).toBe(20);
      expect(numberAt(garbage, '₽ факт')).toBe(2000);
      expect(numberAt(garbage, '₽ оц. ниж.')).toBe(1000);
      const module = a.get('Вывоз мусора');
      expect(numberAt(module, 'м³')).toBe(49);
      expect(numberAt(module, 'Вывозов')).toBe(4);
      expect(numberAt(module, 'Заявок')).toBe(7);
      expect(numberAt(module, '₽ факт')).toBe(3500);
      expect(numberAt(module, 'Без цены')).toBe(1);
      // Large legal amounts of site B, exactly.
      expect(numberAt(detailBlock(detail, 'b').get(SNOW_WASTE_TYPE_NAME), '₽ факт')).toBe(
        1_999_999_996.36,
      );
    });

    it('свод и «Всего» в книге — точные суммы, «итого» сложено до округления', async () => {
      const rows = sheet(await workbook(), 'Свод');
      const groups = rows[2] ?? [];
      const titles = rows[3] ?? [];
      /** A column inside its two-storey header: the group cell, then the title under it. */
      const col = (group: string, title: string): number => {
        const start = groups.indexOf(group);
        if (start === -1) throw new Error(`Группы «${group}» нет`);
        for (let i = start; i < titles.length; i += 1) {
          if (i > start && (groups[i] ?? '') !== '') break;
          if (titles[i] === title) return i;
        }
        throw new Error(`Колонки «${group} · ${title}» нет`);
      };
      const line = (first: string): string[] => {
        const row = rows.find((r) => r[0] === first);
        if (!row) throw new Error(`Строки «${first}» нет`);
        return row;
      };
      const b = line(label('b'));
      expect(Number(b[col('Вывоз мусора', 'м³')])).toBe(25);
      expect(Number(b[col('Деньги, ₽', 'факт')])).toBe(1_999_999_996.36);
      expect(Number(b[col('Деньги, ₽', 'без цены')])).toBe(1);
      const c = line(label('c'));
      expect(Number(c[col('Деньги, ₽', 'факт')])).toBe(0);
      expect(Number(c[col('Деньги, ₽', 'без цены')])).toBe(1);

      const total = line('Всего');
      expect(Number(total[col('Вывоз мусора', 'м³')])).toBe(84);
      expect(Number(total[col('Деньги, ₽', 'факт')])).toBe(2_000_003_496.36);
      expect(Number(total[col('Деньги, ₽', 'итого ниж.')])).toBe(2_000_004_496.36);
      expect(Number(total[col('Деньги, ₽', 'без цены')])).toBe(3);
    });

    it('лист «Данные», «Качество» и методика говорят о снеге то же самое', async () => {
      const sheets = await workbook();
      const data = sheet(sheets, 'Данные');
      const head = data[0] ?? [];
      const at = (title: string): number => head.indexOf(title);
      const snowRows = data.slice(1).filter((row) => row[at('Позиция')] === SNOW_WASTE_TYPE_NAME);
      expect(snowRows).toHaveLength(10);
      const fact = snowRows.reduce(
        (sum, row) => sum + Math.round(Number(row[at('₽ факт')]) * 100),
        0,
      );
      expect(fact).toBe(200_000_149_636);

      const quality = new Map(sheet(sheets, 'Качество').map((row) => [row[0], row[1]]));
      expect(quality.get('Заявок вывоза без цены')).toBe('3 из 12 (25 %)');

      const parameters = sheet(sheets, 'Параметры');
      expect(parameters.find((row) => row[0] === 'Вывоз снега')?.[1]).toContain(
        'внесённая при закрытии',
      );
      const method = parameters.find((row) => row[0] === 'Деньги, ₽ · без цены');
      expect(method?.[1]).toContain('снега');
    });
  });
});
