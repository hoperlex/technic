import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addressKeyOf,
  formatPhone,
  moscowDateKeyOf,
  shiftDateKey,
  taskAddressKey,
  type VehicleRouteDto,
  waybillIssueWarnings,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { issueRouteWaybill } from './waybill-issue-helper';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Контакт точки живой, адрес — снимком (план `docs/route-trips-plan.md`, Р9в и Р9г).
 *
 * Пара выглядит непоследовательно: одно и то же поле карточки в одном случае берётся из заявки
 * сейчас, а в другом остаётся тем, каким было при сборке дня. Так и задумано, и разница не в
 * небрежности: адрес печатается на бумаге и определяет, куда поедет машина, — переписать его молча
 * значит развести собранный день с выданным листом; телефон водитель набирает уже в дороге, и
 * напечатать вчерашний номер, «потому что так было при сборке», — ровно та беда, от которой снимок
 * должен защищать. Файл фиксирует обе половины вместе, чтобы следующая правка не «привела их к
 * одному виду», не заметив, что вид у них разный намеренно.
 *
 * Почему db-тест. Проверяется не функция, а то, что контакта **нигде нет** снимком: он выводится
 * из ролей точки чтением заявки (§5.2), и доказать это можно только правкой заявки, после которой
 * карточку читают заново. Копия контакта, заведённая где угодно по пути — колонкой точки, полем
 * связки, кэшем DTO, — здесь и обнаружится: карточка покажет старый телефон.
 *
 * Вторая половина — цена этого решения (Р9в): раз контакт живой, открытая карточка рейса обязана
 * узнать, что он изменился, и узнаёт она это версией. У линейного заказа дни разложены по разным
 * рейсам (Р7), и версию поднимают **всем** незамороженным — «маршрут заявки» в единственном числе
 * здесь описать нельзя.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-contact-live-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка тестовых людей: по ней их и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: живой контакт точки';
/** Уникальный хвост прогона: коды справочников уникальны, а база переживает прогоны. */
const RUN = Date.now().toString(36);
/**
 * Коды заведённых записей — с «яя»: половина db-тестов берёт объект и тип из справочника
 * выражением `ORDER BY … LIMIT 1`, и запись, ставшая первой, молча увела бы их заявки на тестовую
 * площадку. У типа тем же приёмом начинается наименование: код у него только латиницей.
 */
const OBJECT_CODE = `яя-contact-live-${RUN}`;
const TYPE_PREFIX = `contact_live_${RUN}`;
const TYPE_NAME_PREFIX = 'Ямобуры тестовые (живой контакт';

/** Контакты: номера выдуманы и своими цифрами ни на кого не похожи — база общая. */
const SITE = { name: 'Площадкин Семён Артёмович', phone: '9007770761' };
const SITE_NEXT = { name: 'Сменщиков Игорь Валерьевич', phone: '9007770762' };
/** Третий контакт — им заявку правят прямо в базе, мимо дверей: снимку взяться было бы неоткуда. */
const SITE_DIRECT = { name: 'Прямиков Олег Никитич', phone: '9007770766' };
const LOADING = { name: 'Складов Афанасий Юрьевич', phone: '9007770763' };
const LOADING_NEXT = { name: 'Весовщиков Пётр Егорович', phone: '9007770764' };
const UNLOADING = { name: 'Приёмов Валентин Тарасович', phone: '9007770765' };

/** Адрес площадки: его текст и правится в случае Р9г — семантический ключ при этом не меняется. */
const OBJECT_ADDRESS = 'г Москва, ул Живая, д 1';
const OBJECT_ADDRESS_FIXED = 'г Москва, ул Живая, д 3, стр 2';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  objectId: string;
  objectName: string;
  vehicleId: string;
  otherVehicleId: string;
  driverId: string;
  /** Линейный тип и обычный — оба грузового вида: рейс дня печатает тот же бланк 4-П. */
  linearTypeId: string;
  plainTypeId: string;
  dateFrom: string;
  dateTo: string;
  dayA: string;
  dayB: string;
}

let ctx: Ctx;

/** Что завёл этот файл: по этим спискам он за собой и убирает. */
const createdRequests: string[] = [];
const createdRoutes: string[] = [];

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // S3 в этом сценарии не участвует, но конфиг обязателен — заглушки заведомо нерабочие.
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

