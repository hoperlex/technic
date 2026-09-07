import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  equipmentRequestOutcomeLabels,
  EQUIPMENT_WARRANTY_CHANGE_FIELD,
  type EquipmentChangeRowDto,
  type EquipmentChangesPageDto,
  type EquipmentHistoryPageDto,
  type EquipmentMovementsPageDto,
  type EquipmentRequestRowDto,
  type EquipmentRequestsPageDto,
  type ServiceRequestDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type { Principal } from '../src/auth/principal';

/**
 * ИСТОРИЯ ЕДИНИЦЫ ОРГТЕХНИКИ ТРЕМЯ БИЗНЕС-БЛОКАМИ — серверные случаи §10.1 плана
 * `docs/office-equipment-history-blocks-plan.md` (пункт 13 разбора 02.09.2026).
 *
 * ГЛАВНЫЙ СЛУЧАЙ ПЛАНА СТОИТ ПЕРВЫМ И ЭТО НЕ ПОРЯДОК УДОБСТВА (§10.1, тест 1; критерий К3).
 * Блок «Связанные заявки» — третий экран, рассказывающий о ремонтах одного аппарата, и появился он
 * рядом с лентой и реестром заявок. Три места, отвечающие на один вопрос, обязаны отвечать
 * ОДИНАКОВО — иначе новый блок становится обходным путём к чужим заявкам через справочник, который
 * открыт почти каждой роли портала. Поэтому первый случай сравнивает три множества
 * идентификаторов — блока, ВСЕХ страниц полной ленты и реестра с фильтром по этой технике — и
 * делает это для четырёх разных субъектов, у которых области считаются РАЗНЫМИ предикатами:
 * объектная роль, сквозная область модуля, заказчик и подрядчик.
 *
 * ЧТО ЕЩЁ ЗАКРЕПЛЕНО:
 *
 *   2. смотрящий без `serviceRequests.read` не получает блок заявок (`403`), но видит правки и
 *      перемещения, а полная лента приходит без ремонтной части;
 *   3. пагинация: три страницы по две строки — шесть разных строк без повторов и пропусков, и это
 *      проверено на КАЖДОМ из трёх блоков (у каждого свой ключ порядка и свой курсор);
 *   4. детерминированный порядок при одинаковых отметках времени — разрыв ничьей по `id` (Н8);
 *   5. гарантии в строке заявки: действующие есть, истёкшие нет (Р6, К5);
 *   6. четыре разных `outcome` — нефинансовым кодом со словарной подписью (Р2, Н12);
 *   7. сумма акта: скрыта у аудитории, которой не положена, и открыта назначенному исполнителю (Р5);
 *   8. правка без диффа приходит строкой, а не пропадает (Н5);
 *   9. чужой курсор (ленты и соседнего блока) — `422`, а не молчаливая первая страница (Р8);
 *  10. бюджет запросов (Р10, К8): страница блока заявок стоит не больше ПЯТИ выражений SQL, и число
 *      это одно и то же при одной строке и при двадцати — равенство и есть доказательство того, что
 *      скрытого `N+1` нет.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: файл сравнивает МНОЖЕСТВА строк по единице и
 * считает страницы, а по общей базе идут параллельные прогоны и лежит копия боевого парка. База
 * заводится, мигрируется с нуля и сносится в `afterAll`.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     pnpm --filter @technic/api exec vitest run test/equipment-history-blocks.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_oe_blocks_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-oe-blocks-password-123';
const EQUIPMENT = '/api/v1/office-equipment';
const REQUESTS = '/api/v1/service-requests';

/** Сумма акта заявки, у которой она есть: её и прячет проекция аудитории. */
const ACT_AMOUNT = 12_500;

interface Auth {
  authorization: string;
}

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: TestUser;
  /** «Оргтехника: ведение» на штабе площадки A: область объектная, деньги открыты правом. */
  operator: TestUser;
  /** Заказчик той же площадки: заявки видит, денег ему не положено — аудитория `requester`. */
  requester: TestUser;
  /** Держатель справочника без модуля заявок (менеджер): блок заявок ему закрыт правом. */
  keeper: TestUser;
  /** «Оргтехника: ИТ-служба»: область СКВОЗНАЯ, поэтому площадка у него намеренно чужая. */
  itApprover: TestUser;
  /** Подрядчик, которому справочник открыт отдельным набором: видит только назначенные заявки. */
  contractor: TestUser;
  /** Обычный подрядчик — без справочника вовсе: он до блоков не доходит (см. случай 2). */
  contractorPlain: TestUser;
  serviceCounterpartyId: string;
  objectA: string;
  objectB: string;
  typeId: string;
  /** Единица, вокруг которой собран весь файл: шесть заявок, шесть правок, шесть перемещений. */
  unitId: string;
  /** Соседняя единица той же площадки: её заявка в блок первой попадать не должна. */
  otherUnitId: string;
  /** Единица под случай 4: у её двух правок отметки времени совпадают до микросекунды. */
  tieUnitId: string;
  /** Заявки основной единицы по метке случая. */
  requests: Map<string, ServiceRequestDto>;
  otherUnitRequestId: string;
}

let ctx: Ctx;

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
  process.env.MAIL_ENABLED ??= 'false';
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url,
    headers: auth,
    remoteAddress: nextAddress(),
    ...(payload === undefined ? {} : { payload }),
  });
}

// ── Счётчик SQL-выражений (Р10, К8) ──

/**
 * Открытое окно счёта: пока оно есть, сюда ложится текст каждого выражения, ушедшего в базу.
 * `null` означает, что окна нет и обёртка не делает ничего, — и это главное свойство счётчика:
 * миграции, фикстура, входы и сами проверки результатов в счёт не попадают. Считай он всё подряд,
 * число зависело бы от того, что делалось до замера, то есть от порядка случаев в файле.
 */
let sqlWindow: string[] | null = null;

/** Обёрнутые соединения: клиента из пула берут много раз, а обёртку он получает один. */
const instrumented = new WeakSet<object>();

