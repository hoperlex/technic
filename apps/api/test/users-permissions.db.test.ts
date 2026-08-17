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
  type Permission,
  type Role,
  type UserAccountDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';

/**
 * Витрина учёток отдаёт эффективные права и коды выданных наборов (ADR 0106; план реструктуризации
 * доступа §12, этап 2б) — карточкой и списком, на живой схеме.
 *
 * **Зачем этап.** Вкладка «Права» считает доступ на клиенте, из матрицы, по `UserDto` — где списка
 * прав не было вовсе. Как только часть прав приехала из БД, такой расчёт начал врать ровно в тех
 * местах, ради которых витрину и делали: срез «у кого есть право» не находит держателей от набора,
 * модуль, открытый набором, показывается закрытым, а пометка «только у администратора» не замечает
 * собранного второго всесильного субъекта. Лечится это тем, что права считает сервер и отдаёт их в
 * обоих контрактах — `AuthUser` (его читает портал) и `UserDto` (его читает витрина). Серверную
 * половину и проверяет этот файл.
 *
 * **Зачем база.** Набор, собранный администратором, существует только в таблицах: его код не
 * системный, в пометки рядом с ролью он не попадает (`systemAddonsOf`), матрица его не знает. На
 * подменах «субъект собран целиком» неотличимо от «собран без наборов» — оба ответа выглядят как
 * список прав роли. Гейт совместимости с ролью и вовсе живёт в SQL.
 *
 * **Чем отличается от соседей.** `auth-permissions.db.test.ts` проверяет те же права в четырёх
 * ответах сессии (вход, `refresh`, `/auth/me`, смена пароля) — там субъект собирает принципал.
 * `user-grants-routes.db.test.ts` — двойную запись назначений и пометки рядом с ролью на путях
 * правки учётки. Здесь только витрина: карточка и список, их согласие между собой, пакетность чтения
 * и порядок прав.
 *
 * **Пакетность — предмет проверки, а не деталь.** Витрина перебирает живые учётки целиком, и запрос
 * на учётку превратил бы страницу в сотню обращений к базе; поэтому число обращений к таблицам
 * наборов здесь считается, а не подразумевается чтением кода.
 *
 * **Общий прогон.** Свой префикс адресов и кодов наборов, уборка по нему же до и после; ни одного
 * утверждения обо всей базе — все выборки идут по идентификаторам своих учёток.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/users-permissions.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Метка своих строк: уборка идёт по ней, а не «по последним строкам». Префикс общий на все прогоны —
 * упавший прогон обязан убираться следующим, а не копить учётки в общей базе.
 */
const PREFIX = 'db-users-permissions';
/** Уникальный хвост прогона: адрес занимает действующая учётка, и два прогона не должны спорить. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;

/** Приметы адреса и ФИО в пароль попадать не должны (`passwordIdentityIssue`). */
const ADMIN_PASSWORD = 'db-showcase-secret-123';

/** Системный набор оргтехники, заведённый миграцией 0145: его состав тест не переписывает. */
const OPERATOR_GRANT = 'office_equipment_operator';

/**
 * Право, которого роль `shtab` не имеет ни от должности, ни от системного набора оргтехники, — им и
 * проверяется, что собранный набор доехал до витрины. Журнал путевых листов выбран намеренно:
 * площадочным ролям его не выдают (ADR 0037 — в листе персональные данные водителя), и «пришло от
 * роли» тут невозможно спутать с «пришло от набора».
 */
const ASSEMBLED_PERMISSION: Permission = 'waybills.read';

/**
 * Право, снятое из словаря выкатом, — так выглядит сирота в `grant_permissions`. Лежит в собранном
 * наборе рядом с настоящим: карточка обязана остаться списком `Permission`, а не «тем, что нашлось в
 * базе». Строгое равенство с `permissionsFor` это и сторожит.
 */
