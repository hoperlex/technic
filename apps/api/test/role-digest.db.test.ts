import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatVehicleRequestNumber } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Сборка тела письма из блоков — чистая функция без конфига, поэтому импортируется обычным путём.
import { renderMail } from '../src/services/mail-templates';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type {
  buildRoleDigestMail as BuildRoleDigestMail,
  DigestAudience,
  digestRecipients as DigestRecipients,
  digestScopes as DigestScopes,
} from '../src/services/mailings/role-digest';

/**
 * Ролевая сводка на живой схеме (ADR 0078, ADR 0093): кому уходит письмо и что человек в нём видит.
 *
 * Две половины одного правила. Роль, отмеченные площадки и перечень получателей отвечают на вопрос
 * «кому отправлять» — и только на него: прав они не выдают. Что окажется в письме, решает область
 * видимости самого получателя, собранная из его `Principal` теми же функциями `lib/access.ts`,
 * которыми ограничивает списки портал.
 *
 * Зачем этому тесту база. Ни одну из половин нельзя проверить на правилах: расходятся не правила, а
 * связка «учётка — запрос — схема». Цена расхождения не косметическая — письмо уходит в почтовый
 * ящик, откуда его уже не отозвать: штаб чужой площадки узнаёт номера, сроки и заказчиков заявок, к
 * которым в портале его не пускают. Поэтому «пусто» здесь означает «человеку это не положено», а не
 * «сегодня не завелось».
 *
 * Как из путевых листов собираются строки таблиц, проверяет `digest-waybills.db.test.ts`; чем
 * различаются охваты заявок — `digest-audience.db.test.ts`.
 *
 * Запуск — как у остальных db-тестов; без `TEST_DATABASE_URL` файл пропускается:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test role-digest
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * День рейса и окно письма — заведомо будущие и свои у этого файла: база общая, а сводка роли без
 * области собирается по всему, что попало в окно.
 */
const DAY = '2099-11-03';
/** Окно, в котором не оформлено ничего: им проверяется, что пустая сводка не отправляется. */
const EMPTY_DAY = '2099-11-04';

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
  digestScopes: typeof DigestScopes;
  /** Штаб первой площадки: главный герой проверок на утечку. */
  shtabA: TestUser;
  /** Штаб второй площадки: на нём видно, что отбор по площадкам действительно отсекает. */
  shtabB: TestUser;
  /** Штаб без единого объекта: пустая область — это «ничего», а не «всё». */
  shtabNoScope: TestUser;
  /** Сотрудник отдела: вторая ось области (ADR 0040). */
  dept: TestUser;
  /** Диспетчер — роль без площадко-отдельной оси: отбор по площадкам её не касается. */
  dispatcher: TestUser;
  /** Комендант: право на модуль заявок ТС ему не положено вовсе. */
  commandant: TestUser;
  /** Штаб с неподтверждённым адресом: получателем не становится (ADR 0072). */
  unverified: TestUser;
  /** Штаб с выключенной учёткой и штаб из архива: оба не адреса. */
  inactive: TestUser;
  archived: TestUser;
  objectAId: string;
  objectBId: string;
  departmentId: string;
  vehicleId: string;
  modelId: string;
  driverId: string;
  seriesId: string;
  routeId: string;
  waybillId: string;
  authorId: string;
  /** Расписание с одной ролью в наборе, широкое расписание и расписание без ролей вовсе. */
  scheduleNarrowId: string;
  scheduleWideId: string;
  scheduleNoAddressId: string;
  /** Набор, выдавший коменданту право узкого расписания: чужой источник того же права. */
  grantId: string;
  /** Заявка своей площадки, чужой площадки и отдела — три ответа на «чьё это». */
  requestA: TestRequest;
  requestB: TestRequest;
  requestDept: TestRequest;
}

let ctx: Ctx;
const createdUserIds: string[] = [];
const createdRequestIds: string[] = [];
const createdScheduleIds: string[] = [];

