import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceRequestBulkResultDto, ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Letters to the request author (ADR 0227) on the live schema and through the real routes — the
 * test matrix of the decision (§5), row by row.
 *
 * What is worth checking is not that a letter was composed, but WHEN, HOW MANY and TO WHOM: the
 * author is the only addressee (D1), his own act never mails him, a staff member who already gets
 * the service letter about the same fact gets no second one (E3), the two switches are independent
 * of the service ones (D5), and Reply-To is the portal's general address, never empty (D4, E5).
 *
 * Row 3 of the matrix (imported executor notes) lives in `service-chat-contracts.test.ts`: no
 * route writes an `import` message, and `chatMailTargets` gives that origin no target at all.
 *
 * Run (an own database, empty or migrated — the file applies migrations itself):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_requester_mail_test \
 *     pnpm --filter @technic/api test service-request-requester-mail
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'Test-Password-123';
const SERVICE_MAILBOX = `repair-rq-${RUN}@example.invalid`;
const PORTAL_FROM = `portal-rq-${RUN}@example.invalid`;
const PORTAL_REPLY_TO = `noreply-rq-${RUN}@example.invalid`;
const CONTRACTOR_MAILBOX = `contractor-rq-${RUN}@example.invalid`;
const COPY_MAILBOX = `copy-rq-${RUN}@example.invalid`;
const INTERNAL_TOKEN = `internal-rq-${RUN}`;
const SERVICE_INN = String(7_000_000_000 + Math.floor(Math.random() * 999_999_999));

const COMMENT = 'service_request_requester_comment';
const STATUS = 'service_request_requester_status';

interface Auth {
  authorization: string;
}