const RETIRED_PERMISSION = 'officeEquipment.retire';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  /** Пул нужен ради счётчика запросов: через него drizzle ходит в базу, и другой двери у него нет. */
  pool: pg.Pool;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  /** Администратор с настоящим входом: маршруты учёток закрыты правом `users.manage`. */
  auth: { authorization: string };
  adminId: string;
  /** Площадка: у объектной роли область обязательна (ADR 0039). */
  objectId: string;
  /** Контрагент-оператор: у внешнего исполнителя модульные права приходят от типа (ADR 0038). */
  wasteOperatorId: string;
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
  // Письма здесь ни при чём: учётки заводятся вставкой, а витрина только читает.
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
 * Уборка своих строк — и перед прогоном тоже. Записи журнала уходят первыми: `entity_id` там
 * текстовый и каскадом не убирается, а `actor_user_id` стоит под SET NULL. Назначения уходят
 * каскадом от `users`, а свои наборы — после учёток: `user_grants.grant_id` стоит под RESTRICT, и
 * выданный набор не удаляется, пока жив хоть один держатель.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'user' AND entity_id IN (
    SELECT id::text FROM users WHERE email LIKE ${`${PREFIX}%`})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}%`}`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${PREFIX}%`}`);
}

/**
 * Учётка вставкой, а не маршрутом: сюда нужны и собранный набор, которого форма учётки не примет
 * (`roleAddonsSchema` — enum), и учётка без роли, которую заводит только саморегистрация.
 *
 * Адрес несёт метку прогона, и по нему же список находит свои строки: `search` ищет подстрокой.
 */
async function newUser(
  role: Role | null,
  over: { counterpartyId?: string } = {},
): Promise<{ id: string; email: string }> {
  seq += 1;
  const email = `${PREFIX}-h${RUN}-${seq}@example.invalid`;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: 'Держатель',
      middleName: `Витринный ${seq}`,
      passwordHash: 'db-test-not-a-hash',
      role,
      // Учётка без роли — нерассмотренная заявка на регистрацию (ADR 0034), и активной она не бывает.
      isActive: role !== null,
      counterpartyId: over.counterpartyId ?? null,
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
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.grants.id, code: ctx.schema.grants.code });
  const grantId = created!.id;
  await ctx.db.insert(ctx.schema.grantRoles).values(roles.map((role) => ({ grantId, role })));
  await ctx.db
    .insert(ctx.schema.grantPermissions)
    .values(permissions.map((permission) => ({ grantId, permission })));
  return grantId;
}

/** Код набора по его идентификатору: витрина отвечает кодами, а тест заводил наборы вставкой. */
async function grantCodeOf(grantId: string): Promise<string> {
  const [row] = await ctx.db
    .select({ code: ctx.schema.grants.code })
    .from(ctx.schema.grants)
    .where(sql`${ctx.schema.grants.id} = ${grantId}`);
  return row!.code;
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

/** Выдача набора. Напрямую: двойная запись умеет только надстройки, а витрине важны любые наборы. */
async function assign(userId: string, grantId: string): Promise<void> {
  await ctx.db
    .insert(ctx.schema.userGrants)
    .values({ userId, grantId, grantedBy: ctx.adminId, origin: 'manual' });
}

async function card(id: string): Promise<UserAccountDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/users/${id}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ user: UserAccountDto }>().user;
}

/** Строки списка по поисковой метке: `search` ищет подстрокой в адресе и ФИО. */
async function listRows(search: string): Promise<UserAccountDto[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/users?search=${encodeURIComponent(search)}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ items: UserAccountDto[] }>().items;
}

function rowOf(rows: UserAccountDto[], id: string): UserAccountDto {
  const own = rows.find((row) => row.id === id);
  expect(own, `учётка ${id} в списке`).toBeDefined();
  return own!;
}

/**
 * Ожидаемый список — независимый счёт по контрактам: субъект собирается из того, что тест **сам
 * завёл** (роль, тип контрагента, права выданного набора), а не читается тем же запросом, что и
 * сервер. Сверять ответ повторным вызовом серверного чтения значило бы проверять запрос сам собой.
 */
function expected(subject: AccessSubject): Permission[] {
  return [...permissionsFor(subject)];
}

/**
 * Обращения к таблицам наборов за время одного действия.
 *
 * Считаются обёрткой вокруг `pool.query` — единственной двери, через которую drizzle ходит в базу
 * (`NodePgPreparedQuery.execute` зовёт `client.query`). Логгер drizzle для этого не годится: он
 * задаётся при сборке `db`, то есть до того, как тест успевает вмешаться.
 *
 * Считается **всё**, что упоминает `user_grants`, включая чтение принципала на каждом запросе:
 * отделять «свои» запросы от чужих по тексту значило бы привязать проверку к тому, как drizzle
 * печатает кавычки. Вывод делается не из абсолютного числа, а из его неизменности при росте числа
 * учёток — именно это и означает «читает пачкой».
 */
