import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Письма по решениям об учётных записях (ADR 0087, блоки A и B): отказ по заявке, одобрение
 * заявки и заведение учётки администратором — через настоящие HTTP-пути, на живой схеме.
 *
 * Зачем база. Оба перехода — «заявка → отклонена» и «заявка → рассмотрена» — защищены
 * блокировкой строки (`FOR UPDATE`) внутри транзакции, а блокировку нельзя проверить на моках:
 * там оба запроса увидят одно и то же старое состояние и оба сочтут переход допустимым. Ровно
 * этим гонка и опасна — двумя письмами одному человеку и двумя записями в журнале, — поэтому
 * проверяется она двумя настоящими одновременными запросами к настоящей базе, а не рассуждением.
 *
 * Вторая причина той же природы: письмо и решение живут в одной транзакции. «Заявка отклонена без
 * письма» и «письмо об отказе по неотклонённой заявке» одинаково недопустимы, и держит это
 * свойство не код, а общая транзакция с очередью `mail_messages` + `jobs`. Дедупликация писем —
 * тоже свойство схемы (уникальный индекс по `(kind, dedupe_key)`), и цикл «отказ → восстановление
 * из архива → отказ» проверяется на ней же.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   createdb technic_access_mail_test && psql technic_access_mail_test -c
 *     'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;
 *      CREATE EXTENSION IF NOT EXISTS pg_trgm'
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_access_mail_test \
 *     pnpm --filter @technic/api test user-access-mail
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-access-mail-admin@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';
/** Пароль заявителя при саморегистрации и пароль учётки, заведённой администратором. */
const USER_PASSWORD = 'db-user-password-456';
const CREATED_PASSWORD = 'db-created-secret-789';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  /** Два объекта: параллельные одобрения обязаны различаться не только ролью, но и областью. */
  objectIds: [string, string];
}

let ctx: Ctx;
/** Адреса, заведённые тестом: по ним же он за собой и убирает — база общая с другими файлами. */
const created: string[] = [];

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
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
  // Почта включена, но без внешней доставки: письма составляются в журнал и наружу не уходят.
  process.env.MAIL_ENABLED = 'true';
  process.env.MAIL_TRANSPORT = 'log';
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

/** Свой адрес на каждый запрос: регистрация ограничена пятью попытками за десять минут с IP. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/** Адрес заявки: свой у каждого сценария, чтобы порядок тестов ничего не решал. */
function freshEmail(): string {
  const email = `db-mailacc-${randomUUID().slice(0, 8)}@example.invalid`;
  created.push(email);
  return email;
}

/**
 * Саморегистрация. Капча в тестовом окружении выключена — ключей SmartCaptcha в `env` нет, — и
 * поле `captchaToken` не шлётся вовсе: транспорт объявил его необязательным, а сервер при
 * выключенной капче пустой токен пропускает и в сеть не ходит (план `docs/smart-captcha-plan.md`,
 * §5). Проверка самой капчи живёт в `smart-captcha.test.ts` и в `driver-registration.db.test.ts`.
 */
async function register(email: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: nextAddress(),
    payload: {
      email,
      lastName: 'Заявкин',
      firstName: 'Пётр',
      middleName: '',
      phone: '',
      password: USER_PASSWORD,
      requestedRole: 'other',
      requestedObject: '',
      requestedCompany: '',
      // «Другое» без объяснения словами схема не пропускает: рассматривать такую заявку не по чему.
      requestedComment: 'Сметчик, нужен просмотр заявок',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
}

/** Нерассмотренная заявка: роли нет, учётка неактивна — исходное состояние обоих блоков. */
async function pendingRegistration(): Promise<{ id: string; email: string }> {
  const email = freshEmail();
  await register(email);
  const res = await ctx.db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL`,
  );
  return { id: res.rows[0]!.id, email };
}

function reject(id: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/users/${id}/reject`,
    headers: ctx.auth,
    payload,
  });
}