interface Person {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: Person;
  /** The request author: shtab on the site, no grants of the module. */
  author: Person;
  /** «Ведение» on the same site: in the author's customer scope AND a side of the discussion. */
  colleague: Person;
  /** A named executor of the in-house repairs (`office_equipment_executor`). */
  exec: Person;
  /** Staff who file requests and are also their named executor (E3). */
  staffAuthor: Person;
  /** Authors who will leave: deactivated and deleted after filing (row 6). */
  leaver: Person;
  goner: Person;
  serviceCounterpartyId: string;
  newEquipment: (tag: string) => Promise<string>;
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
  process.env.INTERNAL_API_TOKEN = INTERNAL_TOKEN;
  process.env.MAIL_ENABLED = 'true';
  process.env.MAIL_TRANSPORT = 'log';
  // The default channel's addresses: Reply-To of every letter to the author (D4, E5).
  process.env.MAIL_FROM = `Портал <${PORTAL_FROM}>`;
  process.env.MAIL_REPLY_TO = PORTAL_REPLY_TO;
  // The `repair` channel: the sender of module letters (D7) and the service mailbox.
  process.env.MAIL_ACCOUNT_REPAIR_HOST = 'm.example.invalid';
  process.env.MAIL_ACCOUNT_REPAIR_FROM = `Ремонт <${SERVICE_MAILBOX}>`;
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

let addressNo = 0;
function nextAddress(): string {
  addressNo += 1;
  return `10.41.${(addressNo >> 8) & 0xff}.${addressNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return ctx.app.inject({
    method,
    url,
    headers: { ...auth, ...headers },
    remoteAddress: nextAddress(),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Moscow calendar day: the completion date may not be in the future of the portal's calendar. */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
}

interface Letter {
  kind: string;
  to_email: string;
  reply_to: string;
  account: string;
  subject: string;
  dedupe_key: string;
  body_text: string;
}

async function lettersOf(requestId: string): Promise<Letter[]> {
  const res = await ctx.db.execute<Letter>(sql`
    SELECT kind::text AS kind, to_email::text AS to_email, reply_to, account, subject, dedupe_key,
           body_text
      FROM mail_messages
     WHERE entity_type = 'serviceRequest' AND entity_id = ${requestId}
     ORDER BY created_at, id`);
  return res.rows;
}

/** The author's letters of one kind on one request. */
async function requesterLetters(requestId: string, kind: string = STATUS): Promise<Letter[]> {
  return (await lettersOf(requestId)).filter((l) => l.kind === kind);
}

interface PlannedAudit {
  event: string;
  outcome: string;
  skip?: string;
  targets: Record<string, string>;
}

/** The latest planner trace of a requester event on the request (E2: own audit row). */
async function lastRequesterAudit(requestId: string, event: string): Promise<PlannedAudit> {
  const res = await ctx.db.execute<{ metadata: PlannedAudit }>(sql`
    SELECT metadata FROM audit_log
     WHERE action = 'serviceRequest.mailPlanned' AND entity_id = ${requestId}
       AND metadata->>'event' = ${event}
     ORDER BY created_at DESC, id DESC LIMIT 1`);
  const row = res.rows[0];
  if (!row) throw new Error(`no planner trace of ${event} on ${requestId}`);
  return row.metadata;
}

async function version(id: string): Promise<number> {
  const res = await ctx.db.execute<{ version: number }>(
    sql`SELECT version FROM service_requests WHERE id = ${id}`,
  );
  return Number(res.rows[0]!.version);
}

async function createRequest(by: Person, tag: string): Promise<ServiceRequestDto> {
  const res = await inject('POST', '/api/v1/service-requests', by.auth, {
    officeEquipmentId: await ctx.newEquipment(tag),
    description: `Описание заявки ${tag}`,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { request: ServiceRequestDto }).request;
}

async function patch(id: string, step: string, body: object, by: Person = ctx.admin) {
  const res = await inject('PATCH', `/api/v1/service-requests/${id}/${step}`, by.auth, {
    ...body,
    version: await version(id),
  });
  expect(res.statusCode, `${step}: ${res.body}`).toBe(200);
  return res;
}

/** In-house repair: a named executor, no service company — closes by date, without documents. */
async function assignInHouse(id: string, userId: string = ctx.exec.id): Promise<void> {
  const res = await inject('PUT', `/api/v1/service-requests/${id}/executors`, ctx.admin.auth, {
    userIds: [userId],
    serviceCounterpartyId: null,
    version: await version(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function assignService(id: string): Promise<void> {
  const res = await inject('PUT', `/api/v1/service-requests/${id}/executors`, ctx.admin.auth, {
    userIds: [],
    serviceCounterpartyId: ctx.serviceCounterpartyId,
    version: await version(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function complete(id: string): Promise<void> {
  await patch(id, 'complete', { completedOn: today(), items: [] });
}

async function say(
  id: string,
  by: Person,
  addressees: { sides?: string[]; users?: string[] },
  body: string,
) {
  const res = await inject('POST', `/api/v1/service-requests/${id}/messages`, by.auth, {
    body,
    addressees,
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Flip a switch for the duration of a check and put it back AS IT WAS. */
async function withEventState<T>(event: string, enabled: boolean, fn: () => Promise<T>) {
  const before = await ctx.db.execute<{ is_enabled: boolean }>(sql`
    SELECT is_enabled FROM module_mail_event_settings WHERE event = ${event}`);
  const was = before.rows[0]?.is_enabled ?? false;
  await ctx.db.execute(sql`
    UPDATE module_mail_event_settings SET is_enabled = ${enabled} WHERE event = ${event}`);
  try {
    return await fn();
  } finally {
    await ctx.db.execute(sql`
      UPDATE module_mail_event_settings SET is_enabled = ${was} WHERE event = ${event}`);
  }
}

describe.skipIf(!DB_URL)('письма заявителю (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`RQ-${RUN}`}, ${`Площадка писем заявителю ${RUN}`}, 'г Москва, ул Тестовая, д 7')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]!.id;

    const counterparty = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn, email)
      VALUES ('service', ${`Сервис заявителя ${RUN}`}, ${SERVICE_INN}, ${CONTRACTOR_MAILBOX})
      RETURNING id`);

