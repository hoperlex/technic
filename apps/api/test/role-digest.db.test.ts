import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DigestSection,
  formatServiceRequestNumber,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Сборка тела письма из блоков — чистая функция без конфига, поэтому импортируется обычным путём.
import { renderMail } from '../src/services/mail-templates';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type { loadPrincipal as LoadPrincipal } from '../src/auth/principal';
import type { sectionAllowed as SectionAllowed } from '../src/services/mailings/digest-context';
import type {
  buildRoleDigestMail as BuildRoleDigestMail,
  digestExcludedScopes as DigestExcludedScopes,
  digestPeriod as DigestPeriod,
  digestRecipients as DigestRecipients,
  digestUpcoming as DigestUpcoming,
} from '../src/services/mailings/role-digest';

/**
 * Ролевой дайджест на живой схеме (ADR 0078): проверяется одно свойство — в письме человека нет
 * чужих данных.
 *
 * Зачем этому тесту база. Область видимости письма нигде не написана словами: она собирается из
 * `Principal`, который читается из учётки вместе с её объектами и отделами, и превращается в
 * условие `WHERE` теми же функциями `lib/access.ts`, которыми ограничивает списки портал. Ни одну
 * половину этой цепочки нельзя проверить на правилах: расходятся не правила, а связка «учётка —
 * запрос — схема». Цена расхождения здесь не косметическая — письмо уходит наружу, в почтовый ящик,
 * откуда его уже не отозвать: штаб чужой площадки узнаёт номера, сроки и заказчиков заявок, к
 * которым в портале его не пускают. Поэтому каждая проверка ниже — проверка на утечку, и «пусто»
 * в ней означает «человеку это не положено», а не «сегодня не завелось».
 *
 * Запуск — как у остальных db-тестов; без `TEST_DATABASE_URL` файл пропускается:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test role-digest
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Часовой пояс портала: в нём считаются и границы суток периода, и «какой сегодня день». */
const TIME_ZONE = 'Europe/Moscow';

/**
 * Момент запуска — заведомо будущая **среда**, 08:00 МСК. База общая: на «сегодня» и на ближайшие
 * дни заявки и рейсы заводят соседние тесты, и период, пересекающийся с ними, сделал бы содержимое
 * письма зависимым от того, кто прогонялся раньше. Среда выбрана ради недельного периода: у неё
 * прошлая неделя не совпадает ни с текущей, ни с «последними семью днями».
 */
const PLANNED_AT = new Date('2099-07-15T05:00:00.000Z');
/** Период ежедневной сводки от этого запуска — вчерашние сутки. */
const PERIOD_DAY = '2099-07-14';
/** Заявки заводятся внутри периода: 12:00 МСК того самого дня. */
const CREATED_AT = new Date(`${PERIOD_DAY}T09:00:00.000Z`);
/** День рейса — внутри окна «ближайших» (день запуска плюс три). */
const ROUTE_DATE = '2099-07-16';

/** Разделы письма в тестах задаются явно: в настоящем расписании их выбирает администратор. */
const CHANGES: DigestSection[] = ['vehicle_requests_changes'];
const CHANGES_AND_ROUTES: DigestSection[] = ['vehicle_requests_changes', 'vehicle_routes_upcoming'];
/**
 * Раздел обслуживания оргтехники (ADR 0085) — снимок, а не события периода: он отвечает на «что
 * стоит на вас сейчас», и датой запуска не ограничивается вовсе.
 */
const SERVICE: DigestSection[] = ['service_requests_waiting'];

/** Учётка-получатель: ровно то, что письму нужно от человека. */
interface TestUser {
  id: string;
  email: string;
  fullName: string;
}

