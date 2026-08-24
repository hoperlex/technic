import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, type Role } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/*
 * ФАЙЛУ НУЖНА СВОЯ БАЗА. Каждая команда берёт управляющую строку модуля `FOR SHARE` (шаг 0 канона),
 * а соседние файлы модуля эту же строку меняют и замораживают (план Ю27, Ю30): прогон по общей
 * `TEST_DATABASE_URL` дал бы падение, которое выглядит поломкой кода, а не гонкой файлов. Режим
 * модуля файл при этом не трогает и блокировок дольше своей транзакции не держит.
 *
 * Запуск (база пустая либо промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/ap_auth \
 *     npx vitest run test/assignment-authorization.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

/**
 * Авторизация дверей истории назначения — этап 3, волна 3.4
 * (`docs/assignment-periods-plan.md`, §8, Р9, Р29, Р32; «Авторизационные»).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ЧЕГО НЕТ В ПРЕДМЕТНЫХ ФАЙЛАХ. Права у этих дверей устроены двухслойно:
 * безусловная пара на маршруте (`vehicleRequests.status` + `waybills.read`) и **условная**
 * авторизация шага 9, которая считается уже под блокировкой и по **посчитанному исходу** (Р32).
 * Предметные файлы проверяют второй слой на выдуманном субъекте — `{ role: 'manager' }` в аргументе
 * функции, — и это не то же самое, что боевой путь:
 *
 * - **первого слоя там нет вовсе**: стражи висят на маршруте, и вызов сервиса их не проходит;
 * - **связь «принципал → условная авторизация» не проверена**: роут собирает субъект сам
 *   (`crewCommandSpec({ actor: { ...p, id: p.id } })`), и потеряй он роль по дороге, `can()`
 *   отвечал бы «нет» на всё — плановая смена машиниста стала бы недоступна никому, а тесты двери
 *   остались бы зелёными.
 *
 * Отсюда предметы файла — **перебор прав по боевым HTTP-дверям**:
 *
 * 1. **семь дверей без `waybills.read`** — 403 у каждой, и это первый слой. Контроль — тот же
 *    субъект, которому право выдано полномочием: он проходит стражей и получает предметный ответ;
 * 2. **исход `crew` без `waybills.correct`** — 403 и **ни одной записи** (проверяется состоянием
 *    после отказа, а не только кодом);
 * 3. **глубже тридцати дней без `correctBeyondLimit`** — 403 диспетчеру, работа администратору;
 * 4. **архивная заявка без `archive.read`** — дверь ремонта её открывает (Ц3), а `restore: true`
 *    без `archive.restore` отвечает 403; рядом показано, что общая карточка той же заявки этой же
 *    роли по-прежнему невидима — отступление Ц3 ограничено дверью ремонта;
 * 5. **дремлющая команда** — исход `assignment_tail`, и коррекционных прав она не просит: менеджер,
 *    которому та же дверь отказала в историческом изменении, эту команду проводит;
 * 6. **диспетчер** проходит там, где это предусмотрено решением этапа 0 (п. 8): историческая
 *    коррекция и ремонт истории — его работа.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО. Условный контракт двери **ремонта** разобран по строкам в
 * `assignment-repair.db.test.ts` — он с самого начала написан по HTTP и с настоящими учётками.
 * Здесь ремонт участвует только там, где добавляет своё: в переборе стражей и в той половине Ц3,
 * которой у соседа нет, — «архив этой роли по-прежнему закрыт».
 *
 * ПОЧЕМУ СУБЪЕКТ БЕЗ `waybills.read` СОБИРАЕТСЯ ПОЛНОМОЧИЕМ, А НЕ БЕРЁТСЯ РОЛЬЮ. Роли, у которой
 * есть `vehicleRequests.status` и нет `waybills.read`, в матрице одна — арендодатель, — и она
 * упёрлась бы в область видимости (`assertLessorScope`) раньше стража, то есть проверяла бы не то.
 * Наблюдатель с выданным полномочием даёт ровно нужный срез: сквозная область, право вести
 * состояние заявки и **отсутствие** одного конкретного права.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Метки своих строк: уборка идёт по ним, а не «по последним записям». */