    const app = await buildApp();
    async function login(email: string): Promise<Auth> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    }

    async function makeUser(tag: string, role: string, grants: string[] = []): Promise<Person> {
      const email = `db-rq-${tag}-${RUN}@example.invalid`;
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Заявителев', 'Тест', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      const id = row.rows[0]!.id;
      if (role !== 'admin') {
        await db.execute(sql`
          INSERT INTO user_construction_objects (user_id, construction_object_id)
          VALUES (${id}, ${objectId})`);
      }
      for (const code of grants) {
        await db.execute(sql`
          INSERT INTO user_grants (user_id, grant_id)
          SELECT ${id}, g.id FROM grants g WHERE g.code = ${code}`);
      }
      return { id, email, auth: await login(email) };
    }

    const admin = await makeUser('admin', 'admin');
    ctx = {
      app,
      db,
      closeDb,
      admin,
      author: await makeUser('author', 'shtab'),
      colleague: await makeUser('colleague', 'shtab', ['office_equipment_operator']),
      exec: await makeUser('exec', 'shtab', ['office_equipment_executor']),
      staffAuthor: await makeUser('staff', 'shtab', ['office_equipment_executor']),
      leaver: await makeUser('leaver', 'shtab'),
      goner: await makeUser('goner', 'shtab'),
      serviceCounterpartyId: counterparty.rows[0]!.id,
      newEquipment: async (tag: string) => {
        const row = await db.execute<{ id: string }>(sql`
          INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id)
          VALUES (${typeId}, ${`МФУ ${tag} ${RUN}`}, ${`РЗ-${RUN}-${tag}`}, ${objectId})
          RETURNING id`);
        return row.rows[0]!.id;
      },
    };
  }, 180_000);

  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      const equipment = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE ${`РЗ-${RUN}-%`}`;
      const requests = sql`SELECT id FROM service_requests WHERE office_equipment_id IN (${equipment})`;
      const people = sql`SELECT id FROM users WHERE email LIKE ${`db-rq-%-${RUN}@example.invalid`}`;
      const bulkOps = sql`SELECT id FROM service_request_bulk_operations WHERE actor_user_id IN (${people})`;
      await ctx.db.execute(sql`DELETE FROM mail_messages WHERE entity_id IN (${requests})
                                  OR entity_id IN (${bulkOps})`);
      await ctx.db.execute(sql`DELETE FROM mail_messages WHERE to_email = ${COPY_MAILBOX}`);
      await ctx.db.execute(sql`DELETE FROM jobs WHERE type = 'send_email'
        AND (payload->>'mailMessageId')::uuid NOT IN (SELECT id FROM mail_messages)`);
      await ctx.db.execute(
        sql`DELETE FROM service_request_bulk_operations WHERE id IN (${bulkOps})`,
      );
      await ctx.db.execute(sql`DELETE FROM service_request_status_history
        WHERE request_id IN (${requests})`);
      await ctx.db.execute(sql`DELETE FROM service_requests WHERE id IN (${requests})`);
      await ctx.db.execute(sql`DELETE FROM office_equipment WHERE id IN (${equipment})`);
      await ctx.db.execute(sql`
        DELETE FROM office_equipment_models m
         WHERE m.name LIKE ${`% ${RUN}`}
           AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
      await ctx.db.execute(
        sql`DELETE FROM module_mail_recipients WHERE to_email = ${COPY_MAILBOX}`,
      );
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${people})`);
      await ctx.db.execute(sql`DELETE FROM users WHERE id IN (${people})`);
      await ctx.db.execute(sql`DELETE FROM counterparties WHERE inn = ${SERVICE_INN}`);
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${`RQ-${RUN}`}`);
      await ctx.closeDb();
    }
  });

  // ── Messages (rows 1, 2, 8, 9) ──

  it('1. «Заявителю» и «Всем участникам» — по письму автору; прочие адресаты — ни одного', async () => {
    const request = await createRequest(ctx.author, 'r1');
    await assignInHouse(request.id);

    await say(request.id, ctx.admin, { sides: ['customer'] }, 'Уточните кабинет');
    expect(await requesterLetters(request.id, COMMENT)).toHaveLength(1);
    await say(request.id, ctx.admin, { sides: ['all'] }, 'Запчасть заказана');
    expect(await requesterLetters(request.id, COMMENT)).toHaveLength(2);

    for (const side of ['operator', 'it', 'service']) {
      await say(request.id, ctx.admin, { sides: [side] }, `Реплика стороне ${side}`);
    }
    await say(request.id, ctx.admin, { users: [ctx.exec.id] }, 'Реплика исполнителю');
    const letters = await requesterLetters(request.id, COMMENT);
    expect(letters).toHaveLength(2);
    // The author alone, and not a single other letter to his address.
    expect(new Set(letters.map((l) => l.to_email))).toEqual(new Set([ctx.author.email]));
    expect(
      (await lettersOf(request.id)).filter((l) => l.to_email === ctx.author.email),
    ).toHaveLength(2);
  });

  it('9. канал repair, обратный адрес — общий адрес портала, ссылка открывает обсуждение', async () => {
    const request = await createRequest(ctx.author, 'r9');
    await say(request.id, ctx.admin, { sides: ['customer'] }, 'Пришлите фото дисплея');
    const [letter] = await requesterLetters(request.id, COMMENT);
    expect(letter).toBeDefined();
    expect(letter!.account).toBe('repair');
    // Set explicitly and never empty: empty would let the channel's Reply-To — the service
    // mailbox — win in the worker transport (E5).
    expect(letter!.reply_to).toBe(PORTAL_REPLY_TO);
    expect(letter!.subject).toBe(`${request.displayNumber} · Новое сообщение по вашей заявке`);
    expect(letter!.body_text).toContain('Пришлите фото дисплея');
    expect(letter!.body_text).toContain(`/office-equipment?tab=requests&open=${request.id}&chat=1`);
    expect(letter!.body_text).toContain('Отвечать на это письмо не нужно');
    expect(letter!.dedupe_key.split(':')[2]).toBe(ctx.author.id);
  });

  it('9. без MAIL_REPLY_TO обратный адрес — адрес MAIL_FROM; без обоих письма нет', async () => {
    const { config } = await import('../src/config');
    const { requesterMailConfig } = await import('../src/services/service-request-requester-mail');
    const was = { replyTo: config.mail.replyTo, from: config.mail.from };
    try {
      config.mail.replyTo = '';
      expect(requesterMailConfig()).toMatchObject({ outcome: null, replyTo: PORTAL_FROM });
      config.mail.from = '';
      expect(requesterMailConfig()).toMatchObject({ outcome: 'channel_missing', replyTo: '' });
    } finally {
      config.mail.replyTo = was.replyTo;
      config.mail.from = was.from;
    }
  });

  it('2. своё сообщение автору не приходит; сообщение коллеги «Всем участникам» — приходит', async () => {
    const request = await createRequest(ctx.author, 'r2');
    await say(request.id, ctx.author, { sides: ['all'] }, 'Аппарат снова зажевал бумагу');
    expect(await requesterLetters(request.id, COMMENT)).toHaveLength(0);
    expect(await lastRequesterAudit(request.id, COMMENT)).toMatchObject({
      outcome: 'not_needed',
      skip: 'actor_is_author',
    });

    await say(request.id, ctx.colleague, { sides: ['all'] }, 'Посмотрю после обеда');
    const letters = await requesterLetters(request.id, COMMENT);
    expect(letters.map((l) => l.to_email)).toEqual([ctx.author.email]);
    expect(letters[0]!.body_text).toContain('Посмотрю после обеда');
  });

  it('8. рубильники независимы в обе стороны', async () => {
    const request = await createRequest(ctx.author, 'r8');
    await assignService(request.id);

    // The service comment event off: the author's letter still goes.
    await withEventState('service_request_comment', false, async () => {
      await say(request.id, ctx.admin, { sides: ['all'] }, 'Сервис приедет завтра');
    });
    expect(await requesterLetters(request.id, COMMENT)).toHaveLength(1);
    expect(
      (await lettersOf(request.id)).filter((l) => l.kind === 'service_request_comment'),
    ).toHaveLength(0);

    // The requester event off: `event_off` in the audit, the contractor's letter goes.
    await withEventState(COMMENT, false, async () => {
      await say(request.id, ctx.admin, { sides: ['all'] }, 'Сервис перенёс визит');
    });
    expect(await requesterLetters(request.id, COMMENT)).toHaveLength(1);
    expect(await lastRequesterAudit(request.id, COMMENT)).toMatchObject({ outcome: 'event_off' });
    const contractor = (await lettersOf(request.id)).filter(
      (l) => l.kind === 'service_request_comment' && l.to_email === CONTRACTOR_MAILBOX,
    );
    expect(contractor).toHaveLength(1);
    expect(contractor[0]!.body_text).toContain('Сервис перенёс визит');
  });

  // ── State changes (rows 4, 5, 10) ──

  it('4. весь цикл: каждый вход в «В работе», «Отложена», «Решена», «Закрыта» — письмо', async () => {
    const request = await createRequest(ctx.author, 'r4');
    // Entering «Новая» (creation) and a reassignment that keeps the status: no letter.
    await assignInHouse(request.id);
    expect(await requesterLetters(request.id)).toHaveLength(0);

    const steps: Array<[string, object, string]> = [
      ['start', {}, 'Заявку приняли в работу'],
      [
        'hold',
        { reason: 'Ждём запчасть от поставщика' },
        'Заявку отложили. Причина: Ждём запчасть от поставщика',
      ],
      ['resume', {}, 'Заявку приняли в работу'],
      [
        'complete',
        { completedOn: today(), items: [] },
        'Работы по заявке выполнены. Если неисправность осталась — напишите в обсуждении заявки в портале',
      ],
      ['rework', { reason: 'Снова полосит' }, 'Заявку приняли в работу'],
      ['complete', { completedOn: today(), items: [] }, 'Работы по заявке выполнены'],
      ['accept', {}, 'Заявка закрыта'],
    ];
    for (const [i, [step, body, line]] of steps.entries()) {
      await patch(request.id, step, body);
      const letters = await requesterLetters(request.id);
      expect(letters, `${step}`).toHaveLength(i + 1);
      const last = letters.at(-1)!;
      expect(last.to_email).toBe(ctx.author.email);
      expect(last.reply_to).toBe(PORTAL_REPLY_TO);
      expect(last.body_text).toContain(line);
    }
    const letters = await requesterLetters(request.id);
    expect(letters.at(-1)!.subject).toBe(`${request.displayNumber} · Заявка закрыта`);
    expect(letters.at(-1)!.body_text).toContain(
      `/office-equipment?tab=requests&open=${request.id}`,
    );
    expect(letters.at(-1)!.body_text).not.toContain('chat=1');
  });

  it('4. автозакрытие — письмо «Заявка закрыта автоматически»', async () => {
    const request = await createRequest(ctx.author, 'r4auto');
    await assignInHouse(request.id);
    await patch(request.id, 'start', {});
    await complete(request.id);
    await ctx.db.execute(sql`
      UPDATE service_requests SET completed_at = now() - interval '2 days' WHERE id = ${request.id}`);
    const before = (await requesterLetters(request.id)).length;

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/internal/service-requests/auto-close',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
      remoteAddress: nextAddress(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const closed = await ctx.db.execute<{ status: string }>(
      sql`SELECT status::text AS status FROM service_requests WHERE id = ${request.id}`,
    );
    expect(closed.rows[0]!.status).toBe('accepted');

    const letters = await requesterLetters(request.id);
    expect(letters).toHaveLength(before + 1);
    expect(letters.at(-1)!.subject).toBe(`${request.displayNumber} · Заявка закрыта автоматически`);
    // The service side stays silent on auto-close, as before (§7 of the decision).
    expect(
      (await lettersOf(request.id)).filter(
        (l) => l.kind === 'service_request_status_changed' && l.body_text.includes('Закрыта'),
      ),
    ).toHaveLength(0);
  });

  it('4. отмена статусом и откат в «Новую»: письмо об отмене с причиной, о «Новой» — нет', async () => {
    const request = await createRequest(ctx.author, 'r4cancel');
    await patch(request.id, 'status', { status: 'cancelled', reason: 'Аппарат списали' });
    const letters = await requesterLetters(request.id);
    expect(letters).toHaveLength(1);
    expect(letters[0]!.subject).toBe(`${request.displayNumber} · Заявка отменена`);
    expect(letters[0]!.body_text).toContain('Заявка отменена. Причина: Аппарат списали');

    await patch(request.id, 'status', { status: 'new' });
    expect(await requesterLetters(request.id)).toHaveLength(1);
  });

  it('4 и 10. отказ по объёму работ — письмо об отмене; ни суммы, ни вложений, ни документов', async () => {
    const request = await createRequest(ctx.author, 'r4refuse');
    await assignService(request.id);
    await patch(request.id, 'start', {});
    const items = await inject(
      'PUT',
      `/api/v1/service-requests/${request.id}/estimate`,
      ctx.admin.auth,
      {
        items: [{ kind: 'part', name: 'Ролик подачи', quantity: 1, unitPrice: 2500 }],
        version: await version(request.id),
      },
    );
    expect(items.statusCode, items.body).toBe(200);
    await patch(request.id, 'estimate/submit', { warrantyRepair: false });
    // A document with a telling name: the author's body must name neither it nor the count.
    const file = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
      VALUES ('test', ${`rq/${RUN}/${randomUUID()}`}, 'schet-4412.pdf', 'application/pdf', 1024,
              'active', ${ctx.admin.id})
      RETURNING id`);
    await ctx.db.execute(sql`
      INSERT INTO service_request_files (request_id, file_id, kind, attached_by)
      VALUES (${request.id}, ${file.rows[0]!.id}, 'invoice', ${ctx.admin.id})`);
    const before = (await requesterLetters(request.id)).length;

    await patch(request.id, 'estimate/approval', {
      approved: false,
      reason: 'Ремонт дороже нового аппарата',
      resolution: 'Покупаем новый аппарат',
    });
    const letters = await requesterLetters(request.id);
    expect(letters).toHaveLength(before + 1);
    const letter = letters.at(-1)!;
    expect(letter.subject).toBe(`${request.displayNumber} · Заявка отменена`);
    expect(letter.body_text).toContain('Заявка отменена. Причина: Ремонт дороже нового аппарата');
    // The requester card projection (E4): no money, no attachments count, no document names.
    expect(letter.body_text).not.toMatch(/2\s500/u);
    expect(letter.body_text).not.toContain('Объём работ');
    expect(letter.body_text).not.toContain('Вложений');
    expect(letter.body_text).not.toContain('schet-4412');
    expect(letter.body_text).not.toContain('Заявку завёл');
    // The data was there: the service mailbox reads the count in its own letter about the fact.
    const toService = (await lettersOf(request.id)).find(
      (l) => l.kind === 'service_request_cancelled' && l.to_email === SERVICE_MAILBOX,
    );
    expect(toService?.body_text).toContain('Вложений в заявке: 1');
  });

  /**
   * The author is «Ведение» here: a plain requester has no `serviceRequests.status`, and the arc
   * to «Отменена» is a status move. Who the author is matters only by id (E3).
   */
  it('5. автор сам отменил заявку — письма нет, след в журнале', async () => {
    const request = await createRequest(ctx.colleague, 'r5');
    await patch(
      request.id,
      'status',
      { status: 'cancelled', reason: 'Сам починил' },
      ctx.colleague,
    );
    expect(await requesterLetters(request.id)).toHaveLength(0);
    expect(await lastRequesterAudit(request.id, STATUS)).toMatchObject({
      outcome: 'not_needed',
      skip: 'actor_is_author',
    });
  });

  it('6. автор отключён или удалён — письма нет, исход no_recipients', async () => {
    const left = await createRequest(ctx.leaver, 'r6left');
    const gone = await createRequest(ctx.goner, 'r6gone');
    await ctx.db.execute(sql`UPDATE users SET is_active = false WHERE id = ${ctx.leaver.id}`);
    await ctx.db.execute(
      sql`UPDATE users SET is_active = false, deleted_at = now() WHERE id = ${ctx.goner.id}`,
    );
    for (const request of [left, gone]) {
      await patch(request.id, 'status', { status: 'cancelled', reason: 'Сотрудник уволился' });
      expect(await requesterLetters(request.id)).toHaveLength(0);
      expect(await lastRequesterAudit(request.id, STATUS)).toMatchObject({
        outcome: 'no_recipients',
        skip: 'author_unreachable',
        targets: { requester: 'no_recipients' },
      });
    }
  });

  it('7. автор получает письмо службы — второго нет; служебное выключено — письмо заявителю', async () => {
    const request = await createRequest(ctx.staffAuthor, 'r7');
    await assignInHouse(request.id, ctx.staffAuthor.id);

    // The assignment letter he got as the named executor is another fact: count from here.
    const assigned = new Set((await lettersOf(request.id)).map((l) => l.dedupe_key));
    const mineSince = async () =>
      (await lettersOf(request.id)).filter(
        (l) => l.to_email === ctx.staffAuthor.email && !assigned.has(l.dedupe_key),
      );

    await patch(request.id, 'start', {});
    // One letter about «taken into work»: the service one, internal body, as a named executor.
    expect((await mineSince()).map((l) => l.kind)).toEqual(['service_request_status_changed']);
    expect(await lastRequesterAudit(request.id, STATUS)).toMatchObject({
      outcome: 'not_needed',
      skip: 'service_letter_covers_author',
    });

    await withEventState('service_request_status_changed', false, async () => {
      await patch(request.id, 'hold', { reason: 'Нет картриджа' });
    });
    const after = await mineSince();
    expect(after.map((l) => l.kind)).toEqual(['service_request_status_changed', STATUS]);
    expect(after.at(-1)!.body_text).toContain('Заявку отложили. Причина: Нет картриджа');
  });

  it('11. сверх потолка — сводка автору со ссылкой и обратным адресом портала', async () => {
    const { config } = await import('../src/config');
    const was = config.serviceRequests.mailMaxPerRequestHour;
    config.serviceRequests.mailMaxPerRequestHour = 1;
    const request = await createRequest(ctx.author, 'r11');
    try {
      for (const body of ['Первое', 'Второе', 'Третье']) {
        await say(request.id, ctx.admin, { sides: ['customer'] }, `${body} сообщение`);
      }
    } finally {
      config.serviceRequests.mailMaxPerRequestHour = was;
    }
    const usual = await requesterLetters(request.id, COMMENT);
    expect(usual).toHaveLength(1);
    expect(usual[0]!.body_text).toContain('Первое сообщение');
    const summaries = (await lettersOf(request.id)).filter(
      (l) => l.kind === 'service_request_activity_summary' && l.to_email === ctx.author.email,
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.reply_to).toBe(PORTAL_REPLY_TO);
    // The author has a portal: the summary keeps the link (E6) and says not to reply by mail.
    expect(summaries[0]!.body_text).toContain(`office-equipment?tab=requests&open=${request.id}`);
    expect(summaries[0]!.body_text).toContain('Отвечать на это письмо не нужно');
    expect(summaries[0]!.body_text).not.toContain('Второе сообщение');
  });

  it('12. массовая отмена трёх заявок автора — одна сводка в три строки, ответ на адрес портала', async () => {
    const requests = [
      await createRequest(ctx.author, 'r12a'),
      await createRequest(ctx.author, 'r12b'),
      await createRequest(ctx.author, 'r12c'),
    ];
    const rows = [];
    for (const r of requests) rows.push({ id: r.id, version: await version(r.id) });
    const res = await inject(
      'POST',
      '/api/v1/service-requests/bulk',
      ctx.admin.auth,
      { operation: 'cancel', rows, reason: 'Офис переезжает' },
      { 'idempotency-key': randomUUID() },
    );
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json() as ServiceRequestBulkResultDto;
    expect(result.done).toBe(3);

    // No letter per request: the bulk sink folds them into the digest (E7).
    for (const r of requests) expect(await requesterLetters(r.id)).toHaveLength(0);
    const digests = await ctx.db.execute<Letter>(sql`
      SELECT kind::text AS kind, to_email::text AS to_email, reply_to, account, subject,
             dedupe_key, body_text
        FROM mail_messages
       WHERE kind = 'service_request_bulk_summary' AND entity_id = ${result.operationId}
         AND to_email = ${ctx.author.email}`);
    expect(digests.rows).toHaveLength(1);
    const digest = digests.rows[0]!;
    expect(digest.reply_to).toBe(PORTAL_REPLY_TO);
    for (const r of requests) {
      expect(digest.body_text).toContain(`${r.displayNumber} · Заявка отменена`);
    }
    expect(digest.body_text).toContain('Отвечать на это письмо не нужно');
  });

  it('13. повтор того же факта — одно письмо', async () => {
    const request = await createRequest(ctx.author, 'r13');
    await patch(request.id, 'status', { status: 'cancelled', reason: 'Дубль заявки' });
    const [letter] = await requesterLetters(request.id);
    const anchor = letter!.dedupe_key.split(':')[1]!;
    const { queueRequesterMail } = await import('../src/services/service-request-requester-mail');
    await ctx.db.transaction((tx) =>
      queueRequesterMail(tx, {
        event: STATUS,
        requestId: request.id,
        anchor,
        actorId: ctx.admin.id,
        serviceRecipients: [],
        extra: { fromStatus: 'new', toStatus: 'cancelled', comment: 'Дубль заявки' },
      }),
    );
    expect(await requesterLetters(request.id)).toHaveLength(1);
  });

  it('копия на событие заявителя получает урезанное тело (E12)', async () => {
    const copy = await inject('POST', '/api/v1/admin/mail/recipients', ctx.admin.auth, {
      event: COMMENT,
      toEmail: COPY_MAILBOX,
      replyToMode: 'portal',
    });
    expect(copy.statusCode, copy.body).toBe(201);
    const copyId = (copy.json() as { id: string }).id;
    try {
      const request = await createRequest(ctx.author, 'rcopy');
      await say(request.id, ctx.admin, { sides: ['customer'] }, 'Секретный текст сообщения');
      const letters = await requesterLetters(request.id, COMMENT);
      expect(letters.map((l) => l.to_email).sort()).toEqual(
        [ctx.author.email, COPY_MAILBOX].sort(),
      );
      const toCopy = letters.find((l) => l.to_email === COPY_MAILBOX)!;
      expect(toCopy.body_text).not.toContain('Секретный текст сообщения');
      expect(toCopy.body_text).not.toContain('office-equipment?tab=requests');
      const toAuthor = letters.find((l) => l.to_email === ctx.author.email)!;
      expect(toAuthor.body_text).toContain('Секретный текст сообщения');
    } finally {
      const removed = await inject(
        'DELETE',
        `/api/v1/admin/mail/recipients/${copyId}`,
        ctx.admin.auth,
      );
      expect(removed.statusCode).toBe(204);
    }
  });
});
