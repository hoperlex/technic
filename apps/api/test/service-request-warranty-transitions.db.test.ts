import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  warrantyToday,
  type ServiceRequestDto,
  type ServiceRequestItemDto,
  type ServiceWarrantyRowDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * ГАРАНТИИ В ПЕРЕХОДАХ ЗАЯВКИ — ЭТАП Э1 плана
 * `docs/office-equipment-warranty-completion-plan.md` (§4.2, §8.1, критерий К2).
 *
 * ЗАЧЕМ ФАЙЛ. Гарантии модуля реализованы шире, чем описаны: правила разложены по ADR 0085 (Р12,
 * Р26, Р27), по матрице сбросов контрактов (`serviceResetOnTransition`) и по трём ручкам маршрута,
 * а отдельного ADR у них нет. Э1 требует зафиксировать СЕГОДНЯШНЕЕ поведение тестами **до** правок
 * Э2–Э5 — чтобы ручка исправления даты (Р1), потолок реестра (Р6) и предупреждения окна закрытия
 * (Р4, Р5) не поменяли молча то, о чём никто не договаривался. Поэтому здесь нет ни одного
 * утверждения «как должно быть»: каждый случай записывает то, что код делает сегодня, а расхождения
 * с планом названы комментарием на месте.
 *
 * ЧТО ИМЕННО ЗАКРЕПЛЕНО — шесть переходов §4.2 плюс границы дат §4.1:
 *
 *   1. закрытие работ БЕЗ талона: дата гарантии = «дата выполнения + `warranty_months`»,
 *      `warranty_until_manual = false`; обещанных месяцев нет — даты тоже нет;
 *   2. закрытие С талоном: дата из талона побеждает расчёт и помечается ручной; дата раньше даты
 *      выполнения и дата на невыполненной строке отбиваются `422`;
 *   3. возврат на доработку (`done → in_work`) снимает факт и гарантии ВСЕХ строк и пишет снимок
 *      `clearedWarranties` в аудит; повторное закрытие выставляет даты заново — и дату из талона
 *      приходится присылать заново, потому что хранить её негде;
 *   4. административный откат (`PATCH /:id/status`, `done → in_work`) делает ровно то же самое —
 *      второй путь к той же очистке;
 *   5. переназначение из «В работе» (`in_work → new`) смету и `warranty_months` СОХРАНЯЕТ — но
 *      только пока заявка не сменила рук; смена подрядчика смету сносит (расхождение с Н10, см.
 *      комментарий случая);
 *   6. отмена и возврат отменённой в «Новую»: смета с обещанными месяцами переживает ОТМЕНУ и
 *      умирает на возврате (расхождение с формулировкой §4.2, см. комментарий случая);
 *   7. границы дат: «до сегодня» — гарантия ещё действует, «до вчера» — истекла; сутки московские
 *      (`warrantyToday`).
 *
 * ЗАЧЕМ БАЗА, А НЕ КОНТРАКТНЫЙ ТЕСТ. Проверяемое живёт не в одной функции: дату пишет закрытие
 * работ, снимает — общий помощник перехода по матрице контрактов, снимок кладёт аудит вызывающей
 * ручки, а «гарантии у невыполненной строки не бывает» держит CHECK базы. Матрицу сбросов юнит-тесты
 * и так читают; здесь проверяется, что ручки её ЗОВУТ и что база принимает то, что получилось.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test` (образец — `service-request-equipment-warranty.db.test.ts`):
 * случай 7 смотрит на выдачу реестра гарантий, а по общей базе идут параллельные прогоны и лежит
 * копия боевого парка. База заводится, мигрируется с нуля и сносится в `afterAll`.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     pnpm --filter @technic/api exec vitest run test/service-request-warranty-transitions.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_warranty_transitions_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-warranty-transitions-password-123';
const REQUESTS = '/api/v1/service-requests';
const EQUIPMENT = '/api/v1/office-equipment';

/** День закрытия работ — сегодня по Москве: от него сервер отсчитывает гарантии строк (§4.1). */
const TODAY = warrantyToday();

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
  /** Администратор: только он ходит откатами (`requests.rollbackStatus` + `serviceRequests.status`). */
  admin: TestUser;
  /**
   * «Ведение» модуля: заводит технику и заявку, назначает исполнителя, согласует объём работ,
   * возвращает на доработку, отменяет и принимает работу. Он же читатель карточек — набор
   * `office_equipment_operator` несёт `serviceRequests.finance`, то есть аудиторию `finance`
   * (ADR 0160); заявителю строки объёма работ не приходят вовсе, и проверять гарантии по нему было
   * бы нечем.
   */
  operator: TestUser;
  /** Сервисная компания: её ходы — «принять в работу», объём работ и закрытие работ. */
  service: TestUser;
  serviceCounterpartyId: string;
  /** Второй подрядчик: им и только им проверяется смена рук в случае 5. */
  otherServiceCounterpartyId: string;
  objectId: string;
  typeId: string;
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
  // S3 здесь не участвует: закрывающий акт подшивается уже загруженной строкой `files`.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  // Письма переходов гасятся рубильником: предмет файла — даты гарантий, а не почтовый контур.
  process.env.MAIL_ENABLED ??= 'false';
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/**
 * «Дата плюс N месяцев» календарём — ожидаемое значение гарантии, посчитанное независимо от
 * сервера (та же подрезка конца месяца, что в `addMonths` маршрута): 31 января плюс месяц — это
 * 28 (29) февраля, иначе гарантия уехала бы в март.
 */
function plusMonths(dateKey: string, months: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1 + months, d!));
  if (at.getUTCDate() !== d) at.setUTCDate(0);
  return at.toISOString().slice(0, 10);
}

/** «Дата плюс N дней»: границы §4.1 считаются сутками, а не месяцами. */
function plusDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** Десятизначный ИНН с настоящей контрольной суммой: портал проверяет её при заведении. */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
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

/** Карточка заявки; читатель по умолчанию — «Ведение»: у него аудитория `finance` (ADR 0160). */
async function card(id: string, auth: Auth = ctx.operator.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

/** Текущая версия заявки: её спрашивает каждая изменяющая ручка. */
async function version(id: string, auth: Auth = ctx.operator.auth): Promise<number> {
  return (await card(id, auth)).version;
}

function itemNamed(dto: ServiceRequestDto, name: string): ServiceRequestItemDto {
  const item = dto.items.find((row) => row.name === name);
  if (!item) throw new Error(`В объёме работ нет строки «${name}»`);
  return item;
}

/** Последняя запись аудита названного действия по этой заявке. */
async function lastAudit(action: string, requestId: string): Promise<Record<string, unknown>> {
  const res = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM audit_log
     WHERE action = ${action} AND entity_type = 'serviceRequest' AND entity_id = ${requestId}
     ORDER BY created_at DESC
     LIMIT 1`);
  const row = res.rows[0];
  if (!row) throw new Error(`В аудите нет записи «${action}» по заявке ${requestId}`);
  return row.metadata;
}

