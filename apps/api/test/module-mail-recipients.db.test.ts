import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModuleMailRecipientDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Служебные адресаты писем модулей на живой схеме (план
 * `docs/office-equipment-mail-and-history-plan.md`, Р64).
 *
 * Зачем база, а не юнит на схеме: половина правил здесь — ограничения таблицы, и проверять надо
 * именно их. Пара «режим + адрес» держится CHECK, уникальность «событие + адрес» — индексом, а
 * ответ «этот адрес уже настроен» вместо кода нарушения — веткой маршрута. Юнит на zod-схеме
 * прошёл бы при полностью отсутствующей таблице.
 *
 * Второе, что проверяется только здесь: правка адресата пишет аудит с диффом. «Письма перестали
 * приходить» разбирают через месяц, и ответ на вопрос «кто и когда это выключил» обязан лежать в
 * журнале.
 *
 * Запуск — как у остальных db-тестов; без `TEST_DATABASE_URL` файл пропускается:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test module-mail-recipients
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'Test-Password-123';

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: у него есть и `mailings.read`, и `mailings.manage`. */
  admin: Auth;
  /** Штаб: раздел администрирования ему закрыт целиком — им проверяется 403. */
  shtab: Auth;
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

/** Свой адрес на каждый вход: попытки входа ограничены по IP. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.20.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

const PATH = '/api/v1/admin/mail/recipients';

/** Адреса свои на каждый прогон: база общая, и уникальность «событие + адрес» сквозная. */
const mailbox = (tag: string) => `db-mmr-${tag}-${RUN}@example.invalid`;

