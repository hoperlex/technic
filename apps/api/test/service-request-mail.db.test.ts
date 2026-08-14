import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Письма службе по заявке на обслуживание (план `docs/office-equipment-mail-and-history-plan.md`,
 * Р65–Р70, Р91).
 *
 * Ценность проверки не в том, что письмо составилось, а в том, **когда** оно составилось и сколько
 * их вышло. Событие привязано к входу в статус, а не к ручке: «Новой» заявка бывает и при
 * заведении, и вернувшись откатом, — и служба ждёт её в обоих случаях. Ключ дедупликации при этом
 * обязан различать и повторные циклы, и адресатов: уникальность очереди — `(kind, dedupe_key)`, и
 * ошибка здесь означает не лишнее письмо, а **молча пропавшее**.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test service-request-mail
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'Test-Password-123';
const SERVICE_MAILBOX = `repair-${RUN}@example.invalid`;
const COPY_MAILBOX = `copy-${RUN}@example.invalid`;

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: Auth;
  customer: Auth;
  customerEmail: string;
  /** Своя единица на каждый сценарий: по одной технике незакрытая заявка бывает только одна. */
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
  process.env.MAIL_ENABLED = 'true';
  process.env.MAIL_TRANSPORT = 'log';
  // Канал службы настроен: он и отправитель, и получатель писем модуля (Р88).
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