interface TestRequest {
  id: string;
  /** «ТС-461» — то, чем заявку называют в разговоре и что ищут в письме глазами. */
  number: string;
}

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  buildRoleDigestMail: typeof BuildRoleDigestMail;
  digestRecipients: typeof DigestRecipients;
  digestExcludedScopes: typeof DigestExcludedScopes;
  digestPeriod: typeof DigestPeriod;
  digestUpcoming: typeof DigestUpcoming;
  loadPrincipal: typeof LoadPrincipal;
  sectionAllowed: typeof SectionAllowed;
  /** Штаб первой площадки: главный герой проверок на утечку. */
  shtab: TestUser;
  /** Штаб без единого объекта: пустая область — это «ничего», а не «всё». */
  shtabNoScope: TestUser;
  /** Сотрудник отдела: вторая ось области (ADR 0040). */
  dept: TestUser;
  /** Диспетчер — роль без области: ей видно всё, и на ней видно, что фильтр не режет всё подряд. */
  global: TestUser;
  /**
   * Оператор оргтехники (ADR 0086): тот же штаб первой площадки, но с надстройкой роли. Сторону в
   * цикле заявок задаёт право `serviceRequests.assign`, а не имя роли, — на нём и видно, что
   * раздел собирается правами, а не сравнением с ролью.
   */
  operator: TestUser;
  /** Сервисная компания: сторону задаёт тип контрагента, область — назначение исполнителем. */
  service: TestUser;
  /** Штаб с неподтверждённым адресом: получателем не становится (ADR 0072). */
  unverified: TestUser;
  /** Штаб, вычеркнутый администратором из этого расписания. */
  excludedRecipient: TestUser;
  /** Штаб с выключенной учёткой и штаб из архива: оба не получатели. */
  inactive: TestUser;
  archived: TestUser;
  objectAId: string;
  objectBId: string;
  departmentId: string;
  vehicleId: string;
  modelId: string;
  scheduleId: string;
  /** Заявка своей площадки, чужой площадки, отдела и удалённая — четыре ответа на «чьё это». */
  requestA: TestRequest;
  requestB: TestRequest;
  requestDept: TestRequest;
  requestDeleted: TestRequest;
  /**
   * Заявки на обслуживание — шесть ответов на «кого сейчас ждут и чьё это»: две ждут оператора
   * (разного возраста — ими проверяется порядок), одна ждёт назначенный сервис, одна ждёт **чужой**
   * сервис, одна стоит на чужой площадке, последняя закрыта и не ждёт никого.
   */
  srOperatorOld: TestRequest;
  srOperatorNew: TestRequest;
  srService: TestRequest;
  srOtherService: TestRequest;
  srForeignObject: TestRequest;
  srClosed: TestRequest;
  /** Рейс в окне «ближайших»: раздел рейсов положен только роли без области. */
  routeNumber: string;
}

let ctx: Ctx;

const createdUserIds: string[] = [];
const createdRequestIds: string[] = [];
const createdRouteIds: string[] = [];
const createdServiceRequestIds: string[] = [];
const createdEquipmentIds: string[] = [];
const createdCounterpartyIds: string[] = [];

/**
 * Момент «N дней назад» от настоящего сейчас, а не от `PLANNED_AT`: возраст в статусе раздел
 * считает от текущего времени — заявка, простоявшая неделю, столько же и стоит, когда бы письмо
 * ни собиралось.
 */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/**
 * Десятизначный ИНН по девяти цифрам основы: контрольная цифра считается по весам приказа ФНС.
 * Выдуманный «77…01» здесь не годится — контрагенты остаются в общей базе, а обмен справочниками
 * выгружает её целиком и загружает обратно, проверяя ИНН по-настоящему.
 */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

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
  // Зона задаётся явно: по ней разделы считают границы суток периода, и тест сравнивает даты с той
  // же зоной, а не с той, что окажется в окружении машины.
  process.env.MAIL_SCHEDULER_TIMEZONE = TIME_ZONE;
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

/** Тип ТС берётся из наполнения: у отдела бывают только грузоперевозки (CHECK схемы). */
async function freightTypeId(db: typeof AppDb): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`
    SELECT vt.id FROM vehicle_types vt
    JOIN vehicle_kinds vk ON vk.id = vt.kind_id
    WHERE vk.code = 'freight_transport'
    ORDER BY vt.name
    LIMIT 1`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error('В базе нет типа ТС грузового вида: миграции наполнения не применены');
  return id;
}