const EMAIL_PREFIX = 'db-ap-authz';
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: авторизация дверей истории';
const REQUEST_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: авторизация дверей истории';
const GRANT_PREFIX = 'ap_authz_';
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');
const PASSWORD = 'db-test-password-123';

const TODAY = moscowDateKeyOf(new Date());
/** Историческое изменение в пределах тридцати дней: коррекция диспетчеру по силам. */
const NEAR_FROM = shiftDateKey(TODAY, -20);
/** Настоящий миграционный долг: глубже тридцати дней — только администратору. */
const DEEP_FROM = shiftDateKey(TODAY, -60);
/** Второе решение о машине: цель коррекции — **первое**, а последнее правит окно смены техники. */
const SPLIT_AT = shiftDateKey(TODAY, -3);
const TERM_TO = shiftDateKey(TODAY, 10);

/**
 * Срок дремлющей сцены — целиком в прошлом и кончившийся сорок дней назад.
 *
 * Дата решения хвоста у него — `dateTo + 1`, то есть **прошлое и глубже тридцати дней**. Ровно этим
 * случай и проверяет Р32: прошлого команда не трогает (`inTermRange` пуст), поэтому ни
 * `waybills.correct`, ни снятого предела ей не нужно — сколько бы лет ни было её дате. Возьми сцена
 * будущий хвост, она была бы зелёной и на модели «право спрашивает календарь», которую Р32 и
 * заменил.
 */
const DORMANT_FROM = shiftDateKey(TODAY, -60);
const DORMANT_SPLIT = shiftDateKey(TODAY, -50);
const DORMANT_TO = shiftDateKey(TODAY, -40);

interface Account {
  id: string;
  email: string;
  auth: { authorization: string };
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: Account;
  dispatcher: Account;
  manager: Account;
  /** Наблюдатель с полномочием «вести состояние заявки» и **без** `waybills.read`. */
  gated: Account;
  /** Он же, но с выданным `waybills.read`: контроль к перебору стражей. */
  gatedWithRead: Account;
  objectId: string;
  vehicleA: { id: string; typeId: string };
  vehicleB: { id: string; typeId: string };
  vehicleC: { id: string; typeId: string };
  personA: string;
  personB: string;
}

let ctx: Ctx;
let seq = 0;

beforeAll(async () => {
  if (!DB_URL) return;
  process.env.DATABASE_URL = DB_URL;
  process.env.NODE_ENV ??= 'test';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.MAIL_ENABLED = 'false';

  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }

  const { buildApp: build } = await import('../src/app');
  const { db, closeDb } = await import('../src/db/client');
  ctx = { app: await build(), db, closeDb } as Ctx;
  await cleanup();

  const one = async (q: Parameters<typeof db.execute>[0]): Promise<Record<string, string>> => {
    const [row] = (await db.execute<Record<string, string>>(q)).rows;
    if (!row) throw new Error('в справочнике пусто: сцену не собрать');
    return row;
  };
  ctx.objectId = (await one(sql`SELECT id FROM construction_objects LIMIT 1`)).id!;
  const vehicle = async (offset: number) => {
    const row = await one(sql`
      SELECT v.id, v.vehicle_type_id FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE v.deleted_at IS NULL AND v.ownership = 'own' AND vk.code = 'special_equipment'
       ORDER BY v.id OFFSET ${offset} LIMIT 1`);
    return { id: row.id!, typeId: row.vehicle_type_id! };
  };
  ctx.vehicleA = await vehicle(0);
  ctx.vehicleB = await vehicle(1);
  ctx.vehicleC = await vehicle(2);
  ctx.personA = await newPerson('Машинистов');
  ctx.personB = await newPerson('Сменщиков');
  ctx.admin = await newAccount('admin', 'admin');
  ctx.dispatcher = await newAccount('dispatcher', 'disp');
  ctx.manager = await newAccount('manager', 'mgr');
  ctx.gated = await newAccount('observer', 'gated', ['vehicleRequests.status']);
  ctx.gatedWithRead = await newAccount('observer', 'gated-read', [
    'vehicleRequests.status',
    'waybills.read',
  ]);
}, 240_000);

afterAll(async () => {
  if (!DB_URL || !ctx) return;
  await cleanup();
  await ctx.app?.close();
  await ctx.closeDb?.();
});

