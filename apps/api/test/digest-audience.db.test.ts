import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DigestRequestScope, formatVehicleRequestNumber } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Сборка тела письма из блоков — чистая функция без конфига, поэтому импортируется обычным путём.
import { renderMail } from '../src/services/mail-templates';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type { buildRoleDigestMail as BuildRoleDigestMail } from '../src/services/mailings/role-digest';

/**
 * Охват данных сводки (ADR 0093 п. 9–10): чьи заявки видит получатель.
 *
 * Настроек здесь две, и они отвечают на разные вопросы. Охват (`request_scope`) — «чьи заявки
 * показывать»: свои, всю свою область или область, пересечённую с отмеченным в расписании.
 * Отмеченные площадки и отделы — «кому писать», и в данные они входят **только** при охвате `all`;
 * этим он от `scope` и отличается.
 *
 * Железное условие, при котором вся затея допустима: ни одно значение охвата не расширяет область
 * получателя. `all` — это «всё, что человек и так видит в портале, за вычетом неотмеченного», а не
 * «всё, что есть в базе». Проверять это надо именно на роли со своей осью: у диспетчера, который
 * видит всё, ошибка пересечения незаметна, и письмо со всей компанией внутри выглядит правильным.
 *
 * Отсюда и база: и область, и охват — это условия `WHERE`, собранные из `Principal` и настроек
 * расписания. Ошибка в них не роняет ничего — она отправляет штабу чужой площадки номера, сроки и
 * заказчиков заявок, к которым в портале его не пускают, и отозвать письмо из ящика уже нельзя.
 *
 * Запуск — как у остальных db-тестов; без `TEST_DATABASE_URL` файл пропускается:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test digest-audience
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * День рейса и окно письма — заведомо будущие и свои у этого файла: база общая, а сводка
 * диспетчера собирается без области видимости и потому видит всё, что попало в окно.
 */
const DAY = '2099-10-02';

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
  /** Диспетчер: роль без площадко-отдельной оси, область — вся компания. */
  dispatcher: TestUser;
  /** Штаб первой площадки: главный герой проверок на утечку. */
  shtabA: TestUser;
  objectAId: string;
  objectBId: string;
  vehicleId: string;
  modelId: string;
  driverId: string;
  organizationId: string;
  seriesId: string;
  authorId: string;
  routeId: string;
  waybillId: string;
  /** Заявка своей площадки, чужой площадки и две «своих» — диспетчера и штаба. */
  requestA: TestRequest;
  requestB: TestRequest;
  requestOfDispatcher: TestRequest;
  requestOfShtab: TestRequest;
}

let ctx: Ctx;
const createdRequestIds: string[] = [];
const createdUserIds: string[] = [];

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

/**
 * Сводка одному получателю с заданным охватом. Таблица одна — перевозки: как из листов собираются
 * строки, проверяет `digest-waybills.db.test.ts`, а здесь вопрос ровно один — чьи заявки в них.
 */
function digestFor(
  user: TestUser,
  scope: DigestRequestScope,
  marked: { objectIds?: string[]; selected?: boolean } = {},
) {
  return ctx.buildRoleDigestMail({
    recipient: { userId: user.id, fullName: user.fullName, email: user.email },
    windowFrom: DAY,
    windowTo: DAY,
    requestScope: scope,
    showTrips: true,
    showOnsite: false,
    scopeMode: marked.selected ? 'selected' : 'all',
    objectIds: marked.objectIds ?? [],
    departmentIds: [],
  });
}

/** Текстовая версия письма: её читают в клиентах без HTML, и в ней видно тело целиком. */
async function digestText(
  user: TestUser,
  scope: DigestRequestScope,
  marked?: { objectIds?: string[]; selected?: boolean },
): Promise<string> {
  const mail = await digestFor(user, scope, marked);
  expect(mail).not.toBeNull();
  return renderMail(mail!.content).text;
}

