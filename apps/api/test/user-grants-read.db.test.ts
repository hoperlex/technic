import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPermission, ROLE_ADDON_PERMISSIONS, type Role } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as UserScopesNs from '../src/services/user-scopes';

/**
 * Чтение назначаемых полномочий (ADR 0106, шаг 1c, первый приём) — на живой схеме.
 *
 * Предмет теста — три выражения `services/user-scopes.ts`: `grantCodesExpr`, `grantPermissionsExpr`
 * и пакетный `grantCodesByUserIds`. Ни один читатель на них ещё не переключён, поэтому доказать их
 * правоту больше нечем: поведение `can` от них пока не зависит, и ошибка здесь обнаружилась бы
 * только релизом переключения, то есть расширением или потерей доступа у живых учёток.
 *
 * Зачем база. Проверяется ровно то, чего на подменах не существует: соединение с `grant_roles`
 * (гейт совместимости с ролью), фильтр `deleted_at` на наборе, `DISTINCT` поверх двух наборов и
 * право-сирота, которое в базу можно вставить, а в словаре его нет. Мок ответил бы «запрос собран»
 * на любую из этих ошибок.
 *
 * Главные утверждения — второе и четвёртое. Второе: учётке, чью роль сменили мимо валидации, набор
 * прав **не даёт**, но остаётся видимым в её кодах, — сегодня так же отвечает `can` через
 * `canAttachAddon`, и переключение источника обязано сохранить этот ответ. Четвёртое: право,
 * снятое из словаря выкатом, приходит из базы как есть, и отсеивает его читатель (`isPermission`),
 * а не CHECK и не приведение типа.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/user-grants-read.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Уникальный хвост прогона: база общая с другими db-тестами и переживает прогоны. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
/**
 * Метка своих строк: уборка идёт по ней, а не «по последним строкам». Префикс общий на все прогоны
 * — упавший прогон обязан убираться следующим, а не копить учётки и наборы в общей базе.
 */
const PREFIX = 'db-user-grants-read';

/** Системный набор, заведённый миграцией 0145: его состав и роли берутся не из теста. */
const OPERATOR = 'office_equipment_operator';

/**
 * Право, которого нет в словаре `PERMISSIONS`, — так выглядит сирота после выката, снявшего право.
 * Вставляется руками: через портал такой строки не завести, а жить она обязана (CHECK по списку
 * прав превратил бы снятие права в отказ базы).
 */
const RETIRED_PERMISSION = 'officeEquipment.retire';

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof UserScopesNs;
  closeDb: () => Promise<void>;
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
  // Почта тут ни при чём: тест читает выражения напрямую, мимо маршрутов.
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
 * Уборка своих строк — и перед прогоном тоже. Порядок обязателен: `user_grants.grant_id` стоит под
 * RESTRICT, и свой набор не удалить, пока он кому-то выдан. Учётки уносят свои назначения каскадом,
 * а набор — состав и роли (`grant_permissions`, `grant_roles` — оба `ON DELETE CASCADE`).
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}%`}`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${PREFIX}%`}`);
}

async function newUser(role: Role): Promise<string> {
  seq += 1;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${PREFIX}-${RUN}-${seq}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Держатель',
      middleName: `Наборный ${seq}`,
      // Входа здесь нет: тест читает выражения напрямую, пароль не участвует.
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: true,
    })
    .returning({ id: ctx.schema.users.id });
  return created!.id;
}

/**
 * Набор, собранный тестом: не системный — ровно такие и собирает администратор. Код по умолчанию
 * порядковый; `codeSuffix` нужен там, где проверяется порядок кодов, а не сам факт их появления.
 */
async function newGrant(options: {
  roles: Role[];
  permissions: string[];
  deleted?: boolean;
  codeSuffix?: string;
}): Promise<string> {
  seq += 1;
  const [created] = await ctx.db
    .insert(ctx.schema.grants)
    .values({
      code: `${PREFIX}-${RUN}-${options.codeSuffix ?? seq}`,
      name: `Тестовый набор ${seq}`,
      isSystem: false,
      deletedAt: options.deleted ? new Date() : null,
    })
    .returning({ id: ctx.schema.grants.id });
  const grantId = created!.id;
  if (options.roles.length > 0) {
    await ctx.db
      .insert(ctx.schema.grantRoles)
      .values(options.roles.map((role) => ({ grantId, role })));
  }
  if (options.permissions.length > 0) {
    await ctx.db
      .insert(ctx.schema.grantPermissions)
      .values(options.permissions.map((permission) => ({ grantId, permission })));
  }
  return grantId;
}