function patchUser(id: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/users/${id}`,
    headers: ctx.auth,
    payload,
  });
}

function createUser(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: ctx.auth,
    payload,
  });
}

interface MailRow {
  id: string;
  status: string;
  subject: string;
  body_text: string;
  body_html: string;
  dedupe_key: string;
}

/** Письма этого вида на этот адрес — списком: «ровно одно» и «ни одного» читаются одинаково. */
async function mails(email: string, kind: string): Promise<MailRow[]> {
  const res = await ctx.db.execute<MailRow>(
    sql`SELECT id, status, subject, body_text, body_html, dedupe_key FROM mail_messages
         WHERE to_email = ${email} AND kind = ${kind} ORDER BY created_at`,
  );
  return [...res.rows];
}

/** Все письма на адрес, каким бы видом они ни были: «портал промолчал» — это про любое письмо. */
async function mailCount(email: string): Promise<number> {
  const res = await ctx.db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM mail_messages WHERE to_email = ${email}`,
  );
  return Number(res.rows[0]!.count);
}

/** Задача на отправку: письмо без неё останется лежать в журнале и никуда не уйдёт. */
async function jobsFor(mailId: string): Promise<number> {
  const res = await ctx.db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM jobs
         WHERE type = 'send_email' AND payload ->> 'mailMessageId' = ${mailId}`,
  );
  return Number(res.rows[0]!.count);
}

/** Действия журнала по учётке в порядке появления: по ним считаются «ровно одна» и «новых нет». */
async function auditActions(userId: string): Promise<string[]> {
  const res = await ctx.db.execute<{ action: string }>(
    sql`SELECT action FROM audit_log WHERE entity_id = ${userId} ORDER BY created_at, action`,
  );
  return res.rows.map((r) => r.action);
}

/** Метаданные последней записи этого действия: исход отправки лежит там же, где само решение. */
async function auditMeta(userId: string, action: string): Promise<Record<string, unknown>> {
  const res = await ctx.db.execute<{ metadata: Record<string, unknown> }>(
    sql`SELECT metadata FROM audit_log WHERE entity_id = ${userId} AND action = ${action}
         ORDER BY created_at DESC LIMIT 1`,
  );
  return res.rows[0]?.metadata ?? {};
}

async function userRow(id: string) {
  const res = await ctx.db.execute<{
    role: string | null;
    is_active: boolean;
    deleted_at: Date | null;
    last_name: string;
    phone: string;
  }>(sql`SELECT role, is_active, deleted_at, last_name, phone FROM users WHERE id = ${id}`);
  return res.rows[0];
}

async function objectIdsOf(userId: string): Promise<string[]> {
  const res = await ctx.db.execute<{ construction_object_id: string }>(
    sql`SELECT construction_object_id FROM user_construction_objects WHERE user_id = ${userId}`,
  );
  return res.rows.map((r) => r.construction_object_id).sort();
}

describe.skipIf(!DB_URL)('письма по решениям об учётных записях (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const schema = await import('../src/db/schema');

    const [admin] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
    if (!admin) {
      await db.insert(schema.users).values({
        email: ADMIN_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: '',
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        role: 'admin',
        isActive: true,
        emailVerifiedAt: new Date(),
      });
    }

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: nextAddress(),
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 2`,
    );
    if (objects.rows.length < 2) {
      throw new Error('В базе меньше двух объектов: миграции наполнения не применены');
    }

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json<{ accessToken: string }>().accessToken}` },
      objectIds: [objects.rows[0]!.id, objects.rows[1]!.id],
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    for (const email of created) {
      await ctx.db.execute(sql`DELETE FROM jobs WHERE payload ->> 'mailMessageId' IN (
        SELECT id::text FROM mail_messages WHERE to_email = ${email})`);
      await ctx.db.execute(sql`DELETE FROM mail_messages WHERE to_email = ${email}`);
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'user'
        AND entity_id IN (SELECT id::text FROM users WHERE email = ${email})`);
      await ctx.db.execute(sql`DELETE FROM users WHERE email = ${email}`);
    }
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── Блок A: отказ по заявке ──

  describe('отказ по заявке', () => {
    it('с уведомлением ставит письмо заявителю и задачу на отправку', async () => {
      const { id, email } = await pendingRegistration();

      const res = await reject(id, {
        reason: 'Дубль: человек уже заведён под рабочим адресом',
        applicantMessage: 'Доступ выдаётся только сотрудникам подрядчика.',
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true, notified: 'queued' });
      const [mail, ...rest] = await mails(email, 'registration_rejected');
      expect(rest).toHaveLength(0);
      expect(mail!.subject).toBe('Заявка на регистрацию отклонена');
      // Письмо лежит непрочитанным в очереди и с задачей: без задачи оно никуда не уйдёт.
      expect(mail!.status).toBe('pending');
      expect(await jobsFor(mail!.id)).toBe(1);
      // Исход отправки виден и тому, кто нажал кнопку, и тому, кто потом разбирает журнал.
      expect(await auditMeta(id, 'user.reject_registration')).toMatchObject({
        notified: 'queued',
        applicantMessage: 'Доступ выдаётся только сотрудникам подрядчика.',
      });
    });

    it('со снятой отметкой писем не создаёт вовсе', async () => {
      const { id, email } = await pendingRegistration();

      const res = await reject(id, {
        reason: 'Регистрация бота',
        notifyApplicant: false,
        // Текст присылается и игнорируется: снятая отметка сильнее заполненного поля.
        applicantMessage: 'Этого никто не должен прочитать',
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true, notified: 'not_requested' });
      expect(await mailCount(email)).toBe(0);
      const meta = await auditMeta(id, 'user.reject_registration');
      expect(meta).toMatchObject({ notified: 'not_requested' });
      // Текста, которого никто не получил, в журнале быть не должно: он означал бы обратное.
      expect(meta.applicantMessage).toBeUndefined();
    });

    it('ответ заявителю уходит в письмо, а служебная причина остаётся в журнале', async () => {
      const { id, email } = await pendingRegistration();
      const reason = 'Служебно: дубль учётки Петрова, разбирались по телефону';
      const message = 'Заявка отклонена: доступ к порталу выдаётся только сотрудникам подрядчика.';

      expect((await reject(id, { reason, applicantMessage: message })).statusCode).toBe(200);

      const [mail] = await mails(email, 'registration_rejected');
      expect(mail!.body_text).toContain(message);
      // Формулировка для разбора внутри наружу не годится — ни в текстовой версии, ни в HTML.
      expect(mail!.body_text).not.toContain('дубль учётки Петрова');
      expect(mail!.body_html).not.toContain('дубль учётки Петрова');
      expect(await auditMeta(id, 'user.reject_registration')).toMatchObject({ reason });
    });

    it('отказ по восстановленной из архива заявке — новое письмо, а не дубль прежнего', async () => {
      const { id, email } = await pendingRegistration();
      expect(
        (await reject(id, { reason: 'Первый отказ', applicantMessage: 'Ответ первый' })).statusCode,
      ).toBe(200);

      const restore = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/users/${id}/restore`,
        headers: ctx.auth,
      });
      expect(restore.statusCode, restore.body).toBe(200);

      const second = await reject(id, { reason: 'Второй отказ', applicantMessage: 'Ответ второй' });

      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().notified).toBe('queued');
      // Два события — два письма: ключ дедупликации несёт время отказа, и оно у них разное.
      const sent = await mails(email, 'registration_rejected');
      expect(sent).toHaveLength(2);
      expect(new Set(sent.map((m) => m.dedupe_key)).size).toBe(2);
      expect(sent[1]!.body_text).toContain('Ответ второй');
    });

    it('действующую учётку отклонить нельзя: у неё есть деактивация и удаление', async () => {
      const email = freshEmail();
      const create = await createUser({
        email,
        lastName: 'Новиков',
        firstName: 'Илья',
        middleName: '',
        role: 'dispatcher',
        password: CREATED_PASSWORD,
        isActive: true,
        notifyUser: false,
      });
      expect(create.statusCode, create.body).toBe(201);
      const id = create.json<{ user: { id: string } }>().user.id;

      const res = await reject(id, { reason: 'Ошибка администратора', applicantMessage: 'Ответ' });

      expect(res.statusCode, res.body).toBe(400);
      expect(await mailCount(email)).toBe(0);
      expect(await auditActions(id)).not.toContain('user.reject_registration');
    });
  });

  /**
   * Почта выключена (Р4): решение по учётке административное и от состояния почтового контура
   * зависеть не должно. Второй экземпляр приложения ради этого не поднимается — конфиг читается
   * при импорте один раз на процесс, а флаг живёт в нём же; правится он на время этого сценария и
   * возвращается обратно, чтобы остальные проверки шли по включённой почте.
   */
  describe('почта выключена', () => {
    let restore: () => void;

    beforeAll(async () => {
      const { config } = await import('../src/config');
      const was = config.mail.enabled;
      (config.mail as { enabled: boolean }).enabled = false;
      restore = () => {
        (config.mail as { enabled: boolean }).enabled = was;
      };
    });

    afterAll(() => restore());

    it('отказ проходит, но портал прямо говорит, что письма не было', async () => {
      const { id, email } = await pendingRegistration();

      const res = await reject(id, {
        reason: 'Заявка не по адресу',
        applicantMessage: 'Заявка отклонена.',
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true, notified: 'mail_disabled' });
      // Отказ состоялся: учётка ушла в архив, письма при этом нет ни одного.
      expect((await userRow(id))?.deleted_at).not.toBeNull();
      expect(await mailCount(email)).toBe(0);
      expect(await auditMeta(id, 'user.reject_registration')).toMatchObject({
        notified: 'mail_disabled',
      });
    });
  });

  // ── Блок B: одобрение заявки и заведение учётки (таблица Р8) ──

  describe('рассмотрение заявки', () => {
    it('одобрение шлёт письмо и пишет своё действие журнала, а не общую правку', async () => {
      const { id, email } = await pendingRegistration();

      const res = await patchUser(id, {
        approveRegistration: true,
        role: 'dispatcher',
        isActive: true,
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().notified).toBe('queued');
      const [mail, ...rest] = await mails(email, 'registration_approved');
      expect(rest).toHaveLength(0);
      expect(mail!.subject).toBe('Доступ к порталу открыт');
      expect(mail!.status).toBe('pending');
      expect(await jobsFor(mail!.id)).toBe(1);
      // Одобрение и отказ — два исхода одного решения, и в журнале они стоят рядом и одинаково
      // фильтруются: внутри `user.update` одобрение пришлось бы выуживать из метаданных.
      const actions = await auditActions(id);
      expect(actions.filter((a) => a === 'user.approve_registration')).toHaveLength(1);
      expect(actions).not.toContain('user.update');
      expect(await auditMeta(id, 'user.approve_registration')).toMatchObject({
        notified: 'queued',
      });
    });

    it('повторное одобрение уже рассмотренной заявки — 409, и оно ничего не меняет', async () => {
      const { id } = await pendingRegistration();
      expect(
        (await patchUser(id, { approveRegistration: true, role: 'dispatcher', isActive: true }))
          .statusCode,
      ).toBe(200);
      const before = await userRow(id);
      const actionsBefore = await auditActions(id);

      const res = await patchUser(id, {
        approveRegistration: true,
        role: 'manager',
        isActive: true,
      });

      expect(res.statusCode, res.body).toBe(409);
      expect(res.json<{ message: string }>().message).toMatch(/уже рассмотрел/u);
      // Решение первого администратора не переписано и второй записи в журнале не появилось.
      expect(await userRow(id)).toEqual(before);
      expect(await auditActions(id)).toEqual(actionsBefore);
    });

    it('объявленное одобрение с половинчатым итогом — 400, заявка остаётся заявкой', async () => {
      const { id, email } = await pendingRegistration();

      const roleOnly = await patchUser(id, { approveRegistration: true, role: 'dispatcher' });
      const activeOnly = await patchUser(id, { approveRegistration: true, isActive: true });

      expect(roleOnly.statusCode, roleOnly.body).toBe(400);
      expect(roleOnly.json<{ message: string }>().message).toMatch(/целиком/u);
      expect(activeOnly.statusCode, activeOnly.body).toBe(400);
      expect(await userRow(id)).toMatchObject({ role: null, is_active: false });
      expect(await mailCount(email)).toBe(0);
      expect(await auditActions(id)).not.toContain('user.approve_registration');
    });

    it('роль и активация заявки без объявленного намерения — 400', async () => {
      const { id, email } = await pendingRegistration();

      // Роль без активации: без запрета запись перестала бы быть заявкой, и следующая правка
      // активировала бы её уже как обычную учётку — мимо журнала одобрения и мимо письма.
      const roleOnly = await patchUser(id, { role: 'dispatcher' });
      const activeOnly = await patchUser(id, { isActive: true });
      const both = await patchUser(id, { role: 'dispatcher', isActive: true });

      expect(roleOnly.statusCode, roleOnly.body).toBe(400);
      expect(roleOnly.json<{ message: string }>().message).toMatch(/рассмотрением/u);
      expect(activeOnly.statusCode, activeOnly.body).toBe(400);
      expect(both.statusCode, both.body).toBe(400);
      expect(both.json<{ message: string }>().message).toMatch(/рассмотрением/u);
      expect(await userRow(id)).toMatchObject({ role: null, is_active: false });
      expect(await mailCount(email)).toBe(0);
      // Отвергнутый запрос не оставляет за собой ничего: в журнале только сама саморегистрация.
      expect(await auditActions(id)).toEqual(['user.register']);
    });

    it('правка ФИО и телефона заявки проходит и оставляет её в очереди', async () => {
      const { id, email } = await pendingRegistration();

      const res = await patchUser(id, { lastName: 'Исправленный', phone: '+7 926 000-00-00' });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().notified).toBe('not_requested');
      expect(await userRow(id)).toMatchObject({
        role: null,
        is_active: false,
        last_name: 'Исправленный',
        phone: '9260000000',
      });
      expect(await mailCount(email)).toBe(0);
      // Обычная правка — и записана она обычной правкой: рассмотрения заявки не было.
      expect(await auditActions(id)).toEqual(['user.register', 'user.update']);
    });

    it('цикл «одобрение → деактивация → активация» даёт ровно одно письмо', async () => {
      const { id, email } = await pendingRegistration();

      const approve = await patchUser(id, {
        approveRegistration: true,
        role: 'dispatcher',
        isActive: true,
      });
      const off = await patchUser(id, { isActive: false });
      const on = await patchUser(id, { isActive: true });

      expect(approve.json().notified).toBe('queued');
      expect(off.statusCode, off.body).toBe(200);
      // Заявку по этой учётке рассмотрели однажды: «ваша заявка одобрена» действующему сотруднику
      // было бы неправдой, и повторная активация письма не просит вовсе.
      expect(on.statusCode, on.body).toBe(200);
      expect(on.json().notified).toBe('not_requested');
      expect(await mails(email, 'registration_approved')).toHaveLength(1);
    });
  });

  describe('учётка, заведённая администратором', () => {
    async function create(email: string, body: Record<string, unknown>) {
      return createUser({
        email,
        lastName: 'Новиков',
        firstName: 'Илья',
        middleName: '',
        role: 'dispatcher',
        password: CREATED_PASSWORD,
        ...body,
      });
    }

    it('активная учётка с отметкой получает письмо, и пароля в нём нет', async () => {
      const email = freshEmail();

      const res = await create(email, { isActive: true });

      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().notified).toBe('queued');
      const [mail, ...rest] = await mails(email, 'account_created');
      expect(rest).toHaveLength(0);
      expect(mail!.subject).toBe('Для вас заведена учётная запись');
      expect(await jobsFor(mail!.id)).toBe(1);
      // Пароль почтой не ходит ни в каком виде: отправленный, он остаётся в ящике навсегда.
      expect(mail!.body_text).not.toContain(CREATED_PASSWORD);
      expect(mail!.body_html).not.toContain(CREATED_PASSWORD);
      expect(
        await auditMeta(res.json<{ user: { id: string } }>().user.id, 'user.create'),
      ).toMatchObject({
        notified: 'queued',
      });
    });

    it('со снятой отметкой писем нет', async () => {
      const email = freshEmail();

      const res = await create(email, { isActive: true, notifyUser: false });

      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().notified).toBe('not_requested');
      expect(await mailCount(email)).toBe(0);
    });

    it('неактивная учётка письма не получает даже с отметкой', async () => {
      const email = freshEmail();

      const res = await create(email, { isActive: false, notifyUser: true });

      expect(res.statusCode, res.body).toBe(201);
      // Звать человека в портал, который его не пустит, хуже молчания.
      expect(res.json().notified).toBe('not_requested');
      expect(await mailCount(email)).toBe(0);
    });

    it('смена роли действующему сотруднику писем не порождает', async () => {
      const email = freshEmail();
      const createRes = await create(email, { isActive: true, notifyUser: false });
      expect(createRes.statusCode, createRes.body).toBe(201);
      const id = createRes.json<{ user: { id: string } }>().user.id;

      const res = await patchUser(id, { role: 'manager' });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().notified).toBe('not_requested');
      expect(await mailCount(email)).toBe(0);
    });
  });

  // ── Р0: два администратора решают одновременно ──

  describe('два одновременных решения по одной заявке', () => {
    it('два отказа: один проходит, второй получает 404 — письмо и запись по одной', async () => {
      const { id, email } = await pendingRegistration();

      const [first, second] = await Promise.all([
        reject(id, { reason: 'Отказ первого', applicantMessage: 'Ответ первого администратора' }),
        reject(id, { reason: 'Отказ второго', applicantMessage: 'Ответ второго администратора' }),
      ]);

      // Кто из них успел раньше, `Promise.all` не определяет — важно, что исход ровно один.
      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 404]);
      expect(await mails(email, 'registration_rejected')).toHaveLength(1);
      const actions = await auditActions(id);
      expect(actions.filter((a) => a === 'user.reject_registration')).toHaveLength(1);
    });

    it('два одобрения разными ролью и областью: второй получает 409 и ничего не переписывает', async () => {
      const { id, email } = await pendingRegistration();
      // Роли назначаемые: площадочная тройка с шага prepare этапа 8 (ADR 0113) отклоняется 400, и
      // гонка двух решений проверялась бы на двух отказах. Различаются решения объектом и ролью —
      // этого хватает, чтобы увидеть, чьё именно применилось.
      const bodies = [
        {
          approveRegistration: true,
          role: 'site',
          isActive: true,
          constructionObjectIds: [ctx.objectIds[0]],
        },
        {
          approveRegistration: true,
          role: 'observer',
          isActive: true,
          constructionObjectIds: [],
        },
      ];

      const results = await Promise.all(bodies.map((body) => patchUser(id, body)));

      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(await mails(email, 'registration_approved')).toHaveLength(1);
      const actions = await auditActions(id);
      expect(actions.filter((a) => a === 'user.approve_registration')).toHaveLength(1);
      // Ни одной общей правки: иначе дождавшийся запрос переписал бы чужое решение молча.
      expect(actions).not.toContain('user.update');
      // Итог сверяется с телом того запроса, который получил 200, а не с первым по порядку:
      // зашитый победитель дал бы плавающий тест — очередь на блокировке порядка не обещает.
      const winner = bodies[results.findIndex((r) => r.statusCode === 200)]!;
      expect(await userRow(id)).toMatchObject({ role: winner.role, is_active: true });
      expect(await objectIdsOf(id)).toEqual(winner.constructionObjectIds);
    });
  });
});