let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.30.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(method: 'GET' | 'POST' | 'PATCH', url: string, auth: Auth, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

/** Письма по заявке — те, что журнал записал на её сущность. */
async function mailsOf(requestId: string) {
  const res = await ctx.db.execute<{
    kind: string;
    to_email: string;
    reply_to: string;
    account: string;
    subject: string;
    dedupe_key: string;
  }>(sql`SELECT kind, to_email, reply_to, account, subject, dedupe_key FROM mail_messages
          WHERE entity_type = 'serviceRequest' AND entity_id = ${requestId}
          ORDER BY created_at`);
  return res.rows;
}

async function createRequest(equipmentId: string, description: string) {
  const res = await inject('POST', '/api/v1/service-requests', ctx.customer, {
    officeEquipmentId: equipmentId,
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { request: ServiceRequestDto; mail: string };
}

describe.skipIf(!DB_URL)('письма службе по заявке (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`SM-${RUN}`}, ${`Площадка писем ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    async function makeUser(tag: string, role: string): Promise<string> {
      const email = `db-sm-${tag}-${RUN}@example.invalid`;
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      if (role !== 'admin') {
        await db.execute(sql`
          INSERT INTO user_construction_objects (user_id, construction_object_id)
          VALUES (${row.rows[0]!.id}, ${objectId})`);
      }
      return email;
    }

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]!.id;

    const equipment = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id)
        VALUES (${typeId}, ${`МФУ ${tag}`}, ${`СМ-${RUN}-${tag}`}, ${objectId})
        RETURNING id`);
      return row.rows[0]!.id;
    };

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

    const adminEmail = await makeUser('admin', 'admin');
    const customerEmail = await makeUser('cust', 'shtab');
    ctx = {
      app,
      db,
      closeDb,
      admin: await login(adminEmail),
      customer: await login(customerEmail),
      customerEmail,
      newEquipment: equipment,
    };
  }, 120_000);

  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      const requests = sql`SELECT id FROM service_requests WHERE office_equipment_id IN (
        SELECT id FROM office_equipment WHERE inventory_number LIKE ${`СМ-${RUN}-%`})`;
      await ctx.db.execute(sql`DELETE FROM mail_messages WHERE entity_id IN (${requests})`);
      await ctx.db.execute(sql`DELETE FROM jobs WHERE type = 'send_email'
        AND (payload->>'mailMessageId')::uuid NOT IN (SELECT id FROM mail_messages)`);
      await ctx.db.execute(sql`DELETE FROM service_request_status_history
        WHERE request_id IN (${requests})`);
      await ctx.db.execute(sql`DELETE FROM service_requests WHERE id IN (${requests})`);
      await ctx.db.execute(
        sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`СМ-${RUN}-%`}`,
      );
      await ctx.db.execute(
        sql`DELETE FROM module_mail_recipients WHERE to_email = ${COPY_MAILBOX}`,
      );
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-sm-%-${RUN}@example.invalid`}`,
      );
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${`SM-${RUN}`}`);
      await ctx.closeDb();
    }
  });

  it('заведение шлёт письмо на ящик службы — с её же канала и с ответом заявителю', async () => {
    const { request, mail } = await createRequest(
      await ctx.newEquipment('dup'),
      'Не печатает вторую сторону',
    );
    expect(mail).toBe('queued');

    const letters = await mailsOf(request.id);
    expect(letters).toHaveLength(1);
    expect(letters[0]!.kind).toBe('service_request_waiting_it');
    expect(letters[0]!.to_email).toBe(SERVICE_MAILBOX);
    expect(letters[0]!.account).toBe('repair');
    // Ответ уходит заявителю: письмо, где отправитель и получатель — один ящик, без обратного
    // адреса отвечает само себе (К22).
    expect(letters[0]!.reply_to).toBe(ctx.customerEmail);
    expect(letters[0]!.subject).toContain(request.displayNumber);
  });

  it('срочная заявка помечена в теме', async () => {
    const res = await inject('POST', '/api/v1/service-requests', ctx.customer, {
      officeEquipmentId: await ctx.newEquipment('urgent'),
      description: 'Дым из блока',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      isUrgent: true,
      urgencyReason: 'Работа встала',
    });
    expect(res.statusCode, res.body).toBe(201);
    const { request } = res.json() as { request: ServiceRequestDto };

    const letters = await mailsOf(request.id);
    expect(letters[0]!.subject).toMatch(/^СРОЧНО/u);
  });

  /**
   * Главная проверка события: «Новой» заявка бывает не только при заведении. Отмена и возврат из
   * неё дают ещё два письма, и каждое — со своим ключом: по заявке ключ подавил бы второй заход.
   */
  it('отмена и возврат в «Новую» дают свои письма', async () => {
    const { request } = await createRequest(await ctx.newEquipment('cycle'), 'Замятие бумаги');

    const cancelled = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/status`,
      ctx.admin,
      { status: 'cancelled', reason: 'Решили менять аппарат', version: request.version },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const afterCancel = (cancelled.json() as { request: ServiceRequestDto }).request;

    const restored = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/status`,
      ctx.admin,
      { status: 'new', reason: 'Отменили по ошибке', version: afterCancel.version },
    );
    expect(restored.statusCode, restored.body).toBe(200);

    const letters = await mailsOf(request.id);
    expect(letters.map((l) => l.kind)).toEqual([
      'service_request_waiting_it',
      'service_request_cancelled',
      'service_request_waiting_it',
    ]);
    // Три письма — три разные строки истории статуса в ключах.
    expect(new Set(letters.map((l) => l.dedupe_key)).size).toBe(3);
  });

  it('копия адресата приходит вторым письмом, а не вместо основного', async () => {
    const added = await inject('POST', '/api/v1/admin/mail/recipients', ctx.admin, {
      event: 'service_request_waiting_it',
      toEmail: COPY_MAILBOX,
      replyToMode: 'portal',
    });
    expect(added.statusCode, added.body).toBe(201);

    const { request } = await createRequest(
      await ctx.newEquipment('copy'),
      'Не берёт бумагу из лотка',
    );
    const letters = await mailsOf(request.id);

    expect(letters.map((l) => l.to_email).sort()).toEqual([COPY_MAILBOX, SERVICE_MAILBOX].sort());
    // У копии режим «общий адрес портала» — своего обратного адреса у неё нет.
    expect(letters.find((l) => l.to_email === COPY_MAILBOX)!.reply_to).toBe('');

    // Копия убирается сразу: дальше проверяется счёт писем, и лишний адресат сделал бы «одно
    // письмо на событие» неотличимым от «двух».
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/mail/recipients/${(added.json() as { id: string }).id}`,
      headers: ctx.admin,
    });
    expect(removed.statusCode).toBe(204);
  });

  it('повтор кнопкой: тот же ключ — одно письмо, новый — второе', async () => {
    const { request } = await createRequest(await ctx.newEquipment('repeat'), 'Полосы на копиях');
    const before = (await mailsOf(request.id)).length;
    const key = randomUUID();

    const first = await inject('POST', `/api/v1/service-requests/${request.id}/notify`, ctx.admin, {
      idempotencyKey: key,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().mail).toBe('queued');

    // Тот же ключ — повтор HTTP или второе нажатие: письма не прибавляется.
    await inject('POST', `/api/v1/service-requests/${request.id}/notify`, ctx.admin, {
      idempotencyKey: key,
    });
    const afterSame = await mailsOf(request.id);
    expect(afterSame.length).toBe(before + 1);

    await inject('POST', `/api/v1/service-requests/${request.id}/notify`, ctx.admin, {
      idempotencyKey: randomUUID(),
    });
    expect((await mailsOf(request.id)).length).toBe(before + 2);

    // Постановка в очередь записана аудитом именно как постановка: отправляет письмо worker.
    const audit = await ctx.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM audit_log
       WHERE action = 'serviceRequest.mailQueued' AND entity_id = ${request.id}`);
    expect(Number(audit.rows[0]!.count)).toBe(3);
  });

  it('в статусе без события повторять нечего — 422', async () => {
    const { request } = await createRequest(await ctx.newEquipment('approved'), 'Не сканирует');
    const approved = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/it-approval`,
      ctx.admin,
      { approved: true, version: request.version },
    );
    expect(approved.statusCode, approved.body).toBe(200);

    const res = await inject('POST', `/api/v1/service-requests/${request.id}/notify`, ctx.admin, {
      idempotencyKey: randomUUID(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toContain('не отправлялись');
  });
});