/**
 * Уборка. База своя, но общая для прогонов файла: заявки уносят историю, назначение и связи
 * каскадом, операции журнала — своими ссылками, а работники, полномочия и учётки идут последними.
 */
async function cleanup(): Promise<void> {
  const db = ctx.db;
  await db.execute(sql`
    DELETE FROM audit_log WHERE entity_type = 'vehicle_request' AND entity_id IN (
      SELECT id::text FROM vehicle_requests WHERE comment = ${REQUEST_MARK})`);
  await db.execute(sql`
    DELETE FROM waybills WHERE source_request_id IN (
      SELECT id FROM vehicle_requests WHERE comment = ${REQUEST_MARK})`);
  // Заявки первыми: строки истории ссылаются на операции под RESTRICT, и уносит их каскад заявки.
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${REQUEST_MARK}`);
  await db.execute(sql`
    DELETE FROM waybill_corrections WHERE actor_user_id IN (
      SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`
    DELETE FROM user_grants WHERE grant_id IN (
      SELECT id FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${PERSON_MARK}`);
}

async function newPerson(lastName: string): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO persons (last_name, first_name, comment)
      VALUES (${lastName}, 'Пров', ${PERSON_MARK}) RETURNING id`)
  ).rows;
  return row!.id;
}

/**
 * Учётка роли, при необходимости — с назначенным полномочием (ADR 0106).
 *
 * Полномочие заводится набором и связывается с ролью: гейт совместимости стоит в самом чтении прав
 * (`grantPermissionsExpr` соединяется с `grant_roles`), и набор без строки роли не дал бы учётке
 * ничего — молча, без единой ошибки.
 */
async function newAccount(role: Role, suffix: string, permissions?: string[]): Promise<Account> {
  seq += 1;
  const email = `${EMAIL_PREFIX}-${suffix}-${RUN}-${seq}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${email}, 'Правов', 'Пров', '', ${await hashPassword(PASSWORD)}, ${role}, true, now())
      RETURNING id`)
  ).rows;

  if (permissions?.length) {
    const [grant] = (
      await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO grants (code, name, description)
        VALUES (${`${GRANT_PREFIX}${suffix}_${RUN}`}, ${`Тестовый набор (${suffix})`}, '')
        RETURNING id`)
    ).rows;
    for (const permission of permissions) {
      await ctx.db.execute(sql`
        INSERT INTO grant_permissions (grant_id, permission) VALUES (${grant!.id}, ${permission})`);
    }
    await ctx.db.execute(sql`
      INSERT INTO grant_roles (grant_id, role) VALUES (${grant!.id}, ${role})`);
    await ctx.db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id) VALUES (${row!.id}, ${grant!.id})`);
  }

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const { accessToken } = login.json<{ accessToken: string }>();
  return { id: row!.id, email, auth: { authorization: `Bearer ${accessToken}` } };
}

// ── Сцена ──

interface SceneOptions {
  dateFrom?: string;
  dateTo?: string;
  archived?: boolean;
  /** Второе решение о машине внутри срока: без него у коррекции нет законной цели (Р7). */
  split?: boolean;
  /** Дата второго решения о машине; по умолчанию — три дня назад. */
  splitAt?: string;
  /** Что стоит на шкале машиниста с начала срока. */
  driverAtStart?: 'person_a' | 'unknown';
  /** Дремлющее решение хвоста за концом срока: цель отмены с исходом `assignment_tail` (Р31). */
  dormantTail?: boolean;
  /** Выписать бумагу на весь срок расчётом от его начала. */
  issueSheets?: boolean;
}

interface Scene {
  requestId: string;
  version: number;
  /** Первое решение о машине — законная цель периодной коррекции. */
  firstVehicleChangeId: string;
  /** Vehicle-строка дремлющей группы хвоста: цель отмены. */
  dormantTailChangeId: string | null;
}

async function makeScene(options: SceneOptions = {}): Promise<Scene> {
  const dateFrom = options.dateFrom ?? NEAR_FROM;
  const dateTo = options.dateTo ?? TERM_TO;
  // Хвост истории и назначение обязаны совпадать (Р17): со вторым решением о машине заявка закрыта
  // им, без него — первым.
  const tail = options.split ? ctx.vehicleB : ctx.vehicleA;
  const [request] = (
    await ctx.db.execute<{ id: string; version: number }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment,
                                    created_by, assignment_history_state,
                                    assignment_history_validated_on, deleted_at, deleted_by)
      VALUES ('special_equipment', ${ctx.objectId}, ${ctx.vehicleA.typeId}, 'confirmed',
              ${REQUEST_MARK}, ${ctx.admin.id}, 'materialized', ${TODAY},
              ${options.archived ? new Date().toISOString() : null},
              ${options.archived ? ctx.admin.id : null})
      RETURNING id, version`)
  ).rows;
  const requestId = request!.id;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${requestId}, ${dateFrom}, ${dateTo})`);
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignments
      (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
    VALUES (${requestId}, ${tail.id}, ${tail.typeId}, ${ctx.vehicleA.typeId}, ${ctx.admin.id})`);

  const firstVehicleChangeId = await insertChange({
    requestId,
    effectiveDate: dateFrom,
    dimension: 'vehicle',
    vehicleId: ctx.vehicleA.id,
    origin: 'assignment',
  });
  await insertChange(
    options.driverAtStart === 'unknown'
      ? {
          requestId,
          effectiveDate: dateFrom,
          dimension: 'driver',
          driverState: 'unknown',
          origin: 'backfill',
        }
      : {
          requestId,
          effectiveDate: dateFrom,
          dimension: 'driver',
          driverState: 'set',
          driverPersonId: ctx.personA,
          origin: 'assignment',
        },
  );
  if (options.split) {
    await insertChange({
      requestId,
      effectiveDate: options.splitAt ?? SPLIT_AT,
      dimension: 'vehicle',
      vehicleId: ctx.vehicleB.id,
      origin: 'reassignment',
    });
  }
  let dormantTailChangeId: string | null = null;
  if (options.dormantTail) {
    /*
     * Решение хвоста `assignment_wins` (Р31), оставшееся дремлющим: граница написана машиной
     * **назначения** на `dateTo + 1`, зависимый якорь машиниста — той же группой и тем же
     * провенансом. Гаснут они вместе, и отмена такой группы — «правка уже принятого решения», то
     * есть исход `assignment_tail` без коррекционных прав.
     */
    const group = randomUUID();
    const at = shiftDateKey(dateTo, 1);
    dormantTailChangeId = await insertChange({
      requestId,
      effectiveDate: at,
      dimension: 'vehicle',
      vehicleId: tail.id,
      origin: 'tail_resolution',
      changeGroupId: group,
    });
    await insertChange({
      requestId,
      effectiveDate: at,
      dimension: 'driver',
      driverState: 'set',
      driverPersonId: ctx.personA,
      origin: 'tail_resolution',
      changeGroupId: group,
    });
  }
  if (options.issueSheets) {
    const { syncEsm2Waybills } = await import('../src/services/waybill-esm2');
    await ctx.db.transaction(async (tx) => {
      await syncEsm2Waybills(tx, {
        requestId,
        actor: { id: ctx.admin.id },
        reason: 'сцена теста: бумага на весь срок',
        driverPersonId: ctx.personA,
        asOf: dateFrom,
      });
    });
  }
  return {
    requestId,
    version: await versionOf(requestId),
    firstVehicleChangeId,
    dormantTailChangeId,
  };
}