describe.skipIf(!DB_URL)('охват данных сводки (живая схема)', () => {
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { buildRoleDigestMail } = await import('../src/services/mailings/role-digest');

    async function makeUser(
      tag: string,
      role: 'admin' | 'dispatcher' | 'shtab',
    ): Promise<TestUser> {
      const email = `db-scope-${tag}-${suffix}@example.invalid`;
      const [row] = await db
        .insert(schema.users)
        .values({
          email,
          lastName: 'Тестовый',
          firstName: 'Получатель',
          middleName: tag,
          // Входа в этом тесте нет: письмо собирается сервисом, а не через HTTP.
          passwordHash: 'db-test-not-a-hash',
          role,
          isActive: true,
          emailVerifiedAt: new Date(),
        })
        .returning({ id: schema.users.id, fullName: schema.users.fullName });
      createdUserIds.push(row!.id);
      return { id: row!.id, email, fullName: row!.fullName };
    }

    const author = await makeUser('author', 'admin');
    const dispatcher = await makeUser('disp', 'dispatcher');
    const shtabA = await makeUser('shtab-a', 'shtab');

    const [objectA] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `SCP-A-${suffix}`,
        name: `Тестовая площадка своя ${suffix}`,
        address: 'г Москва, ул Своя, д 1',
      })
      .returning({ id: schema.constructionObjects.id });
    const [objectB] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `SCP-B-${suffix}`,
        name: `Тестовая площадка чужая ${suffix}`,
        address: 'г Москва, ул Чужая, д 2',
      })
      .returning({ id: schema.constructionObjects.id });
    // Область учётки — набором в отдельной таблице (ADR 0039), как её задаёт портал.
    await db
      .insert(schema.userConstructionObjects)
      .values({ userId: shtabA.id, constructionObjectId: objectA!.id });

    const typeRes = await db.execute<{ id: string }>(sql`
      SELECT vt.id FROM vehicle_types vt
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE vk.code = 'freight_transport'
      ORDER BY vt.name LIMIT 1`);
    const typeId = typeRes.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типа ТС грузового вида: наполнение не применено');

    const [model] = await db
      .insert(schema.vehicleModels)
      .values({ vehicleTypeId: typeId, name: `Тестовый самосвал (охват) ${suffix}` })
      .returning({ id: schema.vehicleModels.id });
    const [vehicle] = await db
      .insert(schema.vehicles)
      .values({
        ownership: 'own',
        vehicleTypeId: typeId,
        vehicleModelId: model!.id,
        registrationNumber: `О${suffix.slice(0, 3).toUpperCase()}399`,
        status: 'active',
      })
      .returning({ id: schema.vehicles.id });

    const [driver] = await db
      .insert(schema.persons)
      .values({
        lastName: `Охватов${suffix}`,
        firstName: 'Иван',
        middleName: 'Петрович',
        snils: makeSnils(),
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: охват сводки',
      })
      .returning({ id: schema.persons.id });

    /** Заявка на грузоперевозку: письму нужны и она сама, и её detail-строка с адресами. */
    async function makeRequest(input: {
      objectId: string;
      createdBy: string;
      tag: string;
    }): Promise<TestRequest> {
      const [request] = await db
        .insert(schema.vehicleRequests)
        .values({
          requestType: 'freight_transport',
          objectId: input.objectId,
          vehicleTypeId: typeId!,
          status: 'confirmed',
          createdBy: input.createdBy,
        })
        .returning({ id: schema.vehicleRequests.id, num: schema.vehicleRequests.num });
      createdRequestIds.push(request!.id);
      await db.insert(schema.freightTransportRequestDetails).values({
        requestId: request!.id,
        scheduledAt: new Date(`${DAY}T05:30:00Z`),
        volumeM3: '10.000',
        loadingLocation: `г Москва, ул Погрузочная, д 1 (${input.tag})`,
        unloadingLocation: `г Москва, ул Разгрузочная, д 2 (${input.tag})`,
      });
      return { id: request!.id, number: formatVehicleRequestNumber(request!.num) };
    }

    const requestA = await makeRequest({
      objectId: objectA!.id,
      createdBy: author.id,
      tag: 'своя',
    });
    const requestB = await makeRequest({
      objectId: objectB!.id,
      createdBy: author.id,
      tag: 'чужая',
    });
    // Заявки, заведённые самими получателями: только их и показывает охват «свои».
    const requestOfDispatcher = await makeRequest({
      objectId: objectA!.id,
      createdBy: dispatcher.id,
      tag: 'диспетчера',
    });
    const requestOfShtab = await makeRequest({
      objectId: objectA!.id,
      createdBy: shtabA.id,
      tag: 'штаба',
    });

    // Один рейс с действующим листом на все четыре заявки: без листа в сводку не попадает ничего,
    // а сравнивать надо охваты — не сборку таблицы.
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
      [requestA, requestB, requestOfDispatcher, requestOfShtab].map((request, index) => ({
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
      .values({ code: `scp${suffix}`, name: `Тестовая серия (охват) ${suffix}`, nextNumber: 1 })
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

    ctx = {
      db,
      closeDb,
      schema,
      buildRoleDigestMail,
      dispatcher,
      shtabA,
      objectAId: objectA!.id,
      objectBId: objectB!.id,
      vehicleId: vehicle!.id,
      modelId: model!.id,
      driverId: driver!.id,
      organizationId,
      seriesId: series!.id,
      authorId: author.id,
      routeId: route!.id,
      waybillId: waybill!.id,
      requestA,
      requestB,
      requestOfDispatcher,
      requestOfShtab,
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const { db, schema } = ctx;
    // Порядок — по ссылкам: лист держит RESTRICT'ом рейс, заявку, машину и водителя; рейс держит
    // заявки; заявки держат учётки авторов.
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
    if (createdUserIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
    }
    await db
      .delete(schema.constructionObjects)
      .where(inArray(schema.constructionObjects.id, [ctx.objectAId, ctx.objectBId]));
    await ctx.closeDb();
  });

  it('охват «свои заявки» показывает только заведённые самим получателем', async () => {
    const text = await digestText(ctx.dispatcher, 'author');

    // Диспетчер видит в портале все заявки компании; «свои» — это сужение поверх области, ради
    // которого настройку и заводят: письмо про его собственную работу, а не про чужую.
    expect(hasNumber(text, ctx.requestOfDispatcher.number)).toBe(true);
    expect(hasNumber(text, ctx.requestA.number)).toBe(false);
    expect(hasNumber(text, ctx.requestB.number)).toBe(false);
    expect(hasNumber(text, ctx.requestOfShtab.number)).toBe(false);
    // Первая строка письма говорит, чьими глазами оно собрано: без неё сводка «свои» и сводка
    // «вся область» выглядят одинаково, а разница между ними — в том, чего в письме нет.
    expect(text).toContain('Охват: заявки, поданные вами');
  });

  it('охват «его область» показывает диспетчеру обе площадки', async () => {
    const text = await digestText(ctx.dispatcher, 'scope');

    // Без этой проверки все остальные проходили бы и на сломанной выборке, которая не отдаёт
    // никому ничего: «чужого не видно» и «не видно ничего» — разные состояния.
    expect(hasNumber(text, ctx.requestA.number)).toBe(true);
    expect(hasNumber(text, ctx.requestB.number)).toBe(true);
    expect(hasNumber(text, ctx.requestOfShtab.number)).toBe(true);
  });

  it('отмеченные площадки сужают данные при охвате «все», но не при «его область»', async () => {
    const all = await digestText(ctx.dispatcher, 'all', {
      selected: true,
      objectIds: [ctx.objectAId],
    });
    // Единственное, чем `all` отличается от `scope`: отмеченное в расписании входит в данные.
    expect(hasNumber(all, ctx.requestA.number)).toBe(true);
    expect(hasNumber(all, ctx.requestB.number)).toBe(false);
    expect(all).not.toContain('ул Чужая');

    const scope = await digestText(ctx.dispatcher, 'scope', {
      selected: true,
      objectIds: [ctx.objectAId],
    });
    // При `scope` те же отметки работают только на отбор получателей: применить их к данным
    // значило бы лишить настройку «кому писать» её единственного смысла.
    expect(hasNumber(scope, ctx.requestA.number)).toBe(true);
    expect(hasNumber(scope, ctx.requestB.number)).toBe(true);
  });

  it('штаб чужой площадки не видит её ни при одном значении охвата', async () => {
    for (const scope of ['scope', 'all'] as const) {
      const text = await digestText(ctx.shtabA, scope);
      expect(hasNumber(text, ctx.requestA.number)).toBe(true);
      // Главная проверка файла: заявка соседней площадки в портале штабу не видна, и письмо не
      // должно быть дырой, через которую она к нему приходит.
      expect(hasNumber(text, ctx.requestB.number)).toBe(false);
      expect(text).not.toContain('ул Чужая');
    }

    // Отметка чужой площадки в расписании область не расширяет: пересечение с областью штаба
    // пусто, и письма нет вовсе — а не «письмо про чужую площадку».
    expect(
      await digestFor(ctx.shtabA, 'all', { selected: true, objectIds: [ctx.objectBId] }),
    ).toBeNull();
  });

  it('охват «свои заявки» не расширяет область объектной роли', async () => {
    const text = await digestText(ctx.shtabA, 'author');

    expect(hasNumber(text, ctx.requestOfShtab.number)).toBe(true);
    // Заявка его же площадки, заведённая другим человеком, при охвате «свои» не показывается:
    // сужение считается поверх области, а не вместо неё.
    expect(hasNumber(text, ctx.requestA.number)).toBe(false);
    expect(hasNumber(text, ctx.requestB.number)).toBe(false);
  });

  it('в письме штаба стоит его собственная площадка, а не площадки рассылки', async () => {
    const text = await digestText(ctx.shtabA, 'scope');
    expect(text).toContain('ваши площадки');
    expect(text).toContain(`Тестовая площадка своя ${suffix}`);
  });
});
