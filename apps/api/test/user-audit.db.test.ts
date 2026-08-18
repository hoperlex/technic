import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_TARGET_AUDIT_ACTIONS, auditChangesOf, type AuditEntryDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Журнал изменений учётных записей (ADR 0109) — на живой схеме, через настоящие HTTP-пути.
 *
 * Зачем база. Проверяется ровно то, чего не увидит ни один контрактный тест: что портал **пишет** в
 * `audit_log` при заведении и правке учётки и что ручка журнала умеет отобрать записи по данным
 * самой учётки. Отбор идёт join'ом к `users` и EXISTS'ами по её объектам и отделам — то есть SQL, а
 * не правилами; а перечень изменений собирается по паре карточек, снятых до и после транзакции.
 *
 * Запуск — как у остальных db-тестов: без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-audit-admin@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';
const USER_PASSWORD = 'db-user-password-456';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  objectIds: string[];
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
  // Письма учётке здесь не нужны: проверяется журнал, а не почта.
  process.env.MAIL_ENABLED = 'false';
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

function freshEmail(): string {
  return `db-audit-${randomUUID().slice(0, 8)}@example.invalid`;
}

/*
 * Учётка «Площадки» на одном объекте: у объектной роли область обязательна (ADR 0039).
 *
 * Роль перевода, а не «Штаб»: шаг prepare этапа 8 (ADR 0113) закрыл вход в упраздняемые роли, и
 * заведение штаба маршрутом отвечает 400. Журналу от этого безразлично — он пишет ту роль, которую
 * поставили, — а фикстура заодно перестала опираться на роль, которой скоро не будет.
 */