// ── Подготовка данных: настоящими ручками, кроме двух отмеченных мест ──

/** Своя единица на каждый случай: по технике разрешена одна открытая заявка на ремонт (Р21). */
let unitNo = 0;
async function makeEquipment(tag: string): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', EQUIPMENT, ctx.operator.auth, {
    equipmentTypeId: ctx.typeId,
    name: `Kyocera ECOSYS ${tag} ${RUN}`,
    inventoryNumber: `WT-${RUN}-${unitNo}`,
    objectId: ctx.objectId,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

function createRequest(
  officeEquipmentId: string,
  description: string,
  extra: Record<string, unknown> = {},
) {
  return inject('POST', REQUESTS, ctx.operator.auth, {
    officeEquipmentId,
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    ...extra,
  });
}

/**
 * Загруженный файл строкой в `files`. Первое из двух мест прямого SQL: настоящая загрузка идёт
 * через presign в S3, которого в тесте нет, а предмет проверки — гарантии, а не транспорт.
 */
async function uploadedFile(filename: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`wt/${RUN}/${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            'pending', ${ctx.service.id})
    RETURNING id`);
  return res.rows[0]!.id;
}

/** Акт исполнителя: без закрывающего документа заявку подрядчика в «Решена» не пускают (Н8). */
async function attachAct(id: string): Promise<void> {
  const fileId = await uploadedFile(`akt-${randomUUID()}.pdf`);
  const res = await inject('POST', `${REQUESTS}/${id}/files`, ctx.service.auth, {
    fileIds: [fileId],
    kind: 'act',
  });
  expect(res.statusCode, res.body).toBe(200);
}

interface EstimateLine {
  kind: 'part' | 'service';
  name: string;
  quantity?: number;
  unitPrice: number;
  warrantyMonths?: number | null;
}

/**
 * Заявка, доведённая до «В работе» с СОГЛАСОВАННЫМ объёмом работ и подшитым актом — общий вход всех
 * семи случаев. Одним помощником, а не семью выписанными цепочками: предмет файла начинается с
 * закрытия работ, и повторённый семь раз цикл разъехался бы с первой же правкой соседнего плана.
 */