async function seedAdmin(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (existing) return;
  await db.insert(schema.users).values({
    email: ADMIN_EMAIL,
    lastName: 'Тестовый',
    firstName: 'Администратор',
    middleName: '',
    passwordHash: await hashPassword(PASSWORD),
    role: 'admin',
    isActive: true,
  });
}

/** Водитель рейса: человек со специализацией «водитель» — большего отбор водителя не спрашивает. */
async function seedDriver(): Promise<string> {
  const { db } = await import('../src/db/client');
  const schema = await import('../src/db/schema');

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  if (!specialization) throw new Error('в справочнике нет специализации «водитель»');

  const [person] = await db
    .insert(schema.persons)
    .values({
      lastName: 'Живов',
      firstName: 'Тест',
      middleName: 'Контактович',
      comment: PERSON_MARK,
    })
    .returning({ id: schema.persons.id });
  await db.insert(schema.personSpecializations).values({
    personId: person!.id,
    specializationId: specialization.id,
    isPrimary: true,
    startedOn: '2024-01-15',
  });
  return person!.id;
}

/**
 * Своя площадка: чужую запись справочника тест не трогает, а свою правит и убирает за собой.
 * Правка адреса — предмет случая Р9г, и делать её на общем объекте нельзя.
 */
async function createObject(): Promise<{ id: string; name: string }> {
  const { db } = await import('../src/db/client');
  const name = `Площадка живого контакта ${RUN}`;
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${OBJECT_CODE}, ${name}, ${OBJECT_ADDRESS})
    RETURNING id`);
  return { id: rows.rows[0]!.id, name };
}

async function createType(app: Ctx['app'], auth: Ctx['auth'], kindId: string, isLinear: boolean) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: auth,
    payload: {
      kindId,
      code: `${TYPE_PREFIX}_${isLinear ? 'lin' : 'plain'}`,
      name: `${TYPE_NAME_PREFIX}, ${isLinear ? 'линейный' : 'обычный'} ${RUN})`,
      isLinear,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Виза руководителя: без неё заявку в работу не берут. */
async function approve(request: { id: string; version: number }): Promise<number> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.auth,
    payload: { approved: true, version: request.version },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

/** Линейный заказ в работе: дни он получает отдельно, по одному на рейс (Р7). */
async function linearInProgress(): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.linearTypeId,
      dateFrom: ctx.dateFrom,
      dateTo: ctx.dateTo,
      responsibleName: SITE.name,
      responsiblePhone: SITE.phone,
      comment: 'Планировка площадки',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();
  createdRequests.push(request.id as string);

  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.auth,
    payload: {
      status: 'confirmed',
      comment: '',
      version: await approve(request),
      assignment: {
        vehicleId: ctx.vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.driverId,
      },
      schedule: {
        requestType: 'special_equipment',
        dateFrom: ctx.dateFrom,
        dateTo: ctx.dateTo,
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return { id: request.id as string, version: confirmed.json().version as number };
}

/**
 * Ездка с названным ответственным погрузки. Оба конца — одна и та же запись справочника: жёсткая
 * модель (ADR 0006) свободного текста у новой ездки не принимает, а в две точки их всё равно
 * разводят разные ответственные (Р9) — ровно то, что здесь и нужно.
 */
function freightTrip(from: { name: string; phone: string }): Record<string, unknown> {
  return {
    fromLocation: OBJECT_ADDRESS,
    toLocation: OBJECT_ADDRESS,
    fromAddress: { source: 'object', refId: ctx.objectId },
    toAddress: { source: 'object', refId: ctx.objectId },
    volumeM3: 12,
    fromResponsibleName: from.name,
    fromResponsiblePhone: from.phone,
    toResponsibleName: UNLOADING.name,
    toResponsiblePhone: UNLOADING.phone,
  };
}

/**
 * Грузоперевозка в работе вместе со своим рейсом: контакт у неё лежит в **ездке**, а не в заявке,
 * и живым он обязан быть тем же самым образом — иначе половина Р9в держалась бы только у линейных.
 */
async function freightInProgress(): Promise<{ id: string; version: number; routeId: string }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.plainTypeId,
      scheduledAt: `${ctx.dateFrom}T10:00:00+03:00`,
      trips: [freightTrip(LOADING)],
      comment: 'Песок сеяный',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();
  createdRequests.push(request.id as string);

  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.auth,
    payload: {
      status: 'confirmed',
      comment: '',
      version: await approve(request),
      assignment: {
        vehicleId: ctx.vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        route: { newRoute: { driverPersonId: ctx.driverId } },
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  const dto = confirmed.json();
  expect(dto.route, confirmed.body).not.toBeNull();
  createdRoutes.push(dto.route.id as string);
  return { id: request.id as string, version: dto.version as number, routeId: dto.route.id };
}

/** Поставить день заказа в новый рейс: у каждого дня свой (Р7), и версии у них считаются врозь. */
async function planDay(requestId: string, date: string, vehicleId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/days/${date}/route`,
    headers: ctx.auth,
    payload: { newRoute: { vehicleId, driverPersonId: ctx.driverId } },
  });
  expect(res.statusCode, res.body).toBe(200);
  const day = res.json().items.find((d: { date: string }) => d.date === date);
  expect(day?.route, res.body).toBeTruthy();
  createdRoutes.push(day.route.id as string);
  return day.route.id as string;
}