async function createAccount(email: string, objectId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: ctx.auth,
    payload: {
      email,
      lastName: 'Журналов',
      firstName: 'Семён',
      middleName: 'Игоревич',
      phone: '9000000000',
      password: USER_PASSWORD,
      role: 'site',
      isActive: true,
      constructionObjectIds: [objectId],
      notifyUser: false,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().user.id as string;
}

async function patchAccount(id: string, payload: Record<string, unknown>): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/users/${id}`,
    headers: ctx.auth,
    payload,
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Журнал по фильтрам ручки: то, что увидит подвкладка. */
async function audit(query: Record<string, string>): Promise<AuditEntryDto[]> {
  const search = new URLSearchParams(query).toString();
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/audit?${search}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as AuditEntryDto[];
}

function eventOf(items: AuditEntryDto[], action: string): AuditEntryDto {
  const found = items.find((i) => i.action === action);
  expect(found, `событие «${action}» в журнале`).toBeTruthy();
  return found!;
}

describe.skipIf(!DB_URL)('журнал изменений учёток (живая схема)', () => {
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
      });
    }

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY name LIMIT 2`,
    );
    if (objects.rows.length < 2)
      throw new Error('В базе меньше двух объектов: нужны миграции наполнения');

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      objectIds: objects.rows.map((r) => r.id),
    };
  }, 120_000);

  afterAll(async () => {
    if (ctx?.db) {
      /*
       * Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а здесь
       * каждый сценарий заводит новую учётку — четыре штуки за прогон оседали в ней навсегда.
       *
       * Метка — адрес: `db-audit-<8 знаков>`, его же и выдаёт `freshEmail`. Списком заведённого
       * уборка не пользуется намеренно — прибирать надо и за упавшим прогоном, который до записи
       * в список мог не дойти.
       *
       * Администратор из-под метки выведен: его заводит `beforeAll` один раз на все прогоны и
       * ищет по адресу, а снос заставлял бы каждый прогон заново считать argon2.
       *
       * Записи журнала уходят вместе с учёткой, которую описывают: `audit_log.actor_user_id`
       * обнуляется, а не удаляется, — то есть без этого шага строки о снесённых учётках остались
       * бы висеть и здесь. Сносятся только строки **об учётке**: журнал общий, и события соседних
       * сущностей этому файлу не принадлежат.
       */
      const ours = sql`email LIKE 'db-audit-%' AND email <> ${ADMIN_EMAIL}`;
      await ctx.db.execute(sql`
        DELETE FROM audit_log
        WHERE entity_type = 'user'
          AND entity_id IN (SELECT id::text FROM users WHERE ${ours})`);
      await ctx.db.execute(sql`DELETE FROM users WHERE ${ours}`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('правка учётки ложится в журнал значениями, а не признаками', async () => {
    const id = await createAccount(freshEmail(), ctx.objectIds[0]!);
    await patchAccount(id, {
      role: 'mechanic',
      phone: '9011111111',
      isActive: false,
      // Роль главного механика области не имеет: набор объектов при смене роли обнуляется сам.
      constructionObjectIds: [],
    });

    const items = await audit({ entityType: 'user', entityId: id, pageSize: '50' });
    const changes = auditChangesOf(eventOf(items, 'user.update'));
    expect(changes).toContainEqual({ field: 'role', from: 'Площадка', to: 'Механик' });
    expect(changes).toContainEqual({ field: 'isActive', from: 'открыт', to: 'закрыт' });
    expect(changes).toContainEqual({
      field: 'phone',
      from: '+7 (900) 000 00 00',
      to: '+7 (901) 111 11 11',
    });
    // Название снятой площадки, а не её идентификатор: по uuid разбор не восстановить.
    const removed = changes.find((c) => c.field === 'objectsRemoved');
    expect(removed?.to, 'снятый объект названием').toBeTruthy();

    // Заведение учётки записано составом: слева показывать нечего, учётки до этого не было.
    const created = auditChangesOf(eventOf(items, 'user.create'));
    expect(created).toContainEqual({ field: 'role', from: null, to: 'Площадка' });
    expect(created).toContainEqual({ field: 'isActive', from: null, to: 'открыт' });
  });

  it('строка журнала называет учётку так же, как список: роль и признак архива', async () => {
    const id = await createAccount(freshEmail(), ctx.objectIds[0]!);
    const [before] = await audit({ entityType: 'user', entityId: id });
    expect(before!.targetRole).toBe('site');
    expect(before!.targetIsActive).toBe(true);
    expect(before!.targetDeletedAt).toBeNull();

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${id}`,
      headers: ctx.auth,
    });
    expect(removed.statusCode, removed.body).toBe(200);

    const [after] = await audit({ entityType: 'user', entityId: id });
    // Состояние — нынешнее, а не на момент события: журнал снимков не хранит и не притворяется.
    expect(after!.targetDeletedAt).not.toBeNull();
  });

  it('отбирает журнал по данным учётки: роль, объект и архив', async () => {
    const email = freshEmail();
    const id = await createAccount(email, ctx.objectIds[0]!);

    const byObject = await audit({
      entityType: 'user',
      entityId: id,
      targetObjectId: ctx.objectIds[0]!,
    });
    expect(byObject.length).toBeGreaterThan(0);
    // Чужая площадка отбирает пустоту — EXISTS идёт по набору именно этой учётки.
    expect(
      await audit({ entityType: 'user', entityId: id, targetObjectId: ctx.objectIds[1]! }),
    ).toHaveLength(0);

    expect(await audit({ entityType: 'user', entityId: id, targetRole: 'site' })).not.toHaveLength(
      0,
    );
    expect(await audit({ entityType: 'user', entityId: id, targetRole: 'driver' })).toHaveLength(0);

    // Действующая учётка: «только из архива» её не показывает, «только действующие» — показывает.
    expect(await audit({ entityType: 'user', entityId: id, targetArchive: 'only' })).toHaveLength(
      0,
    );
    expect(
      await audit({ entityType: 'user', entityId: id, targetArchive: 'exclude' }),
    ).not.toHaveLength(0);

    // Поиск — по людям: ФИО и адрес учётки, а не по кодам действий.
    expect(await audit({ entityType: 'user', entityId: id, search: email })).not.toHaveLength(0);
    expect(
      await audit({ entityType: 'user', entityId: id, search: 'таких-фамилий-нет' }),
    ).toHaveLength(0);
  });

  it('карточка учётки открывается и из архива — путь спрашивают как раз у неё', async () => {
    const id = await createAccount(freshEmail(), ctx.objectIds[0]!);
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${id}`,
      headers: ctx.auth,
    });
    expect(removed.statusCode, removed.body).toBe(200);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/users/${id}`,
      headers: ctx.auth,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user.deletedAt).not.toBeNull();
  });

  it('лента отдаёт только действия с учётками: чужие события журнала за её границей', async () => {
    const id = await createAccount(freshEmail(), ctx.objectIds[0]!);
    const schema = await import('../src/db/schema');
    /*
     * Соседи по журналу — записями прямо в таблицу, а не настоящими операциями: проверяется
     * граница выборки, а не то, как портал заводит заявку, и поднимать ради этого технику с
     * маршрутами значило бы проверять чужой модуль.
     */
    const strangers = await ctx.db
      .insert(schema.auditLog)
      .values([
        // Вход: цель — учётка, но за границей подвкладки (ADR 0088, Р2). Их тысячи в неделю.
        { action: 'auth.login', entityType: 'user', entityId: id },
        // Событие чужой сущности: у него свой читатель — история карточки заявки.
        { action: 'vehicle_request.create', entityType: 'vehicle_request', entityId: randomUUID() },
        // Правка каталога полномочий: цель — набор, а не учётка (ADR 0106).
        { action: 'grant.create', entityType: 'grant', entityId: randomUUID() },
      ])
      .returning({ id: schema.auditLog.id });

    try {
      // Лента без фильтров — то, что видит подвкладка при первом открытии. Записи только что
      // легли, порядок ленты — свежие сначала: не будь границы, все три стояли бы наверху.
      const feed = await audit({ pageSize: '100' });
      expect(feed.length).toBeGreaterThan(0);
      for (const item of feed) expect(USER_TARGET_AUDIT_ACTIONS).toContain(item.action);
      const shown = new Set(feed.map((i) => i.id));
      for (const stranger of strangers) expect(shown.has(stranger.id)).toBe(false);

      // Путь учётки — та же ручка: вход не должен утопить её события и здесь.
      const path = await audit({ entityType: 'user', entityId: id, pageSize: '50' });
      expect(path.map((i) => i.action)).not.toContain('auth.login');
      expect(eventOf(path, 'user.create').targetEmail).toBeTruthy();

      // Каталог полномочий читается тем же журналом — своим срезом, а не общей лентой.
      const catalog = await audit({ scope: 'grant', pageSize: '100' });
      expect(catalog.map((i) => i.id)).toContain(strangers[2]!.id);
      expect(catalog.map((i) => i.action)).not.toContain('user.create');
    } finally {
      // Убирается кейс за собой сам: `afterAll` сносит записи об учётках этого файла, а события
      // чужих сущностей ему не принадлежат — по метке их не найти.
      for (const stranger of strangers) {
        await ctx.db.execute(sql`DELETE FROM audit_log WHERE id = ${stranger.id}`);
      }
    }
  });
});