async function requestReadyToComplete(tag: string, items: EstimateLine[]): Promise<string> {
  const equipmentId = await makeEquipment(tag);
  const created = await createRequest(equipmentId, `Не печатает — случай ${tag}`);
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as { request: ServiceRequestDto }).request.id;

  const assigned = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.operator.auth, {
    userIds: [],
    serviceCounterpartyId: ctx.serviceCounterpartyId,
    version: await version(id),
  });
  expect(assigned.statusCode, assigned.body).toBe(200);

  const started = await inject('PATCH', `${REQUESTS}/${id}/start`, ctx.service.auth, {
    version: (assigned.json() as { request: ServiceRequestDto }).request.version,
  });
  expect(started.statusCode, started.body).toBe(200);

  const put = await inject('PUT', `${REQUESTS}/${id}/estimate`, ctx.service.auth, {
    items,
    version: (started.json() as ServiceRequestDto).version,
  });
  expect(put.statusCode, put.body).toBe(200);
  const submitted = await inject('PATCH', `${REQUESTS}/${id}/estimate/submit`, ctx.service.auth, {
    version: (put.json() as ServiceRequestDto).version,
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  const approved = await inject('PATCH', `${REQUESTS}/${id}/estimate/approval`, ctx.operator.auth, {
    approved: true,
    version: (submitted.json() as ServiceRequestDto).version,
  });
  expect(approved.statusCode, approved.body).toBe(200);

  await attachAct(id);
  return id;
}

/** Факт по строке: что предъявил исполнитель и с какой датой из талона. */
interface Fact {
  name: string;
  performed: boolean;
  warrantyUntil?: string;
}

async function complete(id: string, facts: Fact[], completedOn: string = TODAY) {
  const before = await card(id);
  return inject('PATCH', `${REQUESTS}/${id}/complete`, ctx.service.auth, {
    completedOn,
    items: facts.map((fact) => ({
      id: itemNamed(before, fact.name).id,
      performed: fact.performed,
      ...(fact.warrantyUntil === undefined ? {} : { warrantyUntil: fact.warrantyUntil }),
    })),
    version: before.version,
  });
}

/** Приёмка работы: без неё по гарантии позиции не обращаются (четыре условия Р26). */
async function accept(id: string): Promise<void> {
  const res = await inject('PATCH', `${REQUESTS}/${id}/accept`, ctx.operator.auth, {
    version: await version(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Реестр действующих гарантий — та же ручка, что питает вкладку модуля. */
async function warranties(query = ''): Promise<ServiceWarrantyRowDto[]> {
  const res = await inject('GET', `${REQUESTS}/warranties?pageSize=200${query}`, ctx.operator.auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: ServiceWarrantyRowDto[] }).items;
}

describe.skipIf(!DB_URL)('гарантии в переходах заявки на обслуживание (Э1 плана приёмки)', () => {
  beforeAll(async () => {
    /*
     * СВОЯ БАЗА С НУЛЯ. Первые миграции требуют расширений, которых в свежей базе нет вовсе
     * (`pgcrypto` для `gen_random_uuid`, `citext` для адреса учётки, `pg_trgm` для поиска).
     */
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
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`WT-${RUN}`}, ${`Площадка гарантий ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const digits = String(Date.now()).slice(-6);
    const counterparty = async (name: string, inn: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO counterparties (type, name, inn)
        VALUES ('service'::counterparty_type, ${name}, ${inn})
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const serviceCounterpartyId = await counterparty(
      `Сервис-Гарантия ${RUN}`,
      innOf(`77${digits}0`),
    );
    const otherServiceCounterpartyId = await counterparty(
      `Сервис-Второй ${RUN}`,
      innOf(`77${digits}1`),
    );

    /*
     * Учётки — прямым SQL (второе и последнее место): форма учётки предмет своего теста, а здесь
     * она декорация, без которой не разложить три стороны цикла.
     */
    async function makeUser(
      tag: string,
      role: string,
      counterpartyId?: string,
    ): Promise<{ id: string; email: string }> {
      const email = `db-wt-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now(), ${counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const adminUser = await makeUser('admin', 'admin');
    const operatorUser = await makeUser('oper', 'shtab');
    // Права подрядчика даёт ТИП КОНТРАГЕНТА (ADR 0038), а не роль и не набор: ничего сверх этой
    // строки ему не выдаётся — иначе прогон проверял бы выданное тестом, а не поставочный состав.
    const serviceUser = await makeUser('serv', 'operator', serviceCounterpartyId);

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${operatorUser.id}, ${objectId})`);

    /*
     * Надстройка «Оргтехника: ведение» — сервисом, а не прямой вставкой: с шага 1a перехода на
     * назначаемые полномочия (ADR 0106) выдача пишет две таблицы одной транзакцией, и половина
     * оставила бы оператора без прав ровно там, где они читаются.
     */
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operatorUser.id, ['office_equipment_operator'], adminUser.id);
    });

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
      service: await withAuth(serviceUser),
      serviceCounterpartyId,
      otherServiceCounterpartyId,
      objectId,
      typeId,
    };
  }, 300_000);

  afterAll(async () => {
    // База своя — уносим её целиком: чужих строк в ней нет по построению, а оставленная помешала бы
    // следующему прогону завести её заново.
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

  // ── 1. Закрытие работ без талона: дату считает сервер ──

  describe('закрытие без талона', () => {
    it('дата = «дата выполнения + месяцы», ручной пометки нет; без месяцев даты нет', async () => {
      /*
       * Базовая строка таблицы §4.1: у гарантии результата режим ВЫЧИСЛЯЕМЫЙ по умолчанию.
       * Три строки разом, потому что вместе они разводят три законных исхода закрытия (Р4):
       * «расчёт», «гарантия не указана» и «работа не выполнялась». Порознь первый зеленел бы и
       * тогда, когда сервер ставит дату всякой строке подряд.
       */
      const id = await requestReadyToComplete('calc', [
        { kind: 'part', name: 'Ролик подачи', unitPrice: 1800, warrantyMonths: 6 },
        { kind: 'service', name: 'Чистка узла подачи', unitPrice: 1500 },
        { kind: 'part', name: 'Тормозная площадка', unitPrice: 900, warrantyMonths: 12 },
      ]);
      const res = await complete(id, [
        { name: 'Ролик подачи', performed: true },
        { name: 'Чистка узла подачи', performed: true },
        { name: 'Тормозная площадка', performed: false },
      ]);
      expect(res.statusCode, res.body).toBe(200);
      const dto = res.json() as ServiceRequestDto;
      expect(dto.status).toBe('done');

      // Месяцы календарные, а не по тридцать дней: в талоне срок тоже написан месяцами.
      expect(itemNamed(dto, 'Ролик подачи')).toMatchObject({
        performed: true,
        warrantyMonths: 6,
        warrantyUntil: plusMonths(TODAY, 6),
        warrantyUntilManual: false,
      });
      // «Гарантия не указана» — законный исход (Р4): ни обещанных месяцев, ни талона.
      expect(itemNamed(dto, 'Чистка узла подачи')).toMatchObject({
        performed: true,
        warrantyMonths: null,
        warrantyUntil: null,
        warrantyUntilManual: false,
      });
      // Обещание, не ставшее сроком: работу не делали, и гарантии на неё не бывает (CHECK базы).
      expect(itemNamed(dto, 'Тормозная площадка')).toMatchObject({
        performed: false,
        warrantyMonths: 12,
        warrantyUntil: null,
        warrantyUntilManual: false,
      });

      // Что выдали — снимком в аудите закрытия (Р77): сама строка помнит одно последнее значение.
      const granted = (await lastAudit('serviceRequest.complete', id)).grantedWarranties as {
        name: string;
        warrantyUntil: string;
      }[];
      expect(granted.map((w) => [w.name, w.warrantyUntil])).toEqual([
        ['Ролик подачи', plusMonths(TODAY, 6)],
      ]);
    });

    it('НАХОДКА Н6: база пропускает «выполнено, месяцы обещаны, даты нет» — CHECK’а ещё нет', async () => {
      /*
       * Расхождение кода и инварианта, зафиксированное как есть. Штатная ручка такого состояния не
       * создаёт (случай выше это и проверяет), но CHECK'а из Р4 сегодня не существует, и
       * legacy-данные, импорт или прямой SQL заводят такую строку молча — то есть «обещали и не
       * выдали» в базе возможно, и §6 плана поэтому начинается с разбора данных.
       *
       * Э2 добавляет `service_request_items_warranty_promised_check`, и этот случай обязан
       * покраснеть на `UPDATE` — это его назначение, а не хрупкость: тогда его переписывают на
       * ожидание отказа базы (§8.1, п. 13).
       */
      const id = await requestReadyToComplete('promised', [
        { kind: 'part', name: 'Ролик подачи', unitPrice: 1800, warrantyMonths: 6 },
      ]);
      const closed = await complete(id, [{ name: 'Ролик подачи', performed: true }]);
      expect(closed.statusCode, closed.body).toBe(200);
      const itemId = itemNamed(closed.json() as ServiceRequestDto, 'Ролик подачи').id;

      await ctx.db.execute(sql`
        UPDATE service_request_items SET warranty_until = NULL WHERE id = ${itemId}`);
      const left = await ctx.db.execute<{ warranty_months: number; warranty_until: string | null }>(
        sql`SELECT warranty_months, warranty_until FROM service_request_items WHERE id = ${itemId}`,
      );
      expect(left.rows[0]).toMatchObject({ warranty_months: 6, warranty_until: null });

      // Три CHECK'а гарантии, которые у таблицы есть сегодня, — и обещанного среди них нет.
      const constraints = await ctx.db.execute<{ conname: string }>(sql`
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'service_request_items'::regclass AND conname LIKE '%warranty%'
         ORDER BY conname`);
      expect(constraints.rows.map((r) => r.conname)).toEqual([
        'service_request_items_warranty_manual_check',
        'service_request_items_warranty_months_check',
        'service_request_items_warranty_performed_check',
      ]);
    });
  });

  // ── 2. Закрытие с талоном: бумага побеждает расчёт ──

  describe('закрытие по талону', () => {
    it('дата из талона побеждает расчёт и помечается ручной', async () => {
      /*
       * Строка §4.1 «вычисляемый по умолчанию, ручной перекрывает». У первой позиции месяцы ЕСТЬ, и
       * это половина утверждения: не побеждай талон, дата молча стала бы расчётной — а спор с
       * подрядчиком идёт по бумаге, которой портал в этом случае не поверил бы.
       */
      const id = await requestReadyToComplete('talon', [
        { kind: 'part', name: 'Термоузел', unitPrice: 4400, warrantyMonths: 12 },
        { kind: 'service', name: 'Выезд мастера', unitPrice: 1000 },
      ]);
      const talon = plusMonths(TODAY, 24);
      const res = await complete(id, [
        { name: 'Термоузел', performed: true, warrantyUntil: talon },
        { name: 'Выезд мастера', performed: true, warrantyUntil: plusMonths(TODAY, 1) },
      ]);
      expect(res.statusCode, res.body).toBe(200);
      const dto = res.json() as ServiceRequestDto;

      expect(itemNamed(dto, 'Термоузел')).toMatchObject({
        warrantyMonths: 12,
        warrantyUntil: talon,
        warrantyUntilManual: true,
      });
      // Талон работает и там, где месяцев не обещали вовсе: источник даты — бумага, а не расчёт.
      expect(itemNamed(dto, 'Выезд мастера')).toMatchObject({
        warrantyMonths: null,
        warrantyUntil: plusMonths(TODAY, 1),
        warrantyUntilManual: true,
      });
    });

    it('дата раньше даты выполнения — 422, и закрытие не проходит целиком', async () => {
      /*
       * Граница §4.1 «не раньше даты выполнения»: такая дата — либо опечатка в году, либо чужой
       * талон, и принятая молча она означала бы гарантию, которая «была», но никогда не
       * действовала. Проверяется вместе с тем, что отказ ОТКАТЫВАЕТ ход целиком: гарантия пишется
       * тем же обновлением строки, что и факт, и половинчатое закрытие оставило бы заявку с
       * фактом без даты.
       */
      const id = await requestReadyToComplete('early', [
        { kind: 'part', name: 'Ролик отделения', unitPrice: 1200, warrantyMonths: 3 },
        { kind: 'service', name: 'Диагностика', unitPrice: 500 },
      ]);
      const res = await complete(id, [
        { name: 'Ролик отделения', performed: true, warrantyUntil: plusDays(TODAY, -1) },
        { name: 'Диагностика', performed: true },
      ]);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().message).toContain('раньше даты выполнения');

      const after = await card(id);
      expect(after.status).toBe('in_work');
      for (const item of after.items) {
        expect(item.performed).toBeNull();
        expect(item.warrantyUntil).toBeNull();
      }

      // Соседняя граница той же строки таблицы: гарантия бывает только у ВЫПОЛНЕННОЙ позиции, и
      // отбивает её маршрут — до CHECK'а базы дело не доходит.
      const notPerformed = await complete(id, [
        { name: 'Ролик отделения', performed: false, warrantyUntil: plusMonths(TODAY, 6) },
        { name: 'Диагностика', performed: true },
      ]);
      expect(notPerformed.statusCode, notPerformed.body).toBe(422);
      expect(notPerformed.json().message).toContain('гарантии не бывает');
    });
  });

  // ── 3. Возврат на доработку: первый путь к очистке ──

  describe('возврат на доработку (done → in_work)', () => {
    it('снимает гарантии всех строк, пишет снимок в аудит, повторное закрытие ставит даты заново', async () => {
      /*
       * Главный переход §4.2. Заявка возвращается «как будто не закрывали»: факт, итог и ОБЕ
       * гарантии — посчитанная и введённая руками — снимаются, потому что возврат отменяет само
       * выполнение, а строка без выполнения гарантии не держит. Единственный след прежних дат —
       * снимок `clearedWarranties` в аудите: сама строка своё прошлое не помнит (Р77).
       */
      const id = await requestReadyToComplete('rework', [
        { kind: 'part', name: 'Ролик подачи', unitPrice: 1800, warrantyMonths: 6 },
        { kind: 'part', name: 'Термоузел', unitPrice: 4400 },
      ]);
      const talon = plusMonths(TODAY, 3);
      const closed = await complete(id, [
        { name: 'Ролик подачи', performed: true },
        { name: 'Термоузел', performed: true, warrantyUntil: talon },
      ]);
      expect(closed.statusCode, closed.body).toBe(200);
      const beforeRework = closed.json() as ServiceRequestDto;
      expect(itemNamed(beforeRework, 'Ролик подачи').warrantyUntil).toBe(plusMonths(TODAY, 6));
      expect(itemNamed(beforeRework, 'Термоузел').warrantyUntil).toBe(talon);

      const res = await inject('PATCH', `${REQUESTS}/${id}/rework`, ctx.operator.auth, {
        reason: 'Лоток по-прежнему заедает — доделайте',
        version: beforeRework.version,
      });
      expect(res.statusCode, res.body).toBe(200);
      const dto = res.json() as ServiceRequestDto;
      expect(dto.status).toBe('in_work');
      expect(dto.completion).toBeNull();
      for (const item of dto.items) {
        expect(item.performed).toBeNull();
        expect(item.warrantyUntil).toBeNull();
        expect(item.warrantyUntilManual).toBe(false);
      }
      // Смета и подпись целы: возвращают ту же работу и по той же согласованной цене — снимается
      // только факт (`serviceResetOnTransition`, флаг `completion`).
      expect(dto.items).toHaveLength(2);
      expect(itemNamed(dto, 'Ролик подачи').warrantyMonths).toBe(6);
      expect(dto.approval?.revision).toBe(dto.estimateRevision);

      // Снимок снят ДО очистки и лежит в аудите того действия, которое факт и сняло.
      const metadata = await lastAudit('serviceRequest.rework', id);
      expect(metadata.reason).toBe('Лоток по-прежнему заедает — доделайте');
      const cleared = metadata.clearedWarranties as {
        itemId: string;
        name: string;
        warrantyUntil: string;
      }[];
      expect(
        [...cleared]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((w) => [w.name, w.warrantyUntil]),
      ).toEqual([
        ['Ролик подачи', plusMonths(TODAY, 6)],
        ['Термоузел', talon],
      ]);

      /*
       * Повторное закрытие выставляет даты ЗАНОВО — и здесь же видно, чем это оборачивается для
       * талона: хранить его дату негде (`warranty_until` держит одно последнее значение), и не
       * пришли исполнитель бумагу второй раз, позиция осталась бы вовсе без гарантии. Ровно об
       * этом Р5 просит предупреждать в окне закрытия.
       */
      const again = await complete(id, [
        { name: 'Ролик подачи', performed: true },
        { name: 'Термоузел', performed: true },
      ]);
      expect(again.statusCode, again.body).toBe(200);
      const reclosed = again.json() as ServiceRequestDto;
      expect(itemNamed(reclosed, 'Ролик подачи')).toMatchObject({
        warrantyUntil: plusMonths(TODAY, 6),
        warrantyUntilManual: false,
      });
      expect(itemNamed(reclosed, 'Термоузел')).toMatchObject({
        warrantyUntil: null,
        warrantyUntilManual: false,
      });
      // Строки те же самые: гарантия переписана у той же позиции, а не у заведённой заново, —
      // иначе гарантийное обращение по прежнему `itemId` осталось бы без основания.
      expect(itemNamed(reclosed, 'Ролик подачи').id).toBe(
        itemNamed(beforeRework, 'Ролик подачи').id,
      );
    });
  });

  // ── 4. Административный откат: второй путь к той же очистке ──

  describe('административный откат (PATCH /:id/status, done → in_work)', () => {
    it('снимает гарантии тем же кодом и кладёт снимок в аудит своего действия', async () => {
      /*
       * §4.2, строка «Административный откат»: путей к очистке два, и оба ведут в один помощник
       * перехода (`applyTransition`) — потому снимок и снимается там, где очистка, а не в ручках.
       * Разница видна только в аудите: у возврата действие `serviceRequest.rework`, у отката —
       * `serviceRequest.status` с парой «откуда/куда».
       */
      const id = await requestReadyToComplete('rollback', [
        { kind: 'part', name: 'Плата форматтера', unitPrice: 9000, warrantyMonths: 12 },
      ]);
      const closed = await complete(id, [{ name: 'Плата форматтера', performed: true }]);
      expect(closed.statusCode, closed.body).toBe(200);
      const dtoBefore = closed.json() as ServiceRequestDto;
      expect(itemNamed(dtoBefore, 'Плата форматтера').warrantyUntil).toBe(plusMonths(TODAY, 12));

      const res = await inject('PATCH', `${REQUESTS}/${id}/status`, ctx.admin.auth, {
        status: 'in_work',
        reason: 'Откат приёмки: закрыли не ту заявку',
        version: dtoBefore.version,
      });
      expect(res.statusCode, res.body).toBe(200);
      const dto = (res.json() as { request: ServiceRequestDto }).request;
      expect(dto.status).toBe('in_work');
      expect(dto.completion).toBeNull();
      expect(itemNamed(dto, 'Плата форматтера')).toMatchObject({
        performed: null,
        warrantyUntil: null,
        warrantyUntilManual: false,
        // Обещание живёт в смете и переживает откат: снимается ФАКТ, а не договорённость.
        warrantyMonths: 12,
      });

      const metadata = await lastAudit('serviceRequest.status', id);
      expect(metadata).toMatchObject({ from: 'done', to: 'in_work' });
      expect(metadata.clearedWarranties).toEqual([
        {
          itemId: itemNamed(dtoBefore, 'Плата форматтера').id,
          name: 'Плата форматтера',
          warrantyUntil: plusMonths(TODAY, 12),
        },
      ]);
    });
  });

  // ── 5. Переназначение из «В работе» ──

  describe('переназначение (in_work → new)', () => {
    it('тот же состав: заявка возвращается в «Новую», смета и обещанные месяцы целы', async () => {
      /*
       * Н10 плана, ради которой строка §4.2 и заведена: гарантий на этот момент ещё нет — они
       * появляются закрытием, — а обещанные месяцы обязаны пережить возврат к назначенным. Дугу
       * `in_work → new` матрица сбросов не трогает вовсе (`NO_RESET`), и проверяется здесь она.
       */
      const id = await requestReadyToComplete('reassign', [
        { kind: 'part', name: 'Ролик подачи', unitPrice: 1800, warrantyMonths: 6 },
      ]);
      const before = await card(id);
      const res = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.operator.auth, {
        userIds: [],
        serviceCounterpartyId: ctx.serviceCounterpartyId,
        reason: 'Возвращаем задание тому же подрядчику — мастер не выехал',
        version: before.version,
      });
      expect(res.statusCode, res.body).toBe(200);
      const dto = (res.json() as { request: ServiceRequestDto }).request;

      expect(dto.status).toBe('new');
      expect(dto.service?.id).toBe(ctx.serviceCounterpartyId);
      expect(dto.items).toHaveLength(1);
      expect(itemNamed(dto, 'Ролик подачи')).toMatchObject({
        warrantyMonths: 6,
        warrantyUntil: null,
        warrantyUntilManual: false,
      });
      expect(dto.estimateRevision).toBe(before.estimateRevision);
      expect(dto.approval?.revision).toBe(before.approval?.revision);
    });

    it('СМЕНА ПОДРЯДЧИКА, наоборот, сносит смету вместе с обещанными месяцами', async () => {
      /*
       * РАСХОЖДЕНИЕ С ПЛАНОМ, зафиксированное как есть. Н10 говорит «переназначение сервиса смету
       * не сбрасывает», и о матрице сбросов это верно. Но у самой ручки назначения есть СВОЯ ветка
       * `handedOver` (сняли поимённого исполнителя либо сменился контрагент): смета — документ
       * того, кто её составлял, и когда заявка меняет руки, состав, ревизия и подпись стираются
       * самой ручкой, а вместе с составом исчезают обещанные месяцы. То есть «смета цела» §4.2
       * верно ровно для возврата тому же исполнителю (случай выше) и неверно для смены подрядчика —
       * которую строка таблицы как раз и называет «переназначением сервиса».
       */
      const id = await requestReadyToComplete('handover', [
        { kind: 'part', name: 'Ролик подачи', unitPrice: 1800, warrantyMonths: 6 },
      ]);
      const res = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.operator.auth, {
        userIds: [],
        serviceCounterpartyId: ctx.otherServiceCounterpartyId,
        reason: 'Первый подрядчик не берёт эту модель',
        version: await version(id),
      });
      expect(res.statusCode, res.body).toBe(200);
      const dto = (res.json() as { request: ServiceRequestDto }).request;

      expect(dto.status).toBe('new');
      expect(dto.service?.id).toBe(ctx.otherServiceCounterpartyId);
      expect(dto.items).toEqual([]);
      expect(dto.estimateRevision).toBe(0);
      expect(dto.approval).toBeNull();
    });
  });

  // ── 6. Отмена и возврат отменённой в «Новую» ──

  describe('отмена и возврат отменённой', () => {
    it('отмена смету СОХРАНЯЕТ, а возврат в «Новую» уносит её вместе с обещаниями', async () => {
      /*
       * РАСХОЖДЕНИЕ С ФОРМУЛИРОВКОЙ §4.2, зафиксированное как есть. Строка таблицы называет пару
       * «отмена и возврат отменённой в „Новую“» одним событием со сбросом `reset.estimate`. На деле
       * сбросов два разных: отмена снимает исполнителя и подпись, а смету со всеми обещанными
       * месяцами ОСТАВЛЯЕТ — отменённая заявка остаётся рассказом о том, что собирались чинить и за
       * сколько; и только возврат в «Новую» стирает состав целиком.
       *
       * Гарантии РЕЗУЛЬТАТА в этой паре не участвуют вовсе, и это не пропуск теста: отменяют только
       * «Новую», «В работе» и отложенную (`SERVICE_OPERATOR_TRANSITIONS`), а дата гарантии
       * появляется закрытием — то есть к отмене её у заявки не бывает ни при каком пути.
       */
      const id = await requestReadyToComplete('cancel', [
        { kind: 'part', name: 'Ролик подачи', unitPrice: 1800, warrantyMonths: 6 },
        { kind: 'service', name: 'Чистка узла подачи', unitPrice: 1500, warrantyMonths: 3 },
      ]);

      const cancelled = await inject('PATCH', `${REQUESTS}/${id}/status`, ctx.operator.auth, {
        status: 'cancelled',
        reason: 'Аппарат списывают, ремонт не нужен',
        version: await version(id),
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      const afterCancel = (cancelled.json() as { request: ServiceRequestDto }).request;
      expect(afterCancel.status).toBe('cancelled');
      expect(afterCancel.items).toHaveLength(2);
      expect(itemNamed(afterCancel, 'Ролик подачи').warrantyMonths).toBe(6);
      expect(itemNamed(afterCancel, 'Чистка узла подачи').warrantyMonths).toBe(3);
      // Снимаются сторона и подпись: заявка «снова ничья», и согласия со сметой у неё больше нет.
      expect(afterCancel.service).toBeNull();
      expect(afterCancel.approval).toBeNull();

      const restored = await inject('PATCH', `${REQUESTS}/${id}/status`, ctx.admin.auth, {
        status: 'new',
        reason: 'Списание отменили — чиним',
        version: afterCancel.version,
      });
      expect(restored.statusCode, restored.body).toBe(200);
      const dto = (restored.json() as { request: ServiceRequestDto }).request;
      expect(dto.status).toBe('new');
      // «Отменённая заявка гарантий не несёт»: возвращённая проходит цикл заново с нуля.
      expect(dto.items).toEqual([]);
      expect(dto.estimateRevision).toBe(0);
      expect(dto.service).toBeNull();
      expect(dto.approval).toBeNull();
    });
  });

  // ── 7. Границы дат: день окончания входит в гарантию ──

  describe('границы дат (московские сутки)', () => {
    it('«до сегодня» ещё действует, «до вчера» истекла — и в реестре, и в обращении по гарантии', async () => {
      /*
       * Строка §4.1 «сегодня» и находка Н8: день окончания ВХОДИТ в гарантию, а «сегодня» у портала
       * одно и московское (`warrantyToday`). Проверяется парой, а не одним утверждением: «вчера
       * истекла» порознь зеленело бы и при сравнении по любому другому календарю.
       *
       * Два аппарата, а не один: обращение по гарантии заводится заявкой на ТУ ЖЕ единицу, а по
       * единице разрешена одна открытая заявка на ремонт (Р21) — на общем аппарате второй случай
       * получил бы 409 вместо проверяемого ответа.
       */
      async function acceptedRepair(tag: string): Promise<{ itemId: string; equipmentId: string }> {
        const requestId = await requestReadyToComplete(tag, [
          { kind: 'part', name: 'Ролик подачи', unitPrice: 1800 },
        ]);
        // Дата из талона ровно «по сегодня»: сервер её принимает — она не раньше даты выполнения.
        const closed = await complete(requestId, [
          { name: 'Ролик подачи', performed: true, warrantyUntil: TODAY },
        ]);
        expect(closed.statusCode, closed.body).toBe(200);
        const dto = closed.json() as ServiceRequestDto;
        await accept(requestId);
        return { itemId: itemNamed(dto, 'Ролик подачи').id, equipmentId: dto.equipment!.id };
      }

      const today = await acceptedRepair('edge-today');
      const yesterday = await acceptedRepair('edge-yesterday');
      /*
       * «Вчерашняя» гарантия — прямым `UPDATE`: ручка закрытия такую дату не принимает вовсе
       * (граница «не раньше даты выполнения»), и другого способа получить истёкшую гарантию в
       * портале нет. Тем же приёмом эта ветка собрана в `service-request-flow.db.test.ts`.
       */
      await ctx.db.execute(sql`
        UPDATE service_request_items SET warranty_until = ${plusDays(TODAY, -1)}
         WHERE id = ${yesterday.itemId}`);

      // Реестр показывает ДЕЙСТВУЮЩИЕ: сегодняшняя в нём есть и уже подсвечена «истекает».
      const rows = await warranties('&kind=repair');
      expect(rows.find((row) => row.itemId === today.itemId)).toMatchObject({
        warrantyUntil: TODAY,
        state: 'expiring',
        daysLeft: 0,
      });
      expect(rows.map((row) => row.itemId)).not.toContain(yesterday.itemId);

      // Обращение по гарантии — второе, независимое от реестра утверждение о той же границе.
      // Оно же честнее по календарю: реестр режет выборку по `CURRENT_DATE` базы, а обращение —
      // по московскому «сегодня» (`warrantyToday`), и в ночные часы эти два ответа разойдутся.
      const claim = await createRequest(today.equipmentId, 'Та же неисправность — по гарантии', {
        warrantyClaim: { source: 'item', itemId: today.itemId },
      });
      expect(claim.statusCode, claim.body).toBe(201);
      expect((claim.json() as { request: ServiceRequestDto }).request.warrantyClaim).toMatchObject({
        source: 'item',
        itemId: today.itemId,
      });

      const expired = await createRequest(
        yesterday.equipmentId,
        'Та же неисправность — по гарантии',
        { warrantyClaim: { source: 'item', itemId: yesterday.itemId } },
      );
      expect(expired.statusCode, expired.body).toBe(422);
      expect(expired.json().message).toContain('истекла');
    });
  });

  // ── 8. Архивирование заявки: шестая строка §4.2 и находка Н11 ──

  describe('архивирование заявки (Н11)', () => {
    it('гарантия уходит из реестра вместе с заявкой, сама дата цела, восстановление возвращает', async () => {
      /*
       * Н11 подтверждается как есть: обе выборки реестра отбирают `deleted_at IS NULL`, и ушедшая в
       * архив заявка уносит из «что ещё покрыто» гарантию на СДЕЛАННУЮ работу — молча, без пометки.
       * Работа при этом выполнена, акт подшит, а дата в строке никуда не делась: пропала не
       * гарантия, а её носитель из списка. Восстановление возвращает строку на место.
       *
       * Единственная строка §4.2, помеченная «изменить» (Р6): Э3 научит реестр показывать такие
       * гарантии держателю `archive.read` с пометкой. Тогда этот случай обязан покраснеть на
       * «после архивирования строки нет» — и переписывается он на два читателя, а не удаляется.
       */
      const id = await requestReadyToComplete('archive', [
        { kind: 'part', name: 'Ролик подачи', unitPrice: 1800, warrantyMonths: 6 },
      ]);
      const closed = await complete(id, [{ name: 'Ролик подачи', performed: true }]);
      expect(closed.statusCode, closed.body).toBe(200);
      const itemId = itemNamed(closed.json() as ServiceRequestDto, 'Ролик подачи').id;
      await accept(id);
      expect((await warranties('&kind=repair')).map((row) => row.itemId)).toContain(itemId);

      // Архивирует администратор: место в очереди по единице держит статус, а «Принятую» заявку
      // площадочная роль уже не удаляет (`isServiceRequestDeletable`).
      const archived = await inject('DELETE', `${REQUESTS}/${id}`, ctx.admin.auth);
      expect(archived.statusCode, archived.body).toBe(200);
      expect((await warranties('&kind=repair')).map((row) => row.itemId)).not.toContain(itemId);

      // Дата гарантии в строке не тронута: из реестра ушла заявка, а не срок.
      const stored = await ctx.db.execute<{ warranty_until: string }>(
        sql`SELECT warranty_until FROM service_request_items WHERE id = ${itemId}`,
      );
      expect(String(stored.rows[0]!.warranty_until).slice(0, 10)).toBe(plusMonths(TODAY, 6));

      const restored = await inject('POST', `${REQUESTS}/${id}/restore`, ctx.admin.auth);
      expect(restored.statusCode, restored.body).toBe(200);
      expect((await warranties('&kind=repair')).map((row) => row.itemId)).toContain(itemId);
    });
  });
});
