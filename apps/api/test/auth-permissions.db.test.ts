import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  can,
  PERMISSIONS,
  permissionsFor,
  ROLE_ADDON_PERMISSIONS,
  type AccessSubject,
  type AuthUser,
  type Permission,
  type Role,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';

/**
 * Сервер отдаёт эффективные права учётки (ADR 0106, решение 5; план реструктуризации доступа §10.1)
 * — во всех четырёх ответах, которые устанавливают или обновляют сессию, на живой схеме.
 *
 * **Почему четыре ответа, а не только `/auth/me`.** Сборщик ответа в `routes/auth.ts` один, и
 * «поле появилось» проверялось бы одним запросом. Но план перечисляет четыре места именно потому,
 * что каждое из них — самостоятельная дыра: вход рисует меню до первого `/auth/me`; `refresh` после
 * `authVersion + 1` обязан обновить пользователя целиком, иначе сервер уже считает по-новому, а меню
 * остаётся прежним до перезагрузки страницы; смена пароля выдаёт новую сессию и вместе с ней должна
 * обновить доступ. Сборщик может остаться один, а субъект в него прийти **обрезанным** — что и было
 * до этого шага у входа и смены пароля: они читали коды наборов (ради пометок рядом с ролью) и не
 * читали прав наборов вовсе. Поймать это можно только запросом в каждую из четырёх ручек.
 *
 * **Зачем база.** Права наборов считает SQL (`grantPermissionsExpr`) с гейтом совместимости по роли,
 * и собранный администратором набор существует только в таблицах — ни роль, ни пометки о нём не
 * рассказывают. На подменах «субъект пришёл целиком» неотличимо от «пришёл без наборов»: оба ответа
 * выглядят как список прав роли.
 *
 * **Чего этот файл не проверяет.** Сами выражения чтения — `user-grants-read.db.test.ts`, состав
 * системных наборов — `grants-catalog.db.test.ts`, привязку прав к маршрутам — `access-matrix`.
 * Здесь только ответы сессии: что в них есть список, что он равен `permissionsFor` для полного
 * субъекта и что порядок в нём словарный.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/auth-permissions.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Метка своих строк: уборка идёт по ней, а не «по последним строкам». Префикс общий на все прогоны
 * — упавший прогон обязан убираться следующим, а не копить учётки в общей базе.
 */
const PREFIX = 'db-auth-permissions';
/** Уникальный хвост прогона: адрес занимает действующая учётка, и два прогона не должны спорить. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;

/** Приметы адреса и ФИО в пароль попадать не должны (`passwordIdentityIssue` при регистрации). */
const PASSWORD = 'db-session-secret-123';
const NEW_PASSWORD = 'db-session-secret-456';

/** Системный набор оргтехники, заведённый миграцией 0145: его состав тест не переписывает. */
const OPERATOR = 'office_equipment_operator';

/**
 * Право, которого роль `shtab` не имеет ни от должности, ни от системного набора оргтехники, —
 * им и проверяется, что набор доехал до ответа. Журнал путевых листов выбран намеренно: площадочным
 * ролям его не выдают (ADR 0037 — в листе персональные данные водителя), и «пришло от роли» тут
 * невозможно спутать с «пришло от набора».
 */
const ASSEMBLED_PERMISSION: Permission = 'waybills.read';

/**
 * Право, снятое из словаря выкатом, — так выглядит сирота в `grant_permissions`. Лежит в собранном
 * наборе рядом с настоящим: ответ обязан остаться списком `Permission`, а не «тем, что нашлось в
 * базе». Строгое равенство с `permissionsFor` ниже это и сторожит.
 */
const RETIRED_PERMISSION = 'officeEquipment.retire';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  /** Автор выдачи: `user_grants.granted_by` ссылается на живую учётку. */
  adminId: string;
}

let ctx: Ctx;
let seq = 0;

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
  // Письма здесь ни при чём: смена пароля уведомляет владельца ящика, и с выключенной почтой
  // операция состоится без письма — от него она не зависит.
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