describe.skipIf(!DB_URL)('служебные адресаты писем (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    async function makeUser(tag: string, role: string): Promise<string> {
      const email = `db-mmr-user-${tag}-${RUN}@example.invalid`;
      await db.execute(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())`);
      return email;
    }

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
    const shtabEmail = await makeUser('shtab', 'shtab');
    ctx = {
      app,
      db,
      closeDb,
      admin: await login(adminEmail),
      shtab: await login(shtabEmail),
    };
  }, 120_000);

  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      await ctx.db.execute(
        sql`DELETE FROM module_mail_recipients WHERE to_email LIKE ${`db-mmr-%-${RUN}@example.invalid`}`,
      );
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-mmr-user-%-${RUN}@example.invalid`}`,
      );
      await ctx.closeDb();
    }
  });

  it('без права рассылок раздел закрыт', async () => {
    const list = await inject('GET', PATH, ctx.shtab);
    expect(list.statusCode).toBe(403);
    const create = await inject('POST', PATH, ctx.shtab, {
      event: 'service_request_waiting_it',
      toEmail: mailbox('forbidden'),
      replyToMode: 'portal',
    });
    expect(create.statusCode).toBe(403);
  });

  it('адресат заводится, читается списком и правится с версией', async () => {
    const created = await inject('POST', PATH, ctx.admin, {
      event: 'service_request_waiting_it',
      toEmail: mailbox('it'),
      replyToMode: 'author',
      replyToEmail: mailbox('fallback'),
      comment: 'Отдел ИТ',
    });
    expect(created.statusCode, created.body).toBe(201);
    const dto = created.json() as ModuleMailRecipientDto;
    expect(dto.isEnabled).toBe(true);
    expect(dto.version).toBe(0);

    const list = await inject('GET', PATH, ctx.admin);
    expect(list.statusCode).toBe(200);
    const rows = list.json() as ModuleMailRecipientDto[];
    expect(rows.some((r) => r.id === dto.id)).toBe(true);

    const patched = await inject('PATCH', `${PATH}/${dto.id}`, ctx.admin, {
      toEmail: dto.toEmail,
      isEnabled: false,
      replyToMode: 'author',
      replyToEmail: mailbox('fallback'),
      comment: 'Отдел ИТ, пауза',
      version: dto.version,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const after = patched.json() as ModuleMailRecipientDto;
    expect(after.isEnabled).toBe(false);
    expect(after.version).toBe(1);
    expect(after.updatedByName).not.toBeNull();

    // Устаревшая версия — 409: строку успели изменить в другом окне.
    const stale = await inject('PATCH', `${PATH}/${dto.id}`, ctx.admin, {
      toEmail: dto.toEmail,
      isEnabled: true,
      replyToMode: 'portal',
      replyToEmail: '',
      comment: '',
      version: dto.version,
    });
    expect(stale.statusCode).toBe(409);

    // Правка ушла в аудит вместе с диффом: «кто выключил рассылку» спрашивают через месяц.
    const audit = await ctx.db.execute<{ metadata: { changes?: Array<{ field: string }> } }>(sql`
      SELECT metadata FROM audit_log
       WHERE action = 'moduleMailRecipient.update' AND entity_id = ${dto.id}
       ORDER BY created_at DESC LIMIT 1`);
    const changes = audit.rows[0]?.metadata?.changes ?? [];
    expect(changes.map((c) => c.field)).toContain('isEnabled');

    const removed = await inject('DELETE', `${PATH}/${dto.id}`, ctx.admin);
    expect(removed.statusCode).toBe(204);
  });

  it('на одно событие один и тот же адрес дважды не заводится', async () => {
    const body = {
      event: 'service_request_cancelled',
      toEmail: mailbox('dup'),
      replyToMode: 'portal',
    };
    const first = await inject('POST', PATH, ctx.admin, body);
    expect(first.statusCode, first.body).toBe(201);
    const second = await inject('POST', PATH, ctx.admin, body);
    expect(second.statusCode).toBe(422);
    expect(second.json().message).toContain('уже настроен');

    // Тот же индекс ловит и правку: адрес, занятый соседней строкой того же события, обязан дать
    // то же понятное поле формы, а не 500 из глубины транзакции.
    const another = await inject('POST', PATH, ctx.admin, {
      event: 'service_request_cancelled',
      toEmail: mailbox('dup-second'),
      replyToMode: 'portal',
    });
    expect(another.statusCode, another.body).toBe(201);
    const collide = await inject(
      'PATCH',
      `${PATH}/${(another.json() as ModuleMailRecipientDto).id}`,
      ctx.admin,
      {
        toEmail: mailbox('dup'),
        isEnabled: true,
        replyToMode: 'portal',
        replyToEmail: '',
        comment: '',
        version: 0,
      },
    );
    expect(collide.statusCode).toBe(422);
    expect(collide.json().message).toContain('уже настроен');

    // Тот же адрес на другом событии — другая строка, и запрещать её нечем: события разные.
    const other = await inject('POST', PATH, ctx.admin, {
      ...body,
      event: 'service_request_waiting_it',
    });
    expect(other.statusCode, other.body).toBe(201);
  });

  /**
   * Правка приходит целиком, и умолчаний у неё нет: запрос без `isEnabled` не должен молча
   * включать выключенную рассылку, а без `comment` — стирать причину, по которой её выключили.
   */
  it('неполная правка отвергается, а не достраивается умолчаниями', async () => {
    const created = await inject('POST', PATH, ctx.admin, {
      event: 'service_request_waiting_it',
      toEmail: mailbox('partial'),
      isEnabled: false,
      replyToMode: 'portal',
      comment: 'до понедельника не шлём',
    });
    expect(created.statusCode, created.body).toBe(201);
    const dto = created.json() as ModuleMailRecipientDto;

    const partial = await inject('PATCH', `${PATH}/${dto.id}`, ctx.admin, {
      toEmail: dto.toEmail,
      replyToMode: 'portal',
      replyToEmail: '',
      version: dto.version,
    });
    expect(partial.statusCode).toBe(400);

    const after = await inject('GET', PATH, ctx.admin);
    const row = (after.json() as ModuleMailRecipientDto[]).find((r) => r.id === dto.id);
    expect(row?.isEnabled).toBe(false);
    expect(row?.comment).toBe('до понедельника не шлём');
  });

  it('режим и адрес ответа проверяются парой', async () => {
    const noAddress = await inject('POST', PATH, ctx.admin, {
      event: 'service_request_waiting_it',
      toEmail: mailbox('nofixed'),
      replyToMode: 'fixed',
    });
    expect(noAddress.statusCode).toBe(400);

    const portalWithAddress = await inject('POST', PATH, ctx.admin, {
      event: 'service_request_waiting_it',
      toEmail: mailbox('portal'),
      replyToMode: 'portal',
      replyToEmail: mailbox('extra'),
    });
    expect(portalWithAddress.statusCode).toBe(400);
  });

  it('то же правило держит база, а не только схема', async () => {
    // Схему обходим намеренно: CHECK — последняя защита, и снять её мимо формы не должно получаться.
    await expect(
      ctx.db.execute(sql`
        INSERT INTO module_mail_recipients (event, to_email, reply_to_mode, reply_to_email)
        VALUES ('service_request_waiting_it', ${mailbox('raw-fixed')}, 'fixed', '')`),
    ).rejects.toThrow();

    await expect(
      ctx.db.execute(sql`
        INSERT INTO module_mail_recipients (event, to_email, reply_to_mode, reply_to_email)
        VALUES ('service_request_waiting_it', ${mailbox('raw-event')}, 'unknown_mode', '')`),
    ).rejects.toThrow();

    /**
     * А вот незнакомое **событие** база принимает, и это решение, а не упущение: реестр событий
     * открытый и живёт в контрактах (как разделы расписаний), иначе третье событие стоило бы
     * миграции — портал предлагал бы его, а база отвергала. Значения проверяет схема запроса.
     */
    await ctx.db.execute(sql`
      INSERT INTO module_mail_recipients (event, to_email, reply_to_mode)
      VALUES ('service_request_future', ${mailbox('raw-future')}, 'portal')`);
    const rejected = await inject('POST', PATH, ctx.admin, {
      event: 'service_request_future',
      toEmail: mailbox('api-future'),
      replyToMode: 'portal',
    });
    expect(rejected.statusCode).toBe(400);
  });

  it('письмо хранит свой обратный адрес, а пустой означает общий', async () => {
    const { queuePreparedMail } = await import('../src/services/mail');
    const own = await queuePreparedMail({
      kind: 'service_request_waiting_it',
      dedupeKey: `db-mmr-${RUN}-own`,
      to: mailbox('queue-own'),
      replyTo: mailbox('reply'),
      subject: 'Заявка ждёт визы',
      text: 'тело',
      html: '<p>тело</p>',
    });
    expect(own).not.toBeNull();

    const plain = await queuePreparedMail({
      kind: 'service_request_cancelled',
      dedupeKey: `db-mmr-${RUN}-plain`,
      to: mailbox('queue-plain'),
      subject: 'Заявка отменена',
      text: 'тело',
      html: '<p>тело</p>',
    });
    expect(plain).not.toBeNull();

    const rows = await ctx.db.execute<{ id: string; reply_to: string }>(sql`
      SELECT id, reply_to FROM mail_messages WHERE id IN (${own}, ${plain})`);
    const byId = new Map(rows.rows.map((r) => [r.id, r.reply_to]));
    expect(byId.get(own!)).toBe(mailbox('reply'));
    expect(byId.get(plain!)).toBe('');

    // Повтор с тем же ключом письма не плодит: дедупликация по `(kind, dedupe_key)`.
    const again = await queuePreparedMail({
      kind: 'service_request_waiting_it',
      dedupeKey: `db-mmr-${RUN}-own`,
      to: mailbox('queue-own'),
      subject: 'Заявка ждёт визы',
      text: 'тело',
      html: '<p>тело</p>',
    });
    expect(again).toBeNull();

    await ctx.db.execute(
      sql`DELETE FROM jobs WHERE payload->>'mailMessageId' IN (${own}, ${plain})`,
    );
    await ctx.db.execute(sql`DELETE FROM mail_messages WHERE id IN (${own}, ${plain})`);
  });
});