async function insertChange(row: {
  requestId: string;
  effectiveDate: string;
  dimension: 'vehicle' | 'driver';
  vehicleId?: string;
  driverPersonId?: string;
  driverState?: string;
  origin: string;
  changeGroupId?: string;
}): Promise<string> {
  const [inserted] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_request_assignment_changes
        (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
         change_group_id)
      VALUES (${row.requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
              ${row.driverPersonId ?? null}, ${row.driverState ?? null}, ${row.origin},
              ${row.changeGroupId ?? randomUUID()})
      RETURNING id`)
  ).rows;
  return inserted!.id;
}

async function versionOf(requestId: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ version: number }>(
    sql`SELECT version FROM vehicle_requests WHERE id = ${requestId}`,
  );
  return rows[0]!.version;
}

/** Все строки истории заявки — и актуальные, и погашенные: отказ не вправе тронуть ни одну. */
async function rowsOf(requestId: string) {
  return (
    await ctx.db.execute<{
      id: string;
      effective_date: string;
      dimension: string;
      driver_person_id: string | null;
      superseded_at: string | null;
    }>(sql`
      SELECT id, effective_date, dimension, driver_person_id, superseded_at
        FROM vehicle_request_assignment_changes
       WHERE request_id = ${requestId} ORDER BY effective_date, created_at`)
  ).rows;
}

/** Операции журнала, задевшие эту заявку (Р9). */
async function operationsOf(requestId: string) {
  return (
    await ctx.db.execute<{ id: string; kind: string; authorization_scope: unknown }>(sql`
      SELECT c.id, c.kind, c.authorization_scope
        FROM waybill_corrections c
        JOIN vehicle_request_corrections vrc ON vrc.correction_id = c.id
       WHERE vrc.request_id = ${requestId}`)
  ).rows;
}

/** Снимок состояния заявки: по нему и проверяется «ни одной записи». */
/*
 * ЭСМ2-РАЗРЕЗ. Снимок считает листы **числом**, и это устойчиво к разрезу: все утверждения файла
 * сравнивают снимок с самим собой (`after).toEqual(before)`) или требуют нуля операций — то есть
 * говорят «дверь не сделала ничего», а не «бумаги ровно столько». Сколько листов у заявки и как они
 * нарезаны, для перебора прав безразлично.
 *
 * Предмет файла — авторизация: семь дверей без права дают 403, исход решает, каких прав спросить.
 * Режим чтения на это не влияет ни сейчас, ни после этапа 5, поэтому файл закрыт с
 * `readModeIrrelevant`, а не обёрнут двумя прогонами.
 */
async function snapshotOf(requestId: string) {
  return {
    rows: await rowsOf(requestId),
    operations: await operationsOf(requestId),
    version: await versionOf(requestId),
    sheets: (
      await ctx.db.execute<{ id: string }>(sql`
        SELECT id FROM waybills WHERE source_request_id = ${requestId} AND status <> 'cancelled'`)
    ).rows.length,
  };
}

// ── Двери ──

type Reply = { statusCode: number; body: string };

const json = (res: Reply): Record<string, unknown> =>
  JSON.parse(res.body) as Record<string, unknown>;

const url = (requestId: string, tail: string): string =>
  `/api/v1/vehicle-requests/${requestId}${tail}`;

const get = (account: Account, path: string): Promise<Reply> =>
  ctx.app.inject({ method: 'GET', url: path, headers: account.auth });

const post = (account: Account, path: string, payload: unknown): Promise<Reply> =>
  ctx.app.inject({ method: 'POST', url: path, headers: account.auth, payload });

const operation = (reason: string) => ({ operationId: randomUUID(), reason });

/** Тело команды машиниста, вооружённое посчитанным предпросмотром. */
async function armedCrew(
  account: Account,
  scene: Scene,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const preview = await post(account, url(scene.requestId, '/assignment-changes/preview'), body);
  expect(preview.statusCode, preview.body).toBe(200);
  const dto = json(preview) as unknown as {
    fingerprint: string;
    unlockFingerprint: string | null;
    operationRequirement: { kind: string } | null;
  };
  return {
    ...body,
    previewFingerprint: dto.fingerprint,
    ...(dto.unlockFingerprint ? { unlockFingerprint: dto.unlockFingerprint } : {}),
    ...(dto.operationRequirement ? { operation: operation('на объекте работал другой человек') } : {}),
  };
}

describe.skipIf(!DB_URL)('авторизация дверей истории назначения (§8, Р29, Р32)', () => {
  // ── 1. Первый слой: безусловная пара на маршруте ──

  /**
   * `waybills.read` обязателен у **всех семи** дверей, включая боевые (§8, прецедент ADR 0050
   * п. 11): рабочий путь идёт через предпросмотр — он показывает номера бланков и фамилии парка, —
   * и роль без этого права упиралась бы в 403 посреди операции, уже подтвердив разблокировки.
   *
   * Проверяется перебором, а не одной дверью: стражи вешаются на маршрут поимённо, и забытая пара у
   * восьмой двери — ровно та ошибка, которую перебор ловит, а точечный тест нет.
   *
   * Контроль — тот же наблюдатель, которому `waybills.read` выдано полномочием: он обязан пройти
   * стражей и получить **предметный** ответ. Без контроля зелёный выше объяснялся бы и тем, что
   * наблюдателя не пускает что-то другое — область, состояние заявки, отсутствующий маршрут.
   */
  it('семь дверей без waybills.read отвечают 403, а с ним — пропускают к предмету', async () => {
    const scene = await makeScene({ split: true, driverAtStart: 'unknown' });
    const anchors = [{ effectiveDate: NEAR_FROM, driverPersonId: ctx.personA }];
    /*
     * Версия у боевых тел заведомо чужая. Это не хитрость, а способ отделить слои: сверка версии —
     * шаг 3 канона, то есть **после** стражей и **до** условной авторизации. Субъект, прошедший
     * первый слой, обязан дойти до неё и получить 409; отказ 403 на том же теле означал бы, что его
     * не пустил страж.
     */
    /*
     * `passed` — ответ, который субъект с правом обязан получить **вместо** 403. У боевых дверей он
     * назван точно (409 по версии: шаг 3 канона стоит после стражей и до условной авторизации, и
     * такой ответ доказывает, что запрос дошёл до предмета). У предпросмотров точного ответа нет —
     * расчёт законно отвечает и 200, и 422 по гейту этапа 3, — и там проверяется одно: 403 больше
     * не приходит.
     */
    const doors: { name: string; passed?: number; call: (a: Account) => Promise<Reply> }[] = [
      {
        name: 'GET история',
        passed: 200,
        call: (a) => get(a, url(scene.requestId, '/assignment-changes')),
      },
      {
        name: 'POST предпросмотр команды машиниста',
        call: (a) =>
          post(a, url(scene.requestId, '/assignment-changes/preview'), {
            kind: 'set',
            dimension: 'driver',
            effectiveDate: NEAR_FROM,
            driverPersonId: ctx.personA,
            version: scene.version,
          }),
      },
      {
        name: 'POST команда машиниста',
        passed: 409,
        call: (a) =>
          post(a, url(scene.requestId, '/assignment-changes'), {
            kind: 'set',
            dimension: 'driver',
            effectiveDate: NEAR_FROM,
            driverPersonId: ctx.personA,
            version: 9_999,
          }),
      },
      {
        name: 'POST предпросмотр коррекции',
        call: (a) =>
          post(a, url(scene.requestId, '/assignment-changes/correction/preview'), {
            target: { changeId: scene.firstVehicleChangeId },
            vehicleId: ctx.vehicleC.id,
            version: scene.version,
          }),
      },
      {
        name: 'POST коррекция',
        passed: 409,
        call: (a) =>
          post(a, url(scene.requestId, '/assignment-changes/correction'), {
            target: { changeId: scene.firstVehicleChangeId },
            vehicleId: ctx.vehicleC.id,
            version: 9_999,
          }),
      },
      {
        name: 'POST предпросмотр ремонта',
        call: (a) =>
          post(a, url(scene.requestId, '/assignment-changes/repair/preview'), {
            mode: 'repair',
            version: scene.version,
            anchors,
          }),
      },
      {
        name: 'POST ремонт',
        passed: 409,
        call: (a) =>
          post(a, url(scene.requestId, '/assignment-changes/repair'), {
            mode: 'repair',
            version: 9_999,
            anchors,
          }),
      },
    ];

    for (const door of doors) {
      const denied = await door.call(ctx.gated);
      expect(denied.statusCode, `${door.name}: ${denied.body}`).toBe(403);

      const allowed = await door.call(ctx.gatedWithRead);
      if (door.passed === undefined) {
        expect(allowed.statusCode, `${door.name} (с правом): ${allowed.body}`).not.toBe(403);
      } else {
        expect(allowed.statusCode, `${door.name} (с правом): ${allowed.body}`).toBe(door.passed);
      }
    }

    // Первый слой отказал до всякой работы: ни строки истории, ни операции, ни версии.
    const after = await snapshotOf(scene.requestId);
    expect(after.rows).toHaveLength(3);
    expect(after.operations).toEqual([]);
    expect(after.version).toBe(scene.version);
  }, 120_000);

  // ── 2. Второй слой: исход решает, каких прав спросить ──

  /**
   * Историческая смена машиниста задевает прошедшие дни — исход `crew` (Р32), — и без
   * `waybills.correct` кончается отказом. Проверяется не только код: **ни одной записи** быть не
   * должно, а отказ стоит до журнала коррекций и до мутаций (§8, шаг 9 перед шагом 10).
   *
   * Менеджер выбран не случайно: у него есть обе безусловные права и нет коррекционного — то есть
   * первый слой он проходит, а второй нет, и отказ приходит именно оттуда.
   */
  it('исход crew без waybills.correct — 403 менеджеру и ни одной записи', async () => {
    const scene = await makeScene({ issueSheets: true });
    const before = await snapshotOf(scene.requestId);
    // Предпросмотр считает те же последствия и прав не спрашивает: 403 посреди операции хуже, чем
    // отказ до неё, — но и запрещать смотреть последствия праву не за что.
    const body = await armedCrew(ctx.manager, scene, {
      kind: 'set',
      dimension: 'driver',
      effectiveDate: NEAR_FROM,
      driverPersonId: ctx.personB,
      version: scene.version,
    });
    // Исход у команды с прошедшей датой устойчив: причина обязательна, а значит спрошено и право.
    expect(body.operation, JSON.stringify(body)).toBeDefined();

    const denied = await post(ctx.manager, url(scene.requestId, '/assignment-changes'), body);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(json(denied).message).toMatch(/коррекц/i);

    const after = await snapshotOf(scene.requestId);
    expect(after).toEqual(before);

    // Та же команда диспетчером проходит: решение этапа 0 (п. 8) отдало коррекцию истории ему.
    const allowed = await post(ctx.dispatcher, url(scene.requestId, '/assignment-changes'), {
      ...body,
      operation: operation('на объекте работал другой человек'),
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const [written] = await operationsOf(scene.requestId);
    expect(written!.kind).toBe('crew');
    // Снимок авторизации — то, чем перепроверяется повтор (Р9): глубину он помнит, а не считает.
    expect(written!.authorization_scope).toMatchObject({
      requiresCorrect: true,
      requiresCorrectBeyondLimit: false,
      effectiveDate: NEAR_FROM,
    });
  }, 120_000);

  /**
   * Глубже тридцати дней коррекционного права мало: нужен снятый предел, и он остаётся
   * администратору (ADR 0101, Р37). Диспетчер, только что проведший ту же команду двадцатидневной
   * давности, здесь получает 403 — значит отказ считается по **дате мутации**, а не по роли.
   */
  it('глубже тридцати дней — 403 диспетчеру, работа администратору', async () => {
    const scene = await makeScene({ dateFrom: DEEP_FROM, issueSheets: true });
    const before = await snapshotOf(scene.requestId);
    const body = await armedCrew(ctx.dispatcher, scene, {
      kind: 'set',
      dimension: 'driver',
      effectiveDate: DEEP_FROM,
      driverPersonId: ctx.personB,
      version: scene.version,
    });

    const denied = await post(ctx.dispatcher, url(scene.requestId, '/assignment-changes'), body);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(json(denied).message).toMatch(/администратор/i);
    expect(await snapshotOf(scene.requestId)).toEqual(before);

    const allowed = await post(ctx.admin, url(scene.requestId, '/assignment-changes'), {
      ...body,
      operation: operation('миграционный долг: восстановлен состав по табелю'),
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const [written] = await operationsOf(scene.requestId);
    expect(written!.authorization_scope).toMatchObject({
      requiresCorrect: true,
      requiresCorrectBeyondLimit: true,
    });
  }, 120_000);

  /**
   * Дремлющая команда — та, у которой исторический диапазон пуст: отмена решения о хвосте, лежащего
   * **за** концом срока. Исход `assignment_tail` (Р32): причина обязательна, коррекционных прав
   * нет, бумага не тронута.
   *
   * Тот же менеджер, которому дверь только что отказала в историческом изменении, эту команду
   * проводит. В паре эти два случая и доказывают главное свойство Р32: право спрашивается по
   * **посчитанному исходу**, а не по календарю, не по составу тела и не по роли.
   */
  it('дремлющая команда коррекционных прав не требует: менеджер её проводит', async () => {
    const scene = await makeScene({
      dateFrom: DORMANT_FROM,
      dateTo: DORMANT_TO,
      split: true,
      splitAt: DORMANT_SPLIT,
      dormantTail: true,
    });
    const body = await armedCrew(ctx.manager, scene, {
      kind: 'cancel',
      target: { changeId: scene.dormantTailChangeId },
      version: scene.version,
    });
    expect(body.operation, JSON.stringify(body)).toBeDefined();

    const res = await post(ctx.manager, url(scene.requestId, '/assignment-changes'), body);
    expect(res.statusCode, res.body).toBe(200);

    const [written] = await operationsOf(scene.requestId);
    expect(written!.kind).toBe('assignment_tail');
    // Дата операции — прошлогодняя по меркам предела глубины, и оба требования всё равно ложны:
    // мерить глубину у команды, не трогающей прошлого, не по чему (Р32).
    expect(written!.authorization_scope).toMatchObject({
      requiresCorrect: false,
      requiresCorrectBeyondLimit: false,
      effectiveDate: shiftDateKey(DORMANT_TO, 1),
    });
    // Группа погашена целиком — и vehicle-граница, и её зависимый машинист (Р31, В2).
    const alive = (await rowsOf(scene.requestId)).filter((row) => row.superseded_at === null);
    expect(alive.map((r) => `${r.effective_date}|${r.dimension}`).sort()).toEqual([
      `${DORMANT_FROM}|driver`,
      `${DORMANT_FROM}|vehicle`,
      `${DORMANT_SPLIT}|vehicle`,
    ]);
  }, 120_000);

  // ── 3. Архивная заявка: отступление Ц3 и его граница ──

  /**
   * Дверь ремонта принимает архивную заявку **по идентификатору** и без `archive.read` (Ц3), а
   * `restore: true` по-прежнему требует `archive.restore`.
   *
   * Условный контракт самой двери разобран построчно у соседа (`assignment-repair.db.test.ts`);
   * здесь проверяется то, чего у него нет, — **граница отступления**. Ц3 сформулировано так:
   * «дверь принимает архивную заявку, не показывая архив ни в списках, ни в поиске, ни в соседних
   * ручках», и вторая половина этой фразы утверждением о двери не проверяется вовсе. Поэтому рядом
   * с успешным предпросмотром стоит карточка той же заявки той же ролью: она обязана остаться
   * невидимой.
   */
  it('архивная заявка открыта двери ремонта без archive.read, а карточка той же заявки — нет', async () => {
    const scene = await makeScene({ archived: true, driverAtStart: 'unknown' });
    const body = {
      mode: 'repair',
      version: scene.version,
      anchors: [{ effectiveDate: NEAR_FROM, driverPersonId: ctx.personA }],
    };

    const preview = await post(
      ctx.dispatcher,
      url(scene.requestId, '/assignment-changes/repair/preview'),
      body,
    );
    expect(preview.statusCode, preview.body).toBe(200);
    expect(json(preview).archived).toBe(true);

    // Граница отступления: общая карточка архивной заявки этой роли по-прежнему не видна.
    const card = await get(ctx.dispatcher, url(scene.requestId, ''));
    expect(card.statusCode, card.body).toBe(404);
    // А администратору с `archive.read` — видна: 404 выше про право, а не про сломанную сцену.
    const adminCard = await get(ctx.admin, url(scene.requestId, ''));
    expect(adminCard.statusCode, adminCard.body).toBe(200);

    // Вывод из архива остаётся администраторским действием — вторая половина Ц3.
    const restoreBody = { ...body, restore: true };
    const restorePreview = await post(
      ctx.dispatcher,
      url(scene.requestId, '/assignment-changes/repair/preview'),
      restoreBody,
    );
    expect(restorePreview.statusCode, restorePreview.body).toBe(200);
    const denied = await post(ctx.dispatcher, url(scene.requestId, '/assignment-changes/repair'), {
      ...restoreBody,
      previewFingerprint: (json(restorePreview) as unknown as { fingerprint: string }).fingerprint,
      operation: operation('ремонт архивной заявки'),
    });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(json(denied).message).toMatch(/архив/i);

    const [row] = (
      await ctx.db.execute<{ deleted_at: string | null }>(
        sql`SELECT deleted_at FROM vehicle_requests WHERE id = ${scene.requestId}`,
      )
    ).rows;
    expect(row!.deleted_at).not.toBeNull();
  }, 120_000);
});