/**
 * ГДЕ СТОИТ ПЕРЕХВАТ И ПОЧЕМУ ИМЕННО ТАМ.
 *
 * Не в `src/db/client.ts`: счётчик нужен одному файлу тестов, а жил бы в рабочем коде — на каждом
 * запросе прода, ради проверки. Р10 просит обёртку, а не постоянного жильца.
 *
 * Не на `pool.query`: `Pool.query` внутри берёт соединение и зовёт `client.query` на нём
 * (`pg-pool/index.js`), поэтому счёт на обоих уровнях сразу удваивал бы каждый запрос, а счёт на
 * одном только пуле терял бы всё, что идёт через `pool.connect()` — выделенное соединение берут
 * транзакции drizzle, и спрятанный в них `N+1` остался бы невидимым. Соединение — единственная
 * точка, через которую проходит и то и другое, и ровно по разу.
 *
 * Событием `connect`, а не подменой `pool.connect`: событие приходит один раз на каждое НОВОЕ
 * физическое соединение и до первого запроса по нему (`_acquireClient`), то есть обёртка ставится
 * ровно один раз на клиента и не зависит от того, сколько раз его брали из пула.
 *
 * Ставится счётчик сразу после импорта клиента, пока пул пуст: соединение, созданное раньше,
 * обёртки бы не получило и молча не считалось бы — а незамеченный запрос здесь хуже отсутствия
 * проверки, потому что выглядит она при этом зелёной.
 */
function installSqlCounter(target: pg.Pool): void {
  target.on('connect', (client) => {
    if (instrumented.has(client)) return;
    instrumented.add(client);
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args) => {
      sqlWindow?.push(statementTextOf(args[0]));
      return original(...args);
    };
  });
}

/**
 * Текст выражения — для сообщения об ошибке: считаем мы вызовы, а вот показывать при расхождении
 * надо то, что ушло в базу. Оба вида вызова: drizzle зовёт клиента объектом `{ text, values }`,
 * голая строка приходит от прямых обращений вроде `pingDb`.
 */
function statementTextOf(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && 'text' in arg) {
    return String((arg as { text: unknown }).text);
  }
  return '<выражение неизвестного вида>';
}

/**
 * Считает выражения ОДНОГО действия. Вкладывать замеры нельзя, и попытка отбивается сразу: у
 * вложенных окон внешнее не досчитало бы внутренних запросов, и «пять» вышло бы из ниоткуда.
 */
async function countSql<T>(run: () => Promise<T>): Promise<{ value: T; sql: string[] }> {
  if (sqlWindow) throw new Error('Окно счёта уже открыто: замеры не вкладываются');
  const log: string[] = [];
  sqlWindow = log;
  try {
    const value = await run();
    return { value, sql: log };
  } finally {
    sqlWindow = null;
  }
}

// ── Чтение блоков ──

