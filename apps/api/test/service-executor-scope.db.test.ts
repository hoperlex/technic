import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GRANT_MODULE_WIDE_SCOPE,
  hasModuleWideScope,
  type OfficeEquipmentCandidateDto,
  type ScopeModule,
  type ServiceRequestDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * **ОБЛАСТЬ ИСПОЛНИТЕЛЯ ЗА РУБИЛЬНИКОМ** — серверная половина решений Р3, Р5, Р7, Р9–Р11 плана
 * `docs/office-equipment-free-estimate-and-executor-scope-plan.md` (ответы В3, В6, В7, В11
 * заказчика от 09.09.2026; §7, случаи Т8–Т10, Т12, Т13, Т15, Т16, Т19, Т21, Т22; миграции
 * 0299 и 0300).
 *
 * ГЛАВНОЕ УТВЕРЖДЕНИЕ ВОЛНЫ, РАДИ КОТОРОГО ФАЙЛ И НАПИСАН: **назначение СУЖАЕТ область, а не
 * расширяет её** — но только у одного профиля и только при включённом ключе. Отсюда четыре
 * независимых предмета проверки, и каждый ловит свой класс ошибки:
 *
 *   1. РАЗВИЛКА ОБЛАСТИ ЧТЕНИЯ (Т8, Т10, Т12, Т19). Ветка исполнителя ЗАМЕНЯЕТ ось роли, а не
 *      дополняет её: соединённая через `and`, она отобрала бы у сисадмина заявки соседних площадок,
 *      ради которых его и назначают, а через `or` — вернула бы ему всю свою площадку, которой
 *      ответ В3 ему не обещает. Ни то, ни другое не видно на предикате глазами: видно на выдаче.
 *   2. ДВЕ ОБЛАСТИ, А НЕ ОДНА (Т9, Т22). Бывший исполнитель заявку ЧИТАЕТ (след снятия расширил
 *      чтение) и в обсуждении участвует, а действовать по ней больше не может. Расширь волна одну
 *      лишь видимость — вместе с чтением он получил бы назначение, заморозку, отмену, объём работ и
 *      подшивку: дальше по коду его спрашивают о праве и статусе, но не об отношении к заявке.
 *   3. РУБИЛЬНИК — ЭТО ОТКАТ (Т19). Выключенный ключ обязан отвечать СЕГОДНЯШНИМ поведением до
 *      единого ответа, включая сквозную видимость ИТ-набора: откат волны — это `UPDATE` одной
 *      строки, а не обратный выкат. Отсутствие строки ключа — то же самое (fail-closed).
 *   4. PARITY A ≡ B (Т21). При включённом ключе выпуск A обязан отвечать так же, как ответит
 *      выпуск B — тот, что уберёт `serviceRequests` из карты сквозной области. Здесь это и
 *      проверяется единственным честным способом: карта снимается прямо в прогоне, и те же пять
 *      проб задаются дважды.
 *
 * ПОЧЕМУ БАЗА. Область — это предикат в SQL и проверка по строке: назначение живёт в
 * `service_request_executors`, след снятия — в заведённой волной `service_request_past_executors`,
 * авторство — в колонке заявки, а сам рубильник читается ПОЛЕМ ПРИНЦИПАЛА тем же запросом, что и
 * остальной субъект (`loadPrincipal`). Ни одно из четырёх утверждений на моках не проверяется:
 * там проверялись бы моки.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`, и причина сильнее обычной. Файл щёлкает ГЛОБАЛЬНЫМ
 * состоянием — строкой `feature_flags`, — а в двух случаях ещё и снимает карту области у всего
 * процесса. Параллельный прогон по общей базе видел бы сужение то включённым, то выключенным в
 * середине собственного случая; утверждения вида «в списке ровно три заявки» по общей базе были бы
 * ложными и без всякого рубильника.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО. Отрицательные случаи доступа, уже доказанные соседями, не
 * переписываются: `service-executor-access.db.test.ts` держит сегодняшнюю модель (§6.1–§6.18) на
 * ВЫКЛЮЧЕННОМ ключе, `office-equipment-profiles.db.test.ts` — состав каталожных наборов,
 * `service-estimate-breakdown.db.test.ts` — дверь раскладки. Здесь предмет один: что меняет
 * включённый ключ и чего он не меняет.
 *
 * Запуск (из `apps/api`; базу тест заводит и сносит сам, из адреса берётся только кластер):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run test/service-executor-scope.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_executor_scope_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-exec-scope-password-123';
const REQUESTS = '/api/v1/service-requests';
const CANDIDATES = '/api/v1/office-equipment-candidates';
const EXECUTOR_SCOPE = 'service_request_executor_scope';

type Auth = { authorization: string };

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: заводит парк, распределяет заявки обеих площадок, и он же — предмет Т10. */
  admin: TestUser;
  /** Заказчик площадки A: заводит заявки и пишет в обсуждение. */
  customerA: TestUser;
  /** Заказчик площадки B: без него «чужая площадка» неотличима от «пустой площадки». */
  customerB: TestUser;
  /**
   * **Системный администратор** — оба кода профиля (`office_equipment_it_approver` плюс
   * `office_equipment_executor`), роль штаба площадки A. Главный субъект файла: именно ему
   * назначение область сужает.
   */
  sysadmin: TestUser;
  /**
   * Второй сисадмин того же профиля: без него «чужая заявка» пришлось бы изображать заявкой, к
   * которой не назначен никто, — а это другой случай. Здесь заявка ведётся, просто не им.
   */
  sysadminB: TestUser;
  /**
   * Половина профиля — ОДИН набор исполнителя, без ИТ. Разница с полным профилем видна ровно в
   * одном месте: в обсуждении (Н15). Область заявок у обоих одна и та же.
   */
  execOnly: TestUser;
  /**
   * **«ИТ + Ведение» на чужой площадке** — профиль, ради которого Т21 и написан двумя субъектами.
   * У него есть карта сквозной области (набор ИТ) и есть «Ведение», то есть
   * `actsAsServiceExecutorOnly` про него ЛОЖЕН. Останься карта прочитанной хоть одной веткой
   * развилки — в выпуске A он видел бы компанию, а в выпуске B область своей роли, и parity-тест
   * на обычном сисадмине этого не поймал бы.
   */
  itOperator: TestUser;
  /** «Ведение» площадки A: распределяет, разбирает сообщения о технике, согласует. */
  operator: TestUser;
  /** Оператор подрядчика A: ему назначают заявку площадки B. */
  serviceA: TestUser;
  /** Оператор подрядчика B: ему не назначено ничего — он и есть отрицательная половина Т12. */
  serviceB: TestUser;
  /** Автор сообщения о технике, которого переводят на другую площадку (Т15). */
  mover: TestUser;
  objectAId: string;
  objectBId: string;
  counterpartyAId: string;
  counterpartyBId: string;
  typeId: string;
}

let ctx: Ctx;

/** Заявки-фикстуры: заводятся один раз при ВЫКЛЮЧЕННОМ ключе и живут на весь файл. */
interface Fixtures {
  /** Площадка A, сисадмин назначен поимённо — первое слагаемое области (В3). */
  assigned: string;
  /** Площадка A, заведена САМИМ сисадмином — второе слагаемое (В6, «свои заведённые»). */
  authored: string;
  /** Площадка A, сисадмина назначили и сняли — третье слагаемое (В6, след снятия Р5). */
  past: string;
  /** Площадка A, к сисадмину отношения не имеет: ведёт её второй сисадмин. */
  foreign: string;
  /** Площадка B, назначена подрядчику A — предмет Т12. */
  contractor: string;
  /** Площадка A, снят держатель ОДНОГО исполнительского набора — предмет Т16 (Н15). */
  pastExecOnly: string;
}

let fx: Fixtures;

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
  process.env.MAIL_ENABLED ??= 'false';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query('CREATE EXTENSION IF NOT EXISTS citext');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function inject(
  method: Method,
  url: string,
  auth: Auth,
  payload?: unknown,
  headers?: Record<string, string>,
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { ...auth, ...headers },
    remoteAddress: nextAddress(),
  };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return ctx.app.inject(options);
}

function messageOf(res: LightMyRequestResponse): string {
  try {
    return (res.json() as { message?: string }).message ?? '';
  } catch {
    return res.body;
  }
}

/**
 * ЩЕЛЧОК РУБИЛЬНИКА — тем же `UPDATE`, каким его щёлкает выкат (Р4, §8). Административной ручки у
 * ключа нет и в этой волне не будет: подменять её здесь прямой записью в таблицу — не срезание
 * угла, а единственный существующий способ переключения.
 */
async function setExecutorScope(isEnabled: boolean): Promise<void> {
  const res = await ctx.db.execute(
    sql`UPDATE feature_flags SET is_enabled = ${isEnabled}, updated_at = now()
         WHERE key = ${EXECUTOR_SCOPE}`,
  );
  // Строка обязана существовать: `UPDATE` по отсутствующей молча меняет ноль строк, и весь файл
  // зеленел бы при выключенном сужении, ничего не проверив.
  expect(res.rowCount, 'строка рубильника заведена миграцией 0300').toBe(1);
}

/** Идентификаторы заявок, видимых субъекту: страница заведомо больше, чем данных у файла. */
async function listIds(auth: Auth): Promise<string[]> {
  const res = await inject('GET', `${REQUESTS}?pageSize=200`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as ServiceRequestDto[]).map((row) => row.id);
}

async function card(id: string, auth: Auth): Promise<LightMyRequestResponse> {
  return inject('GET', `${REQUESTS}/${id}`, auth);
}

async function versionOf(id: string): Promise<number> {
  const res = await card(id, ctx.admin.auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as ServiceRequestDto).version;
}

function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

let unitNo = 0;

/** Своя единица под каждую заявку: по технике разрешена одна открытая заявка. */
async function makeEquipment(objectId: string): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: ctx.typeId,
    name: `Kyocera ECOSYS M3145 ${RUN}`,
    inventoryNumber: `SES-${RUN}-${unitNo}`,
    objectId,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function createRequest(
  auth: Auth,
  objectId: string,
  description: string,
): Promise<ServiceRequestDto> {
  const res = await inject('POST', REQUESTS, auth, {
    officeEquipmentId: await makeEquipment(objectId),
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { request: ServiceRequestDto }).request;
}

/**
 * Состав исполнителей меняет администратор — он видит обе площадки при любом положении рубильника.
 * Причина ушла из обязательных полей волной (Р6), и здесь она не шлётся намеренно: заодно
 * проверяется, что переназначение без причины проходит.
 */
async function assign(
  id: string,
  input: { userIds?: string[]; serviceCounterpartyId?: string | null },
): Promise<void> {
  const res = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.admin.auth, {
    userIds: input.userIds ?? [],
    serviceCounterpartyId: input.serviceCounterpartyId ?? null,
    version: await versionOf(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Строки следа снятия по заявке — то, чем область чтения узнаёт бывшего исполнителя (Р5). */
async function pastExecutorIds(requestId: string): Promise<string[]> {
  const res = await ctx.db.execute<{ user_id: string }>(sql`
    SELECT user_id FROM service_request_past_executors WHERE request_id = ${requestId}::uuid`);
  return res.rows.map((row) => row.user_id);
}

/** Реплика в обсуждении: адресат обязателен — у ленты нет «просто сообщений». */
async function sendMessage(
  id: string,
  auth: Auth,
  body: string,
  sides: string[] = ['all'],
): Promise<LightMyRequestResponse> {
  return inject('POST', `${REQUESTS}/${id}/messages`, auth, {
    body,
    addressees: { sides, users: [] },
  });
}

describe.skipIf(!DB_URL)('область исполнителя за рубильником (Р3, Р7)', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
    await migrate(OWN_DB!);

    prepareEnv(OWN_DB!);
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const email = `db-ses-${input.tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${input.tag}, ${passwordHash},
                ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const counterparty = async (name: string, inn: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO counterparties (type, name, inn)
        VALUES ('service'::counterparty_type, ${name}, ${inn})
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const digits = String(Date.now()).slice(-6);
    const counterpartyAId = await counterparty(`Сервис-SES-A ${RUN}`, innOf(`78${digits}0`));
    const counterpartyBId = await counterparty(`Сервис-SES-B ${RUN}`, innOf(`78${digits}1`));

    const makeObject = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`SES-${tag}-${RUN}`}, ${`Тестовая площадка SES ${tag} ${RUN}`},
                'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const objectAId = await makeObject('A');
    const objectBId = await makeObject('B');

    const adminUser = await makeUser({ tag: 'admin', role: 'admin' });
    const customerA = await makeUser({ tag: 'custa', role: 'shtab' });
    const customerB = await makeUser({ tag: 'custb', role: 'shtab' });
    const sysadmin = await makeUser({ tag: 'sys', role: 'shtab' });
    const sysadminB = await makeUser({ tag: 'sysb', role: 'shtab' });
    const execOnly = await makeUser({ tag: 'exec', role: 'shtab' });
    const itOperator = await makeUser({ tag: 'itop', role: 'shtab' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const mover = await makeUser({ tag: 'mover', role: 'shtab' });
    const serviceA = await makeUser({
      tag: 'srva',
      role: 'operator',
      counterpartyId: counterpartyAId,
    });
    const serviceB = await makeUser({
      tag: 'srvb',
      role: 'operator',
      counterpartyId: counterpartyBId,
    });

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customerA.id}, ${objectAId}), (${customerB.id}, ${objectBId}),
             (${sysadmin.id}, ${objectAId}), (${sysadminB.id}, ${objectAId}),
             (${execOnly.id}, ${objectAId}), (${operator.id}, ${objectAId}),
             (${mover.id}, ${objectAId}), (${itOperator.id}, ${objectBId})`);

    // Наборы — КАТАЛОЖНЫЕ (миграции 0183, 0262): предмет файла — профили в том виде, в каком они
    // приезжают держателю в проде, и собранный тестом набор доказывал бы состав, придуманный тестом.
    const grantIdOf = async (code: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(
        sql`SELECT id FROM grants WHERE code = ${code} AND deleted_at IS NULL`,
      );
      const id = row.rows[0]?.id;
      if (!id) throw new Error(`в базе нет набора «${code}»`);
      return id;
    };
    const itGrantId = await grantIdOf('office_equipment_it_approver');
    const executorGrantId = await grantIdOf('office_equipment_executor');
    const grant = async (userId: string, grantId: string): Promise<void> => {
      await db.execute(sql`
        INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
        VALUES (${userId}, ${grantId}, ${adminUser.id}, 'manual')`);
    };

    /*
     * НАДСТРОЙКИ ВЫДАЮТСЯ ПЕРВЫМИ, И ПОРЯДОК ЗДЕСЬ НЕ КОСМЕТИКА. `replaceUserAddons` — это ЗАМЕНА
     * набора надстроек: коды, которых нет в переданном списке, она снимает вместе с их строками в
     * `user_grants`. А `office_equipment_it_approver` — это одновременно и надстройка, и системный
     * набор, то есть выданный вручную ИТ-набор она сняла бы, оставив профиль без карты сквозной
     * области. Выданный ПОСЛЕ — переживает: разницу она считает по `user_role_addons`, и о ручной
     * строке там ничего нет. Собранный не в том порядке `itOperator` тихо превратился бы в
     * «исполнитель + Ведение», а parity-тест на нём зеленел бы, проверяя не тот профиль.
     */
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], adminUser.id);
      await replaceUserAddons(tx, itOperator.id, ['office_equipment_operator'], adminUser.id);
    });

    // Профиль «Системный администратор» — ПАРА кодов и выдаётся вместе (Э8 плана профилей).
    await grant(sysadmin.id, itGrantId);
    await grant(sysadmin.id, executorGrantId);
    await grant(sysadminB.id, itGrantId);
    await grant(sysadminB.id, executorGrantId);
    // Половина профиля: один набор работы руками.
    await grant(execOnly.id, executorGrantId);
    // «ИТ + Ведение»: пара кодов профиля плюс координатор модуля.
    await grant(itOperator.id, itGrantId);
    await grant(itOperator.id, executorGrantId);

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    const app = await buildApp();
    await app.ready();

    const login = async (user: { id: string; email: string }): Promise<TestUser> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: nextAddress(),
        payload: { email: user.email, password: PASSWORD },
      });
      if (res.statusCode !== 200) throw new Error(`вход ${user.email}: ${res.body}`);
      const token = (res.json() as { accessToken: string }).accessToken;
      return { ...user, auth: { authorization: `Bearer ${token}` } };
    };

    ctx = {
      app,
      db,
      closeDb,
      admin: await login(adminUser),
      customerA: await login(customerA),
      customerB: await login(customerB),
      sysadmin: await login(sysadmin),
      sysadminB: await login(sysadminB),
      execOnly: await login(execOnly),
      itOperator: await login(itOperator),
      operator: await login(operator),
      serviceA: await login(serviceA),
      serviceB: await login(serviceB),
      mover: await login(mover),
      objectAId,
      objectBId,
      counterpartyAId,
      counterpartyBId,
      typeId,
    };

    /*
     * ФИКСТУРЫ ЗАВОДЯТСЯ ПРИ ВЫКЛЮЧЕННОМ КЛЮЧЕ — так же, как заведены заявки на проде до выката, и
     * это половина смысла Т19: сужение обязано работать по УЖЕ СУЩЕСТВУЮЩИМ заявкам, а не только
     * по заведённым после включения. Backfill следа снятия при этом невозможен (Н13), и заявки,
     * переданные до выката, бывшему исполнителю не видны — здесь снятие происходит уже на живом
     * коде, поэтому след пишется.
     */
    const assigned = await createRequest(ctx.customerA.auth, objectAId, 'Назначена сисадмину');
    await assign(assigned.id, { userIds: [ctx.sysadmin.id] });

    const authored = await createRequest(ctx.sysadmin.auth, objectAId, 'Заведена самим сисадмином');

    const past = await createRequest(ctx.customerA.auth, objectAId, 'Снята с сисадмина');
    await assign(past.id, { userIds: [ctx.sysadmin.id] });
    await assign(past.id, { userIds: [ctx.execOnly.id] });

    const foreign = await createRequest(ctx.customerA.auth, objectAId, 'Ведёт её другой сисадмин');
    await assign(foreign.id, { userIds: [ctx.sysadminB.id] });

    const contractor = await createRequest(ctx.customerB.auth, objectBId, 'Заявка подрядчика A');
    await assign(contractor.id, { serviceCounterpartyId: counterpartyAId });

    const pastExecOnly = await createRequest(
      ctx.customerA.auth,
      objectAId,
      'Снята с держателя одного исполнительского набора',
    );
    await assign(pastExecOnly.id, { userIds: [ctx.execOnly.id] });
    // Принимает её ВТОРОЙ сисадмин, а не главный субъект файла: попади она в его область живым
    // назначением — Т8 перестал бы различать «вижу по следу» и «вижу по назначению».
    await assign(pastExecOnly.id, { userIds: [ctx.sysadminB.id] });

    fx = {
      assigned: assigned.id,
      authored: authored.id,
      past: past.id,
      foreign: foreign.id,
      contractor: contractor.id,
      pastExecOnly: pastExecOnly.id,
    };
  }, 300_000);

  afterAll(async () => {
    await ctx?.app?.close();
    await ctx?.closeDb?.();
    if (!ADMIN_DB) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  // ── Фикстура: профили собраны из каталожных наборов ──

  describe('профили субъектов', () => {
    /**
     * ПРОВЕРКА ФИКСТУРЫ, А НЕ ПОВЕДЕНИЯ — и она обязательна ровно здесь. Все утверждения файла
     * стоят на том, КАКИЕ КОДЫ НАБОРОВ у субъекта: развилка Р3 спрашивает их, а не права. Соберись
     * профиль не так — половина случаев зеленела бы, проверяя не тот субъект, и заметить это было
     * бы нечем: ответы сервера остались бы правдоподобными. Один раз собранные коды поэтому
     * сверяются вслух, до первого случая.
     */
    it('коды наборов у каждого субъекта — те, о которых написан файл', async () => {
      const codesOf = async (user: TestUser): Promise<string[]> => {
        const res = await inject('GET', '/api/v1/auth/me', user.auth);
        expect(res.statusCode, res.body).toBe(200);
        return [...((res.json() as { grantCodes: string[] }).grantCodes ?? [])].sort();
      };
      expect(await codesOf(ctx.sysadmin)).toEqual(
        ['office_equipment_executor', 'office_equipment_it_approver'].sort(),
      );
      expect(await codesOf(ctx.execOnly)).toEqual(['office_equipment_executor']);
      expect(await codesOf(ctx.operator)).toEqual(['office_equipment_operator']);
      expect(await codesOf(ctx.itOperator)).toEqual(
        [
          'office_equipment_executor',
          'office_equipment_it_approver',
          'office_equipment_operator',
        ].sort(),
      );
      // У администратора кодов не бывает вовсе — права у него от роли (Н1).
      expect(await codesOf(ctx.admin)).toEqual([]);
    });
  });

  // ── След снятия (Р5, этап Э4) ──

  describe('след снятого исполнителя пишется всеми путями снятия', () => {
    it('переназначение оставляет строку следа, а живое назначение остаётся одно', async () => {
      /*
       * ЭТО НЕ ПОВТОР Т8, А ЕГО ОСНОВАНИЕ. Т8 спрашивает выдачу списка; здесь спрашивается сама
       * строка, потому что без неё третье слагаемое области было бы неотличимо от «сисадмин видит
       * всё подряд»: пустой след в паре с ошибкой в предикате дал бы тот же зелёный список.
       */
      expect(await pastExecutorIds(fx.past)).toEqual([ctx.sysadmin.id]);
      expect(await pastExecutorIds(fx.pastExecOnly)).toEqual([ctx.execOnly.id]);

      // Живое назначение при этом ровно одно: след — отдельная таблица, а не флаг в назначении.
      const live = await ctx.db.execute<{ user_id: string }>(sql`
        SELECT user_id FROM service_request_executors WHERE request_id = ${fx.past}::uuid`);
      expect(live.rows.map((r) => r.user_id)).toEqual([ctx.execOnly.id]);
    });

    it('снятия без причины проходят: причина замены стала необязательной (Р6)', async () => {
      /*
       * ВСЕ ПЕРЕНАЗНАЧЕНИЯ ФИКСТУР ВЫШЕ СДЕЛАНЫ БЕЗ ПОЛЯ `reason` — и прошли. Прежде сервер отвечал
       * на такое тело 422 «Укажите причину переназначения»; строка здесь стоит затем, чтобы возврат
       * этого отказа падал ОДНИМ понятным случаем, а не десятком чужих фикстур сразу.
       */
      const id = (await createRequest(ctx.customerA.auth, ctx.objectAId, 'Замена без причины')).id;
      await assign(id, { userIds: [ctx.sysadminB.id] });
      const res = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.admin.auth, {
        // Принимает заявку тот, чьих списков файл не сверяет поимённо: подставь сюда субъекта Т8,
        // и случай про причину замены менял бы ожидания соседнего блока.
        userIds: [ctx.itOperator.id],
        serviceCounterpartyId: null,
        version: await versionOf(id),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await pastExecutorIds(id)).toEqual([ctx.sysadminB.id]);
    });

    it('отмена заявки: сброс состава тоже оставляет след', async () => {
      /*
       * ПЕРВАЯ ИЗ ЧЕТЫРЁХ ВЕТОК `DELETE` (Р5) — та, что живёт не в ручке назначения, а в матрице
       * сбросов помощника перехода: отмена возвращает заявку в состояние «ничего не делали» и
       * снимает состав целиком. Заявка, отменённая и потом возвращённая в «Новую», обязана
       * остаться видимой тому, кто её вёл: переписку и документы по ней писал он.
       */
      const id = (await createRequest(ctx.customerA.auth, ctx.objectAId, 'Отмена со сбросом')).id;
      await assign(id, { userIds: [ctx.sysadminB.id] });
      const res = await inject('PATCH', `${REQUESTS}/${id}/status`, ctx.operator.auth, {
        status: 'cancelled',
        reason: 'аппарат списан',
        version: await versionOf(id),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await pastExecutorIds(id)).toEqual([ctx.sysadminB.id]);
    });

    it('отказ исполнителя от заявки: снимает себя — и остаётся в следе', async () => {
      // ТРЕТЬЯ ветка: исполнитель снял с заявки себя сам. Заявку он всё равно дочитывает — вопрос
      // от заказчика приходит после отказа не реже, чем до.
      const id = (await createRequest(ctx.customerA.auth, ctx.objectAId, 'Отказ исполнителя')).id;
      await assign(id, { userIds: [ctx.sysadminB.id] });
      const res = await inject('PATCH', `${REQUESTS}/${id}/decline`, ctx.sysadminB.auth, {
        reason: 'нет запчасти, пусть возьмёт другой',
        version: await versionOf(id),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await pastExecutorIds(id)).toEqual([ctx.sysadminB.id]);
    });

    it('отказ «за всех»: снимается весь состав, и след пишется на каждого', async () => {
      /*
       * ЧЕТВЁРТАЯ ветка, и потерять её было легче всего: логических путей снятия три, а веток
       * `DELETE` четыре — ровно из-за развилки внутри отказа. Отказ «за всех» делает тот, кто в
       * заявке не значится ни строкой, ни компанией: администратор, доводящий чужую заявку.
       */
      const id = (await createRequest(ctx.customerA.auth, ctx.objectAId, 'Отказ за всех')).id;
      // Состав из двоих — и оба вне тех учёток, чьи списки файл сверяет поимённо: след это
      // ЗАПИСЬ, и лишняя строка у субъекта Т8 сделала бы соседний блок ложным.
      await assign(id, { userIds: [ctx.sysadminB.id, ctx.itOperator.id] });
      const res = await inject('PATCH', `${REQUESTS}/${id}/decline`, ctx.admin.auth, {
        reason: 'заявку доводит другой отдел',
        version: await versionOf(id),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect([...(await pastExecutorIds(id))].sort()).toEqual(
        [ctx.sysadminB.id, ctx.itOperator.id].sort(),
      );
    });
  });

  // ── Т19. Рубильник ──

  describe('Т19. рубильник: выключен — сегодняшнее поведение, включён — сужение', () => {
    it('выключенный ключ: сисадмин видит заявки компании, включая чужую', async () => {
      await setExecutorScope(false);
      const ids = await listIds(ctx.sysadmin.auth);
      // Сквозная область ИТ-набора цела: он видит и заявку соседней площадки, к которой не имеет
      // отношения вовсе. Это и есть «сегодняшнее поведение», к которому возвращает откат.
      expect(ids).toContain(fx.foreign);
      expect(ids).toContain(fx.contractor);
      expect((await card(fx.foreign, ctx.sysadmin.auth)).statusCode).toBe(200);
    });

    it('строки ключа нет вовсе — тоже сегодняшнее поведение (fail-closed)', async () => {
      /*
       * НЕДОКАЧЕННЫЙ ВЫКАТ ЧИТАЕТСЯ КАК «ВЫКЛЮЧЕНО», а не как «включено» и не как отказ:
       * `coalesce(..., false)` в подзапросе принципала. Случай проверяет ровно это состояние —
       * код волны на базе, где миграции 0300 ещё нет.
       */
      await ctx.db.execute(sql`DELETE FROM feature_flags WHERE key = ${EXECUTOR_SCOPE}`);
      try {
        expect((await card(fx.foreign, ctx.sysadmin.auth)).statusCode).toBe(200);
        expect(await listIds(ctx.sysadmin.auth)).toContain(fx.foreign);
      } finally {
        await ctx.db.execute(sql`
          INSERT INTO feature_flags (key, is_enabled) VALUES (${EXECUTOR_SCOPE}, false)
          ON CONFLICT (key) DO UPDATE SET is_enabled = false`);
      }
    });

    it('включение сужает НЕМЕДЛЕННО, тем же токеном и без перезапуска', async () => {
      /*
       * ПРИЗНАК ЖИВЁТ ПОЛЕМ ПРИНЦИПАЛА, а принципал перечитывается на каждом запросе — то есть
       * включение действует на уже открытые сессии, а не «после перезахода». Ровно на это и
       * рассчитан шаг runbook: сервер безопасен сразу после `UPDATE`. Токен здесь тот же самый,
       * что и в предыдущем случае: перелогина между ними нет.
       */
      await setExecutorScope(true);
      const denied = await card(fx.foreign, ctx.sysadmin.auth);
      expect(denied.statusCode, denied.body).toBe(403);
      expect(messageOf(denied)).toContain('Исполнитель работает со своими заявками');
      expect(await listIds(ctx.sysadmin.auth)).not.toContain(fx.foreign);
    });
  });

  // ── Т8. Область чтения исполнительского профиля ──

  describe('Т8. сисадмин видит назначенную, свою заведённую и снятую с него', () => {
    beforeAll(async () => {
      await setExecutorScope(true);
    });

    it('список — ровно три слагаемых, и ни одной чужой', async () => {
      const ids = await listIds(ctx.sysadmin.auth);
      /*
       * СРАВНЕНИЕ МНОЖЕСТВАМИ, А НЕ ВКЛЮЧЕНИЯМИ. `toContain` на трёх строках прошёл бы и у
       * предиката, отдающего всё подряд, — а именно это и есть самая дорогая из возможных ошибок
       * развилки (`or` с осью роли вернул бы сисадмину всю его площадку).
       */
      expect([...ids].sort()).toEqual([fx.assigned, fx.authored, fx.past].sort());
    });

    it('карточка каждой из трёх открывается, чужая — 403 по области', async () => {
      for (const id of [fx.assigned, fx.authored, fx.past]) {
        const res = await card(id, ctx.sysadmin.auth);
        expect(res.statusCode, `${id}: ${res.body}`).toBe(200);
      }
      const denied = await card(fx.foreign, ctx.sysadmin.auth);
      expect(denied.statusCode, denied.body).toBe(403);
      // Отказ называет ПРАВИЛО, а не «заявка недоступна»: человеку надо понять, что заявки
      // соседей он теперь не видит по решению, а не по ошибке выдачи.
      expect(messageOf(denied)).toContain('назначенными, заведёнными им самим');
    });

    it('история и лента обсуждения сужены той же областью, что и карточка', async () => {
      // Витрины ⊆ карточка: разойдись они, чужая заявка утекала бы через соседнюю ручку.
      expect(
        (await inject('GET', `${REQUESTS}/${fx.past}/history`, ctx.sysadmin.auth)).statusCode,
      ).toBe(200);
      expect(
        (await inject('GET', `${REQUESTS}/${fx.foreign}/history`, ctx.sysadmin.auth)).statusCode,
      ).toBe(403);
      expect(
        (await inject('GET', `${REQUESTS}/${fx.foreign}/messages`, ctx.sysadmin.auth)).statusCode,
      ).toBe(403);
    });

    /**
     * **«ИТ + ВЕДЕНИЕ»: ОБЛАСТЬ РОЛИ ПЛЮС АВТОРСТВО, И НИЧЕГО СВЕРХ** — строка 4 таблицы Р3 в двух
     * половинах, которые легко перепутать.
     *
     * ЧТО ОБЕЩАНО ПЛАНОМ. Такому субъекту область считает ветка «Ведения»: своя площадка, свой
     * отдел — и БЕЗ расширения назначением. Заявку чужой площадки, на которую его назначили, он не
     * видит; это решение («координатор модуля работает своей площадкой»), а не потеря.
     *
     * И ЧТО ЗАКРЫВАЕТ ОСЬ АВТОРСТВА В ТОЙ ЖЕ ВЕТКЕ. Заводить заявку по предмету чужой площадки ему
     * МОЖНО — разборы предмета и рубеж заведения спрашивают область ПАРКА (Р9, ответ В5: парк виден
     * целиком). Заведение в модуле поэтому ШИРЕ чтения, и без оси авторства получалось «отправил и
     * не вижу»: 201 на заведение и 403 на карточку той же заявки. Db-прогон это и застал (находка
     * Д2), после чего ось авторства приехала в обе записи правила — предикат выборки и проверку по
     * строке.
     *
     * ДВЕ ПОЛОВИНЫ СТОЯТ В ОДНОМ СЛУЧАЕ НАМЕРЕННО: порознь каждая читается как произвол («почему
     * назначенную не видит?», «почему заведённую видит?»), а вместе — как одно правило: область
     * даёт роль и авторство, назначение её не расширяет.
     */
    it('«ИТ + Ведение»: свою заведённую видит, назначенную ему — нет', async () => {
      const own = (await createRequest(ctx.itOperator.auth, ctx.objectAId, 'Своя, чужая площадка'))
        .id;
      const assignedToHim = (
        await createRequest(ctx.customerA.auth, ctx.objectAId, 'Назначена «ИТ + Ведению»')
      ).id;
      await assign(assignedToHim, { userIds: [ctx.itOperator.id] });

      const ids = await listIds(ctx.itOperator.auth);
      // Заведение по чужой площадке прошло — иначе `createRequest` упал бы на своём же `expect`.
      expect((await card(own, ctx.admin.auth)).statusCode).toBe(200);
      // И автор её видит: обе записи правила — список и карточка, — иначе одна отдавала бы то,
      // чего нет в другой.
      expect(ids).toContain(own);
      expect((await card(own, ctx.itOperator.auth)).statusCode).toBe(200);
      // Назначение области не расширяет — это по плану (строка 4 таблицы Р3).
      expect(ids).not.toContain(assignedToHim);
      expect((await card(assignedToHim, ctx.itOperator.auth)).statusCode).toBe(403);
    });

    it('держатель ОДНОГО исполнительского набора сужается так же', async () => {
      /*
       * ПРИЗНАК СПРАШИВАЕТ КОДЫ НАБОРОВ, А НЕ ПРАВО (Н2): у держателя одного ИТ-набора
       * `serviceRequests.execute` нет вовсе, а у этого — есть. Правило «по праву» разошлось бы с
       * решением на обоих, и здесь проверяется вторая половина: набор работы руками сужает так же,
       * как пара кодов профиля.
       */
      const ids = await listIds(ctx.execOnly.auth);
      expect([...ids].sort()).toEqual([fx.past, fx.pastExecOnly].sort());
      expect((await card(fx.foreign, ctx.execOnly.auth)).statusCode).toBe(403);
    });
  });

  // ── Т10. Администратор ──

  describe('Т10. администратор после сужения видит всё (Н1)', () => {
    beforeAll(async () => {
      await setExecutorScope(true);
    });

    it('право execute у роли admin есть по построению — и области ему не сужает', async () => {
      /*
       * Н1 ПЛАНА ОДНОЙ СТРОКОЙ: `admin: [...PERMISSIONS]`, то есть `serviceRequests.execute` у
       * администратора есть. Признак «исполнитель — тот, у кого execute» отобрал бы у него ВСЕ
       * заявки портала, то есть сузил ровно того, кто разбирает застрявшее. Ветка `admin` в
       * развилке стоит первой и именно поэтому.
       */
      const ids = await listIds(ctx.admin.auth);
      for (const id of Object.values(fx)) expect(ids).toContain(id);
      for (const id of Object.values(fx)) {
        expect((await card(id, ctx.admin.auth)).statusCode).toBe(200);
      }
    });
  });

  // ── Т12. Сервисный центр ──

  describe('Т12. сервисный центр видит только заявки своей компании (В7)', () => {
    beforeAll(async () => {
      await setExecutorScope(true);
    });

    /**
     * ЗАКРЕПЛЯЮЩИЙ ТЕСТ, А НЕ ПРОВЕРКА НОВОГО ПОВЕДЕНИЯ. Ответ В7 — «у сервисного центра всё верно
     * уже сегодня», и волна его не трогала. Но развилка Р3 переписала ветку «остальные» целиком:
     * прежде она звала `serviceRequestScopeWhere` (с картой сквозной области внутри), теперь —
     * `serviceRequestRoleAxisWhere` напрямую. Подрядчик проходит именно этой веткой, и случай
     * держит то, что переписывание ему ничего не поменяло — ни в плюс, ни в минус.
     */
    it('своя заявка видна целиком: список, карточка, история, лента', async () => {
      expect(await listIds(ctx.serviceA.auth)).toEqual([fx.contractor]);
      expect((await card(fx.contractor, ctx.serviceA.auth)).statusCode).toBe(200);
      expect(
        (await inject('GET', `${REQUESTS}/${fx.contractor}/history`, ctx.serviceA.auth)).statusCode,
      ).toBe(200);
      expect(
        (await inject('GET', `${REQUESTS}/${fx.contractor}/messages`, ctx.serviceA.auth))
          .statusCode,
      ).toBe(200);
    });

    it('заявка другого подрядчика закрыта на каждой двери, включая файл по прямой ссылке', async () => {
      expect(await listIds(ctx.serviceB.auth)).toEqual([]);
      expect((await card(fx.contractor, ctx.serviceB.auth)).statusCode).toBe(403);
      expect(
        (await inject('GET', `${REQUESTS}/${fx.contractor}/history`, ctx.serviceB.auth)).statusCode,
      ).toBe(403);
      expect(
        (await inject('GET', `${REQUESTS}/${fx.contractor}/messages`, ctx.serviceB.auth))
          .statusCode,
      ).toBe(403);

      // Файл подшивает подрядчик A, а подрядчик B получает на прямую ссылку 404: 403 подтвердил бы
      // ему, что файл с таким id существует.
      const fileRow = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
        VALUES ('test', ${`ses/${RUN}/${randomUUID()}`}, 'akt.pdf', 'application/pdf', 2048,
                'pending', ${ctx.serviceA.id})
        RETURNING id`);
      const fileId = fileRow.rows[0]!.id;
      // Акт не прикладывают к «Новой» — заявку сперва берут в работу. Ход делает сам подрядчик:
      // предмет случая — файл видимой ему заявки, и чужой рукой поставленный статус ничего бы не
      // изменил, кроме лишнего вопроса «а кто это сделал».
      const started = await inject(
        'PATCH',
        `${REQUESTS}/${fx.contractor}/start`,
        ctx.serviceA.auth,
        {
          version: await versionOf(fx.contractor),
        },
      );
      expect(started.statusCode, started.body).toBe(200);
      const attached = await inject(
        'POST',
        `${REQUESTS}/${fx.contractor}/files`,
        ctx.serviceA.auth,
        {
          fileIds: [fileId],
          kind: 'act',
        },
      );
      expect(attached.statusCode, attached.body).toBe(200);

      const denied = await inject('GET', `/api/v1/files/${fileId}/download`, ctx.serviceB.auth);
      expect(denied.statusCode, denied.body).toBe(404);
      // Своя сторона файл получает — иначе 404 выше означал бы «файла нет», а не «вам не видно».
      const own = await inject('GET', `/api/v1/files/${fileId}/download`, ctx.serviceA.auth);
      expect(own.statusCode, own.body).toBe(200);
    });
  });

  // ── Т13. Бейдж непрочитанного ──

  describe('Т13. бейдж и счётчик непрочитанного не считают невидимое', () => {
    beforeAll(async () => {
      await setExecutorScope(true);
    });

    it('реплика в невидимой заявке в бейдж не идёт, а в видимой — идёт', async () => {
      /*
       * СЛУЧАЙ ЛОВИТ ТО, ЧЕГО НЕ ЛОВИТ Т8. Адресат «ИТ-службе» совпадает с субъектом по КОДУ
       * НАБОРА, то есть безотносительно к заявке: реплика в чужой заявке «адресована мне» ровно так
       * же, как в своей. Единственное, что держит её вне бейджа, — область списка
       * (`chatUnreadCount(p, visibility(p))`); ошибись область — бейдж горел бы по всей компании и
       * вёл бы в список, где этих заявок нет.
       */
      const visible = await sendMessage(fx.assigned, ctx.customerA.auth, 'Когда почините?', ['it']);
      expect(visible.statusCode, visible.body).toBe(200);
      const invisible = await sendMessage(fx.foreign, ctx.customerA.auth, 'И это тоже ИТ', ['it']);
      expect(invisible.statusCode, invisible.body).toBe(200);

      const badge = await inject('GET', `${REQUESTS}/unread-count`, ctx.sysadmin.auth);
      expect(badge.statusCode, badge.body).toBe(200);
      expect(badge.json()).toEqual({ count: 1 });

      // Счётчик самой карточки считает то же и по тому же правилу.
      const own = await card(fx.assigned, ctx.sysadmin.auth);
      expect(own.statusCode).toBe(200);
      expect((own.json() as ServiceRequestDto).chat?.unreadMine).toBe(1);
    });

    it('выключенный рубильник возвращает в бейдж обе — сужается именно область', async () => {
      /*
       * ВТОРАЯ ПОЛОВИНА ДОКАЗАТЕЛЬСТВА. Без неё «единица» выше могла бы означать что угодно —
       * скажем, что вторая реплика не дошла или адресована не тому. Щёлкнув рубильник и не тронув
       * ни одной реплики, мы видим ровно вклад области.
       */
      await setExecutorScope(false);
      try {
        const badge = await inject('GET', `${REQUESTS}/unread-count`, ctx.sysadmin.auth);
        expect(badge.json()).toEqual({ count: 2 });
      } finally {
        await setExecutorScope(true);
      }
    });
  });

  // ── Т16. Обсуждение бывшего исполнителя ──

  describe('Т16. чат бывшего исполнителя по строкам таблицы Р3 (Н15)', () => {
    beforeAll(async () => {
      await setExecutorScope(true);
    });

    it('с ИТ-набором: читает и ПИШЕТ по заявке, с которой его сняли', async () => {
      /*
       * УЧАСТИЕ СНЯТОГО ДЕРЖИТСЯ НА СТОРОНЕ `it`, то есть на КОДЕ НАБОРА, а не на факте назначения:
       * сторона `service` требует ДЕЙСТВУЮЩЕЙ строки, которой у него больше нет. Ответ В11
       * («смотреть и писать в чат») выполняется поэтому именно у сисадмина — у того, ради кого
       * просьба и высказана.
       */
      const page = await inject('GET', `${REQUESTS}/${fx.past}/messages`, ctx.sysadmin.auth);
      expect(page.statusCode, page.body).toBe(200);

      // Признак «пишу» портал читает из сводки обсуждения в карточке — её и спрашиваем: ответь она
      // иначе, чем ручка отправки, кнопка и дверь разошлись бы молча.
      const dto = await card(fx.past, ctx.sysadmin.auth);
      expect(dto.statusCode, dto.body).toBe(200);
      const chat = (dto.json() as ServiceRequestDto).chat;
      expect(chat?.canWrite).toBe(true);
      expect(chat?.participantSides).toContain('it');

      const sent = await sendMessage(fx.past, ctx.sysadmin.auth, 'Передал заявку, вот что успел');
      expect(sent.statusCode, sent.body).toBe(200);
    });

    it('с одним исполнительским набором: читает, но не пишет — 403 (Н15)', async () => {
      /*
       * ЭТО НЕ ДЫРА И НЕ НЕДОДЕЛКА, А НАЗВАННАЯ ГРАНИЦА ВОЛНЫ. Заводить в модели чата факт «был
       * назначен» план не брался: у такого факта последствия в адресации, непрочитанном и почтовой
       * аудитории. Значит В11 у половины профиля не выполняется, и записано это строкой в таблице
       * Р3 — а держит запись этот случай.
       */
      const page = await inject(
        'GET',
        `${REQUESTS}/${fx.pastExecOnly}/messages`,
        ctx.execOnly.auth,
      );
      expect(page.statusCode, page.body).toBe(200);

      const dto = await card(fx.pastExecOnly, ctx.execOnly.auth);
      expect(dto.statusCode, dto.body).toBe(200);
      const chat = (dto.json() as ServiceRequestDto).chat;
      expect(chat?.canWrite).toBe(false);
      // Сторон у него не осталось ни одной: `service` требует ДЕЙСТВУЮЩЕЙ строки назначения, а
      // кода ИТ-набора, которым держится сторона `it`, у него нет.
      expect(chat?.participantSides).toEqual([]);

      const sent = await sendMessage(fx.pastExecOnly, ctx.execOnly.auth, 'А я ещё поработаю');
      expect(sent.statusCode, sent.body).toBe(403);
      expect(messageOf(sent)).toContain('пишут её стороны и автор');
    });

    it('по закрытой заявке не пишет никто — ни стороны, ни автор', async () => {
      const id = (await createRequest(ctx.customerA.auth, ctx.objectAId, 'Отменённая заявка')).id;
      const cancelled = await inject('PATCH', `${REQUESTS}/${id}/status`, ctx.operator.auth, {
        status: 'cancelled',
        reason: 'аппарат списан',
        version: await versionOf(id),
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);

      for (const who of [ctx.customerA, ctx.operator, ctx.admin]) {
        const sent = await sendMessage(id, who.auth, 'Ещё словечко');
        // 409, а не 403: сторона у человека есть, закрыта сама заявка — и различать эти два ответа
        // обязан не только код, но и текст, который читает человек.
        expect(sent.statusCode, `${who.email}: ${sent.body}`).toBe(409);
      }
    });
  });

  // ── Т9. Область действий бывшего исполнителя ──

  describe('Т9. бывший исполнитель: читает и пишет в чат — и больше ничего', () => {
    beforeAll(async () => {
      await setExecutorScope(true);
    });

    /**
     * ВСЕ ДВЕРИ РАЗОМ, ОДНИМ ПЕРЕБОРОМ. Правило Р7 стоит на ОБЩЕМ входе изменяющих ручек, и его
     * ценность именно в том, что оно не расставлено по ручкам поимённо: расставленное, оно
     * приезжало бы в следующую только вместе с тем, кто про него вспомнит. Перебор дверей — это
     * проверка общего входа, а не восьми отдельных проверок.
     *
     * ЧТО ОТБИВАЕТ КАЖДУЮ, СКАЗАНО В ТАБЛИЦЕ. У семи дверей право у субъекта ЕСТЬ (правку и
     * удаление даёт роль штаба, подшивку — набор исполнителя, назначение и заморозку — набор ИТ,
     * объём работ и ходы — набор исполнителя), и отбивает их именно область действий. Восьмая —
     * отмена — отбивается раньше, стражем маршрута: `serviceRequests.status` исполнительскому
     * профилю не выдаётся вовсе. Она в списке ради полноты Т9, и это отмечено прямо в таблице,
     * чтобы следующий читатель не принял её за доказательство области.
     */
    const doors: {
      what: string;
      method: Method;
      path: (id: string) => string;
      payload: (version: number) => unknown;
      /** Кто отбивает: область действий (`side`) либо страж маршрута (`route`). */
      by: 'side' | 'route';
    }[] = [
      {
        what: 'правка заявки',
        method: 'PATCH',
        path: (id) => `${REQUESTS}/${id}`,
        payload: (version) => ({ description: 'Правка бывшим исполнителем', version }),
        by: 'side',
      },
      {
        what: 'удаление заявки',
        method: 'DELETE',
        path: (id) => `${REQUESTS}/${id}`,
        payload: (version) => ({ version }),
        by: 'side',
      },
      {
        what: 'подшивка документа',
        method: 'POST',
        path: (id) => `${REQUESTS}/${id}/files`,
        payload: () => ({ fileIds: [randomUUID()], kind: 'act' }),
        by: 'side',
      },
      {
        what: 'назначение исполнителей',
        method: 'PUT',
        path: (id) => `${REQUESTS}/${id}/executors`,
        payload: (version) => ({ userIds: [], serviceCounterpartyId: null, version }),
        by: 'side',
      },
      {
        what: 'заморозка',
        method: 'PATCH',
        path: (id) => `${REQUESTS}/${id}/hold`,
        payload: (version) => ({ reason: 'подожду', version }),
        by: 'side',
      },
      {
        what: 'возобновление',
        method: 'PATCH',
        path: (id) => `${REQUESTS}/${id}/resume`,
        payload: (version) => ({ comment: '', version }),
        by: 'side',
      },
      {
        what: 'объём работ',
        method: 'PUT',
        path: (id) => `${REQUESTS}/${id}/estimate`,
        payload: (version) => ({
          items: [{ kind: 'service', name: 'Своя строка', quantity: 1, unitPrice: 100 }],
          version,
        }),
        by: 'side',
      },
      {
        what: 'ход исполнителя (взять в работу)',
        method: 'PATCH',
        path: (id) => `${REQUESTS}/${id}/start`,
        payload: (version) => ({ version }),
        by: 'side',
      },
      {
        what: 'отмена заявки',
        method: 'PATCH',
        path: (id) => `${REQUESTS}/${id}/status`,
        payload: (version) => ({ status: 'cancelled', reason: 'не нужно', version }),
        by: 'route',
      },
    ];

    it('все девять дверей отвечают 403, а карточка и лента остаются открытыми', async () => {
      const version = await versionOf(fx.past);
      const answers: Record<string, number> = {};
      for (const door of doors) {
        const res = await inject(
          door.method,
          door.path(fx.past),
          ctx.sysadmin.auth,
          door.payload(version),
        );
        answers[door.what] = res.statusCode;
        if (door.by === 'side') {
          // Текст отказа — половина доказательства: он называет ПРИЧИНУ (заявка видна, а действует
          // тот, кто её ведёт), и по нему видно, что запрос дошёл до области действий, а не упёрся
          // в страж маршрута или в статус.
          expect(messageOf(res), `${door.what}: ${res.body}`).toContain(
            'действует по ней тот, кто её ведёт сейчас',
          );
        }
      }
      expect(answers).toEqual(Object.fromEntries(doors.map((door) => [door.what, 403])));

      // Чтение осталось: ровно ради этого след снятия и заведён (В6).
      expect((await card(fx.past, ctx.sysadmin.auth)).statusCode).toBe(200);
      expect(
        (await inject('GET', `${REQUESTS}/${fx.past}/messages`, ctx.sysadmin.auth)).statusCode,
      ).toBe(200);
    });

    it('заявка не изменилась ни одной из девяти попыток', async () => {
      // Отказ обязан быть отказом целиком: 403 с половиной применённых изменений хуже, чем 200.
      const row = await card(fx.past, ctx.admin.auth);
      const dto = row.json() as ServiceRequestDto;
      expect(dto.status).toBe('new');
      expect(dto.executors.map((e) => e.userId)).toEqual([ctx.execOnly.id]);
      expect(dto.items).toEqual([]);
    });
  });

  // ── Т22. Назначенный сисадмин на чужой площадке ──

  describe('Т22. назначенный на чужой площадке: чинит и подшивает, но не распоряжается', () => {
    let foreignAssigned: string;
    let ownAssigned: string;
    let ownAuthored: string;

    beforeAll(async () => {
      await setExecutorScope(true);
      // Заявка ЧУЖОЙ площадки (B), на которую сисадмина назначили поимённо: ради этого сценария у
      // профиля и заведён второй набор.
      foreignAssigned = (await createRequest(ctx.customerB.auth, ctx.objectBId, 'Ремонт на B')).id;
      await assign(foreignAssigned, { userIds: [ctx.sysadmin.id] });
      // Заявка СВОЕЙ площадки, тоже назначенная: на ней поведение обязано остаться прежним.
      ownAssigned = (await createRequest(ctx.customerA.auth, ctx.objectAId, 'Ремонт на A')).id;
      await assign(ownAssigned, { userIds: [ctx.sysadmin.id] });
      // Своя заведённая заявка на ЧУЖОЙ площадке: автор правит независимо от площадки.
      ownAuthored = (await createRequest(ctx.sysadmin.auth, ctx.objectBId, 'Заведена сисадмином'))
        .id;
    });

    it('действия исполнителя и подшивка документов открыты', async () => {
      /*
       * УСЛОВИЕ СВЯЗНОСТИ, А НЕ ПОБОЧНЫЙ ЭФФЕКТ. Под общим входом изменяющих ручек живёт подшивка
       * документов, а сисадмина штатно назначают на заявки чужих площадок — акт по такой заявке он
       * обязан приложить. Сузь область действий назначенного заодно с бывшим, и назначенный
       * исполнитель перестал бы прикладывать бумагу к заявке, которую сам же чинит.
       */
      const started = await inject(
        'PATCH',
        `${REQUESTS}/${foreignAssigned}/start`,
        ctx.sysadmin.auth,
        {
          version: await versionOf(foreignAssigned),
        },
      );
      expect(started.statusCode, started.body).toBe(200);

      const fileRow = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
        VALUES ('test', ${`ses/${RUN}/${randomUUID()}`}, 'akt.pdf', 'application/pdf', 2048,
                'pending', ${ctx.sysadmin.id})
        RETURNING id`);
      const attached = await inject(
        'POST',
        `${REQUESTS}/${foreignAssigned}/files`,
        ctx.sysadmin.auth,
        { fileIds: [fileRow.rows[0]!.id], kind: 'act' },
      );
      expect(attached.statusCode, attached.body).toBe(200);
    });

    it('правка и удаление чужой площадки — 403: назначение не даёт распоряжения (Р10)', async () => {
      /*
       * ДВА РАЗНЫХ ОСНОВАНИЯ, И СМЕШИВАТЬ ИХ НЕЛЬЗЯ НИ В ОДНУ СТОРОНУ: «я это чиню» даёт
       * назначение, «я этим распоряжаюсь» — сторона заказчика. Слитые, они либо отобрали бы у
       * исполнителя акт (случай выше), либо отдали бы ему чужую заявку целиком.
       *
       * ПОСЛЕ ВЫПУСКА B ОТВЕТЫ ТЕ ЖЕ, и держит это решение Р10: страж узнаёт субъекта КОДАМИ
       * НАБОРОВ, а не картой сквозной области, которую следующий выпуск уберёт. Оставь волна
       * прежнее опознание — снятая карта сделала бы признак ложным, страж ответил бы «да», и
       * правка чужой заявки открылась бы через назначение ровно тому профилю, у которого её только
       * что отобрали. Проверяется это парой к случаю в блоке Т21.
       */
      const version = await versionOf(foreignAssigned);
      const edited = await inject('PATCH', `${REQUESTS}/${foreignAssigned}`, ctx.sysadmin.auth, {
        description: 'Правлю чужую заявку',
        version,
      });
      expect(edited.statusCode, edited.body).toBe(403);
      const removed = await inject('DELETE', `${REQUESTS}/${foreignAssigned}`, ctx.sysadmin.auth, {
        version,
      });
      expect(removed.statusCode, removed.body).toBe(403);
    });

    it('автор правит свою заявку и на чужой площадке', async () => {
      const res = await inject('PATCH', `${REQUESTS}/${ownAuthored}`, ctx.sysadmin.auth, {
        description: 'Своя заявка, правлю',
        version: await versionOf(ownAuthored),
      });
      expect(res.statusCode, res.body).toBe(200);
    });

    it('на своей площадке поведение прежнее — тот же ответ и тем же правилом', async () => {
      /*
       * «ПРЕЖНЕЕ» ПРОВЕРЯЕТСЯ ЩЕЛЧКОМ РУБИЛЬНИКА, А НЕ ОЖИДАНИЕМ «200». Правку заявки СВОЕЙ
       * площадки сисадмину закрывает не волна, а действующее правило окна правки: со стороны
       * заказчика правят заявку, которую ещё никому не отдали (`assertServiceRequestEditable`), а
       * эта уже назначена — ему же самому. Утверждение поэтому такое: ответ на своей площадке
       * одинаков при включённом и выключенном ключе, и отбивает его СТАРОЕ правило, а не два
       * новых стража.
       *
       * Отличить их можно только по тексту, и это не придирка: 403 «заявку уже отдали
       * исполнителю» означает «поведение сохранено», а 403 «действует по ней тот, кто её ведёт
       * сейчас» или «вправе сторона заказчика» означал бы, что назначенный на СВОЕЙ площадке
       * потерял то, чего волна у него не отбирала.
       */
      const edit = async (): Promise<LightMyRequestResponse> =>
        inject('PATCH', `${REQUESTS}/${ownAssigned}`, ctx.sysadmin.auth, {
          description: 'Своя площадка, правлю',
          version: await versionOf(ownAssigned),
        });

      const withScope = await edit();
      await setExecutorScope(false);
      const withoutScope = await edit();
      await setExecutorScope(true);

      expect(withScope.statusCode, withScope.body).toBe(403);
      expect(withoutScope.statusCode).toBe(withScope.statusCode);
      expect(messageOf(withScope)).toContain('только до назначения сервиса');
      expect(messageOf(withoutScope)).toBe(messageOf(withScope));
    });
  });

  // ── Т15. Сообщения о технике («техника не найдена») ──

  describe('Т15. кандидаты: разбор работает, ссылка на невидимую заявку не показывается', () => {
    let candidateId: string;
    let requestId: string;

    beforeAll(async () => {
      await setExecutorScope(true);
      const res = await inject(
        'POST',
        REQUESTS,
        ctx.mover.auth,
        {
          description: 'Не печатает, в справочнике не нашёл',
          responsibleName: 'Иванов Иван Иванович',
          responsiblePhone: '+79990000000',
          equipmentCandidate: {
            equipmentTypeId: ctx.typeId,
            declaredModel: 'HP LaserJet 1320',
            objectId: ctx.objectAId,
            location: 'каб. 3',
            inventoryNumber: `SES-CAND-${RUN}`,
          },
        },
        { 'idempotency-key': randomUUID() },
      );
      expect(res.statusCode, res.body).toBe(201);
      requestId = (res.json() as { request: ServiceRequestDto }).request.id;
      const row = await ctx.db.execute<{ id: string }>(sql`
        SELECT equipment_candidate_id AS id FROM service_requests WHERE id = ${requestId}::uuid`);
      candidateId = row.rows[0]!.id;
    });

    it('очередь проверяющего работает при включённом сужении и показывает ссылку на заявку', async () => {
      /*
       * Н12: ОЧЕРЕДЬ СЧИТАЕТ СВОЯ ОСЬ (`officeEquipmentCandidateReviewWhere`), а не видимость
       * заявки, и право на разбор живёт в «Ведении», а не в ИТ-наборе. Сужение заявок не имеет
       * права закрыть разбор — иначе сообщения о технике копились бы без адресата.
       */
      const queue = await inject('GET', `${CANDIDATES}?pageSize=200`, ctx.operator.auth);
      expect(queue.statusCode, queue.body).toBe(200);
      const rows = queue.json().items as OfficeEquipmentCandidateDto[];
      const mine = rows.find((row) => row.id === candidateId);
      expect(mine, 'сообщение стоит в очереди проверяющего').toBeDefined();
      expect(mine!.request?.id).toBe(requestId);
    });

    it('автор, потерявший заявку из области, видит сообщение — но без ссылки', async () => {
      /*
       * СУЖАЕТСЯ РОВНО ОДНО (Н12): ссылка на связанную заявку у того, кто эту заявку больше не
       * видит. Сообщение автору остаётся — оно свидетельство конкретного человека, и основание
       * `own` не зависит от того, где он теперь служит.
       *
       * ПЕРЕВОД НА ДРУГУЮ ПЛОЩАДКУ — самый честный способ это показать: заявка написана на
       * площадку A, а человек теперь на B, и ни одна ось его к ней больше не приводит. Тем же
       * запросом проверяется, что `request: null` означает «не видно», а не «связи нет»: у
       * проверяющего строкой выше связь та же и видна.
       */
      const before = await inject('GET', `${CANDIDATES}/${candidateId}`, ctx.mover.auth);
      expect(before.statusCode, before.body).toBe(200);
      expect((before.json() as OfficeEquipmentCandidateDto).request?.id).toBe(requestId);

      await ctx.db.execute(sql`
        UPDATE user_construction_objects SET construction_object_id = ${ctx.objectBId}
         WHERE user_id = ${ctx.mover.id}::uuid`);
      try {
        expect((await card(requestId, ctx.mover.auth)).statusCode).toBe(403);
        const after = await inject('GET', `${CANDIDATES}/${candidateId}`, ctx.mover.auth);
        expect(after.statusCode, after.body).toBe(200);
        expect((after.json() as OfficeEquipmentCandidateDto).request).toBeNull();
      } finally {
        await ctx.db.execute(sql`
          UPDATE user_construction_objects SET construction_object_id = ${ctx.objectAId}
           WHERE user_id = ${ctx.mover.id}::uuid`);
      }
    });

    it('сисадмин, не назначенный на заявку кандидата, не видит и самого сообщения', async () => {
      // Ни одного из трёх оснований: не автор, права разбора у ИТ-набора нет вовсе (Н12), а
      // связанная заявка при включённом сужении ему не видна.
      expect((await card(requestId, ctx.sysadmin.auth)).statusCode).toBe(403);
      const denied = await inject('GET', `${CANDIDATES}/${candidateId}`, ctx.sysadmin.auth);
      // 404, а не 403: сообщение достают отбором по области, и «вам не видно» отвечает тем же, чем
      // «такого нет», — постороннему незачем знать, что запись с этим id существует.
      expect(denied.statusCode, denied.body).toBe(404);
    });
  });

  // ── Т21. Parity A ≡ B ──

  describe('Т21. parity: выпуск A отвечает так же, как ответит выпуск B', () => {
    beforeAll(async () => {
      await setExecutorScope(true);
    });

    /**
     * **ВЫПУСК B — ЭТО СНЯТАЯ СТРОКА КАРТЫ, И ЗДЕСЬ ОНА СНИМАЕТСЯ ПО-НАСТОЯЩЕМУ.** Карта
     * `GRANT_MODULE_WIDE_SCOPE` живёт в коде, а не в базе, поэтому единственный честный способ
     * задать вопрос «а как ответит выпуск B» — убрать `serviceRequests` из массива на время пробы:
     * `hasModuleWideScope` спрашивает тот же массив по ссылке, и правка действует на весь процесс
     * немедленно. Пересказ карты вторым списком доказывал бы пересказ.
     *
     * `officeEquipment` при этом ОСТАЁТСЯ (ответ В5): парк виден целиком во всех трёх выпусках, и
     * снятие обеих строк проверяло бы не тот выпуск.
     */
    async function underReleaseB<T>(probe: () => Promise<T>): Promise<T> {
      const map = GRANT_MODULE_WIDE_SCOPE.office_equipment_it_approver as ScopeModule[];
      const saved = [...map];
      map.splice(0, map.length, ...saved.filter((module) => module !== 'serviceRequests'));
      try {
        // Проверка, что подмена вообще сработала: без неё «одинаковые ответы» означали бы, что мы
        // дважды спросили выпуск A.
        expect(hasModuleWideScope(['office_equipment_it_approver'], 'serviceRequests')).toBe(false);
        expect(hasModuleWideScope(['office_equipment_it_approver'], 'officeEquipment')).toBe(true);
        return await probe();
      } finally {
        map.splice(0, map.length, ...saved);
      }
    }

    /** Ответ пробы в сравнимом виде: код и поля отказа — то, что видит портал. */
    function answerOf(res: LightMyRequestResponse): { status: number; fields: string[] } {
      let fields: string[] = [];
      try {
        fields = Object.keys((res.json() as { fields?: Record<string, string> }).fields ?? {});
      } catch {
        fields = [];
      }
      return { status: res.statusCode, fields };
    }

    /** Заведение заявки по аппарату чужой площадки — проба «заведение» и «перенос аппарата». */
    async function createOnForeignSite(
      user: TestUser,
      objectId: string,
      overrideTo?: string,
    ): Promise<LightMyRequestResponse> {
      return inject('POST', REQUESTS, user.auth, {
        officeEquipmentId: await makeEquipment(objectId),
        description: 'Проба parity',
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
        ...(overrideTo === undefined ? {} : { objectId: overrideTo, objectOverridden: true }),
      });
    }

    /** Заявка без аппарата — проба «подбор заказчика» (`resolveEmptySubjectCustomer`). */
    async function createWithoutEquipment(
      user: TestUser,
      objectId: string,
    ): Promise<LightMyRequestResponse> {
      return inject('POST', REQUESTS, user.auth, {
        description: 'Проба parity без аппарата',
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
        objectId,
      });
    }

    /** Сообщение о технике на чужой площадке — проба «площадка кандидата». */
    async function proposeAt(user: TestUser, objectId: string): Promise<LightMyRequestResponse> {
      return inject(
        'POST',
        REQUESTS,
        user.auth,
        {
          description: 'Проба parity: техника не найдена',
          responsibleName: 'Иванов Иван Иванович',
          responsiblePhone: '+79990000000',
          equipmentCandidate: {
            equipmentTypeId: ctx.typeId,
            declaredModel: 'HP LaserJet 1320',
            objectId,
            location: 'каб. 5',
            inventoryNumber: `SES-PAR-${RUN}-${(unitNo += 1)}`,
          },
        },
        { 'idempotency-key': randomUUID() },
      );
    }

    /**
     * **ПОДМЕНА КАРТЫ ДОХОДИТ ДО СЕРВЕРА — СТРАЖ САМОГО ПРИЁМА.**
     *
     * Все равенства ниже читаются как утверждение «карта при включённом ключе не читается вовсе», и
     * ровно поэтому они зелены и тогда, когда подмена не сработала: сломайся `underReleaseB` —
     * промахнись он мимо той копии массива, которую спрашивает сервер, — обе половины пробы
     * отвечали бы одинаково просто потому, что мир не менялся. Отличить одно от другого можно
     * единственным способом: найти состояние, в котором карта ТОЧНО читается, и показать, что
     * снятие строки его меняет.
     *
     * Такое состояние есть — ВЫКЛЮЧЕННЫЙ рубильник: там сквозная область ИТ-набора и есть причина,
     * по которой сисадмин видит заявки всей компании (Т19). Снимаем строку — и он видит только свою
     * площадку. Значит подмена действует на живом сервере, а не на копии в тесте.
     */
    it('снятие строки карты меняет ответ там, где карта читается — на выключенном ключе', async () => {
      await setExecutorScope(false);
      try {
        const withMap = await listIds(ctx.sysadmin.auth);
        const withoutMap = await underReleaseB(() => listIds(ctx.sysadmin.auth));
        // При живой карте видна и заявка соседней площадки, к которой он не имеет отношения.
        expect(withMap).toContain(fx.contractor);
        // Без карты — область его роли: площадка A, и ничего с B.
        expect(withoutMap).not.toContain(fx.contractor);
        expect(withoutMap.length).toBeGreaterThan(0);
      } finally {
        await setExecutorScope(true);
      }
    });

    for (const profile of ['обычный сисадмин', 'ИТ + Ведение на чужой площадке'] as const) {
      describe(profile, () => {
        const userOf = (): TestUser =>
          profile === 'обычный сисадмин' ? ctx.sysadmin : ctx.itOperator;
        /** Площадка, ЧУЖАЯ для субъекта: у сисадмина это B, у «ИТ + Ведение» — A. */
        const foreignObject = (): string =>
          profile === 'обычный сисадмин' ? ctx.objectBId : ctx.objectAId;

        it('список заявок совпадает до и после уборки карты', async () => {
          /*
           * ПЕРВАЯ ПРОБА И САМАЯ ВАЖНАЯ ДЛЯ ВТОРОГО ПРОФИЛЯ. У «ИТ + Ведение» признак
           * `actsAsServiceExecutorOnly` ложен — «Ведение» его исключает, — и, оставь развилка карту
           * прочитанной хоть одной веткой, в выпуске A он видел бы компанию, а в выпуске B область
           * своей роли. На обычном сисадмине это расхождение не видно вовсе: его ловит ветка
           * исполнителя, которая карту не спрашивает.
           */
          const before = await listIds(userOf().auth);
          const after = await underReleaseB(() => listIds(userOf().auth));
          // Непустой список — условие осмысленности: два пустых совпали бы и при сломанном
          // предикате, и равенство ниже доказывало бы только то, что обе половины молчат.
          expect(before.length).toBeGreaterThan(0);
          expect([...after].sort()).toEqual([...before].sort());
        });

        /**
         * **ЗАВЕДЕНИЕ ЗАЯВКИ: A ≡ B ПО ВСЕМ ЧЕТЫРЁМ ДВЕРЯМ** (Р9, Т21).
         *
         * ЧТО ИМЕННО ПРОВЕРЯЕТСЯ. Решение Р9 переводит на область ПАРКА
         * (`canPickAnyServiceSubject`) не только три разбора предмета — площадку аппарата,
         * заказчика заявки без аппарата и площадку сообщения о технике, — но и «второй рубеж»
         * поверх них (`assertServiceRequestScope`), который спрашивает, попадёт ли получившаяся
         * заявка к самому автору. Пока оба ключа стоят у одного набора, подмена ответов не меняет;
         * доказать это обязан прогон, а не рассуждение — потому проба и задаётся дважды, со снятой
         * строкой карты и без неё.
         *
         * СЛУЧАЙ УЖЕ ЛОВИЛ РАССОГЛАСОВАНИЕ (находка Д1 первого прогона): рубеж оставался на карте
         * заявок, и при снятой строке все четыре двери отвечали 403 «работает только со своими
         * объектами» вместо 201 — то есть выпуск, объявленный уборкой, менял правила ЗАВЕДЕНИЯ.
         * Починено переводом рубежа на область парка; здесь остаётся страж, который не даст этому
         * вернуться.
         *
         * РАВЕНСТВО САМО ПО СЕБЕ НИЧЕГО НЕ СТОИТ, и первая половина утверждения — про это:
         * «одинаково закрыто» тоже равенство. Поэтому сперва проверяется, что в выпуске A все
         * четыре двери ОТКРЫТЫ (201) — иначе проба не дотягивалась бы до карты вовсе, — и лишь
         * потом, что снятие строки ответов не изменило.
         */
        it('заведение, заказчик, кандидат и перенос аппарата: A ≡ B', async () => {
          const probes: Record<string, () => Promise<LightMyRequestResponse>> = {
            'заведение по аппарату чужой площадки': () =>
              createOnForeignSite(userOf(), foreignObject()),
            'подбор заказчика заявки без аппарата': () =>
              createWithoutEquipment(userOf(), foreignObject()),
            'площадка сообщения о технике': () => proposeAt(userOf(), foreignObject()),
            'перенос аппарата на чужую площадку': () =>
              createOnForeignSite(
                userOf(),
                profile === 'обычный сисадмин' ? ctx.objectAId : ctx.objectBId,
                foreignObject(),
              ),
          };

          const inA: Record<string, number> = {};
          const inB: Record<string, number> = {};
          for (const [what, probe] of Object.entries(probes)) {
            inA[what] = answerOf(await probe()).status;
            inB[what] = answerOf(await underReleaseB(probe)).status;
          }

          // Выпуск A: все четыре двери открыты — сегодняшнее поведение и обещание В5.
          expect(inA).toEqual(Object.fromEntries(Object.keys(probes).map((what) => [what, 201])));
          // Выпуск B: ровно те же ответы. Уборка строки остаётся уборкой.
          expect(inB).toEqual(inA);
        });
      });
    }

    it('страж распоряжения записью переживает уборку карты (Р10)', async () => {
      /*
       * ВТОРОЙ БЛОКЕР ТРЕТЬЕГО РЕВЬЮ, И ОН ОПАСНЕЕ ПЕРВОГО. Прежде `canChangeRequestAsCustomer`
       * узнавал сисадмина через КАРТУ сквозной области; сними её — признак стал бы ложным, страж
       * ответил бы «да», и правка ЧУЖОЙ заявки открылась бы через назначение. Случай задаёт тот же
       * вопрос, что и Т22, но в мире выпуска B: ответ обязан остаться 403.
       */
      const id = (await createRequest(ctx.customerB.auth, ctx.objectBId, 'Правка после B')).id;
      await assign(id, { userIds: [ctx.sysadmin.id] });
      const version = await versionOf(id);
      const answer = await underReleaseB(async () =>
        answerOf(
          await inject('PATCH', `${REQUESTS}/${id}`, ctx.sysadmin.auth, {
            description: 'Правлю чужую заявку после уборки карты',
            version,
          }),
        ),
      );
      expect(answer.status).toBe(403);
    });
  });
});