/**
 * Уборка своих строк — и перед прогоном тоже. Записи журнала уходят первыми: вход и смена пароля
 * пишут в `audit_log`, где `entity_id` текстовый и каскадом не убирается. Остальное каскадом от
 * `users` (сессии и назначения объявлены `ON DELETE CASCADE`), а свой набор — после учёток:
 * `user_grants.grant_id` стоит под RESTRICT и выданный набор не удаляется.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'user' AND entity_id IN (
    SELECT id::text FROM users WHERE email LIKE ${`${PREFIX}%`})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}%`}`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${PREFIX}%`}`);
}

/**
 * Учётка с настоящим паролем: предмет проверки — ответы входа, и хеш здесь обязан быть живым.
 * Заводится вставкой, а не маршрутом учёток: маршрут проверяет совместимость наборов с ролью, а
 * сюда нужен и собранный набор, которого форма не примет.
 */
async function newUser(role: Role): Promise<{ id: string; email: string }> {
  seq += 1;
  const email = `${PREFIX}-${RUN}-${seq}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: 'Держатель',
      middleName: `Сессионный ${seq}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  return { id: created!.id, email };
}

/** Набор, собранный администратором: не системный — ровно такие и собирает конструктор. */
async function newAssembledGrant(roles: Role[], permissions: string[]): Promise<string> {
  seq += 1;
  const [created] = await ctx.db
    .insert(ctx.schema.grants)
    .values({
      code: `${PREFIX}-${RUN}-${seq}`,
      name: `Собранный набор ${seq}`,
      isSystem: false,
    })
    .returning({ id: ctx.schema.grants.id });
  const grantId = created!.id;
  await ctx.db.insert(ctx.schema.grantRoles).values(roles.map((role) => ({ grantId, role })));
  await ctx.db
    .insert(ctx.schema.grantPermissions)
    .values(permissions.map((permission) => ({ grantId, permission })));
  return grantId;
}

/** Идентификатор системного набора по коду — его завела миграция, а не тест. */
async function systemGrantId(code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: ctx.schema.grants.id })
    .from(ctx.schema.grants)
    .where(sql`${ctx.schema.grants.code} = ${code}`);
  if (!row) throw new Error(`В базе нет системного набора «${code}»`);
  return row.id;
}

/** Выдача набора. Напрямую: двойная запись умеет только надстройки, а проверяются ответы сессии. */
async function assign(userId: string, grantId: string): Promise<void> {
  await ctx.db
    .insert(ctx.schema.userGrants)
    .values({ userId, grantId, grantedBy: ctx.adminId, origin: 'manual' });
}

/**
 * Свой адрес на каждый запрос: ручки входа ограничены десятью попытками в минуту с адреса, а этот
 * файл только их и дёргает. Без разных адресов прогон упирался бы в 429 на середине.
 */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

interface SessionResponse {
  accessToken: string;
  user: AuthUser;
}

/** Cookie ответа целиком: имя refresh-токена тест не повторяет — он возвращает то, что выдал сервер. */
function cookieJar(cookies: { name: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(cookies.map((c) => [c.name, c.value]));
}

interface LoggedIn extends SessionResponse {
  /** Cookie входа: с ними идёт `refresh` — предъявлять их обязан клиент, а не тест по имени. */
  jar: Record<string, string>;
}

async function login(email: string, password = PASSWORD): Promise<LoggedIn> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: nextAddress(),
    payload: { email, password },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json<SessionResponse>();
  return { ...body, jar: cookieJar(res.cookies as { name: string; value: string }[]) };
}

async function me(accessToken: string): Promise<AuthUser> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    remoteAddress: nextAddress(),
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<AuthUser>();
}

async function refresh(jar: Record<string, string>): Promise<SessionResponse> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    remoteAddress: nextAddress(),
    cookies: jar,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<SessionResponse>();
}

async function changePassword(accessToken: string): Promise<SessionResponse> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/change-password',
    remoteAddress: nextAddress(),
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<SessionResponse>();
}

/**
 * Ожидаемый список — независимый счёт по контрактам: субъект собирается из того, что тест **сам
 * завёл** (роль и права выданного набора), а не читается тем же выражением, что и сервер. Сверять
 * ответ с повторным вызовом серверного запроса значило бы проверять запрос сам собой.
 */