/** Карточка рейса целиком: точки с ролями, контактами и версией — то, что видит диспетчер. */
async function routeCard(routeId: string): Promise<VehicleRouteDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-routes/${routeId}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as VehicleRouteDto;
}

/** Версия заявки на сейчас: её спрашивает всякая правка. */
async function requestVersion(requestId: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${requestId}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

/** Правка заявки — той же дверью, которой её правит человек. */
async function patchRequest(
  requestId: string,
  payload: Record<string, unknown>,
): Promise<ReturnType<typeof ctx.app.inject>> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${requestId}`,
    headers: ctx.auth,
    payload: { version: await requestVersion(requestId), ...payload },
  });
}

/**
 * Предупреждения выписки по карточке рейса — тем же расчётом, что показывает окно подтверждения
 * (Р21). Считаются из точек: расхождение адреса рождается здесь, и никакой другой двери у него нет.
 */
function warningCodesOf(route: VehicleRouteDto): string[] {
  return waybillIssueWarnings({
    routeId: route.id,
    routeNumber: route.displayNumber,
    formCode: route.formCode,
    driver: null,
    points: route.points,
  }).map((w) => w.facts.code);
}

/** Все контакты всех точек рейса подряд — «кому звонить», как это читает карточка. */
function contactsOf(route: VehicleRouteDto): { name: string; phone: string }[] {
  return route.points.flatMap((point) => point.contacts);
}

/** Стоит ли на рейсе хоть одно расхождение адреса (Р10): по флагам ролей, а не по тексту. */
function mismatchesOf(route: VehicleRouteDto): number {
  return route.points.flatMap((p) => p.actions).filter((a) => a.addressMismatch).length;
}

describe.skipIf(!DB_URL)('контакт живой, адрес снимком (Р9в, Р9г)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    await seedAdmin();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const auth = { authorization: `Bearer ${login.json().accessToken}` };

    // Машины — из справочника: их наполняют миграции, а рейс заводится только на собственную
    // активную технику грузового вида с бланком 4-П.
    const vehicles = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vt.waybill_form_code = '4p' AND vk.code = 'freight_transport'
      ORDER BY v.registration_number
      LIMIT 2`);
    const [first, second] = vehicles.rows;
    if (!first || !second) {
      throw new Error('в базе нет двух своих грузовых машин с бланком 4-П: миграции не применены');
    }

    const today = moscowDateKeyOf(new Date());
    const object = await createObject();
    ctx = {
      app,
      db,
      closeDb,
      auth,
      objectId: object.id,
      objectName: object.name,
      vehicleId: first.id,
      otherVehicleId: second.id,
      driverId: await seedDriver(),
      linearTypeId: await createType(app, auth, first.kind_id, true),
      plainTypeId: await createType(app, auth, first.kind_id, false),
      dateFrom: today,
      dateTo: shiftDateKey(today, 7),
      dayA: shiftDateKey(today, 1),
      dayB: shiftDateKey(today, 2),
    };
  }, 120_000);

  afterAll(async () => {
    /*
     * За собой убираем: база у db-тестов общая, и заведённые здесь заказы с рейсами иначе видны
     * соседним файлам — журналу листов, отборам списка заявок, сводкам рассылок. Порядок обратный
     * ссылкам: сначала листы (они держат и рейс, и заявку ключами `restrict`), потом рейсы (состав
     * уходит каскадом), потом заявки, площадка, типы и люди. Учётка теста остаётся намеренно — на
     * неё ссылается журнал аудита, а `seedAdmin` переиспользует её при следующем прогоне.
     */
    if (ctx?.db) {
      const requests = sql.param(createdRequests);
      const routes = sql.param(createdRoutes);
      await ctx.db.execute(sql`
        DELETE FROM waybills
        WHERE route_id = ANY(${routes}::uuid[]) OR source_request_id = ANY(${requests}::uuid[])`);
      await ctx.db.execute(sql`DELETE FROM vehicle_routes WHERE id = ANY(${routes}::uuid[])`);
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id = ANY(${requests}::uuid[])`);
      await ctx.db.execute(sql`
        DELETE FROM construction_objects
        WHERE code = ${OBJECT_CODE}
          AND id NOT IN (SELECT object_id FROM vehicle_requests WHERE object_id IS NOT NULL)`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_types
        WHERE code LIKE ${`${TYPE_PREFIX}%`}
          AND id NOT IN (SELECT vehicle_type_id FROM vehicle_requests)
          AND id NOT IN (SELECT vehicle_type_id FROM vehicles)`);
      await ctx.db.execute(sql`
        DELETE FROM persons
        WHERE comment = ${PERSON_MARK}
          AND id NOT IN (SELECT driver_person_id FROM waybills)
          AND id NOT IN (
            SELECT driver_person_id FROM vehicle_routes WHERE driver_person_id IS NOT NULL)`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  /**
   * Главный случай Р9в. Точка собрана вчерашним контактом, заявку правят сегодня — и карточка
   * обязана показать новый телефон **без** пересборки дня: контакт нигде не хранится, он выводится
   * из ролей чтением заявки (§5.2).
   *
   * Расхождению при этом взяться неоткуда, и это проверяется тут же: снимка контакта нет, сравнивать
   * не с чем, а факты `address_mismatch` несут ключи адресов. Прежняя редакция плана обещала
   * помечать правку контакта тем же предупреждением — обещание невыполнимое, и случай держит
   * границу, чтобы его не восстановили по памяти.
   */
  it('правка контакта заказа видна в карточке точки сразу и расхождения не поднимает', async () => {
    const request = await linearInProgress();
    const routeId = await planDay(request.id, ctx.dayA, ctx.vehicleId);

    const before = await routeCard(routeId);
    expect(contactsOf(before)).toEqual([{ name: SITE.name, phone: SITE.phone }]);
    expect(mismatchesOf(before)).toBe(0);
    const pointLocation = before.points[0]!.location;

    const edited = await patchRequest(request.id, {
      requestType: 'special_equipment',
      responsibleName: SITE_NEXT.name,
      responsiblePhone: SITE_NEXT.phone,
    });
    expect(edited.statusCode, edited.body).toBe(200);

    const after = await routeCard(routeId);
    expect(contactsOf(after)).toEqual([{ name: SITE_NEXT.name, phone: SITE_NEXT.phone }]);
    // Адрес точки при этом остался снимком (Р10): контакт и адрес живут по разным правилам, и
    // правка одного не трогает другое.
    expect(after.points[0]!.location).toBe(pointLocation);
    expect(mismatchesOf(after)).toBe(0);
    expect(warningCodesOf(after)).not.toContain('address_mismatch');

    /*
     * И то же самое — правкой прямо в базе, мимо всех дверей.
     *
     * Случай выше прошёл бы и у портала, который хранит контакт снимком, а дверь правки аккуратно
     * его переписывает: снаружи разницы не видно, пока правка идёт через ручку. Здесь ручки нет
     * вовсе — переписывать снимок некому, — и карточка обязана показать новый номер всё равно.
     * Это и есть «выводится из ролей» (Р9в) в проверяемом виде.
     */
    await ctx.db.execute(sql`
      UPDATE special_equipment_request_details
      SET responsible_phone = ${SITE_DIRECT.phone}, responsible_name = ${SITE_DIRECT.name}
      WHERE request_id = ${request.id}`);
    expect(contactsOf(await routeCard(routeId))).toEqual([
      { name: SITE_DIRECT.name, phone: SITE_DIRECT.phone },
    ]);
  });

  /**
   * Цена живого контакта (Р9в): открытая карточка рейса обязана узнать, что печатать теперь надо
   * другое, — и узнаёт она это версией.
   *
   * У линейного заказа рейсов столько, сколько дней распланировано (Р7), и версию поднимают всем.
   * Случай назван «а не одного» не для красоты: «маршрут заявки» в единственном числе — самая
   * дешёвая из здешних ошибок, и написавший её увидит зелёный тест на грузоперевозке.
   */
  it('правка контакта поднимает версию всех рейсов заказа, а не одного', async () => {
    const request = await linearInProgress();
    const routeA = await planDay(request.id, ctx.dayA, ctx.vehicleId);
    const routeB = await planDay(request.id, ctx.dayB, ctx.otherVehicleId);
    expect(routeA).not.toBe(routeB);
    const versionA = (await routeCard(routeA)).version;
    const versionB = (await routeCard(routeB)).version;

    const edited = await patchRequest(request.id, {
      requestType: 'special_equipment',
      responsibleName: SITE_NEXT.name,
      responsiblePhone: SITE_NEXT.phone,
    });
    expect(edited.statusCode, edited.body).toBe(200);

    expect((await routeCard(routeA)).version).toBe(versionA + 1);
    expect((await routeCard(routeB)).version).toBe(versionB + 1);
    // И контакт живой в обоих: день второго рейса собран той же заявкой.
    expect(contactsOf(await routeCard(routeB))).toEqual([
      { name: SITE_NEXT.name, phone: SITE_NEXT.phone },
    ]);
  });

  /**
   * Граница «всех незамороженных» с другой стороны: рейс с выданным листом версией не двигают —
   * его бумага уже выпущена, и «пересоберите маршрут» сказать там некому.
   *
   * Живой контакт при этом виден и в замороженной карточке, и это не противоречие, а всё то же
   * разделение: карточка отвечает на «кому звонить сейчас», а бумага — на «что было напечатано».
   * Снимок листа остаётся с прежним номером, и проверяется он здесь же: если бы живое значение
   * протекло в `waybills.data`, выданный документ менялся бы задним числом молча.
   */
  it('замороженный рейс версией не двигают, а его лист держит контакт снимком', async () => {
    const request = await linearInProgress();
    const routeA = await planDay(request.id, ctx.dayA, ctx.vehicleId);
    const routeB = await planDay(request.id, ctx.dayB, ctx.otherVehicleId);
    await issueRouteWaybill({
      app: ctx.app,
      headers: ctx.auth,
      routeId: routeB,
      payload: { version: (await routeCard(routeB)).version },
    });

    const versionA = (await routeCard(routeA)).version;
    const frozen = await routeCard(routeB);
    expect(frozen.waybill?.status).toBe('issued');

    const edited = await patchRequest(request.id, {
      requestType: 'special_equipment',
      responsibleName: SITE_NEXT.name,
      responsiblePhone: SITE_NEXT.phone,
    });
    expect(edited.statusCode, edited.body).toBe(200);

    expect((await routeCard(routeA)).version).toBe(versionA + 1);
    expect((await routeCard(routeB)).version).toBe(frozen.version);
    // Карточка замороженного рейса — живая: диспетчер звонит тому, кто на площадке сегодня.
    expect(contactsOf(await routeCard(routeB))).toEqual([
      { name: SITE_NEXT.name, phone: SITE_NEXT.phone },
    ]);

    // Графа бланка печатает контакт сокращённо («Иванов И.И., +7 (900) …»), поэтому сверяется по
    // номеру: он в снимке единственное, что нельзя спутать.
    const printed = await ctx.db.execute<{ contacts: string }>(sql`
      SELECT data->>'task_contacts' AS contacts FROM waybills WHERE route_id = ${routeB}`);
    expect(printed.rows[0]!.contacts).toContain(formatPhone(SITE.phone));
    expect(printed.rows[0]!.contacts).not.toContain(formatPhone(SITE_NEXT.phone));
  });

  /**
   * Та же половина Р9в у грузоперевозки: её контакт лежит в ездке, читается той же выборкой ролей
   * и обязан быть живым тем же образом. Случай отдельный потому, что путь другой — правка ездок
   * (`trips` в теле, §7), — и снимок контакта завестись мог бы именно здесь: раскладка ездки по
   * точкам трогает связку, и записать контакт «заодно» в неё дешевле всего.
   */
  it('правка контакта ездки видна в карточке точки сразу', async () => {
    const request = await freightInProgress();
    const before = await routeCard(request.routeId);
    expect(contactsOf(before)).toEqual([
      { name: LOADING.name, phone: LOADING.phone },
      { name: UNLOADING.name, phone: UNLOADING.phone },
    ]);
    const tripId = (
      await ctx.db.execute<{ id: string }>(
        sql`SELECT id FROM vehicle_request_trips WHERE request_id = ${request.id}`,
      )
    ).rows[0]!.id;

    const edited = await patchRequest(request.id, {
      requestType: 'freight_transport',
      trips: [{ ...freightTrip(LOADING_NEXT), id: tripId }],
    });
    expect(edited.statusCode, edited.body).toBe(200);

    const after = await routeCard(request.routeId);
    expect(contactsOf(after)).toEqual([
      { name: LOADING_NEXT.name, phone: LOADING_NEXT.phone },
      { name: UNLOADING.name, phone: UNLOADING.phone },
    ]);
    expect(after.version).toBe(before.version + 1);
    expect(mismatchesOf(after)).toBe(0);
    expect(warningCodesOf(after)).not.toContain('address_mismatch');
  });

  /**
   * Р9г — та половина пары, где сравнивается **напечатанное**, а не смысл.
   *
   * Адрес точки взят из объекта справочника, и семантический ключ у него `ref:<uuid>`: он не
   * меняется, когда правят текст адреса того же объекта. Возьми расхождение этот ключ — портал
   * промолчал бы ровно в том случае, ради которого предупреждение и заведено: на бумаге поедет
   * одна строка, в справочнике будет другая, и заметить это будет некому.
   *
   * Тут же видно, почему у контакта такого предупреждения нет и быть не может (случаи выше): у
   * адреса есть **снимок**, с которым можно сравнить, — у контакта нет.
   */
  it('правка текста адреса объекта поднимает расхождение при том же ключе ref:', async () => {
    const request = await linearInProgress();
    const routeId = await planDay(request.id, ctx.dayA, ctx.vehicleId);
    const before = await routeCard(routeId);
    expect(mismatchesOf(before)).toBe(0);
    const point = before.points[0]!;
    // Точка линейного дня несёт объект справочника: и печатаемую строку, и ссылку на запись.
    expect(point.location).toBe(`${ctx.objectName}, ${OBJECT_ADDRESS}`);
    expect(addressKeyOf(point)).toBe(`ref:${ctx.objectId}`);

    const fixed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/objects/${ctx.objectId}`,
      headers: ctx.auth,
      payload: { address: OBJECT_ADDRESS_FIXED },
    });
    expect(fixed.statusCode, fixed.body).toBe(200);

    const after = await routeCard(routeId);
    const fixedPoint = after.points[0]!;
    // Семантический ключ тот же — сводить точки нечем, а расхождение всё равно поднялось.
    expect(addressKeyOf(fixedPoint)).toBe(`ref:${ctx.objectId}`);
    expect(fixedPoint.location).toBe(point.location);
    expect(mismatchesOf(after)).toBe(1);

    const action = fixedPoint.actions[0]!;
    const warning = waybillIssueWarnings({
      routeId: after.id,
      routeNumber: after.displayNumber,
      formCode: after.formCode,
      driver: null,
      points: after.points,
      // Адрес самой строки задания у линейного дня — объект заявки, каким он стал после правки:
      // предупреждение обязано назвать **оба** текста, иначе подтверждать человеку нечего.
      sourceAddresses: new Map([
        [taskAddressKey(action.ref, action.role), `${ctx.objectName}, ${OBJECT_ADDRESS_FIXED}`],
      ]),
    }).find((w) => w.facts.code === 'address_mismatch');
    expect(warning).toBeTruthy();
    expect(warning!.message).toContain(OBJECT_ADDRESS);
    expect(warning!.message).toContain(OBJECT_ADDRESS_FIXED);

    // Возвращаем адрес: площадка общая для случаев файла, и следующий прогон начинает с чистого.
    const restored = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/objects/${ctx.objectId}`,
      headers: ctx.auth,
      payload: { address: OBJECT_ADDRESS },
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });
});