/** Идентификатор системного набора по коду — его завела миграция, а не тест. */
async function systemGrantId(code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: ctx.schema.grants.id })
    .from(ctx.schema.grants)
    .where(eq(ctx.schema.grants.code, code));
  if (!row) throw new Error(`В базе нет системного набора «${code}»`);
  return row.id;
}

/** Выдача набора учётке. Напрямую: двойная запись умеет только надстройки, а читаем мы схему. */
async function assign(userId: string, grantId: string): Promise<void> {
  await ctx.db
    .insert(ctx.schema.userGrants)
    .values({ userId, grantId, grantedBy: ctx.adminId, origin: 'manual' });
}

interface Read {
  codes: string[];
  permissions: string[];
}

/**
 * Оба выражения — одним запросом по строке пользователя: они коррелированные и без `users` в
 * запросе не существуют, а читатель (принципал) берёт их именно так.
 */
async function read(userId: string): Promise<Read> {
  const [row] = await ctx.db
    .select({
      codes: ctx.service.grantCodesExpr,
      permissions: ctx.service.grantPermissionsExpr,
    })
    .from(ctx.schema.users)
    .where(eq(ctx.schema.users.id, userId));
  return { codes: row!.codes, permissions: [...row!.permissions].sort() };
}

describe.skipIf(!DB_URL)('назначения: чтение наборов учётки (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const service = await import('../src/services/user-scopes');
    await cleanup(db);

    ctx = { db, schema, service, closeDb, adminId: '' };
    ctx.adminId = await newUser('admin');
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await cleanup(ctx.db);
      await ctx.closeDb();
    }
  });

  it('выданный набор отдаёт и свой код, и свои права', async () => {
    const userId = await newUser('shtab');
    const grantId = await newGrant({
      roles: ['shtab'],
      permissions: ['officeEquipment.write', 'serviceRequests.assign'],
    });
    await assign(userId, grantId);

    const { codes, permissions } = await read(userId);
    expect(codes).toHaveLength(1);
    expect(permissions).toEqual(['officeEquipment.write', 'serviceRequests.assign']);
  });

  /**
   * Тот же ответ на настоящем наборе — системном, заведённом миграцией 0145. Состав сверяется с
   * `ROLE_ADDON_PERMISSIONS`, а не переписывается сюда списком: миграция копировала его один в один,
   * и на равенстве этих двух наборов держится обещание «переключение источника не меняет прав».
   *
   * Проверка на **включение**, а не на равенство: системный набор — общая строка базы, которую этот
   * тест не заводил и убирать за собой не должен, а база у db-тестов одна на все файлы и переживает
   * прогоны. Потеря права здесь означала бы потерю доступа при переключении и ловится; лишняя
   * строка, оставленная соседом, — это грязь в общей базе, а не свойство выражения.
   */
  it('системный набор отдаёт состав, перенесённый миграцией', async () => {
    const userId = await newUser('shtab');
    await assign(userId, await systemGrantId(OPERATOR));

    const { codes, permissions } = await read(userId);
    expect(codes).toEqual([OPERATOR]);
    expect(permissions).toEqual(expect.arrayContaining([...ROLE_ADDON_PERMISSIONS[OPERATOR]]));
  });

  /**
   * Гейт совместимости с ролью. `observer` в `grant_roles` системного набора нет — как нет его и в
   * `ROLE_ADDON_BASE_ROLES`, — и права набор такой учётке не даёт: ровно так сегодня отвечает `can`
   * через `canAttachAddon`. Коды при этом приходят: выдача состоялась, и витрина обязана её
   * показывать, иначе снять непонятно откуда взявшееся полномочие будет нечем.
   *
   * РОЛЬ ЗДЕСЬ СМЕНИЛАСЬ С `manager` НА `observer` (этап Э7 плана профилей оргтехники, Р5,
   * миграция B): «Ведение» стало выдаваемым офисной паре ролей, и менеджер перестал быть примером
   * несовместимости — на нём тест доказывал бы обратное тому, ради чего написан. Наблюдатель для
   * этой роли выбран не случайно: он по построению только смотрит, и наборов оргтехники ему не
   * дадут ни при каком расширении списка (Р5, правило 3 — набор обязан что-то давать).
   *
   * Собрать такую учётку через форму нельзя — совместимость проверяет маршрут, — поэтому здесь она
   * собирается руками. Именно поэтому же соединение с `grant_roles` нельзя «оптимизировать»: ни
   * один тест матрицы этот случай не порождает, и потеря гейта прошла бы незамеченной.
   */
  it('роли, которой набор не положен, права не приходят — а коды приходят', async () => {
    const userId = await newUser('observer');
    await assign(userId, await systemGrantId(OPERATOR));

    const { codes, permissions } = await read(userId);
    expect(codes).toEqual([OPERATOR]);
    expect(permissions).toEqual([]);
  });

  /** Мягко удалённый набор не действует ни у кого: строка выдачи остаётся, доступ — нет. */
  it('мягко удалённый набор не даёт ни кодов, ни прав', async () => {
    const userId = await newUser('shtab');
    const grantId = await newGrant({
      roles: ['shtab'],
      permissions: ['officeEquipment.write'],
      deleted: true,
    });
    await assign(userId, grantId);

    const { codes, permissions } = await read(userId);
    expect(codes).toEqual([]);
    expect(permissions).toEqual([]);
    // Назначение при этом на месте — реестр выдач обязан объяснять прошлое (`grant_id` под
    // RESTRICT именно ради этого).
    const rows = await ctx.db
      .select({ id: ctx.schema.userGrants.id })
      .from(ctx.schema.userGrants)
      .where(eq(ctx.schema.userGrants.userId, userId));
    expect(rows).toHaveLength(1);
  });

  /**
   * Право-сирота. Выражение отдаёт его как есть — базе неоткуда знать словарь, — а отсеивает его
   * читатель. `isPermission` здесь не украшение теста: без фильтра сирота доехала бы до `can` и
   * витрины, и портал начал бы рассказывать про доступ то, чего в коде уже нет.
   */
  it('право вне словаря приходит из базы как есть и отсеивается isPermission', async () => {
    const userId = await newUser('shtab');
    const grantId = await newGrant({
      roles: ['shtab'],
      permissions: ['officeEquipment.write', RETIRED_PERMISSION],
    });
    await assign(userId, grantId);

    const { permissions } = await read(userId);
    expect(permissions).toContain(RETIRED_PERMISSION);
    expect(permissions.filter(isPermission)).toEqual(['officeEquipment.write']);
  });

  /**
   * Одно право в двух наборах — штатный случай свободной сборки, а не редкость: наборы собираются
   * независимо и пересекаются. Дубль в массиве означал бы, что число прав учётки зависит от того,
   * сколько наборов их дало, — и предпросмотр отзыва считался бы по этому числу.
   */
  it('дубль права в двух наборах не даёт дубля в результате', async () => {
    const userId = await newUser('shtab');
    const first = await newGrant({
      roles: ['shtab'],
      permissions: ['serviceRequests.status', 'serviceRequests.assign'],
    });
    const second = await newGrant({
      roles: ['shtab'],
      permissions: ['serviceRequests.status', 'officeEquipment.write'],
    });
    await assign(userId, first);
    await assign(userId, second);

    const { codes, permissions } = await read(userId);
    expect(codes).toHaveLength(2);
    expect(permissions).toEqual([
      'officeEquipment.write',
      'serviceRequests.assign',
      'serviceRequests.status',
    ]);
  });

  /**
   * Пакетное чтение — то же самое для списка учёток. Проверяется вместе с одиночным выражением и
   * на тех же данных: разъехавшись, они дали бы карточку и список, по-разному отвечающие про одну
   * учётку.
   */
  it('пакетное чтение кодов совпадает с выражением и молчит про удалённые наборы', async () => {
    const holder = await newUser('shtab');
    const empty = await newUser('shtab');
    const alive = await newGrant({ roles: ['shtab'], permissions: ['officeEquipment.write'] });
    const dead = await newGrant({ roles: ['shtab'], permissions: ['drivers.read'], deleted: true });
    await assign(holder, alive);
    await assign(holder, dead);

    const map = await ctx.service.grantCodesByUserIds(ctx.db, [holder, empty]);
    expect(map.get(holder)).toEqual((await read(holder)).codes);
    expect(map.get(holder)).toHaveLength(1);
    // Учётка без наборов в карте отсутствует — как и в `addonsByUserIds`: читатель подставляет `[]`.
    expect(map.get(empty)).toBeUndefined();
    expect(await ctx.service.grantCodesByUserIds(ctx.db, [])).toEqual(new Map());
  });

  /**
   * Пакетное чтение прав — близнец `grantPermissionsExpr` для списка учёток (витрина «Права», этап
   * 2б плана). Проверяется на тех же данных и теми же тремя правилами, что одиночное выражение:
   * гейт совместимости с ролью, мягко удалённый набор, право-сирота. Разъехавшись с выражением, они
   * дали бы карточку и список, по-разному отвечающие про одну учётку, — а витрина назначена
   * критерием готовности этапов именно потому, что показывает факт.
   *
   * **Одно отличие от выражения намеренное**: сироту пакетный читатель отсеивает сам
   * (`isPermission`), потому что отдаёт `Permission[]`, а не строки из базы. Поэтому сверка идёт с
   * отфильтрованным ответом выражения, а не с сырым.
   */
  it('пакетное чтение прав повторяет выражение: гейт роли, удалённый набор и сирота', async () => {
    const holder = await newUser('shtab');
    const empty = await newUser('shtab');
    // Роль, которой набор не положен: права ей не приходят ни выражением, ни пачкой.
    const stranger = await newUser('manager');
    const alive = await newGrant({
      roles: ['shtab'],
      permissions: ['officeEquipment.write', RETIRED_PERMISSION],
    });
    const dead = await newGrant({ roles: ['shtab'], permissions: ['drivers.read'], deleted: true });
    await assign(holder, alive);
    await assign(holder, dead);
    await assign(stranger, alive);

    const map = await ctx.service.grantPermissionsByUserIds(ctx.db, [holder, empty, stranger]);
    expect(map.get(holder)).toEqual((await read(holder)).permissions.filter(isPermission));
    expect(map.get(holder)).toEqual(['officeEquipment.write']);
    // Права удалённого набора не приходят, сирота отсеяна на границе «база → код».
    expect(map.get(holder)).not.toContain('drivers.read');
    expect(map.get(holder)).not.toContain(RETIRED_PERMISSION);
    // Ни у учётки без наборов, ни у чужой роли строк нет вовсе: читатель подставляет `[]`.
    expect(map.get(empty)).toBeUndefined();
    expect(map.get(stranger)).toBeUndefined();
    expect(await ctx.service.grantPermissionsByUserIds(ctx.db, [])).toEqual(new Map());
  });

  /**
   * Порядок кодов задан выражением (`ORDER BY g.code`), а не порядком выдачи: набор показывается
   * пометками рядом с ролью и не должен переставляться от того, что кому выдали раньше.
   */
  it('коды приходят в порядке кода, а не выдачи', async () => {
    const userId = await newUser('shtab');
    const last = await newGrant({
      roles: ['shtab'],
      permissions: ['officeEquipment.write'],
      codeSuffix: 'zzz',
    });
    const first = await newGrant({
      roles: ['shtab'],
      permissions: ['drivers.read'],
      codeSuffix: 'aaa',
    });
    // Выдаётся первым тот, чей код больше: без `ORDER BY` порядок совпал бы с порядком выдачи.
    await assign(userId, last);
    await assign(userId, first);

    const { codes } = await read(userId);
    expect(codes).toEqual([`${PREFIX}-${RUN}-aaa`, `${PREFIX}-${RUN}-zzz`]);
  });
});
