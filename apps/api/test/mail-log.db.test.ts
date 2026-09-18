import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAIL_KINDS,
  mailKindLabels,
  type MailLogItemDto,
  type MailLogMessageDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { mailKindEnum, mailStatusEnum } from '../src/db/schema';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Журнал отправки писем на живой схеме (ADR 0199).
 *
 * Зачем база, а не юнит на схеме: журнал целиком состоит из отбора по очереди, и проверять надо
 * именно его — что канал делит список, что фильтры и поиск сходятся с тем, что лежит в
 * `mail_messages`, и что тело письма приезжает отдельной ручкой. Юнит на zod-схеме прошёл бы при
 * полностью отсутствующей таблице.
 *
 * Главный вопрос файла — **разделение каналов**: ради него вкладку и заводили. Письмо задания
 * водителю и письмо подрядчику лежат в одной таблице, и список, показавший их вместе, топит второе
 * в первом ровно тогда, когда его ищут.
 *
 * Запуск — как у остальных db-тестов; без `TEST_DATABASE_URL` файл пропускается:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test mail-log
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'Test-Password-123';
const PATH = '/api/v1/admin/mail/log';

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: у него есть `mailings.read`. */
  admin: Auth;
  /** Штаб: раздел администрирования ему закрыт целиком — им проверяется 403. */
  shtab: Auth;
  /** Идентификатор отправленного письма подрядчику: по нему читается тело. */
  sentId: string;
  failedId: string;
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
  return `10.30.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(url: string, auth: Auth) {
  return ctx.app.inject({ method: 'GET', url, headers: auth });
}

/** Адреса свои на каждый прогон: база общая, и чужие письма в ней остаются от соседних файлов. */
const mailbox = (tag: string) => `db-mlog-${tag}-${RUN}@example.invalid`;

/** Список журнала: страница с `items`, как её видит вкладка. */
async function listOf(query: string): Promise<{ items: MailLogItemDto[]; total: number }> {
  const res = await inject(`${PATH}?${query}`, ctx.admin);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: MailLogItemDto[]; total: number };
}

describe.skipIf(!DB_URL)('журнал отправки писем (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    async function makeUser(tag: string, role: string): Promise<string> {
      const email = `db-mlog-user-${tag}-${RUN}@example.invalid`;
      await db.execute(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())`);
      return email;
    }

    /**
     * Письма кладутся прямо в очередь, а не через ручки портала: журналу безразлично, кто письмо
     * составил, а собирать ради трёх строк заявку с исполнителями значило бы проверять чужой код.
     */
    async function putMail(opts: {
      kind: string;
      account: string;
      to: string;
      subject: string;
      status: string;
      error?: string;
    }): Promise<string> {
      const rows = await db.execute<{ id: string }>(sql`
        INSERT INTO mail_messages (kind, dedupe_key, to_email, account, subject, body_text,
                                   body_html, status, last_error, sent_at)
        VALUES (${sql.raw(`'${opts.kind}'::mail_kind`)}, ${`mlog:${RUN}:${opts.to}:${opts.subject}`},
                ${opts.to}, ${opts.account}, ${opts.subject},
                ${`Текст письма ${opts.subject}`}, ${`<p>Текст письма ${opts.subject}</p>`},
                ${sql.raw(`'${opts.status}'::mail_status`)}, ${opts.error ?? ''},
                ${opts.status === 'sent' ? sql`now()` : sql`NULL`})
        RETURNING id`);
      return rows.rows[0]!.id;
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

    const sentId = await putMail({
      kind: 'service_request_assigned',
      account: 'repair',
      to: mailbox('contractor'),
      subject: `СО-${RUN} · Заявка назначена исполнителю`,
      status: 'sent',
    });
    const failedId = await putMail({
      kind: 'service_request_comment',
      account: 'repair',
      to: mailbox('contractor'),
      subject: `СО-${RUN} · Реплика в обсуждении`,
      status: 'failed',
      error: '550 mailbox unavailable',
    });
    await putMail({
      kind: 'driver_routes',
      account: 'default',
      to: mailbox('driver'),
      subject: `Задание на рейсы ${RUN}`,
      status: 'pending',
    });

    ctx = {
      app,
      db,
      closeDb,
      admin: await login(adminEmail),
      shtab: await login(shtabEmail),
      sentId,
      failedId,
    };
  }, 120_000);

  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      await ctx.db.execute(sql`DELETE FROM mail_messages WHERE dedupe_key LIKE ${`mlog:${RUN}:%`}`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-mlog-user-%-${RUN}@example.invalid`}`,
      );
      await ctx.closeDb();
    }
  });

  /**
   * Перечень видов в контрактах обязан совпадать с `mail_kind` в базе — иначе журнал покажет строку
   * без подписи либо предложит в фильтре вид, которого нет. Сверка здесь, а не в контрактном
   * тесте: перечень enum'а живёт в схеме API, и контрактам он не виден.
   */
  it('перечень видов писем сходится со схемой базы', () => {
    expect([...MAIL_KINDS]).toEqual([...mailKindEnum.enumValues]);
    for (const kind of mailKindEnum.enumValues) {
      expect(mailKindLabels[kind]).toBeTruthy();
    }
    // Исходы доставки — тем же порядком: тег состояния в таблице красится по закрытому словарю.
    expect([...mailStatusEnum.enumValues]).toEqual(['pending', 'sent', 'failed']);
  });

  it('без права рассылок журнал закрыт', async () => {
    const list = await inject(PATH, ctx.shtab);
    expect(list.statusCode).toBe(403);
    const message = await inject(`${PATH}/${ctx.sentId}`, ctx.shtab);
    expect(message.statusCode).toBe(403);
  });

  /**
   * Главное свойство журнала: канал делит список. Письмо водителю и письмо подрядчику лежат в одной
   * таблице, и показать их вместе значило бы утопить второе в первом.
   */
  it('канал делит список: письма соседнего контура не видны', async () => {
    const repair = await listOf(`account=repair&search=${RUN}`);
    expect(repair.items.map((i) => i.kind).sort()).toEqual([
      'service_request_assigned',
      'service_request_comment',
    ]);

    const drivers = await listOf(`account=default&search=${RUN}`);
    expect(drivers.items).toHaveLength(1);
    expect(drivers.items[0]!.kind).toBe('driver_routes');
    expect(drivers.items[0]!.status).toBe('pending');
    // У неотправленного письма времени отправки нет вовсе: «ждёт» и «ушло» различаются именно им.
    expect(drivers.items[0]!.sentAt).toBeNull();
  });

  it('отбор по состоянию и виду сужает список, отказ виден строкой', async () => {
    const failed = await listOf(`account=repair&status=failed&search=${RUN}`);
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0]!.id).toBe(ctx.failedId);
    expect(failed.items[0]!.lastError).toBe('550 mailbox unavailable');

    const assigned = await listOf(`account=repair&kind=service_request_assigned&search=${RUN}`);
    expect(assigned.items).toHaveLength(1);
    expect(assigned.items[0]!.id).toBe(ctx.sentId);
    expect(assigned.items[0]!.sentAt).not.toBeNull();
  });

  /**
   * Поиск идёт по адресу и по теме — по двум полям, которыми письмо ищут: «что уходило на этот
   * ящик» и «где письма по этой заявке» (номер заявки стоит в теме).
   */
  it('поиск находит и по адресу, и по теме', async () => {
    const byAddress = await listOf(`account=repair&search=${mailbox('contractor')}`);
    expect(byAddress.total).toBe(2);

    const bySubject = await listOf(
      `account=repair&search=${encodeURIComponent('Реплика в обсуждении')}`,
    );
    expect(bySubject.items.some((i) => i.id === ctx.failedId)).toBe(true);
  });

  /**
   * Тела в списке нет намеренно (страница из пятисот тел весила бы мегабайты), и приезжает оно
   * отдельной ручкой — той, которую зовёт модальное окно.
   */
  it('тело письма приезжает отдельной ручкой, в списке его нет', async () => {
    const list = await listOf(`account=repair&search=${RUN}`);
    expect(list.items[0]).not.toHaveProperty('bodyText');

    const res = await inject(`${PATH}/${ctx.sentId}`, ctx.admin);
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as MailLogMessageDto;
    expect(dto.bodyText).toContain('Текст письма');
    expect(dto.bodyHtml).toContain('<p>');
    expect(dto.account).toBe('repair');
    expect(dto.dedupeKey).toContain(`mlog:${RUN}`);
  });

  it('письма нет — понятный отказ, а не пятисотка', async () => {
    const res = await inject(`${PATH}/${randomUUID()}`, ctx.admin);
    expect(res.statusCode).toBe(404);
  });
});