/** Тип оргтехники — из сида модуля (ADR 0085): карточки без типа схема не принимает. */
async function officeEquipmentTypeId(db: typeof AppDb): Promise<string> {
  const res = await db.execute<{ id: string }>(
    sql`SELECT id FROM office_equipment_types WHERE code = 'mfp' LIMIT 1`,
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');
  return id;
}

/**
 * Номер в тексте письма ищется по границе цифр. Простой подстрокой «ТС-46» нашёлся бы внутри
 * «ТС-461», и проверка «чужой заявки в письме нет» прошла бы ровно там, где утечка есть.
 */
function hasNumber(text: string, displayNumber: string): boolean {
  return new RegExp(`${displayNumber}(?!\\d)`, 'u').test(text);
}

/** Заголовки разделов письма: по ним видно, какие разделы вообще собрались и сколько в них строк. */
function headings(blocks: { kind: string; text?: string }[]): string[] {
  return blocks.flatMap((b) => (b.kind === 'heading' && b.text ? [b.text] : []));
}

/**
 * Сводка одному получателю на тех же границах, что посчитал бы настоящий запуск: период и окно
 * «ближайших» берутся у тех же функций, которыми их считает `runRoleDigest`.
 */
function digestFor(
  user: TestUser,
  sections: DigestSection[],
  excluded: { objectIds: string[]; departmentIds: string[] } = { objectIds: [], departmentIds: [] },
) {
  const period = ctx.digestPeriod(PLANNED_AT, 'daily', TIME_ZONE);
  const upcoming = ctx.digestUpcoming(PLANNED_AT, TIME_ZONE);
  return ctx.buildRoleDigestMail({
    recipient: { userId: user.id, fullName: user.fullName, email: user.email },
    sections,
    periodStart: period.start,
    periodEnd: period.end,
    upcomingFrom: upcoming.from,
    upcomingTo: upcoming.to,
    excludedObjectIds: excluded.objectIds,
    excludedDepartmentIds: excluded.departmentIds,
    periodicity: 'daily',
  });
}

/** Текстовая версия письма: её читают в клиентах без HTML, и в ней видно всё тело целиком. */
async function digestText(
  user: TestUser,
  sections: DigestSection[],
  excluded?: { objectIds: string[]; departmentIds: string[] },
): Promise<string> {
  const mail = await digestFor(user, sections, excluded);
  expect(mail).not.toBeNull();
  return renderMail(mail!.content).text;
}

describe.skipIf(!DB_URL)('ролевой дайджест: область видимости письма (живая схема)', () => {
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { loadPrincipal } = await import('../src/auth/principal');
    const { sectionAllowed } = await import('../src/services/mailings/digest-context');
    const {
      buildRoleDigestMail,
      digestExcludedScopes,
      digestPeriod,
      digestRecipients,
      digestUpcoming,
    } = await import('../src/services/mailings/role-digest');

    /** Учётка с подтверждённым адресом: без него человек не получатель, а тут проверяется другое. */
    async function makeUser(input: {
      tag: string;
      role: 'admin' | 'shtab' | 'department' | 'dispatcher' | 'operator';
      isActive?: boolean;
      verified?: boolean;
      deleted?: boolean;
      /** Контрагент внешнего исполнителя (ADR 0038): им и задаётся его сторона в цикле. */
      counterpartyId?: string;
    }): Promise<TestUser> {
      const email = `db-digest-${input.tag}-${suffix}@example.invalid`;
      const [row] = await db
        .insert(schema.users)
        .values({
          email,
          lastName: 'Тестовый',
          firstName: 'Получатель',
          middleName: input.tag,
          // Входа в этом тесте нет: письмо собирается сервисом, а не через HTTP.
          passwordHash: 'db-test-not-a-hash',
          role: input.role,
          isActive: input.isActive ?? true,
          emailVerifiedAt: (input.verified ?? true) ? new Date() : null,
          deletedAt: input.deleted ? new Date() : null,
          counterpartyId: input.counterpartyId ?? null,
        })
        .returning({ id: schema.users.id, fullName: schema.users.fullName });
      createdUserIds.push(row!.id);
      return { id: row!.id, email, fullName: row!.fullName };
    }

    /** Контрагент-сервис: их два — «свой» и чужой, иначе область исполнителя нечем проверить. */
    async function makeServiceCounterparty(tag: string, inn: string): Promise<string> {
      const [row] = await db
        .insert(schema.counterparties)
        .values({ type: 'service', name: `Тестовый сервис ${tag} ${suffix}`, inn })
        .returning({ id: schema.counterparties.id });
      createdCounterpartyIds.push(row!.id);
      return row!.id;
    }

    // ИНН уникален среди живых контрагентов: основа берётся от времени прогона, а не константой.
    const innBase = String(Date.now()).slice(-6);
    const serviceCounterpartyId = await makeServiceCounterparty('свой', innOf(`78${innBase}0`));
    const otherServiceCounterpartyId = await makeServiceCounterparty(
      'чужой',
      innOf(`78${innBase}1`),
    );

    const author = await makeUser({ tag: 'author', role: 'admin' });
    const shtab = await makeUser({ tag: 'shtab', role: 'shtab' });
    const shtabNoScope = await makeUser({ tag: 'noscope', role: 'shtab' });
    const dept = await makeUser({ tag: 'dept', role: 'department' });
    const global = await makeUser({ tag: 'global', role: 'dispatcher' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const service = await makeUser({
      tag: 'serv',
      role: 'operator',
      counterpartyId: serviceCounterpartyId,
    });
    const unverified = await makeUser({ tag: 'unverified', role: 'shtab', verified: false });
    const excludedRecipient = await makeUser({ tag: 'excluded', role: 'shtab' });
    const inactive = await makeUser({ tag: 'inactive', role: 'shtab', isActive: false });
    const archived = await makeUser({ tag: 'archived', role: 'shtab', deleted: true });

    // Свои площадки и свой отдел, а не чужие из наполнения: на записи наполнения опираются соседние
    // сценарии, и править их тест не вправе.
    const [objectA] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `DIG-A-${suffix}`,
        name: `Тестовая площадка своя ${suffix}`,
        address: 'г Москва, ул Своя, д 1',
      })
      .returning({ id: schema.constructionObjects.id });
    const [objectB] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `DIG-B-${suffix}`,
        name: `Тестовая площадка чужая ${suffix}`,
        address: 'г Москва, ул Чужая, д 2',
      })
      .returning({ id: schema.constructionObjects.id });
    // Отдел без площадки: производной объектной области (ADR 0062) у него нет — проверяется ось
    // отдела в чистом виде.
    const [department] = await db
      .insert(schema.departments)
      .values({ code: `DIG-D-${suffix}`, name: `Тестовый отдел ${suffix}` })
      .returning({ id: schema.departments.id });

    // Область учётки — набором в отдельной таблице (ADR 0039, 0040), как её задаёт портал.
    await db
      .insert(schema.userConstructionObjects)
      .values({ userId: shtab.id, constructionObjectId: objectA!.id });
    await db
      .insert(schema.userDepartments)
      .values({ userId: dept.id, departmentId: department!.id });
    // Оператор оргтехники — обычный штаб первой площадки плюс надстройка (ADR 0086): роль у него
    // остаётся `shtab`, и сторону в цикле заявок ему даёт только право из надстройки.
    await db
      .insert(schema.userConstructionObjects)
      .values({ userId: operator.id, constructionObjectId: objectA!.id });
    await db
      .insert(schema.userRoleAddons)
      .values({ userId: operator.id, addon: 'office_equipment_operator' });

    const typeId = await freightTypeId(db);
    const [model] = await db
      .insert(schema.vehicleModels)
      .values({ vehicleTypeId: typeId, name: `Тестовый самосвал (сводка) ${suffix}` })
      .returning({ id: schema.vehicleModels.id });
    const [vehicle] = await db
      .insert(schema.vehicles)
      .values({
        ownership: 'own',
        vehicleTypeId: typeId,
        vehicleModelId: model!.id,
        registrationNumber: `С${suffix.slice(0, 3).toUpperCase()}799`,
        status: 'active',
      })
      .returning({ id: schema.vehicles.id });

    /** Заявка на технику прямо в таблицах: письму нужны и она сама, и её detail-строка. */
    async function makeRequest(input: {
      objectId?: string;
      departmentId?: string;
      deleted?: boolean;
      loading: string;
    }): Promise<TestRequest> {
      const [request] = await db
        .insert(schema.vehicleRequests)
        .values({
          requestType: 'freight_transport',
          objectId: input.objectId ?? null,
          departmentId: input.departmentId ?? null,
          vehicleTypeId: typeId,
          status: 'new',
          createdBy: author.id,
          // Дата заведения задаётся явно: раздел «заведено и сменило статус» отбирает по ней, и
          // период из будущего отсекает всё, что завели соседние тесты «сегодня».
          createdAt: CREATED_AT,
          ...(input.deleted ? { deletedAt: new Date(), deletedBy: author.id } : {}),
        })
        .returning({ id: schema.vehicleRequests.id, num: schema.vehicleRequests.num });
      createdRequestIds.push(request!.id);

      await db.insert(schema.freightTransportRequestDetails).values({
        requestId: request!.id,
        scheduledAt: new Date(`${ROUTE_DATE}T05:30:00Z`),
        volumeM3: '10.000',
        loadingLocation: input.loading,
        unloadingLocation: 'г Москва, ул Разгрузочная, д 9',
      });

      return { id: request!.id, number: formatVehicleRequestNumber(request!.num) };
    }

    const requestA = await makeRequest({
      objectId: objectA!.id,
      loading: `г Москва, ул Своя, д 1 (${suffix})`,
    });
    const requestB = await makeRequest({
      objectId: objectB!.id,
      loading: `г Москва, ул Чужая, д 2 (${suffix})`,
    });
    const requestDept = await makeRequest({
      departmentId: department!.id,
      loading: `г Москва, ул Отдельская, д 3 (${suffix})`,
    });
    const requestDeleted = await makeRequest({
      objectId: objectA!.id,
      deleted: true,
      loading: `г Москва, ул Удалённая, д 4 (${suffix})`,
    });

    const equipmentTypeId = await officeEquipmentTypeId(db);

    /**
     * Единица справочника — своя на каждую заявку: схема не допускает двух открытых заявок на одну
     * единицу (`service_requests_open_per_equipment_unique`), и общий принтер развалил бы набор.
     */
    async function makeEquipment(tag: string, objectId: string): Promise<{ id: string }> {
      const [row] = await db
        .insert(schema.officeEquipment)
        .values({
          equipmentTypeId,
          name: `Тестовый МФУ ${tag} ${suffix}`,
          inventoryNumber: `DIG-OE-${tag}-${suffix}`,
          objectId,
        })
        .returning({ id: schema.officeEquipment.id });
      createdEquipmentIds.push(row!.id);
      return { id: row!.id };
    }

    /**
     * Заявка на обслуживание прямо в таблице: цикл её ведёт своя ручка на каждый переход, и
     * проходить его целиком ради снимка «кто кого ждёт» значило бы проверять здесь чужой сценарий.
     * Возраст в статусе задаётся явно — им раздел и сортирует строки.
     */
    async function makeServiceRequest(input: {
      tag: string;
      objectId: string;
      status: ServiceRequestStatus;
      serviceCounterpartyId?: string;
      daysInStatus: number;
    }): Promise<TestRequest> {
      const equipment = await makeEquipment(input.tag, input.objectId);
      const [row] = await db
        .insert(schema.serviceRequests)
        .values({
          officeEquipmentId: equipment.id,
          equipmentObjectId: input.objectId,
          // Снимок предмета: письмо называет технику так же, как карточка заявки (ADR 0085 §7).
          equipmentName: `Тестовый МФУ ${input.tag} ${suffix}`,
          equipmentInventoryNumber: `DIG-OE-${input.tag}-${suffix}`,
          description: `Не печатает (${input.tag} ${suffix})`,
          status: input.status,
          statusChangedAt: daysAgo(input.daysInStatus),
          serviceCounterpartyId: input.serviceCounterpartyId ?? null,
          createdBy: author.id,
        })
        .returning({ id: schema.serviceRequests.id, num: schema.serviceRequests.num });
      createdServiceRequestIds.push(row!.id);
      return { id: row!.id, number: formatServiceRequestNumber(row!.num) };
    }

    // «Ожидает приёмки» и «Новая» ждут оператора, «Назначен сервис» — исполнителя (Р35). Возрасты
    // разные и заданы намеренно: по ним проверяется и порядок строк, и колонка «сколько стоит».
    const srOperatorOld = await makeServiceRequest({
      tag: 'accept',
      objectId: objectA!.id,
      status: 'done',
      serviceCounterpartyId,
      daysInStatus: 6,
    });
    const srOperatorNew = await makeServiceRequest({
      tag: 'new',
      objectId: objectA!.id,
      status: 'new',
      daysInStatus: 1,
    });
    const srService = await makeServiceRequest({
      tag: 'assigned',
      objectId: objectA!.id,
      status: 'assigned',
      serviceCounterpartyId,
      daysInStatus: 3,
    });
    // Та же площадка и тот же статус, но исполнитель другой: без неё «сервис видит свои заявки»
    // проходило бы и на выборке, отдающей исполнителю вообще все назначенные кому-либо заявки.
    const srOtherService = await makeServiceRequest({
      tag: 'foreign-service',
      objectId: objectA!.id,
      status: 'assigned',
      serviceCounterpartyId: otherServiceCounterpartyId,
      daysInStatus: 4,
    });
    const srForeignObject = await makeServiceRequest({
      tag: 'foreign-object',
      objectId: objectB!.id,
      status: 'new',
      daysInStatus: 5,
    });
    // Закрытая не ждёт никого: `waitingOn = nobody` — и в разделе её быть не должно ни у одной
    // стороны, хотя область у обеих подходит.
    const srClosed = await makeServiceRequest({
      tag: 'closed',
      objectId: objectA!.id,
      status: 'accepted',
      serviceCounterpartyId,
      daysInStatus: 2,
    });

    const [route] = await db
      .insert(schema.vehicleRoutes)
      .values({
        vehicleId: vehicle!.id,
        routeDate: ROUTE_DATE,
        purpose: 'freight',
        createdBy: author.id,
      })
      .returning({ id: schema.vehicleRoutes.id, num: schema.vehicleRoutes.num });
    createdRouteIds.push(route!.id);

    // Расписание ролевой сводки: окна рейсов у него нет (CHECK схемы), получателей задаёт роль.
    const [schedule] = await db
      .insert(schema.mailingSchedules)
      .values({
        type: 'role_digest',
        name: `Тестовая сводка ${suffix}`,
        isEnabled: true,
        periodicity: 'daily',
        sendAt: '08:00',
        createdBy: author.id,
      })
      .returning({ id: schema.mailingSchedules.id });
    await db
      .insert(schema.mailingScheduleRoles)
      .values({ scheduleId: schedule!.id, role: 'shtab' });
    await db
      .insert(schema.mailingScheduleExcludedUsers)
      .values({ scheduleId: schedule!.id, userId: excludedRecipient.id });
    // Исключённая администратором площадка: её вычитание проверяется через настройку расписания, а
    // не переданным руками массивом, — иначе проверялась бы только половина пути.
    await db
      .insert(schema.mailingScheduleExcludedScopes)
      .values({ scheduleId: schedule!.id, objectId: objectA!.id });

    ctx = {
      db,
      closeDb,
      schema,
      buildRoleDigestMail,
      digestRecipients,
      digestExcludedScopes,
      digestPeriod,
      digestUpcoming,
      loadPrincipal,
      sectionAllowed,
      shtab,
      shtabNoScope,
      dept,
      global,
      operator,
      service,
      unverified,
      excludedRecipient,
      inactive,
      archived,
      objectAId: objectA!.id,
      objectBId: objectB!.id,
      departmentId: department!.id,
      vehicleId: vehicle!.id,
      modelId: model!.id,
      scheduleId: schedule!.id,
      requestA,
      requestB,
      requestDept,
      requestDeleted,
      srOperatorOld,
      srOperatorNew,
      srService,
      srOtherService,
      srForeignObject,
      srClosed,
      routeNumber: formatVehicleRouteNumber(route!.num),
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const { db, schema } = ctx;
    // Убирается только своё и в порядке ссылок: настройки расписания уходят каскадом за ним,
    // автора заявок и рейсов держит RESTRICT их `created_by` — учётки удаляются последними, а
    // площадку и отдел держит RESTRICT заявки.
    await db.delete(schema.mailingSchedules).where(eq(schema.mailingSchedules.id, ctx.scheduleId));
    if (createdRouteIds.length > 0) {
      await db
        .delete(schema.vehicleRoutes)
        .where(inArray(schema.vehicleRoutes.id, createdRouteIds));
    }
    if (createdRequestIds.length > 0) {
      await db
        .delete(schema.vehicleRequests)
        .where(inArray(schema.vehicleRequests.id, createdRequestIds));
    }
    // Заявка на обслуживание держит `RESTRICT`'ом и единицу справочника, и контрагента, и автора:
    // порядок здесь тот же, что у заявок ТС, — сначала заявки, потом то, на что они ссылаются.
    if (createdServiceRequestIds.length > 0) {
      await db
        .delete(schema.serviceRequests)
        .where(inArray(schema.serviceRequests.id, createdServiceRequestIds));
    }
    if (createdEquipmentIds.length > 0) {
      await db
        .delete(schema.officeEquipment)
        .where(inArray(schema.officeEquipment.id, createdEquipmentIds));
    }
    await db.delete(schema.vehicles).where(eq(schema.vehicles.id, ctx.vehicleId));
    await db.delete(schema.vehicleModels).where(eq(schema.vehicleModels.id, ctx.modelId));
    // Связи учёток с площадками, отделами и надстройками уходят каскадом за учёткой. Контрагент
    // удаляется после неё: на нём висит учётка исполнителя.
    if (createdUserIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
    }
    if (createdCounterpartyIds.length > 0) {
      await db
        .delete(schema.counterparties)
        .where(inArray(schema.counterparties.id, createdCounterpartyIds));
    }
    await db.delete(schema.departments).where(eq(schema.departments.id, ctx.departmentId));
    await db
      .delete(schema.constructionObjects)
      .where(inArray(schema.constructionObjects.id, [ctx.objectAId, ctx.objectBId]));
    await ctx.closeDb();
  });

  it('штаб видит в письме заявку своей площадки и не видит заявки чужой', async () => {
    const mail = await digestFor(ctx.shtab, CHANGES);
    expect(mail).not.toBeNull();
    const text = renderMail(mail!.content).text;

    expect(hasNumber(text, ctx.requestA.number)).toBe(true);
    // Главная проверка файла: заявка соседней площадки в портале штабу не видна, и письмо не
    // должно быть дырой, через которую она к нему приходит.
    expect(hasNumber(text, ctx.requestB.number)).toBe(false);
    expect(text).not.toContain('ул Чужая');
    // Счётчик раздела считается тем же условием, что и строки: он обязан быть равен единице —
    // иначе чужие заявки не напечатались, но были посчитаны, и человек видит чужую цифру.
    expect(headings(mail!.content.blocks)).toEqual([
      'Заявки на технику: заведено и сменило статус — 1',
    ]);
  });

  it('штабу без единого объекта письма нет вовсе: пустая область — это «ничего», а не «всё»', async () => {
    // Учётка объектной роли без объектов — состояние, которого API не допускает, но выборка не
    // должна зависеть от того, удержалась ли та проверка: незаполненная область, понятая как
    // «ограничений нет», отдала бы человеку заявки всех площадок компании.
    expect(await digestFor(ctx.shtabNoScope, CHANGES)).toBeNull();
  });

  it('роль отдела видит заявки своего отдела, а объектные — нет', async () => {
    const mail = await digestFor(ctx.dept, CHANGES);
    expect(mail).not.toBeNull();
    const text = renderMail(mail!.content).text;

    expect(hasNumber(text, ctx.requestDept.number)).toBe(true);
    // Ось у роли одна (ADR 0040): отдел заказывает от себя, и площадочные заявки к нему отношения
    // не имеют — ни своей площадки, ни чужой у него нет вовсе.
    expect(hasNumber(text, ctx.requestA.number)).toBe(false);
    expect(hasNumber(text, ctx.requestB.number)).toBe(false);
    expect(headings(mail!.content.blocks)).toEqual([
      'Заявки на технику: заведено и сменило статус — 1',
    ]);
  });

  it('роль без области видит обе заявки: письмо режет область, а не фильтр вообще', async () => {
    const text = await digestText(ctx.global, CHANGES);

    // Без этой проверки все предыдущие проходили бы и на сломанной выборке, которая не отдаёт
    // никому ничего: «чужого не видно» и «не видно ничего» — разные состояния.
    expect(hasNumber(text, ctx.requestA.number)).toBe(true);
    expect(hasNumber(text, ctx.requestB.number)).toBe(true);
    expect(hasNumber(text, ctx.requestDept.number)).toBe(true);
  });

  it('исключённая администратором площадка вычитается и у роли без области', async () => {
    const excluded = await ctx.digestExcludedScopes(ctx.scheduleId);
    expect(excluded.objectIds).toContain(ctx.objectAId);

    const text = await digestText(ctx.global, CHANGES, excluded);

    // Исключение вычитается из области каждого получателя: администратор может убрать площадку из
    // рассылки — и убирает её всем, включая тех, кому она видна в портале.
    expect(hasNumber(text, ctx.requestA.number)).toBe(false);
    expect(text).not.toContain('ул Своя');
    // Остальное на месте: исключение снимает одну площадку, а не глушит раздел целиком.
    expect(hasNumber(text, ctx.requestB.number)).toBe(true);
    // Заявка отдела площадки не имеет — вычитание площадки её не касается.
    expect(hasNumber(text, ctx.requestDept.number)).toBe(true);
  });

  it('разделы рейсов и путевых листов не идут роли с объектной областью, а роли без области идут', async () => {
    const shtabMail = await digestFor(ctx.shtab, CHANGES_AND_ROUTES);
    expect(shtabMail).not.toBeNull();
    const shtabText = renderMail(shtabMail!.content).text;

    // У рейса нет площадки, к которой его можно отнести: сузить раздел под штаб нечем, и попади он
    // в письмо — штаб получил бы рейсы всей компании, включая чужие площадки и чужих водителей.
    expect(headings(shtabMail!.content.blocks)).toEqual([
      'Заявки на технику: заведено и сменило статус — 1',
    ]);
    expect(hasNumber(shtabText, ctx.routeNumber)).toBe(false);

    const globalText = await digestText(ctx.global, CHANGES_AND_ROUTES);
    expect(hasNumber(globalText, ctx.routeNumber)).toBe(true);

    // Раздел путевых листов закрыт тем же правилом; проверяется у двери, а не по телу письма:
    // бланка строгой отчётности тест не выписывает, а вопрос здесь ровно один — кому раздел положен.
    const shtabPrincipal = await ctx.loadPrincipal(ctx.shtab.id);
    const deptPrincipal = await ctx.loadPrincipal(ctx.dept.id);
    const globalPrincipal = await ctx.loadPrincipal(ctx.global.id);
    expect(ctx.sectionAllowed('waybills_issued', shtabPrincipal!)).toBe(false);
    expect(ctx.sectionAllowed('waybills_issued', deptPrincipal!)).toBe(false);
    expect(ctx.sectionAllowed('waybills_issued', globalPrincipal!)).toBe(true);
  });

  it('удалённая заявка не попадает в письмо никому', async () => {
    const shtabText = await digestText(ctx.shtab, CHANGES);
    const globalText = await digestText(ctx.global, CHANGES);

    // Архив открыт только администратору, и сводка — не журнал удалений: напечатанная удалённая
    // заявка это и утечка того, что скрыто, и повод поехать по отменённой работе.
    expect(hasNumber(shtabText, ctx.requestDeleted.number)).toBe(false);
    expect(hasNumber(globalText, ctx.requestDeleted.number)).toBe(false);
    expect(shtabText).not.toContain('ул Удалённая');
    expect(globalText).not.toContain('ул Удалённая');
  });

  it('оператору оргтехники приходят ждущие его заявки его площадки, дольше всех стоящая — первой', async () => {
    const mail = await digestFor(ctx.operator, SERVICE);
    expect(mail).not.toBeNull();
    const text = renderMail(mail!.content).text;

    // Ждут оператора «Новая», «Смета на согласовании» и «Ожидает приёмки» (Р35) — обе его заявки
    // на месте, обе с площадки, которую он ведёт.
    expect(hasNumber(text, ctx.srOperatorOld.number)).toBe(true);
    expect(hasNumber(text, ctx.srOperatorNew.number)).toBe(true);
    // Ждущая исполнителя — не его шаг: раздел отвечает на «что стоит на вас», а не «что открыто».
    expect(hasNumber(text, ctx.srService.number)).toBe(false);
    expect(hasNumber(text, ctx.srOtherService.number)).toBe(false);
    // Чужая площадка: у оператора роль объектная, и надстройка область не расширяет (Р4).
    expect(hasNumber(text, ctx.srForeignObject.number)).toBe(false);
    expect(hasNumber(text, ctx.srClosed.number)).toBe(false);
    expect(headings(mail!.content.blocks)).toEqual(['Заявки на обслуживание: ждут вас — 2']);

    // Порядок — по возрасту в статусе: письмо начинается с того, что стоит дольше всех, иначе
    // зависшая на неделю заявка окажется под свежими и раздел перестанет отвечать на свой вопрос.
    expect(text.indexOf(ctx.srOperatorOld.number)).toBeLessThan(
      text.indexOf(ctx.srOperatorNew.number),
    );
    // Колонки строки: статус и возраст в нём — ради них раздел и читают.
    expect(text).toContain('Ожидает приёмки');
    expect(text).toContain('ждёт 6 дней');
    expect(text).toContain('ждёт 1 день');
  });

  it('сервисной компании приходят только назначенные ей заявки', async () => {
    const mail = await digestFor(ctx.service, SERVICE);
    expect(mail).not.toBeNull();
    const text = renderMail(mail!.content).text;

    expect(hasNumber(text, ctx.srService.number)).toBe(true);
    // Главная проверка стороны исполнителя: заявка того же статуса и той же площадки, назначенная
    // другому сервису, — чужая работа, чужие сроки и чужой заказчик.
    expect(hasNumber(text, ctx.srOtherService.number)).toBe(false);
    // Шаги оператора сервису не показываются даже по своим заявкам: «Ожидает приёмки» — не его
    // очередь, и заявка до назначения («Новая») ему не видна вовсе.
    expect(hasNumber(text, ctx.srOperatorOld.number)).toBe(false);
    expect(hasNumber(text, ctx.srOperatorNew.number)).toBe(false);
    expect(hasNumber(text, ctx.srForeignObject.number)).toBe(false);
    expect(hasNumber(text, ctx.srClosed.number)).toBe(false);
    expect(headings(mail!.content.blocks)).toEqual(['Заявки на обслуживание: ждут вас — 1']);
    expect(text).toContain('Назначен сервис');
    expect(text).toContain('ждёт 3 дня');
  });

  it('заказчику раздел не собирается: право модуля у него есть, а шага в цикле нет', async () => {
    // Штаб и отдел видят заявки в портале и заводят их, но решений по ним не принимают: приёмку
    // делает оператор (Р35). Раздел у них пуст всегда — и потому письма нет вовсе.
    expect(await digestFor(ctx.shtab, SERVICE)).toBeNull();
    expect(await digestFor(ctx.dept, SERVICE)).toBeNull();

    // Пусто — не то же самое, что нельзя: право модуля у заказчика есть, и раздел до запроса
    // допускается. Различие важно ровно тем, что «нельзя» проверяется до выборки, а «пусто» — после.
    const shtabPrincipal = await ctx.loadPrincipal(ctx.shtab.id);
    expect(ctx.sectionAllowed('service_requests_waiting', shtabPrincipal!)).toBe(true);
  });

  it('роли без права модуля раздел обслуживания не достаётся вовсе', async () => {
    // У диспетчера справочник оргтехники есть, а заявок на обслуживание нет: их ведёт
    // ответственный за оргтехнику. Проверка у двери, а не по телу письма: области у роли нет, и
    // собранный раздел отдал бы ей заявки всей компании разом.
    const globalPrincipal = await ctx.loadPrincipal(ctx.global.id);
    expect(ctx.sectionAllowed('service_requests_waiting', globalPrincipal!)).toBe(false);
    expect(await digestFor(ctx.global, SERVICE)).toBeNull();

    // А обе стороны цикла раздел получают: без этого предыдущая проверка проходила бы и на
    // ветке, закрывающей раздел вообще всем.
    const operatorPrincipal = await ctx.loadPrincipal(ctx.operator.id);
    const servicePrincipal = await ctx.loadPrincipal(ctx.service.id);
    expect(ctx.sectionAllowed('service_requests_waiting', operatorPrincipal!)).toBe(true);
    expect(ctx.sectionAllowed('service_requests_waiting', servicePrincipal!)).toBe(true);
  });

  it('получателями становятся только действующие учётки с ролью набора и подтверждённым адресом', async () => {
    const recipients = await ctx.digestRecipients(ctx.scheduleId);
    const ids = recipients.map((r) => r.userId);

    expect(ids).toContain(ctx.shtab.id);
    // Область у него пустая, но получателем он всё равно становится: «кому слать» решает роль, а
    // «что показать» — область, и пустое письмо отсекается уже сборкой.
    expect(ids).toContain(ctx.shtabNoScope.id);

    // Адрес без подтверждения (ADR 0072) означает, что за ним может не быть человека, а сводка —
    // рабочие данные компании: отправить их «куда-то» нельзя.
    expect(ids).not.toContain(ctx.unverified.id);
    // Вычеркнутый администратором не получает письма, оставаясь в своей роли.
    expect(ids).not.toContain(ctx.excludedRecipient.id);
    // Выключенная и архивная учётки — тоже не адреса: человек уволен, а письмо ушло бы ему домой.
    expect(ids).not.toContain(ctx.inactive.id);
    expect(ids).not.toContain(ctx.archived.id);
    // Роль — фильтр получателей: диспетчер в набор расписания не входит и письма не получает.
    expect(ids).not.toContain(ctx.global.id);
  });

  it('период считается календарными сутками и календарной неделей, а не «последними N часами»', async () => {
    // Ежедневная сводка — за предыдущий полный день: письмо, отправленное в 8 утра, говорит о
    // вчерашнем дне целиком, а не о промежутке «вчера 8:00 — сегодня 8:00», который человек не
    // соотнесёт ни с чем.
    expect(ctx.digestPeriod(PLANNED_AT, 'daily', TIME_ZONE)).toEqual({
      start: '2099-07-14',
      end: '2099-07-14',
    });

    // Недельная — за прошлую полную неделю, понедельник–воскресенье. Запуск в среду 15 июля 2099:
    // прошлая неделя это 6–12 июля, а не «семь дней назад» (8–14) и не текущая неделя.
    expect(ctx.digestPeriod(PLANNED_AT, 'weekly', TIME_ZONE)).toEqual({
      start: '2099-07-06',
      end: '2099-07-12',
    });
  });
});