/** СНИЛС с верной контрольной суммой: база общая, номера наполнения в ней заняты. */
function makeSnils(): string {
  const digits = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = digits.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${digits.join('')}${String(checksum).padStart(2, '0')}`;
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
 * Номер в тексте письма ищется по границе цифр. Простой подстрокой «ТС-46» нашёлся бы внутри
 * «ТС-461», и проверка «чужой заявки в письме нет» прошла бы ровно там, где утечка есть.
 */
function hasNumber(text: string, displayNumber: string): boolean {
  return new RegExp(`${displayNumber}(?!\\d)`, 'u').test(text);
}

/** Аудитория «все три оси открыты» — от неё отталкиваются проверки отбора. */
const ALL_AUDIENCE: DigestAudience = {
  scopeMode: 'all',
  objectIds: [],
  departmentIds: [],
  recipientMode: 'all',
};

/** Сводка одному получателю на окне, где оформлен рейс: так её собирает настоящий запуск. */
function digestFor(user: TestUser, day = DAY) {
  return ctx.buildRoleDigestMail({
    recipient: { userId: user.id, fullName: user.fullName, email: user.email },
    windowFrom: day,
    windowTo: day,
    requestScope: 'scope',
    showTrips: true,
    showOnsite: false,
    scopeMode: 'all',
    objectIds: [],
    departmentIds: [],
  });
}

/** Текстовая версия письма: её читают в клиентах без HTML, и в ней видно тело целиком. */
async function digestText(user: TestUser): Promise<string> {
  const mail = await digestFor(user);
  expect(mail).not.toBeNull();
  return renderMail(mail!.content).text;
}

/** Идентификаторы получателей расписания при заданной аудитории. */
async function recipientIds(scheduleId: string, audience: DigestAudience): Promise<string[]> {
  const rows = await ctx.digestRecipients(scheduleId, audience);
  return rows.map((r) => r.userId);
}

describe.skipIf(!DB_URL)('ролевая сводка: получатели и область письма (живая схема)', () => {
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { buildRoleDigestMail, digestRecipients, digestScopes } =
      await import('../src/services/mailings/role-digest');

    async function makeUser(input: {
      tag: string;
      role: 'admin' | 'shtab' | 'department' | 'dispatcher' | 'commandant';
      isActive?: boolean;
      verified?: boolean;
      deleted?: boolean;
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
        })
        .returning({ id: schema.users.id, fullName: schema.users.fullName });
      createdUserIds.push(row!.id);
      return { id: row!.id, email, fullName: row!.fullName };
    }

    const author = await makeUser({ tag: 'author', role: 'admin' });
    const shtabA = await makeUser({ tag: 'shtab-a', role: 'shtab' });
    const shtabB = await makeUser({ tag: 'shtab-b', role: 'shtab' });
    const shtabNoScope = await makeUser({ tag: 'noscope', role: 'shtab' });
    const dept = await makeUser({ tag: 'dept', role: 'department' });
    const dispatcher = await makeUser({ tag: 'disp', role: 'dispatcher' });
    const commandant = await makeUser({ tag: 'comm', role: 'commandant' });
    const unverified = await makeUser({ tag: 'unverified', role: 'shtab', verified: false });
    const inactive = await makeUser({ tag: 'inactive', role: 'shtab', isActive: false });
    const archived = await makeUser({ tag: 'archived', role: 'shtab', deleted: true });

    // Свои площадки и свой отдел, а не чужие из наполнения: на записи наполнения опираются
    // соседние сценарии, и править их тест не вправе.
    const [objectA] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `RD-A-${suffix}`,
        name: `Тестовая площадка своя ${suffix}`,
        address: 'г Москва, ул Своя, д 1',
      })
      .returning({ id: schema.constructionObjects.id });
    const [objectB] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `RD-B-${suffix}`,
        name: `Тестовая площадка чужая ${suffix}`,
        address: 'г Москва, ул Чужая, д 2',
      })
      .returning({ id: schema.constructionObjects.id });
    // Отдел без площадки: производной объектной области (ADR 0062) у него нет — проверяется ось
    // отдела в чистом виде.
    const [department] = await db
      .insert(schema.departments)
      .values({ code: `RD-D-${suffix}`, name: `Тестовый отдел ${suffix}` })
      .returning({ id: schema.departments.id });

    // Область учётки — набором в отдельной таблице (ADR 0039, 0040), как её задаёт портал.
    await db.insert(schema.userConstructionObjects).values([
      { userId: shtabA.id, constructionObjectId: objectA!.id },
      { userId: shtabB.id, constructionObjectId: objectB!.id },
      { userId: commandant.id, constructionObjectId: objectA!.id },
    ]);
    await db
      .insert(schema.userDepartments)
      .values({ userId: dept.id, departmentId: department!.id });

    const typeRes = await db.execute<{ id: string }>(sql`
      SELECT vt.id FROM vehicle_types vt
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE vk.code = 'freight_transport'
      ORDER BY vt.name LIMIT 1`);
    const typeId = typeRes.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типа ТС грузового вида: наполнение не применено');

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
    const [driver] = await db
      .insert(schema.persons)
      .values({
        lastName: `Сводкин${suffix}`,
        firstName: 'Иван',
        middleName: 'Петрович',
        snils: makeSnils(),
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: ролевая сводка',
      })
      .returning({ id: schema.persons.id });

    /** Заявка на грузоперевозку: письму нужны и она сама, и её ездка с адресами. */
    async function makeRequest(input: {
      objectId?: string;
      departmentId?: string;
      loading: string;
    }): Promise<TestRequest> {
      const [request] = await db
        .insert(schema.vehicleRequests)
        .values({
          requestType: 'freight_transport',
          objectId: input.objectId ?? null,
          departmentId: input.departmentId ?? null,
          vehicleTypeId: typeId!,
          status: 'confirmed',
          createdBy: author.id,
        })
        .returning({ id: schema.vehicleRequests.id, num: schema.vehicleRequests.num });
      createdRequestIds.push(request!.id);
      await db.insert(schema.freightTransportRequestDetails).values({
        requestId: request!.id,
        scheduledAt: new Date(`${DAY}T05:30:00Z`),
      });
      // Адреса и количество — у ездки, а не у заявки (план `docs/route-trips-plan.md`, Р2): у
      // заявки с ездками `A→B` и `A→C` «адрес разгрузки заявки» не существует. Одна ездка — то
      // же, чем была пара полей детали.
      await db.insert(schema.vehicleRequestTrips).values({
        requestId: request!.id,
        num: 1,
        fromLocation: input.loading,
        toLocation: 'г Москва, ул Разгрузочная, д 9',
        volumeM3: '10.000',
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

    // Рейс с действующим листом: без листа в сводку не попадает ничего, а проверяется здесь не
    // отбор по листам, а область каждого получателя.
    const [route] = await db
      .insert(schema.vehicleRoutes)
      .values({
        vehicleId: vehicle!.id,
        routeDate: DAY,
        purpose: 'freight',
        driverPersonId: driver!.id,
        createdBy: author.id,
      })
      .returning({ id: schema.vehicleRoutes.id });
    await db.insert(schema.vehicleRouteRequests).values(
      [requestA, requestB, requestDept].map((request, index) => ({
        routeId: route!.id,
        requestId: request.id,
        position: index + 1,
      })),
    );

    const organization = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`,
    );
    const organizationId = organization.rows[0]?.id;
    if (!organizationId) throw new Error('В базе нет организации: наполнение не применено');
    const [series] = await db
      .insert(schema.waybillSeries)
      .values({ code: `rdg${suffix}`, name: `Тестовая серия (сводка) ${suffix}`, nextNumber: 1 })
      .returning({ id: schema.waybillSeries.id });
    const [waybill] = await db
      .insert(schema.waybills)
      .values({
        seriesId: series!.id,
        number: 1,
        formCode: '4p',
        organizationId,
        vehicleId: vehicle!.id,
        driverPersonId: driver!.id,
        issuedForDate: DAY,
        routeId: route!.id,
        issuedBy: author.id,
      })
      .returning({ id: schema.waybills.id });

    /** Расписание сводки: окно «на завтра», аудитория задаётся отдельными таблицами. */
    async function makeSchedule(name: string, permissions: string[]) {
      const [row] = await db
        .insert(schema.mailingSchedules)
        .values({
          type: 'role_digest',
          name: `${name} ${suffix}`,
          isEnabled: true,
          sendAt: '08:00',
          runWeekdays: [1, 2, 3, 4, 5, 6, 7],
          windowFromDays: 1,
          windowDays: 1,
          createdBy: author.id,
        })
        .returning({ id: schema.mailingSchedules.id });
      createdScheduleIds.push(row!.id);
      if (permissions.length > 0) {
        await db
          .insert(schema.mailingSchedulePermissions)
          .values(permissions.map((permission) => ({ scheduleId: row!.id, permission })));
      }
      return row!.id;
    }

    // Узкое расписание адресовано праву заявок на обслуживание: его держат «Штаб» и «Отдел», но не
    // «Диспетчер». Права, отбирающего ровно «Штаб», в словаре нет вовсе — и это не пробел теста, а
    // свойство модели (ADR 0111): право отвечает на вопрос о работе, а не о названии должности, и
    // должность целиком им не выражается.
    const scheduleNarrowId = await makeSchedule('Сводка заказчикам обслуживания', [
      'serviceRequests.create',
    ]);
    const scheduleWideId = await makeSchedule('Сводка широкая', ['vehicleRequests.create']);
    const scheduleNoAddressId = await makeSchedule('Сводка без адресации', []);

    // Назначенный набор (ADR 0106) с тем же правом, что у узкого расписания, — коменданту, у
    // которого этого права по должности нет. Второй источник того же права и есть то, ради чего
    // адресация обязана считать эффективные права, а не разворачивать матрицу ролей.
    const [grant] = await db
      .insert(schema.grants)
      .values({
        code: `db-digest-grant-${suffix}`,
        name: `Тестовый набор (сводка) ${suffix}`,
        createdBy: author.id,
      })
      .returning({ id: schema.grants.id });
    const grantId = grant!.id;
    await db
      .insert(schema.grantRoles)
      .values({ grantId, role: 'commandant' })
      .onConflictDoNothing();
    await db
      .insert(schema.grantPermissions)
      .values({ grantId, permission: 'serviceRequests.create' })
      .onConflictDoNothing();
    await db.insert(schema.userGrants).values({
      userId: commandant.id,
      grantId,
      grantedBy: author.id,
    });
    // Отмеченная площадка и отмеченный получатель: отбор, а не исключение (ADR 0093 п. 5).
    await db
      .insert(schema.mailingScheduleScopes)
      .values({ scheduleId: scheduleWideId, objectId: objectA!.id });
    await db
      .insert(schema.mailingScheduleRecipients)
      .values({ scheduleId: scheduleWideId, userId: shtabA.id });

    ctx = {
      db,
      closeDb,
      schema,
      buildRoleDigestMail,
      digestRecipients,
      digestScopes,
      shtabA,
      shtabB,
      shtabNoScope,
      dept,
      dispatcher,
      commandant,
      unverified,
      inactive,
      archived,
      objectAId: objectA!.id,
      objectBId: objectB!.id,
      departmentId: department!.id,
      vehicleId: vehicle!.id,
      modelId: model!.id,
      driverId: driver!.id,
      seriesId: series!.id,
      routeId: route!.id,
      waybillId: waybill!.id,
      authorId: author.id,
      scheduleNarrowId,
      scheduleWideId,
      scheduleNoAddressId,
      grantId,
      requestA,
      requestB,
      requestDept,
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const { db, schema } = ctx;
    // Убирается только своё и в порядке ссылок: настройки расписаний уходят каскадом за ними, лист
    // держит RESTRICT'ом рейс, заявку, машину и водителя, а учётки держат заявки и рейсы.
    if (createdScheduleIds.length > 0) {
      await db
        .delete(schema.mailingSchedules)
        .where(inArray(schema.mailingSchedules.id, createdScheduleIds));
    }
    // Назначение держит набор RESTRICT'ом: сперва снимается выдача, потом сам набор. Учётку
    // коменданта убирает общий проход по `createdUserIds` ниже — назначение уйдёт за ней каскадом,
    // но набор без явного удаления остался бы в каталоге и портил соседние прогоны.
    await db.delete(schema.userGrants).where(eq(schema.userGrants.grantId, ctx.grantId));
    await db.delete(schema.grants).where(eq(schema.grants.id, ctx.grantId));
    await db.delete(schema.waybills).where(eq(schema.waybills.id, ctx.waybillId));
    await db.delete(schema.waybillSeries).where(eq(schema.waybillSeries.id, ctx.seriesId));
    await db.delete(schema.vehicleRoutes).where(eq(schema.vehicleRoutes.id, ctx.routeId));
    if (createdRequestIds.length > 0) {
      await db
        .delete(schema.vehicleRequests)
        .where(inArray(schema.vehicleRequests.id, createdRequestIds));
    }
    await db.delete(schema.vehicles).where(eq(schema.vehicles.id, ctx.vehicleId));
    await db.delete(schema.vehicleModels).where(eq(schema.vehicleModels.id, ctx.modelId));
    await db.delete(schema.persons).where(eq(schema.persons.id, ctx.driverId));
    // Связи учёток с площадками и отделами уходят каскадом за учёткой.
    if (createdUserIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
    }
    await db.delete(schema.departments).where(eq(schema.departments.id, ctx.departmentId));
    await db
      .delete(schema.constructionObjects)
      .where(inArray(schema.constructionObjects.id, [ctx.objectAId, ctx.objectBId]));
    await ctx.closeDb();
  });

  describe('кому уходит сводка', () => {
    it('право отбирает получателей: у кого его нет, письма не получает', async () => {
      const narrow = await recipientIds(ctx.scheduleNarrowId, ALL_AUDIENCE);
      expect(narrow).toContain(ctx.shtabA.id);
      expect(narrow).toContain(ctx.shtabB.id);
      // Область у него пустая, но получателем он всё равно становится: «кому слать» решает право,
      // а «что показать» — область, и пустое письмо отсекается уже сборкой.
      expect(narrow).toContain(ctx.shtabNoScope.id);
      // Диспетчер заявок на обслуживание не заводит — права нет, письма нет.
      expect(narrow).not.toContain(ctx.dispatcher.id);
      // А сотрудник отдела заводит их наравне со штабом, и адресация правом это видит. Прежняя
      // адресация ролью различала бы их только потому, что должности называются по-разному.
      expect(narrow).toContain(ctx.dept.id);

      // Без этой половины первая проходила бы и на выборке, не отдающей никого вообще.
      const wide = await recipientIds(ctx.scheduleWideId, ALL_AUDIENCE);
      expect(wide).toContain(ctx.dispatcher.id);
      expect(wide).toContain(ctx.dept.id);
    });

    it('право, пришедшее назначенным набором, адресует письмо наравне с правом должности', async () => {
      // Главное свойство переезда (ADR 0111): адресация считает ЭФФЕКТИВНОЕ право. У коменданта
      // права заводить заявки на обслуживание нет по должности — оно выдано ему набором, и письмо
      // обязано уйти ему тоже. Забудь отбор про наборы — держатель полномочия не получал бы сводку,
      // адресованную ровно его работе, и узнал бы об этом ненаступившим письмом.
      expect(await recipientIds(ctx.scheduleNarrowId, ALL_AUDIENCE)).toContain(ctx.commandant.id);

      // Мягко удалённый набор не действует ни у кого — тем же правилом, что у принципала.
      await ctx.db
        .update(ctx.schema.grants)
        .set({ deletedAt: new Date() })
        .where(eq(ctx.schema.grants.id, ctx.grantId));
      expect(await recipientIds(ctx.scheduleNarrowId, ALL_AUDIENCE)).not.toContain(
        ctx.commandant.id,
      );
      await ctx.db
        .update(ctx.schema.grants)
        .set({ deletedAt: null })
        .where(eq(ctx.schema.grants.id, ctx.grantId));
    });

    it('отмеченные площадки отсекают штаб чужой площадки, но не диспетчера', async () => {
      // Отметки читаются из таблицы расписания — той самой, что переименована из «исключений» в
      // «отбор» (ADR 0093 п. 5): прочитай её кто-нибудь по-старому, набор получателей вывернется
      // наизнанку и письма уйдут ровно тем, кого выбирать не собирались.
      const scopes = await ctx.digestScopes(ctx.scheduleWideId);
      expect(scopes.objectIds).toEqual([ctx.objectAId]);

      const ids = await recipientIds(ctx.scheduleWideId, {
        ...ALL_AUDIENCE,
        scopeMode: 'selected',
        objectIds: scopes.objectIds,
      });
      expect(ids).toContain(ctx.shtabA.id);
      expect(ids).not.toContain(ctx.shtabB.id);
      expect(ids).not.toContain(ctx.shtabNoScope.id);
      // Роль без площадко-отдельной оси отбором по площадкам не отсекается: вычитать из области,
      // которой не существует, нечего, а «выбрал Северный» не должно означать «выбросил
      // диспетчера» — то есть ровно того, ради кого рассылку обычно и заводят.
      expect(ids).toContain(ctx.dispatcher.id);
      // Ось у сотрудника отдела есть, но другая: отметка площадок его не выбирает.
      expect(ids).not.toContain(ctx.dept.id);

      const withDepartment = await recipientIds(ctx.scheduleWideId, {
        ...ALL_AUDIENCE,
        scopeMode: 'selected',
        objectIds: scopes.objectIds,
        departmentIds: [ctx.departmentId],
      });
      expect(withDepartment).toContain(ctx.dept.id);
      // Отдел добавился, а чужая площадка так и не попала: оси складываются, а не отменяют друг
      // друга.
      expect(withDepartment).not.toContain(ctx.shtabB.id);
    });

    it('перечень получателей сужает набор до отмеченных поимённо', async () => {
      const ids = await recipientIds(ctx.scheduleWideId, {
        ...ALL_AUDIENCE,
        recipientMode: 'selected',
      });

      expect(ids).toContain(ctx.shtabA.id);
      // Роль у них та же, площадка подходит — не подходит только то, что их не отметили.
      expect(ids).not.toContain(ctx.shtabB.id);
      expect(ids).not.toContain(ctx.dispatcher.id);
      expect(ids).not.toContain(ctx.dept.id);
    });

    it('неподтверждённый адрес, выключенная и удалённая учётки получателями не становятся', async () => {
      const ids = await recipientIds(ctx.scheduleNarrowId, ALL_AUDIENCE);

      // Адрес без подтверждения (ADR 0072) означает, что за ним может не быть человека, а сводка
      // — рабочие данные компании: отправить их «куда-то» нельзя.
      expect(ids).not.toContain(ctx.unverified.id);
      // Выключенная и архивная учётки — тоже не адреса: человек уволен, а письмо ушло бы ему домой.
      expect(ids).not.toContain(ctx.inactive.id);
      expect(ids).not.toContain(ctx.archived.id);
    });

    it('расписание без единого права не находит никого', async () => {
      // Пустой набор прав — не «все права»: понятый так, он разослал бы рабочую сводку всему
      // справочнику учёток разом. Контракт такого расписания не пропускает, но отбор не вправе
      // зависеть от того, удержалась ли та проверка. Так же выглядит расписание, которому переезд
      // на права не нашёл эквивалента: оно молчит, пока его не настроит человек.
      expect(await recipientIds(ctx.scheduleNoAddressId, ALL_AUDIENCE)).toEqual([]);
    });
  });

  describe('что человек видит в письме', () => {
    it('штаб видит заявку своей площадки и не видит заявки чужой', async () => {
      const text = await digestText(ctx.shtabA);

      expect(hasNumber(text, ctx.requestA.number)).toBe(true);
      // Главная проверка файла: заявка соседней площадки в портале штабу не видна, и письмо не
      // должно быть дырой, через которую она к нему приходит.
      expect(hasNumber(text, ctx.requestB.number)).toBe(false);
      expect(text).not.toContain('ул Чужая');
      // Заявка отдела — тоже не его: ось у роли одна.
      expect(hasNumber(text, ctx.requestDept.number)).toBe(false);
    });

    it('роль отдела видит заявки своего отдела, а площадочные — нет', async () => {
      const text = await digestText(ctx.dept);

      expect(hasNumber(text, ctx.requestDept.number)).toBe(true);
      // Ось у роли одна (ADR 0040): отдел заказывает от себя, и площадочные заявки к нему
      // отношения не имеют — ни своей площадки, ни чужой у него нет вовсе.
      expect(hasNumber(text, ctx.requestA.number)).toBe(false);
      expect(hasNumber(text, ctx.requestB.number)).toBe(false);
    });

    it('роль без области видит все три заявки: письмо режет область, а не фильтр вообще', async () => {
      const text = await digestText(ctx.dispatcher);

      // Без этой проверки обе предыдущие проходили бы и на сломанной выборке, которая не отдаёт
      // никому ничего: «чужого не видно» и «не видно ничего» — разные состояния.
      expect(hasNumber(text, ctx.requestA.number)).toBe(true);
      expect(hasNumber(text, ctx.requestB.number)).toBe(true);
      expect(hasNumber(text, ctx.requestDept.number)).toBe(true);
    });

    it('штабу без единого объекта письма нет вовсе: пустая область — это «ничего», а не «всё»', async () => {
      // Учётка объектной роли без объектов — состояние, которого API не допускает, но выборка не
      // должна зависеть от того, удержалась ли та проверка: незаполненная область, понятая как
      // «ограничений нет», отдала бы человеку заявки всех площадок компании.
      expect(await digestFor(ctx.shtabNoScope)).toBeNull();
    });

    it('роли без права на модуль письма нет вовсе', async () => {
      // Комендант ведёт на площадке только вывоз мусора: заявок на технику он не видит в портале
      // и не должен получать их письмом. Проверка стоит до запросов — «пусто» и «нельзя» разные
      // состояния, и путать их значит однажды показать чужие данные из-за одной забытой строчки.
      expect(await digestFor(ctx.commandant)).toBeNull();
    });

    it('пустая сводка не отправляется', async () => {
      // «На завтра рейсов нет» — не новость, ради которой стоит писать человеку каждый вечер:
      // такие письма перестают читать, а вместе с ними перестают читать непустые.
      expect(await digestFor(ctx.dispatcher, EMPTY_DAY)).toBeNull();
    });
  });
});