async function requestsPage(
  auth: Auth,
  query = '',
  unitId = ctx.unitId,
): Promise<EquipmentRequestsPageDto> {
  const res = await inject('GET', `${EQUIPMENT}/${unitId}/requests${query}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as EquipmentRequestsPageDto;
}

async function changesPage(
  auth: Auth,
  query = '',
  unitId = ctx.unitId,
): Promise<EquipmentChangesPageDto> {
  const res = await inject('GET', `${EQUIPMENT}/${unitId}/changes${query}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as EquipmentChangesPageDto;
}

async function movementsPage(
  auth: Auth,
  query = '',
  unitId = ctx.unitId,
): Promise<EquipmentMovementsPageDto> {
  const res = await inject('GET', `${EQUIPMENT}/${unitId}/movements${query}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as EquipmentMovementsPageDto;
}

/**
 * Все строки блока — через курсор, а не одной большой страницей: множество, собранное `pageSize=200`,
 * доказывало бы только выборку, а вопрос стоит о ней ВМЕСТЕ с пагинацией.
 */
async function walkRequests(auth: Auth): Promise<EquipmentRequestRowDto[]> {
  const rows: EquipmentRequestRowDto[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page: EquipmentRequestsPageDto = await requestsPage(
      auth,
      `?pageSize=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    rows.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return rows;
}

/**
 * Идентификаторы заявок из ВСЕХ страниц полной ленты (§10.1, тест 1: «одна страница ленты не
 * считается доказательством»), и сразу — счётчик пройденных страниц.
 *
 * РАЗМЕР СТРАНИЦЫ ЗДЕСЬ ЗНАЧИМ, и это находка, а не настройка фикстуры. У ленты предел стоит НА
 * ИСТОЧНИК (`sourceLimit = pageSize + 1`) и применяется ДО отсечения курсором: `visibleRequests`
 * при каждом запросе берёт `pageSize + 1` САМЫХ СВЕЖИХ заявок, а курсор потом выбрасывает уже
 * показанные. Значит заявка, не попавшая в этот срез, не появится ни на какой глубине пагинации —
 * см. отдельный случай ниже. Восьмёрка выбрана так, чтобы срез накрыл все шесть заявок фикстуры и
 * при этом страниц было несколько: событий у единицы вдвое больше.
 */
async function feedRequestIds(
  auth: Auth,
  pageSize = 8,
): Promise<{ ids: Set<string>; pages: number }> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  for (let guard = 0; guard < 60; guard += 1) {
    const res = await inject(
      'GET',
      `${EQUIPMENT}/${ctx.unitId}/history?pageSize=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      auth,
    );
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as EquipmentHistoryPageDto;
    pages += 1;
    for (const event of page.items) {
      if (event.kind === 'service_request') ids.add(event.requestId);
    }
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return { ids, pages };
}

/** Реестр заявок с фильтром по этой технике — третий рассказ о том же (Н1). */
async function registryIds(auth: Auth): Promise<Set<string>> {
  const res = await inject('GET', `${REQUESTS}?equipmentId=${ctx.unitId}&pageSize=200`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return new Set((res.json() as { items: ServiceRequestDto[] }).items.map((row) => row.id));
}

const idsOf = (rows: { id: string }[]): Set<string> => new Set(rows.map((row) => row.id));
const sorted = (ids: Iterable<string>): string[] => [...ids].sort();

describe.skipIf(!DB_URL)('история единицы оргтехники тремя блоками (§10.1 плана)', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
    const client = new pg.Client({ connectionString: OWN_DB });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    prepareEnv(OWN_DB!);
    const { db, closeDb, pool } = await import('../src/db/client');
    // До первого запроса: соединений в пуле ещё нет, и обёртку получат все до одного.
    installSqlCounter(pool);
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    const makeObject = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`HB-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const objectA = await makeObject('A');
    const objectB = await makeObject('B');

    const counterparty = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-История ${RUN}`},
              ${String(Date.now()).slice(-10)})
      RETURNING id`);
    const serviceCounterpartyId = counterparty.rows[0]!.id;

    async function makeUser(
      tag: string,
      role: string,
      opts: { objectIds?: string[]; counterpartyId?: string } = {},
    ): Promise<{ id: string; email: string }> {
      const email = `db-hb-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now(), ${opts.counterpartyId ?? null})
        RETURNING id`);
      const id = res.rows[0]!.id;
      for (const objectId of opts.objectIds ?? []) {
        await db.execute(sql`
          INSERT INTO user_construction_objects (user_id, construction_object_id)
          VALUES (${id}, ${objectId})`);
      }
      return { id, email };
    }

    const adminUser = await makeUser('admin', 'admin');
    const operatorUser = await makeUser('oper', 'shtab', { objectIds: [objectA] });
    const requesterUser = await makeUser('req', 'shtab', { objectIds: [objectA] });
    const keeperUser = await makeUser('keep', 'manager');
    // Площадка у ИТ-службы намеренно ЧУЖАЯ: без сквозной области модуля (`GRANT_MODULE_WIDE_SCOPE`)
    // она не увидела бы ни карточку, ни заявки, и случай доказывал бы область роли, а не набора.
    const itUser = await makeUser('it', 'shtab', { objectIds: [objectB] });
    const contractorUser = await makeUser('serv', 'operator', {
      counterpartyId: serviceCounterpartyId,
    });
    const contractorPlainUser = await makeUser('serv2', 'operator', {
      counterpartyId: serviceCounterpartyId,
    });

    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operatorUser.id, ['office_equipment_operator'], adminUser.id);
      await replaceUserAddons(tx, itUser.id, ['office_equipment_it_approver'], adminUser.id);
    });

    /*
     * Подрядчику справочник открывается СОБРАННЫМ набором, и это не подгонка фикстуры под ответ.
     * Поставочный подрядчик `officeEquipment.read` не имеет вовсе (`COUNTERPARTY_TYPE_PERMISSIONS`),
     * то есть до блоков и до ленты он не доходит — это отдельный случай ниже. Но именно поэтому
     * область его строк никем и не проверена: открой кто-нибудь ему справочник — и вопрос «а не
     * покажет ли блок чужие ремонты» становится настоящим. Здесь он и задаётся.
     */
    const grant = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, is_system)
      VALUES (${`hb_contractor_read_${RUN}`}, ${`Справочник подрядчику ${RUN}`}, false)
      RETURNING id`);
    const grantId = grant.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'operator'::role)`);
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      VALUES (${grantId}, 'officeEquipment.read')`);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
      VALUES (${contractorUser.id}, ${grantId}, ${adminUser.id}, 'manual')`);

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    const app = await buildApp();
    await app.ready();

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
    const withAuth = async (u: { id: string; email: string }): Promise<TestUser> => ({
      ...u,
      auth: await login(u.email),
    });

    ctx = {
      app,
      db,
      closeDb,
      admin: await withAuth(adminUser),
      operator: await withAuth(operatorUser),
      requester: await withAuth(requesterUser),
      keeper: await withAuth(keeperUser),
      itApprover: await withAuth(itUser),
      contractor: await withAuth(contractorUser),
      contractorPlain: await withAuth(contractorPlainUser),
      serviceCounterpartyId,
      objectA,
      objectB,
      typeId,
      unitId: '',
      otherUnitId: '',
      tieUnitId: '',
      requests: new Map(),
      otherUnitRequestId: '',
    };

    // ── Фикстура: единицы ──

    let unitNo = 0;
    async function makeEquipment(tag: string): Promise<string> {
      unitNo += 1;
      const res = await inject('POST', EQUIPMENT, ctx.operator.auth, {
        equipmentTypeId: ctx.typeId,
        name: `Kyocera ECOSYS ${tag} ${RUN}`,
        inventoryNumber: `HB-${RUN}-${unitNo}`,
        objectId: ctx.objectA,
        location: 'кабинет 200',
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { id: string }).id;
    }
    ctx.unitId = await makeEquipment('main');
    ctx.otherUnitId = await makeEquipment('other');
    ctx.tieUnitId = await makeEquipment('tie');

    // ── Фикстура: заявки ──

    async function createRequest(
      unitId: string,
      description: string,
      kind: 'repair' | 'consumable' = 'repair',
    ): Promise<ServiceRequestDto> {
      const res = await inject('POST', REQUESTS, ctx.operator.auth, {
        officeEquipmentId: unitId,
        description,
        kind,
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { request: ServiceRequestDto }).request;
    }

    /*
     * ИСХОДЫ ЗАЯВОК ПРОСТАВЛЯЮТСЯ ПРЯМЫМ SQL, и это осознанно. Предмет файла — READ MODEL: блок
     * читает `status`, `rejection_resolution`, `replacement_recommended`, `warranty_claim_source`,
     * `final_total_amount` и строки объёма работ, и правило `outcome` считает по ним. Проводить
     * каждую из шести заявок настоящим циклом (смета → предъявление → согласование → закрытие →
     * приёмка) значило бы проверять здесь маршруты цикла — предмет соседнего файла
     * (`service-request-warranty-transitions.db.test.ts`) — и завязать историю на них.
     *
     * Контрагент проставляется ВМЕСТЕ со статусом: заявка в рабочем или принятом статусе без
     * исполнителя не проходит отложенный триггер `service_requests_executor_present` (миграция
     * 0178). Порядок заведения тоже не свободен: по единице разрешена одна открытая заявка НА ВИД
     * (Р21, миграция 0177), поэтому каждая следующая заводится после закрытия предыдущей.
     */
    const request = async (
      tag: string,
      description: string,
      kind: 'repair' | 'consumable' = 'repair',
    ): Promise<ServiceRequestDto> => {
      const row = await createRequest(ctx.unitId, description, kind);
      ctx.requests.set(tag, row);
      return row;
    };

    const cancelled = await request('cancelled', 'Не включается — оказалось, не наш аппарат');
    await db.execute(sql`
      UPDATE service_requests
         SET status = 'cancelled', rejection_resolution = 'Ремонт нецелесообразен'
       WHERE id = ${cancelled.id}`);

    const replacement = await request('replacement', 'Печатает полосами, барабан изношен');
    await db.execute(sql`
      UPDATE service_requests
         SET status = 'cancelled', rejection_resolution = 'Меняем аппарат',
             replacement_recommended = true
       WHERE id = ${replacement.id}`);

    const warranty = await request('warranty', 'Повторная поломка по гарантии поставщика');
    await db.execute(sql`
      UPDATE service_requests
         SET status = 'accepted', warranty_claim_source = 'equipment',
             service_counterparty_id = ${ctx.serviceCounterpartyId}
       WHERE id = ${warranty.id}`);

    const accepted = await request('accepted', 'Замена ролика подачи и чистка узла');
    await db.execute(sql`
      UPDATE service_requests
         SET status = 'accepted', final_total_amount = ${ACT_AMOUNT},
             service_counterparty_id = ${ctx.serviceCounterpartyId}
       WHERE id = ${accepted.id}`);
    // Две гарантии: действующая и истёкшая. Блок обязан показать первую и промолчать о второй —
    // «до какого числа обещали» и «когда-то обещали» это разные утверждения (Р6, К5).
    await db.execute(sql`
      INSERT INTO service_request_items
        (request_id, kind, name, unit_price, performed, warranty_until, sort_order)
      VALUES (${accepted.id}, 'part', 'Ролик подачи', 1800, true, CURRENT_DATE + 30, 10),
             (${accepted.id}, 'part', 'Тормозная площадка', 900, true, CURRENT_DATE - 30, 20)`);

    const awaiting = await request('awaiting', 'Заменили термоузел, ждём приёмки');
    await db.execute(sql`
      UPDATE service_requests
         SET status = 'done', service_counterparty_id = ${ctx.serviceCounterpartyId}
       WHERE id = ${awaiting.id}`);

    // Расходники открыты одновременно с открытым ремонтом: правило «одна открытая» считает по виду.
    await request('open', 'Закончился тонер', 'consumable');

    const otherRequest = await createRequest(ctx.otherUnitId, 'Заявка по соседнему аппарату');
    ctx.otherUnitRequestId = otherRequest.id;

    // ── Фикстура: правки карточки ──

    const patch = async (unitId: string, body: Record<string, unknown>): Promise<void> => {
      const res = await inject('PATCH', `${EQUIPMENT}/${unitId}`, ctx.operator.auth, body);
      expect(res.statusCode, res.body).toBe(200);
    };
    await patch(ctx.unitId, { comment: 'Стоит у окна' });
    await patch(ctx.unitId, { comment: 'Переставили к двери' });
    await patch(ctx.unitId, { serialNumber: `SN-${RUN}` });
    await patch(ctx.unitId, { purchasedOn: '2024-01-15' });
    // Гарантия поставщика в ленте — своё событие, а в блоке правок — строка `changes` (Р3, Н7).
    await patch(ctx.unitId, { warrantyUntil: '2027-03-01' });
    // Правка, ничего не изменившая: аудит её пишет, а диффа у неё нет — та самая строка «без
    // подробностей» (Н5). Естественный источник таких записей — код до появления
    // `officeEquipmentDiff`, но получается она и сегодня, пустым телом.
    await patch(ctx.unitId, {});

    await patch(ctx.tieUnitId, { comment: 'Первая правка' });
    await patch(ctx.tieUnitId, { comment: 'Вторая правка' });
    /*
     * Ничья по времени — руками: две правки, сделанные в одну секунду, в жизни бывают (импорт,
     * пакетное действие), а вот подстроить их обращением к ручке нельзя. Порядок обязан оставаться
     * одним и тем же при каждом чтении, и держит его `id` вторым ключом (Н8, Р8).
     */
    await ctx.db.execute(sql`
      UPDATE audit_log SET created_at = timestamptz '2026-09-01 10:00:00+03'
       WHERE entity_type = 'officeEquipment' AND entity_id = ${ctx.tieUnitId}
         AND action = 'officeEquipment.update'`);

    // ── Фикстура: перемещения ──
    //
    // Все шесть — внутри площадки A: у объектной роли карточка, уехавшая на соседний объект,
    // выпадает из области, и блоки стали бы недоступны тому, кто их читает.
    for (let i = 1; i <= 6; i += 1) {
      const res = await inject('POST', `${EQUIPMENT}/${ctx.unitId}/move`, ctx.operator.auth, {
        objectId: ctx.objectA,
        location: `кабинет 20${i}`,
        movedOn: `2026-08-0${i}`,
        reason: `Переезд ${i}`,
      });
      expect(res.statusCode, res.body).toBe(201);
    }
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

  // ── 1. ГЛАВНЫЙ СЛУЧАЙ: область не расширилась ни на строку (тест 1, критерий К3) ──

  describe('множество заявок блока = множеству ленты = множеству реестра', () => {
    const subjects: { name: string; auth: () => Auth; expected: () => string[] }[] = [
      {
        name: 'ведение справочника (объектная область площадки)',
        auth: () => ctx.operator.auth,
        expected: () => [...ctx.requests.values()].map((r) => r.id),
      },
      {
        name: 'заказчик той же площадки',
        auth: () => ctx.requester.auth,
        expected: () => [...ctx.requests.values()].map((r) => r.id),
      },
      {
        name: 'ИТ-служба (сквозная область модуля с чужой площадки)',
        auth: () => ctx.itApprover.auth,
        expected: () => [...ctx.requests.values()].map((r) => r.id),
      },
      {
        name: 'подрядчик: только назначенные ему',
        auth: () => ctx.contractor.auth,
        expected: () =>
          ['warranty', 'accepted', 'awaiting'].map((tag) => ctx.requests.get(tag)!.id),
      },
    ];

    for (const subject of subjects) {
      it(`${subject.name}`, async () => {
        const auth = subject.auth();
        const block = idsOf(await walkRequests(auth));
        const feed = await feedRequestIds(auth);
        const registry = await registryIds(auth);

        expect(sorted(block)).toEqual(sorted(subject.expected()));
        // Лента прочитана НЕ одной страницей: одна страница доказывала бы выборку, а не пагинацию.
        expect(feed.pages).toBeGreaterThan(1);
        // Три места, три предиката — один ответ. Разойдись они, блок стал бы обходным путём к
        // чужим ремонтам через справочник, открытый почти каждой роли портала.
        expect(sorted(feed.ids)).toEqual(sorted(block));
        expect(sorted(registry)).toEqual(sorted(block));
      });
    }

    it('мелкой страницей лента заявки ТЕРЯЕТ, а блок — нет (предел на источник, Н3, Р9)', async () => {
      /*
       * НАХОДКА, а не оформление известного. План числит за лентой находку Н3 — «ключевые шаги
       * режутся общим пределом на источник» — и считает её терпимой: «следующая страница дочитает».
       * Не дочитает. `loadEquipmentHistoryPage` применяет `pageSize + 1` к КАЖДОМУ источнику до
       * отсечения курсором и делает это заново на каждой странице, а `visibleRequests` берёт всегда
       * самые свежие строки и курсора не знает вовсе. Значит потолок «сколько заявок лента покажет
       * за всю пагинацию» равен `pageSize + 1` — и то же верно для перемещений и правок карточки.
       *
       * Именно поэтому §10.1 (тест 1) сравнивает множества при странице, накрывающей всю фикстуру:
       * при мелкой равенство недостижимо не из-за области, а из-за устройства ленты. Блок этим не
       * болеет — у него свой предел на свою таблицу (Р9), и это тот самый выигрыш, ради которого
       * блоки и заведены.
       */
      const block = idsOf(await walkRequests(ctx.operator.auth));
      expect(block.size).toBe(6);

      const small = await feedRequestIds(ctx.operator.auth, 2);
      expect(small.pages).toBeGreaterThan(3);
      // Сколько бы страниц ни пролистали — не больше `pageSize + 1` заявок.
      expect(small.ids.size).toBeLessThanOrEqual(3);
      expect(small.ids.size).toBeLessThan(block.size);
    });

    it('блок живёт внутри одной единицы: заявка соседнего аппарата в него не попадает', async () => {
      const block = idsOf(await walkRequests(ctx.operator.auth));
      expect(block.has(ctx.otherUnitRequestId)).toBe(false);
      // А в реестре без фильтра по технике она есть — то есть дело не в области, а в предмете.
      const all = await inject('GET', `${REQUESTS}?pageSize=200`, ctx.operator.auth);
      expect(all.statusCode, all.body).toBe(200);
      expect((all.json() as { items: ServiceRequestDto[] }).items.map((r) => r.id)).toContain(
        ctx.otherUnitRequestId,
      );
    });
  });

  // ── 2. Смотрящий без права модуля заявок (тест 2, Р1, Р11) ──

  describe('без права `serviceRequests.read`', () => {
    it('блок заявок закрыт, правки и перемещения работают, лента без ремонтной части', async () => {
      const denied = await inject('GET', `${EQUIPMENT}/${ctx.unitId}/requests`, ctx.keeper.auth);
      // 403, а не пустая страница: право решает судьбу целой вкладки, и объяснять внутри ответа
      // нечего — портал вкладки не показывает вовсе.
      expect(denied.statusCode, denied.body).toBe(403);

      expect((await changesPage(ctx.keeper.auth, '?pageSize=100')).items.length).toBe(6);
      expect((await movementsPage(ctx.keeper.auth, '?pageSize=100')).items.length).toBe(6);

      const feed = await inject(
        'GET',
        `${EQUIPMENT}/${ctx.unitId}/history?pageSize=100`,
        ctx.keeper.auth,
      );
      expect(feed.statusCode, feed.body).toBe(200);
      const page = feed.json() as EquipmentHistoryPageDto;
      expect(page.serviceVisible).toBe(false);
      expect(page.items.map((e) => e.kind)).not.toContain('service_request');
      expect(page.items.map((e) => e.kind)).toContain('movement');
    });

    it('поставочный подрядчик до блоков не доходит вовсе: справочник ему закрыт', async () => {
      /*
       * Строка §10.1 «для трёх ролей и подрядчика» выполнима только с оговоркой, и вот она: у
       * подрядчика по поставке нет `officeEquipment.read` (`COUNTERPARTY_TYPE_PERMISSIONS.service`),
       * поэтому ни один из трёх блоков и ни лента ему не открываются — сравнивать множества не с
       * чем. Случай выше сравнивает их у подрядчика, которому справочник выдали отдельным набором:
       * это и есть проверка того, что блок не расширяет область, когда дверь открывается.
       */
      for (const path of ['requests', 'changes', 'movements', 'history']) {
        const res = await inject(
          'GET',
          `${EQUIPMENT}/${ctx.unitId}/${path}`,
          ctx.contractorPlain.auth,
        );
        expect(res.statusCode, `${path}: ${res.body}`).toBe(403);
      }
    });
  });

  // ── 3. Пагинация на каждом блоке (тест 3, Р8, Р9) ──

  describe('три страницы по две строки', () => {
    /** Общий проход: три страницы, шесть разных строк, курсор на последней пуст. */
    async function paginate(
      read: (
        query: string,
      ) => Promise<{ items: { id: string }[]; hasMore: boolean; nextCursor: string | null }>,
    ): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 1; page <= 3; page += 1) {
        const got = await read(
          `?pageSize=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        expect(got.items, `страница ${page}`).toHaveLength(2);
        expect(got.hasMore, `страница ${page}`).toBe(page < 3);
        seen.push(...got.items.map((row) => row.id));
        cursor = got.nextCursor;
        if (page < 3) expect(cursor, `страница ${page}`).not.toBeNull();
      }
      // Ни повторов, ни пропусков: шесть строк — шесть разных идентификаторов, и дальше пусто.
      expect(new Set(seen).size).toBe(6);
      expect(cursor).toBeNull();
      return seen;
    }

    it('блок «Связанные заявки»', async () => {
      const seen = await paginate((query) => requestsPage(ctx.operator.auth, query));
      expect(sorted(seen)).toEqual(sorted([...ctx.requests.values()].map((r) => r.id)));
    });

    it('блок «Ручные правки»', async () => {
      const seen = await paginate((query) => changesPage(ctx.operator.auth, query));
      const whole = await changesPage(ctx.operator.auth, '?pageSize=100');
      // Порядок страниц совпадает с порядком цельной выдачи — курсор не переставляет строки.
      expect(seen).toEqual(whole.items.map((row) => row.id));
    });

    it('блок «Перемещения»', async () => {
      const seen = await paginate((query) => movementsPage(ctx.operator.auth, query));
      const whole = await movementsPage(ctx.operator.auth, '?pageSize=100');
      expect(seen).toEqual(whole.items.map((row) => row.id));
      // Ключ порядка у перемещений тройной: дата переезда, время записи, `id` (Р8).
      expect(whole.items.map((row) => row.movedOn)).toEqual([
        '2026-08-06',
        '2026-08-05',
        '2026-08-04',
        '2026-08-03',
        '2026-08-02',
        '2026-08-01',
      ]);
    });
  });

  // ── 4. Детерминированный порядок при равных отметках (тест 4, Н8) ──

  it('две правки одной секундой приходят в одном и том же порядке', async () => {
    const first = await changesPage(ctx.operator.auth, '?pageSize=100', ctx.tieUnitId);
    const second = await changesPage(ctx.operator.auth, '?pageSize=100', ctx.tieUnitId);
    expect(first.items).toHaveLength(2);
    expect(first.items.map((row) => row.at)).toEqual([first.items[1]!.at, first.items[0]!.at]);
    // Повтор запроса даёт тот же порядок: ничью разрывает `id`, а не порядок чтения.
    expect(second.items.map((row) => row.id)).toEqual(first.items.map((row) => row.id));
    // И разрывает её именно `id` по убыванию — то же, чем упорядочен ключ курсора.
    expect(first.items.map((row) => row.id)).toEqual(
      [...first.items.map((row) => row.id)].sort().reverse(),
    );

    // Страницами — тот же порядок: иначе «показать ещё» повторяло бы строку.
    const page = await changesPage(ctx.operator.auth, '?pageSize=1', ctx.tieUnitId);
    expect(page.items[0]!.id).toBe(first.items[0]!.id);
    const next = await changesPage(
      ctx.operator.auth,
      `?pageSize=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
      ctx.tieUnitId,
    );
    expect(next.items[0]!.id).toBe(first.items[1]!.id);
  });

  // ── 5. Гарантии строки заявки (тест 6, Р6, К5) ──

  it('в строке заявки только ДЕЙСТВУЮЩИЕ гарантии', async () => {
    const rows = await walkRequests(ctx.operator.auth);
    const row = rows.find((item) => item.id === ctx.requests.get('accepted')!.id)!;
    expect(row.warranties.map((w) => w.name)).toEqual(['Ролик подачи']);
    // Истёкшая — уже история, и её место в «Полной истории» отдельным событием, а не в строке
    // заявки: строка прошлого не восстанавливает.
    expect(row.warranties.map((w) => w.name)).not.toContain('Тормозная площадка');
  });

  // ── 6. Итог заявки — нефинансовым кодом (тест 7, Р2, Н12) ──

  it('четыре разных `outcome` и словарные подписи без единой цифры', async () => {
    const rows = await walkRequests(ctx.operator.auth);
    const codeOf = (tag: string): string =>
      rows.find((row) => row.id === ctx.requests.get(tag)!.id)!.outcome.code;

    expect(codeOf('cancelled')).toBe('cancelled');
    // Приоритет ветвей значим: отменённая с рекомендацией замены отвечает «Рекомендована замена».
    expect(codeOf('replacement')).toBe('replacement_recommended');
    expect(codeOf('warranty')).toBe('warranty_repair');
    expect(codeOf('accepted')).toBe('accepted');
    // Ещё два исхода того же словаря — «Выполнена» это не итог, а ожидание приёмки.
    expect(codeOf('awaiting')).toBe('awaiting_acceptance');
    expect(codeOf('open')).toBe('open');

    for (const row of rows) {
      expect(row.outcome.label).toBe(equipmentRequestOutcomeLabels[row.outcome.code]);
      // Ни суммы, ни валюты: подпись приходит в одной строке со скрытой суммой (Н12).
      expect(row.outcome.label).not.toMatch(/[0-9₽]|руб/i);
    }
  });

  // ── 7. Деньги по аудитории строки (тест 8, Р5) ──

  it('сумма акта скрыта у заказчика и открыта назначенному исполнителю', async () => {
    const acceptedId = ctx.requests.get('accepted')!.id;
    const amountFor = async (auth: Auth): Promise<number | null> => {
      const rows = await walkRequests(auth);
      return rows.find((row) => row.id === acceptedId)!.totalAmount;
    };

    // Заказчику деньги не положены — та же проекция, что вычистила их из карточки заявки.
    expect(await amountFor(ctx.requester.auth)).toBeNull();
    // Подрядчику, которому заявка назначена, — положены: это его собственный счёт.
    expect(await amountFor(ctx.contractor.auth)).toBe(ACT_AMOUNT);
    // «Ведению» — правом `serviceRequests.finance`, а не назначением.
    expect(await amountFor(ctx.operator.auth)).toBe(ACT_AMOUNT);

    // Скрытая сумма не просачивается в остальные поля строки: итог остаётся нефинансовым.
    const requesterRows = await walkRequests(ctx.requester.auth);
    const row = requesterRows.find((item) => item.id === acceptedId)!;
    expect(JSON.stringify(row)).not.toContain(String(ACT_AMOUNT));
  });

  // ── 8. Правка без диффа (тест 9, Н5) ──

  it('правка без подробностей приходит строкой, а не пропадает', async () => {
    const page = await changesPage(ctx.operator.auth, '?pageSize=100');
    expect(page.items).toHaveLength(6);

    const empty = page.items.filter((row: EquipmentChangeRowDto) => row.changes.length === 0);
    expect(empty).toHaveLength(1);
    // Автор и дата у неё есть — прячется только «что именно»: «правок не было» и «правки были, но
    // подробностей не сохранилось» это разные утверждения, и первое было бы неправдой. Подпись
    // строки (`EQUIPMENT_CHANGE_NO_DETAILS_LABEL`) рисует портал: в DTO её нет и быть не должно.
    expect(empty[0]!.actorName).toBeTruthy();
    expect(empty[0]!.at).toBeTruthy();

    // Гарантия поставщика приведена к общей форме и стоит строкой блока (Р3, закрывает Н7).
    const fields = page.items.flatMap((row) => row.changes.map((c) => c.field));
    expect(fields).toContain(EQUIPMENT_WARRANTY_CHANGE_FIELD);
    expect(fields).toContain('comment');
  });

  // ── 9. Чужой курсор (тест 12, Р8) ──

  describe('чужой курсор', () => {
    it('курсор ленты не читается ни одним блоком', async () => {
      const feed = await inject(
        'GET',
        `${EQUIPMENT}/${ctx.unitId}/history?pageSize=1`,
        ctx.operator.auth,
      );
      expect(feed.statusCode, feed.body).toBe(200);
      const cursor = (feed.json() as EquipmentHistoryPageDto).nextCursor!;
      expect(cursor).toBeTruthy();

      for (const path of ['requests', 'changes', 'movements']) {
        const res = await inject(
          'GET',
          `${EQUIPMENT}/${ctx.unitId}/${path}?cursor=${encodeURIComponent(cursor)}`,
          ctx.operator.auth,
        );
        // Отказ словами, а не молчаливая первая страница: ссылка устарела — это разные ответы.
        expect(res.statusCode, `${path}: ${res.body}`).toBe(422);
        expect(res.json().message).toContain('не читается');
      }
    });

    it('курсор соседнего блока и неизвестная версия — тоже 422', async () => {
      const requests = await requestsPage(ctx.operator.auth, '?pageSize=1');
      const changes = await changesPage(ctx.operator.auth, '?pageSize=1');
      const movements = await movementsPage(ctx.operator.auth, '?pageSize=1');

      /*
       * У заявок и правок ключ одинаков ПО ФОРМЕ — «отметка времени плюс uuid», — и без метки блока
       * курсор одной вкладки молча открыл бы другую с середины. Отсюда и проверка крест-накрест.
       */
      const foreign: [string, string][] = [
        ['requests', changes.nextCursor!],
        ['requests', movements.nextCursor!],
        ['changes', requests.nextCursor!],
        ['changes', movements.nextCursor!],
        ['movements', requests.nextCursor!],
        ['movements', changes.nextCursor!],
      ];
      for (const [path, cursor] of foreign) {
        const res = await inject(
          'GET',
          `${EQUIPMENT}/${ctx.unitId}/${path}?cursor=${encodeURIComponent(cursor)}`,
          ctx.operator.auth,
        );
        expect(res.statusCode, `${path} ← ${cursor}: ${res.body}`).toBe(422);
      }

      // Версия — часть схемы курсора, а не проверка в коде: чужая отбивается тем же отказом.
      const bumped = requests.nextCursor!.replace(/^1~/, '9~');
      const res = await inject(
        'GET',
        `${EQUIPMENT}/${ctx.unitId}/requests?cursor=${encodeURIComponent(bumped)}`,
        ctx.operator.auth,
      );
      expect(res.statusCode, res.body).toBe(422);
    });
  });

  // ── 10. Бюджет запросов на страницу (тест 11, Р10, К8) ──

  describe('бюджет запросов: страница не дорожает от строк', () => {
    /** Двадцать строк — вторая точка замера из §10.1; первая точка та же выборка при `pageSize=1`. */
    const BULK_ROWS = 20;

    /**
     * Отдельная единица под замер, и это не чистота фикстуры ради самой себя: вопрос Р10 звучит
     * «растёт ли число запросов вместе со строками», а ответ на него даёт ОДНА выборка, прочитанная
     * дважды — одной строкой и двадцатью. Те же данные, тот же читатель, тот же (пустой) курсор:
     * разойдись числа — разойтись им будет не от чего, кроме строк.
     */
    let bulkUnitId = '';
    let blocks: typeof import('../src/services/office-equipment-blocks');
    /** Право `serviceRequests.execute` есть у администратора — он платит все пять запросов. */
    let adminPrincipal: Principal;
    /** У «ведения справочника» права исполнения нет: аудитория ему в базу не ходит вовсе. */
    let operatorPrincipal: Principal;

    beforeAll(async () => {
      blocks = await import('../src/services/office-equipment-blocks');
      /*
       * Сервис зовётся НАПРЯМУЮ, а не через `inject`, и это и есть предмет Р10: решение писалось
       * про страницу блока, а ручка вокруг неё делает свою работу — читает принципала и карточку
       * ради области. Меряя ручку, мы записали бы в бюджет страницы то, что от неё не зависит;
       * отдельный случай ниже эти два запроса и называет.
       */
      const { loadPrincipal } = await import('../src/auth/principal');
      const [asAdmin, asOperator] = await Promise.all([
        loadPrincipal(ctx.admin.id),
        loadPrincipal(ctx.operator.id),
      ]);
      if (!asAdmin || !asOperator) throw new Error('Принципал не прочитан: сцена собрана неверно');
      adminPrincipal = asAdmin;
      operatorPrincipal = asOperator;

      const created = await inject('POST', EQUIPMENT, ctx.operator.auth, {
        equipmentTypeId: ctx.typeId,
        name: `Kyocera ECOSYS bulk ${RUN}`,
        inventoryNumber: `HB-${RUN}-bulk`,
        objectId: ctx.objectA,
        location: 'кабинет 300',
      });
      expect(created.statusCode, created.body).toBe(201);
      bulkUnitId = (created.json() as { id: string }).id;

      for (let i = 1; i <= BULK_ROWS; i += 1) {
        const res = await inject('POST', REQUESTS, ctx.operator.auth, {
          officeEquipmentId: bulkUnitId,
          description: `Заявка ${i} под замер бюджета`,
          kind: 'repair',
          responsibleName: 'Иванов Иван Иванович',
          responsiblePhone: '+79990000000',
        });
        expect(res.statusCode, res.body).toBe(201);
        const { request } = res.json() as { request: ServiceRequestDto };
        // Каждая закрывается сразу: по единице разрешена одна открытая заявка НА ВИД (Р21, миграция
        // 0177), а замеру нужны двадцать строк, а не двадцать способов их не завести.
        await ctx.db.execute(sql`
          UPDATE service_requests
             SET status = 'cancelled', rejection_resolution = 'Строка замера'
           WHERE id = ${request.id}`);
      }
    }, 300_000);

    it('страница заявок: не больше пяти запросов, и число не растёт со строками', async () => {
      const measure = (pageSize: number) =>
        countSql(() =>
          blocks.loadEquipmentRequestsPage(
            adminPrincipal,
            { id: bulkUnitId, objectId: ctx.objectA },
            { cursor: null, pageSize },
          ),
        );
      const one = await measure(1);
      const twenty = await measure(BULK_ROWS);

      expect(one.value.items).toHaveLength(1);
      expect(twenty.value.items).toHaveLength(BULK_ROWS);

      // Потолок Р10 и К8 — на обеих страницах.
      expect(one.sql.length, one.sql.join('\n')).toBeLessThanOrEqual(5);
      expect(twenty.sql.length, twenty.sql.join('\n')).toBeLessThanOrEqual(5);
      /*
       * И ГЛАВНОЕ: двадцать строк стоят ровно столько же, сколько одна. Потолок сам по себе `N+1` не
       * ловит — страница в одну строку укладывается в него и при походе за каждой, — а вот
       * равенство ловит: догрузка на строку дала бы здесь 5 против 24, и краснело бы это на любой
       * машине, без единой отметки времени в проверке.
       */
      expect(twenty.sql.length, twenty.sql.join('\n')).toBe(one.sql.length);
    });

    it('пятый запрос платит только читатель с правом исполнения', async () => {
      const forReader = (p: Principal) =>
        countSql(() =>
          blocks.loadEquipmentRequestsPage(
            p,
            { id: bulkUnitId, objectId: ctx.objectA },
            { cursor: null, pageSize: BULK_ROWS },
          ),
        );
      const asAdmin = await forReader(adminPrincipal);
      const asOperator = await forReader(operatorPrincipal);

      expect(asAdmin.value.items).toHaveLength(BULK_ROWS);
      expect(asOperator.value.items).toHaveLength(BULK_ROWS);

      /*
       * Числа названы ТОЧНО, а не «не больше», и вот зачем. Пятёрка Р10 — это потолок, который
       * платит не всякий: аудитория (`serviceAudienceByRequest`) не ходит в базу без
       * `serviceRequests.execute`, и у «ведения справочника» страница стоит четырёх. Ровно на этом
       * месте план и комментарий сервиса разошлись: четвёртой догрузкой была аудитория, а пятая —
       * подтверждения заявленного места — пришла позже соседней работой, и потолок стал пятью.
       * Появится шестая — красным станет этот случай, а не рассуждение в чьей-нибудь голове.
       */
      expect(asAdmin.sql, asAdmin.sql.join('\n')).toHaveLength(5);
      expect(asOperator.sql, asOperator.sql.join('\n')).toHaveLength(4);
    });

    it('пустая страница в базу за догрузками не идёт вовсе', async () => {
      const empty = await countSql(() =>
        blocks.loadEquipmentRequestsPage(
          adminPrincipal,
          // У единицы случая 4 есть правки карточки и ни одной заявки — то есть блок пуст, а сама
          // карточка жива: пустота здесь не следствие отказа в области.
          { id: ctx.tieUnitId, objectId: ctx.objectA },
          { cursor: null, pageSize: BULK_ROWS },
        ),
      );
      expect(empty.value.items).toHaveLength(0);
      // Один запрос — сама страница. Все четыре догрузки видят пустой список идентификаторов и
      // возвращают пустые карты, не притрагиваясь к базе: иначе пустой блок стоил бы пяти запросов
      // ради четырёх заведомо пустых ответов, а пустых блоков в справочнике большинство.
      expect(empty.sql, empty.sql.join('\n')).toHaveLength(1);
    });

    it('блоки правок и перемещений стоят одного запроса каждый', async () => {
      const changes = await countSql(() =>
        blocks.loadEquipmentChangesPage(ctx.unitId, { cursor: null, pageSize: 100 }),
      );
      const movements = await countSql(() =>
        blocks.loadEquipmentMovementsPage(ctx.unitId, { cursor: null, pageSize: 100 }),
      );

      expect(changes.value.items).toHaveLength(6);
      expect(movements.value.items).toHaveLength(6);
      // Догрузок у этих двух нет ни одной: автора правки, обе площадки, оба отдела и номер заявки
      // отдают соединения, и каждое из них — по одной строке на запись. Шесть строк стоят здесь
      // ровно столько же, сколько ноль.
      expect(changes.sql, changes.sql.join('\n')).toHaveLength(1);
      expect(movements.sql, movements.sql.join('\n')).toHaveLength(1);
    });

    it('ручка дороже страницы на два запроса, и ни один из них не про строки', async () => {
      const service = await countSql(() =>
        blocks.loadEquipmentRequestsPage(
          adminPrincipal,
          { id: bulkUnitId, objectId: ctx.objectA },
          { cursor: null, pageSize: BULK_ROWS },
        ),
      );
      const http = await countSql(async () => {
        const res = await inject(
          'GET',
          `${EQUIPMENT}/${bulkUnitId}/requests?pageSize=${BULK_ROWS}`,
          ctx.admin.auth,
        );
        expect(res.statusCode, res.body).toBe(200);
        return res.json() as EquipmentRequestsPageDto;
      });

      expect(http.value.items).toHaveLength(service.value.items.length);
      /*
       * ЧТО НЕ ВХОДИТ В БЮДЖЕТ Р10 и почему это честно. Обращение к ручке стоит на два выражения
       * больше страницы: страж читает принципала (`loadPrincipal`), а обработчик — карточку ради
       * ОБЛАСТИ (`requireHistoryEquipment`). Оба — цена входа, а не цена страницы: они одинаковы
       * при одной строке и при двадцати, повторяются на каждой ручке модуля и от предмета Р10
       * («не появилось ли похода в базу на строку») не зависят. Записывать их в бюджет блока
       * значило бы мерить бюджетом страницы работу аутентификации; молчать о них — обещать
       * шестью запросами то, что стоит семи. Поэтому они названы здесь поимённо и посчитаны.
       */
      expect(http.sql.length, http.sql.join('\n')).toBe(service.sql.length + 2);
      expect(http.sql[0]).toContain('"users"');
      expect(http.sql[1]).toContain('"office_equipment"');
    });
  });
});