async function grantQueriesOf<T>(run: () => Promise<T>): Promise<{ value: T; queries: string[] }> {
  type RawQuery = (...args: unknown[]) => unknown;
  const original = ctx.pool.query as unknown as RawQuery;
  const queries: string[] = [];
  const spy: RawQuery = (...args) => {
    const first = args[0];
    const text =
      typeof first === 'string' ? first : String((first as { text?: string })?.text ?? '');
    if (/user_grants/i.test(text)) queries.push(text);
    return original.apply(ctx.pool, args);
  };
  ctx.pool.query = spy as unknown as typeof ctx.pool.query;
  try {
    return { value: await run(), queries };
  } finally {
    ctx.pool.query = original as unknown as typeof ctx.pool.query;
  }
}

describe.skipIf(!DB_URL)('витрина учёток отдаёт эффективные права (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, pool, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    await cleanup(db);

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 1`,
    );
    if (objects.rows.length === 0) {
      throw new Error(
        'В базе нет ни одного действующего объекта: миграции наполнения не применены',
      );
    }
    const operators = await db.execute<{ id: string }>(
      sql`SELECT id FROM counterparties
          WHERE type = 'operator' AND is_active AND deleted_at IS NULL ORDER BY name LIMIT 1`,
    );
    if (operators.rows.length === 0) {
      throw new Error('В базе нет действующего контрагента-оператора: наполнение не применено');
    }

    ctx = {
      app,
      db,
      pool,
      schema,
      closeDb,
      auth: { authorization: '' },
      adminId: '',
      objectId: objects.rows[0]!.id,
      wasteOperatorId: operators.rows[0]!.id,
    };

    // Администратор со настоящим входом: витрина закрыта правом `users.manage`, и токен обязан быть
    // выданным, а не собранным тестом.
    const email = `${PREFIX}-admin-${RUN}@example.invalid`;
    const { hashPassword } = await import('../src/auth/password');
    const [admin] = await db
      .insert(schema.users)
      .values({
        email,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: '',
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        role: 'admin',
        isActive: true,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    ctx.adminId = admin!.id;
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    ctx.auth = { authorization: `Bearer ${login.json<{ accessToken: string }>().accessToken}` };

    // Системный набор завела миграция 0145. Если его нет — сломан не тест, а накат: пусть это будет
    // видно здесь, а не в чужом ожидании.
    await systemGrantId(OPERATOR_GRANT);
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  /**
   * Карточка. Права сверяются с независимо посчитанным `permissionsFor` для субъекта учётки, коды —
   * с тем, что тест выдал. Состав системного набора берётся из `ROLE_ADDON_PERMISSIONS`, а не
   * переписывается списком: миграция 0145 копировала его один в один, и на равенстве этих двух
   * наборов держится обещание «переключение источника прав живым учёткам ничего не меняет».
   *
   * Сирота из состава собранного набора равенства не ломает: `permissionsFor` знает только словарь, а
   * читатель на границе «база → код» отсекает всё, чего в нём нет.
   */
  it('карточка отдаёт эффективные права и коды выданных наборов', async () => {
    const holder = await newUser('shtab');
    await assign(holder.id, await systemGrantId(OPERATOR_GRANT));
    const assembled = await newAssembledGrant(
      ['shtab'],
      [ASSEMBLED_PERMISSION, RETIRED_PERMISSION],
    );
    await assign(holder.id, assembled);
    const assembledCode = await grantCodeOf(assembled);

    const user = await card(holder.id);

    expect(user.permissions).toEqual(
      expected({
        role: 'shtab',
        grantPermissions: [...ROLE_ADDON_PERMISSIONS[OPERATOR_GRANT], ASSEMBLED_PERMISSION],
      }),
    );
    // Пустой список — не тот же ответ: у учётки без прав он тоже пустой, и равенство выше сошлось бы
    // на двух пустых массивах, ничего не проверив.
    expect(user.permissions.length).toBeGreaterThan(0);
    expect(user.permissions).toContain(ASSEMBLED_PERMISSION);
    expect(user.permissions).not.toContain(RETIRED_PERMISSION);
    // Коды — все выданные наборы, а не только системные: колонка «наборы» спрашивает про выданное
    // целиком. Порядок в ответе — по коду (`grantCodesByUserIds`).
    expect(user.grantCodes).toEqual(
      [OPERATOR_GRANT, assembledCode].sort((a, b) => a.localeCompare(b)),
    );
    // Пометка рядом с ролью осталась прежней и отвечает только за системные наборы: список прав её
    // не заменяет — она про «что выдано», он про «что учётка может».
    expect(user.addons).toEqual([OPERATOR_GRANT]);
  });

  /**
   * Список. Проверяется не «поле есть», а согласие двух ответов на один вопрос: строка списка и
   * карточка обязаны совпадать по правам и по кодам. Разойтись они могут только чтением — то есть
   * тем, что один из двух путей собирает субъект иначе.
   *
   * Учётки нарочно разные: у площадки права от роли, у диспетчера — от другой роли и без наборов, у
   * внешнего исполнителя весь его модуль приходит от **типа контрагента** (ADR 0038). Последняя и
   * ловит обрезанный субъект: роль `operator` без типа отвечает за одно `directories.read`, и
   * потерянный тип выглядел бы не ошибкой, а просто более коротким списком.
   */
  it('список отдаёт те же права и коды, что карточка, — для каждой строки', async () => {
    const site = await newUser('shtab');
    await assign(site.id, await systemGrantId(OPERATOR_GRANT));
    const dispatcher = await newUser('dispatcher');
    const executor = await newUser('operator', { counterpartyId: ctx.wasteOperatorId });

    const rows = await listRows(`${PREFIX}-h${RUN}`);

    const siteRow = rowOf(rows, site.id);
    expect(siteRow.permissions).toEqual(
      expected({ role: 'shtab', grantPermissions: [...ROLE_ADDON_PERMISSIONS[OPERATOR_GRANT]] }),
    );
    expect(siteRow.grantCodes).toEqual([OPERATOR_GRANT]);

    const dispatcherRow = rowOf(rows, dispatcher.id);
    expect(dispatcherRow.permissions).toEqual(expected({ role: 'dispatcher' }));
    expect(dispatcherRow.grantCodes).toEqual([]);

    const executorRow = rowOf(rows, executor.id);
    expect(executorRow.counterpartyType).toBe('operator');
    expect(executorRow.permissions).toEqual(
      expected({ role: 'operator', counterpartyType: 'operator' }),
    );
    // Страж самой проверки: без типа контрагента список был бы короче — и равенство выше не значило
    // бы ничего, если бы оба варианта совпадали.
    expect(executorRow.permissions).not.toEqual(expected({ role: 'operator' }));

    // И то же самое карточкой: два ответа на один вопрос, и разойтись им нечем.
    for (const row of [siteRow, dispatcherRow, executorRow]) {
      const one = await card(row.id);
      expect(one.permissions, row.email).toEqual(row.permissions);
      expect(one.grantCodes, row.email).toEqual(row.grantCodes);
      expect(one.addons, row.email).toEqual(row.addons);
    }
  });

  /**
   * Чтение пакетное. Витрина перебирает живые учётки целиком — по ним считаются держатели права,
   * группировка по фактическому набору и пометка «только у администратора», — и запрос на учётку
   * превратил бы страницу в сотню обращений к базе.
   *
   * Утверждение сформулировано неизменностью, а не числом: обращений к `user_grants` за страницу
   * четырёх учёток должно быть столько же, сколько за страницу одной. Чтение по строке дало бы
   * вчетверо больше и провалилось бы здесь; абсолютное же число зависит и от чтения принципала,
   * которое к пачке отношения не имеет.
   */
  it('список читает наборы пачкой: обращений не больше, чем у одной учётки', async () => {
    const grantId = await newAssembledGrant(['shtab'], [ASSEMBLED_PERMISSION]);
    const holders = [];
    for (let i = 0; i < 4; i += 1) {
      const holder = await newUser('shtab');
      await assign(holder.id, grantId);
      holders.push(holder);
    }

    const many = await grantQueriesOf(() => listRows(`${PREFIX}-h${RUN}`));
    expect(many.value.length).toBeGreaterThanOrEqual(holders.length);
    // Права доехали до **каждой** своей строки — иначе «мало запросов» означало бы «ничего не
    // прочитали»: пропущенная учётка в пачке выглядит как учётка без наборов.
    for (const holder of holders) {
      expect(rowOf(many.value, holder.id).permissions, holder.email).toContain(
        ASSEMBLED_PERMISSION,
      );
    }

    const one = await grantQueriesOf(() => listRows(holders[0]!.email));
    expect(one.value).toHaveLength(1);

    expect(many.queries.length, many.queries.join('\n')).toBe(one.queries.length);
    expect(many.queries.length).toBeLessThan(holders.length);
  });

  /**
   * Собранный администратором набор — главное, чего сегодняшняя витрина не видит вовсе. Его код не
   * системный, в `addons` он не попадает (`systemAddonsOf`), и матрица о нём не знает: без кодов и
   * прав от сервера такая учётка выглядела бы как обычная площадка без единого дополнительного
   * права.
   */
  it('набор, собранный администратором, даёт и свой код, и свои права мимо addons', async () => {
    const holder = await newUser('shtab');
    const assembled = await newAssembledGrant(['shtab'], [ASSEMBLED_PERMISSION]);
    await assign(holder.id, assembled);
    const code = await grantCodeOf(assembled);

    const user = await card(holder.id);

    expect(user.grantCodes).toEqual([code]);
    expect(user.permissions).toContain(ASSEMBLED_PERMISSION);
    expect(user.permissions).toEqual(
      expected({ role: 'shtab', grantPermissions: [ASSEMBLED_PERMISSION] }),
    );
    // Права роли никуда не делись: набор добавляет, а не заменяет.
    expect(user.permissions).toEqual(expect.arrayContaining(expected({ role: 'shtab' })));
    // Пометок у собранного набора нет — и это ровно то, из-за чего витрине понадобились коды.
    expect(user.addons).toEqual([]);
    expect(rowOf(await listRows(holder.email), holder.id)).toMatchObject({
      grantCodes: [code],
      addons: [],
    });
  });

  /**
   * Учётка без роли — нерассмотренная заявка на регистрацию (ADR 0034): доступ выдаётся ролью, и
   * пока её не назначили, человек для портала никто. Набор ей при этом выдан, и это вторая половина
   * проверки: коды отвечают на «что выдано» и остаются, а прав он не даёт — гейт совместимости с
   * ролью стоит в самом чтении (`grant_roles`), и `role IS NULL` не совпадает ни с одной его
   * строкой.
   */
  it('учётка без роли получает пустой список прав, даже держа набор', async () => {
    const applicant = await newUser(null);
    const assembled = await newAssembledGrant(['shtab'], [ASSEMBLED_PERMISSION]);
    await assign(applicant.id, assembled);
    const code = await grantCodeOf(assembled);

    const user = await card(applicant.id);

    expect(user.role).toBeNull();
    expect(user.permissions).toEqual([]);
    expect(user.grantCodes).toEqual([code]);
    expect(user.addons).toEqual([]);
    // Список отвечает то же: заявки разбирают именно из него.
    expect(rowOf(await listRows(applicant.email), applicant.id)).toMatchObject({
      permissions: [],
      grantCodes: [code],
    });
  });

  /**
   * Порядок — словарный (`PERMISSIONS`), а не алфавитный и не тот, в котором права вернула база.
   * Витрина сравнивает наборы прав между учётками (группировка «совпадающие профили», сверка «до и
   * после» на этапах перехода), и нестабильный порядок давал бы разный ответ на одинаковый состав.
   *
   * Проверяется обеими сторонами. Равенство `PERMISSIONS.filter(...)` можно получить и случайно,
   * поэтому рядом стоит неравенство алфавитному порядку — и сам алфавит сверяется с словарным, чтобы
   * утверждение не оказалось пустым на субъекте, где эти два порядка совпали.
   */
  it('порядок прав в карточке и в списке словарный, а не алфавитный', async () => {
    const holder = await newUser('shtab');
    await assign(holder.id, await systemGrantId(OPERATOR_GRANT));
    const subject: AccessSubject = {
      role: 'shtab',
      grantPermissions: [...ROLE_ADDON_PERMISSIONS[OPERATOR_GRANT]],
    };

    const user = await card(holder.id);
    expect(user.permissions).toEqual(PERMISSIONS.filter((permission) => can(subject, permission)));

    const alphabetical = [...user.permissions].sort();
    // Страж самой проверки: на субъекте, где алфавит и словарь совпадают, неравенство ниже не
    // значило бы ничего.
    expect(alphabetical, 'алфавит и словарь на этом субъекте совпали').not.toEqual(
      user.permissions,
    );
    expect(user.permissions).not.toEqual(alphabetical);
    // Список собирается тем же сборщиком, и порядок в нём тот же: витрина читает именно его.
    expect(rowOf(await listRows(holder.email), holder.id).permissions).toEqual(user.permissions);
  });
});