function expected(subject: AccessSubject): Permission[] {
  return [...permissionsFor(subject)];
}

describe.skipIf(!DB_URL)('ответы сессии отдают эффективные права учётки (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    await cleanup(db);

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    ctx = { app, db, schema, closeDb, adminId: '' };
    ctx.adminId = (await newUser('admin')).id;

    // Системный набор завела миграция 0145. Если его нет — сломан не тест, а накат: пусть это будет
    // видно здесь, а не в чужом ожидании.
    await systemGrantId(OPERATOR);
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  /**
   * Вход. До первого `/auth/me` портал уже рисует меню по этому ответу, поэтому список обязан быть
   * здесь. Сверяется с `permissionsFor` для роли — то есть ровно с тем, что портал считал бы сам,
   * пока умел это делать.
   */
  it('вход отдаёт права, совпадающие с permissionsFor для этой учётки', async () => {
    const { email } = await newUser('shtab');
    const { user } = await login(email);

    expect(user.permissions).toEqual(expected({ role: 'shtab' }));
    // Пустой список — не тот же ответ: у роли без прав он тоже пустой, и равенство выше сошлось бы
    // на двух пустых массивах, ничего не проверив.
    expect(user.permissions.length).toBeGreaterThan(0);
    // Поля, которые портал читает сегодня, остались на месте: новый список ничего не заменяет.
    expect(user.role).toBe('shtab');
    expect(user.addons).toEqual([]);
  });

  it('/auth/me отдаёт тот же список, что и вход', async () => {
    const { email } = await newUser('shtab');
    const { accessToken, user } = await login(email);

    const current = await me(accessToken);
    expect(current.permissions).toEqual(expected({ role: 'shtab' }));
    // Ровно тот же список, а не «тоже правильный»: два ответа собирает один сборщик, и разойтись
    // они могут только субъектом — то есть тем, что один из путей читает не всё.
    expect(current.permissions).toEqual(user.permissions);
  });

  /**
   * `refresh`. План называет это место дырой: сервер `user` в ответе отдаёт, а клиент разбирает его
   * как `{ accessToken }` и выбрасывает. Клиент — не предмет этого файла, но серверная половина
   * обязана быть на месте: обновление сессии без обновления доступа оставляет меню прежним после
   * `authVersion + 1`.
   */
  it('refresh отдаёт права вместе с новым токеном', async () => {
    const { email } = await newUser('shtab');
    const { jar, user } = await login(email);

    const rotated = await refresh(jar);
    expect(rotated.accessToken).toBeTruthy();
    expect(rotated.user.permissions).toEqual(expected({ role: 'shtab' }));
    expect(rotated.user.permissions).toEqual(user.permissions);
  });

  it('смена пароля отдаёт права вместе с новой сессией', async () => {
    const { email } = await newUser('shtab');
    const { accessToken, user } = await login(email);

    const changed = await changePassword(accessToken);
    expect(changed.user.permissions).toEqual(expected({ role: 'shtab' }));
    expect(changed.user.permissions).toEqual(user.permissions);
    // Ответ смены пароля правит одно поле пользователя — и только его.
    expect(changed.user.mustChangePassword).toBe(false);
  });

  /**
   * Системный набор оргтехники. Состав берётся из `ROLE_ADDON_PERMISSIONS`, а не переписывается
   * списком: миграция 0145 копировала его один в один, и на равенстве этих двух наборов держится
   * обещание «переключение источника прав живым учёткам ничего не меняет».
   */
  it('выданный системный набор оргтехники добавляет свои права в список', async () => {
    const holder = await newUser('shtab');
    await assign(holder.id, await systemGrantId(OPERATOR));

    const { user } = await login(holder.email);
    const grantPermissions = [...ROLE_ADDON_PERMISSIONS[OPERATOR]];
    expect(user.permissions).toEqual(expected({ role: 'shtab', grantPermissions }));
    expect(user.permissions).toEqual(expect.arrayContaining(grantPermissions));
    // Пометка рядом с ролью пришла тем же ответом: список прав её не заменяет — она отвечает на
    // «что учётке выдано», а список на «что учётка может».
    expect(user.addons).toEqual([OPERATOR]);
  });

  it('учётке без набора права набора не приходят', async () => {
    const { email } = await newUser('shtab');

    const { user } = await login(email);
    for (const permission of ROLE_ADDON_PERMISSIONS[OPERATOR]) {
      expect(user.permissions, `право набора у учётки без набора: ${permission}`).not.toContain(
        permission,
      );
    }
  });

  /**
   * **Главное утверждение файла.** Набор, собранный администратором, роль и пометки о себе не
   * рассказывают: его код не системный, в `addons` он не попадает (`systemAddonsOf`), и увидеть его
   * можно только прочитав права наборов. Проверяются все четыре ответа: сборщик один, но субъект в
   * него собирают три разных читателя (вход, принципал, смена пароля), и обрезанный субъект даёт не
   * ошибку, а просто список короче — то есть скрытый на портале раздел у человека, которому сервер
   * его разрешает.
   *
   * До этого шага вход и смена пароля читали только коды наборов, и ровно этот случай они бы
   * провалили, пока `/auth/me` отвечал правильно.
   */
  it('собранный набор доходит до всех четырёх ответов сессии', async () => {
    const holder = await newUser('shtab');
    const grantId = await newAssembledGrant(['shtab'], [ASSEMBLED_PERMISSION, RETIRED_PERMISSION]);
    await assign(holder.id, grantId);

    // Сирота из состава набора в список не попадает и равенства не ломает: `permissionsFor` знает
    // только словарь, а читатель на границе «база → код» отсекает всё, чего в нём нет.
    const list = expected({ role: 'shtab', grantPermissions: [ASSEMBLED_PERMISSION] });
    expect(list).toContain(ASSEMBLED_PERMISSION);

    const { accessToken, jar, user } = await login(holder.email);
    expect(user.permissions, 'вход').toEqual(list);
    expect((await me(accessToken)).permissions, '/auth/me').toEqual(list);
    expect((await refresh(jar)).user.permissions, 'refresh').toEqual(list);
    // Смена пароля последней: она гасит выданные сессии, и после неё прежним токеном не походить.
    expect((await changePassword(accessToken)).user.permissions, 'смена пароля').toEqual(list);

    // Пометок у собранного набора нет — иначе «пришло от набора» было бы неотличимо от «пришло от
    // надстройки», и утверждение выше проверяло бы не тот источник.
    expect(user.addons).toEqual([]);
  });

  /**
   * Порядок — словарный (`PERMISSIONS`), а не алфавитный и не тот, в котором права вернула база.
   * Клиенту предстоит сравнивать списки (обновилось ли меню после `refresh`), а нестабильный порядок
   * делает такое сравнение ложно-положительным: состав тот же, массивы разные.
   *
   * Проверяется обеими сторонами. Равенство `PERMISSIONS.filter(...)` можно было бы получить и
   * случайно, поэтому рядом стоит неравенство алфавитному порядку — и сам алфавит сверяется с
   * словарным, чтобы утверждение не оказалось пустым на роли, где эти два порядка совпали.
   */
  it('порядок прав в ответе словарный, а не алфавитный', async () => {
    const holder = await newUser('shtab');
    await assign(holder.id, await systemGrantId(OPERATOR));
    const subject: AccessSubject = {
      role: 'shtab',
      grantPermissions: [...ROLE_ADDON_PERMISSIONS[OPERATOR]],
    };

    const { user } = await login(holder.email);
    expect(user.permissions).toEqual(PERMISSIONS.filter((permission) => can(subject, permission)));

    const alphabetical = [...user.permissions].sort();
    // Страж самой проверки: на субъекте, где алфавит и словарь совпадают, неравенство ниже не
    // значило бы ничего.
    expect(alphabetical, 'алфавит и словарь на этом субъекте совпали').not.toEqual(
      user.permissions,
    );
    expect(user.permissions).not.toEqual(alphabetical);
  });
});
