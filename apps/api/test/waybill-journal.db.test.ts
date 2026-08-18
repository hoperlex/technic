import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, WAYBILL_CANCELLED_PRINT_MESSAGE } from '@technic/contracts';
import { runSeed, snilsOf } from './db-identity';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Журнал путевых листов: отбор по номеру, порядок строк, отказ в бумаге аннулированному бланку и
 * отметки о печати.
 *
 * Все четыре вещи ломаются молча — ответ остаётся успешным, меняется только его содержимое.
 * Поиск и сортировка собираются в SQL: номер отбирается выражением из серии и числа, а порядок
 * берётся allowlist-картой колонок. Ошибка там не роняет запрос, а отдаёт не тот список — до сих
 * пор оба параметра сервер просто игнорировал, и снаружи это выглядело как «поиск ничего не
 * фильтрует» и «стрелка в заголовке столбца ничего не переставляет». Вызвать эти условия отдельной
 * функцией нельзя: они и есть запрос, поэтому проверяются на живой схеме и настоящим HTTP-путём.
 *
 * Запрет печати аннулированного листа сам по себе — чистая функция (`canPrintWaybill`, её случаи
 * закрыты контрактными тестами), но спрашивают её три разных пути: выгрузка, печать и печать
 * пачкой. Списанный номер, ушедший на бумагу, неотличим от действующего и ездит документом,
 * которого нет, — поэтому сторожится каждая ручка, а у пачки ещё и текст отказа: не назвав номер,
 * ошибка не подсказывает, какой лист убрать из выбора.
 *
 * Печать вдобавок упирается в LibreOffice, а он есть не в каждой среде: без него ручка отвечает
 * 409 «не удалось подготовить бланк». Поэтому у выданного листа проверяется не успех конвертации,
 * а то, что бланк не приняли за списанный, — отказ конвертера от запрета отличается текстом.
 *
 * Отметки «печатали» и «выгружали» своих колонок у листа не имеют и считаются по журналу аудита.
 * Перестань ручка писать событие — журнал молча покажет «ни разу не печатали» у бумаги, которая
 * уже уехала; поймать это можно только пройдя весь путь: выгрузка, затем список.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_journal_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Тестовый машинист: СНИЛС из одинаковых цифр с верной контрольной суммой, серия «00 00». */
// Свой на прогон, а не общая константа: пять файлов заводили водителя по одному номеру, и
// первый добежавший решал, с какими документами тот живёт до конца прогона (см. `db-identity`).
// Табельный номер уникален в паре с работодателем (`person_employments_personnel_no_unique`),
// и файлы делили его так же, как делили СНИЛС. Тот же хвост прогона разводит и его.
const PERSONNEL_RUN = Date.now().toString(36).slice(-5);
const DRIVER_SNILS = snilsOf(runSeed('waybill-journal'));
const DRIVER_LICENSE_SERIES = '00 00';
const DRIVER_LICENSE_NUMBER = '000103';
const DRIVER_LICENSE_ISSUED_ON = '2021-03-12';

/**
 * Второй сотрудник — машинист экскаватора: его должность требует удостоверения
 * тракториста-машиниста, а не водительского (ADR 0095). Заведён ради снимка недельного листа: по
 * нему и видно, что документ выбирается должностью. СНИЛС такой же выдуманный — одинаковые цифры с
 * верной контрольной суммой, — но свой: база db-тестов общая, человек ищется по СНИЛС, и «11…» с
 * «22…» уже заняты соседними файлами (перегон, срез гаража).
 */
const MACHINIST_SNILS = '33333333334';
const MACHINIST_JOB_TITLE = 'Машинист экскаватора';
const TRACTOR_LICENSE_SERIES = '00 01';
const TRACTOR_LICENSE_NUMBER = '000104';
const TRACTOR_LICENSE_ISSUED_ON = '2022-05-16';
const ADMIN_EMAIL = 'db-journal-admin@example.invalid';
const PASSWORD = 'db-test-password-123';

/**
 * С какого номера пойдёт серия ЭСМ-2 в этом тесте. Счётчик сдвигается намеренно: с первого номера
 * бланки печатались бы как «00000001», и поиск по хвосту «1» совпадал бы с любым соседом просто
 * подстрокой — проверка перестала бы что-либо доказывать. Четырёхзначный номер даёт и ведущие
 * нули в напечатанном виде, и хвост, которого у соседних листов нет.
 */
const FIRST_NUMBER = 4897;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  vehicle: { id: string; typeId: string; categoryId: string | null };
  objectId: string;
  personId: string;
  /** Машинист экскаватора: допущен тракторным удостоверением, а не водительским (ADR 0095). */
  machinistPersonId: string;
  date: string;
}

/** Лист в том виде, в каком его читает тест: id, напечатанный номер и само число из базы. */
interface Sheet {
  id: string;
  number: string;
  numeric: number;
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

/**
 * Сотрудник с одним документом: специализация «водитель» (ею человек попадает в подбор), должность
 * действующим трудовым отношением и удостоверение того вида, которого эта должность требует.
 *
 * Заводится однажды: база теста живёт между прогонами, и человек ищется по СНИЛС — он его ключ.
 */
async function seedPerson(person: {
  snils: string;
  firstName: string;
  personnelNo: string;
  jobTitle: string;
  credentialTypeCode: 'driver_license' | 'tractor_license';
  series: string;
  number: string;
  issuedOn: string;
  categoryCodes: string[];
}): Promise<string> {
  const { db } = await import('../src/db/client');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(sql`${schema.persons.snils} = ${person.snils}`);
  if (existing) return existing.id;

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  const [licenseType] = await db
    .select({ id: schema.credentialTypes.id })
    .from(schema.credentialTypes)
    .where(sql`${schema.credentialTypes.code} = ${person.credentialTypeCode}`);
  // Категории — внутри своего вида документа: «B» и «C» есть и у водительского удостоверения, и у
  // тракторного (миграция 0123), а составной внешний ключ чужую категорию в документ не пустит.
  const categories = await db
    .select({ id: schema.qualificationCategories.id })
    .from(schema.qualificationCategories)
    .where(
      sql`${schema.qualificationCategories.credentialTypeId} = ${licenseType!.id}
          AND ${schema.qualificationCategories.code} = ANY(${sql.param(person.categoryCodes)}::text[])`,
    );

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.persons)
      .values({
        lastName: 'Тестовый',
        firstName: person.firstName,
        middleName: 'Интеграционный',
        snils: person.snils,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: интеграционный тест журнала листов',
      })
      .returning({ id: schema.persons.id });
    const personId = created!.id;

    await tx.insert(schema.personSpecializations).values({
      personId,
      specializationId: specialization!.id,
      isPrimary: true,
      startedOn: '2024-01-15',
    });
    await tx.insert(schema.personEmployments).values({
      personId,
      employmentType: 'staff',
      personnelNo: person.personnelNo,
      jobTitle: person.jobTitle,
      startedOn: '2024-01-15',
    });
    const [credential] = await tx
      .insert(schema.personCredentials)
      .values({
        personId,
        credentialTypeId: licenseType!.id,
        series: person.series,
        number: person.number,
        issuedOn: person.issuedOn,
        // Срок заведомо длинный: тест идёт «на сегодня», и истечение сломало бы отбор водителя
        // через несколько лет молча — пустым списком вместо понятного отказа.
        expiresOn: '2099-03-12',
        verificationStatus: 'verified',
        verifiedAt: new Date('2021-03-12T12:00:00Z'),
      })
      .returning({ id: schema.personCredentials.id });
    await tx.insert(schema.personCredentialCategories).values(
      categories.map((c) => ({
        credentialId: credential!.id,
        qualificationCategoryId: c.id,
        credentialTypeId: licenseType!.id,
        validFrom: person.issuedOn,
      })),
    );
    return personId;
  });
}

/** Учётка и двое работников: организация, объекты, парк и серии бланков приходят миграциями. */
async function seed(): Promise<{ personId: string; machinistPersonId: string }> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (!user) {
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

  // Должность «Машинист» в списке ADR 0095 не значится, и документ у неё умолчанием водительский:
  // незнакомая должность поведения не меняет.
  const personId = await seedPerson({
    snils: DRIVER_SNILS,
    firstName: 'Машинист',
    personnelNo: `Т-103-${PERSONNEL_RUN}`,
    jobTitle: 'Машинист',
    credentialTypeCode: 'driver_license',
    series: DRIVER_LICENSE_SERIES,
    number: DRIVER_LICENSE_NUMBER,
    issuedOn: DRIVER_LICENSE_ISSUED_ON,
    categoryCodes: ['b', 'c'],
  });
  const machinistPersonId = await seedPerson({
    snils: MACHINIST_SNILS,
    firstName: 'Экскаваторщик',
    personnelNo: `Т-104-${PERSONNEL_RUN}`,
    jobTitle: MACHINIST_JOB_TITLE,
    credentialTypeCode: 'tractor_license',
    series: TRACTOR_LICENSE_SERIES,
    number: TRACTOR_LICENSE_NUMBER,
    issuedOn: TRACTOR_LICENSE_ISSUED_ON,
    categoryCodes: ['c', 'e'],
  });
  return { personId, machinistPersonId };
}

/**
 * Заявка на спецтехнику, взятая в работу: этим и выписывается лист ЭСМ-2 — отдельной ручки
 * «выписать» у журнала нет, лист рождается решением по заявке. Срок в один день, чтобы неделя
 * была ровно одна и на заявку приходился ровно один бланк.
 *
 * Машинист — параметром: снимок листа берёт его документ по должности, и проверяется это разными
 * людьми.
 */
async function requestInWork(driverPersonId = ctx.personId): Promise<{ id: string }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicle.typeId,
      vehicleCategoryId: ctx.vehicle.categoryId,
      dateFrom: ctx.date,
      dateTo: ctx.date,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();

  const approved = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.auth,
    payload: { approved: true, version: request.version },
  });
  expect(approved.statusCode, approved.body).toBe(200);

  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.auth,
    payload: {
      status: 'confirmed',
      comment: '',
      version: approved.json().version,
      assignment: {
        vehicleId: ctx.vehicle.id,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId,
      },
      schedule: {
        requestType: 'special_equipment',
        dateFrom: ctx.date,
        dateTo: ctx.date,
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return { id: request.id };
}

interface JournalRow {
  id: string;
  number: string;
  status: string;
  exportedAt: string | null;
  printedAt: string | null;
  requests: { requestId: string }[];
}

/**
 * Страница журнала с заданным отбором — целиком, вместе со счётчиком: база теста живёт между
 * прогонами, и «последняя страница» считается по нему, а не предполагается первой.
 */
async function journalPage(query: Record<string, string> = {}): Promise<{
  items: JournalRow[];
  total: number;
  pageSize: number;
}> {
  const params = new URLSearchParams({ pageSize: '100', ...query });
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waybills?${params.toString()}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** Строки журнала: порядок сохраняется — тесты смотрят и его. */
async function journal(query: Record<string, string> = {}): Promise<JournalRow[]> {
  return (await journalPage(query)).items;
}

/** Числа номеров списком идентификаторов: журнал сортирует их, а отдаёт напечатанный вид. */
async function numbersOf(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.db.execute<{ id: string; number: string }>(
    sql`SELECT id, number FROM waybills WHERE id = ANY(${sql.param(ids)}::uuid[])`,
  );
  return new Map(rows.rows.map((row) => [row.id, Number(row.number)]));
}

/**
 * Выписанный лист: заявка в работе — и её единственный бланк из журнала. Число номера читается из
 * базы, а не выкусывается из напечатанного вида: серия у бланка своя, и разбор строки сломался бы
 * от первого же префикса.
 */
async function issueWaybill(driverPersonId?: string): Promise<Sheet> {
  const request = await requestInWork(driverPersonId);
  /*
   * Отбор по машине теста, а не вся первая страница. База живёт между прогонами, и соседние файлы
   * засевают листы **будущими** датами; журнал сортирует `issued_for_date DESC, number DESC`, так
   * что сотня таких листов занимает всю первую страницу и только что выписанный на неё не попадает
   * вовсе. Тест падал бы с «выписывает ровно один недельный лист: 0» — то есть врал бы о выписке,
   * хотя лист выписан.
   */
  const sheets = (await journal({ vehicleId: ctx.vehicle.id })).filter((w) =>
    w.requests.some((link) => link.requestId === request.id),
  );
  expect(sheets.length, 'заявка в работе выписывает ровно один недельный лист').toBe(1);
  const sheet = sheets[0]!;
  const rows = await ctx.db.execute<{ number: string }>(
    sql`SELECT number FROM waybills WHERE id = ${sheet.id}`,
  );
  return { id: sheet.id, number: sheet.number, numeric: Number(rows.rows[0]!.number) };
}

/** Испорченный бланк: номер списывается, и лист остаётся в журнале аннулированным. */
async function cancel(id: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/waybills/${id}/cancel`,
    headers: ctx.auth,
    payload: { reason: 'Испорчен при печати' },
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe.skipIf(!DB_URL)('журнал путевых листов: поиск, порядок и печать (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { personId, machinistPersonId } = await seed();
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    // Своя спецтехника с категорией: заявку на тип с категориями сервер без неё не примет, а
    // недельные листы выписываются только на собственную машину.
    const vehicles = await db.execute<{ id: string; type_id: string; category_id: string | null }>(
      sql`
        SELECT v.id, v.vehicle_type_id AS type_id, v.vehicle_category_id AS category_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
        WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
          AND vk.code = 'special_equipment' AND v.vehicle_category_id IS NOT NULL
        LIMIT 1`,
    );
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active LIMIT 1`,
    );
    const vehicle = vehicles.rows[0];
    const object = objects.rows[0];
    if (!vehicle || !object) {
      throw new Error('В базе нет своей спецтехники или объекта: миграции наполнения не применены');
    }

    // Счётчик серии сдвигается один раз и только вперёд: повторный прогон по той же базе
    // продолжает нумерацию, а не отматывает её назад на уже выданные номера.
    await db.execute(
      sql`UPDATE waybill_series SET next_number = ${FIRST_NUMBER}
          WHERE code = 'esm2' AND next_number < ${FIRST_NUMBER}`,
    );

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      vehicle: { id: vehicle.id, typeId: vehicle.type_id, categoryId: vehicle.category_id },
      objectId: object.id,
      personId,
      machinistPersonId,
      // Заявку задним числом сервер не принимает (`isAllowedRequestDate`), а лист аннулируют по
      // последний день периода включительно — поэтому и заявка, и бланк живут сегодняшним днём.
      date: moscowDateKeyOf(new Date()),
    };
  }, 120_000);

  afterAll(async () => {
    if (ctx?.db) {
      /*
       * Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а здесь почти
       * каждый случай выписывает лист — за прогон в ней оседало полтора десятка заказов со всей их
       * бумагой. Свои же проверки от этого и страдали: журнал сортирует по дате и номеру, накопленные
       * листы занимают первую страницу, и половина здешних отборов уже сузилась до «своей машины»
       * именно поэтому (см. `issueWaybill`).
       *
       * Метка — собственная учётка файла: всё, что тут заводится, заводит она, а чужого под ней не
       * бывает. Списком заведённого уборка не пользуется намеренно — прибирать надо и за упавшим
       * прогоном, который до записи в список мог не дойти. Саму учётку уборка не трогает: её
       * `beforeAll` ищет по адресу и заводит один раз на все прогоны.
       *
       * Порядок обратен ссылкам: лист держит и заказ, и рейс ключами `restrict`, состав рейса —
       * заказ. Талоны листа, детали и история заказа уходят каскадом со своей головной строкой.
       *
       * Люди и их документы остаются: они ищутся по СНИЛС и заводятся один раз на все прогоны —
       * то есть не накапливаются.
       */
      const ourUsers = sql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
      const ourRequests = sql`SELECT id FROM vehicle_requests WHERE created_by IN (${ourUsers})`;
      await ctx.db.execute(sql`
        DELETE FROM waybills
        WHERE source_request_id IN (${ourRequests})
           OR id IN (SELECT waybill_id FROM waybill_requests WHERE request_id IN (${ourRequests}))
           OR route_id IN (SELECT id FROM vehicle_routes
                            WHERE source_request_id IN (${ourRequests}))`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_route_requests WHERE request_id IN (${ourRequests})`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_routes WHERE source_request_id IN (${ourRequests})`);
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id IN (${ourRequests})`);
      // Журнал — по автору: писала в него только здешняя учётка, а видов записей у неё несколько.
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  }, 60_000);

  it('поиск по номеру: напечатанный целиком, хвост цифр и чужой номер', async () => {
    const sheet = await issueWaybill();
    const other = await issueWaybill();

    // Так номер стоит в бланке и так его копируют из карточки листа.
    const whole = await journal({ search: sheet.number });
    expect(whole.map((w) => w.id)).toContain(sheet.id);
    expect(whole.map((w) => w.id)).not.toContain(other.id);

    // А так его называют вслух и набирают руками — без ведущих нулей серии.
    const tail = await journal({ search: String(sheet.numeric) });
    expect(sheet.number).toContain('0');
    expect(String(sheet.numeric).length).toBeLessThan(sheet.number.length);
    expect(tail.map((w) => w.id)).toContain(sheet.id);
    expect(tail.map((w) => w.id)).not.toContain(other.id);

    // Пустой поиск журнал не сужает: ссылка `?number=` без значения ведёт в обычный список. Отбор
    // по машине здесь остаётся — проверяется, что **поиск** ничего не сузил, а не то, что оба
    // листа попали на первую страницу накопленной базы: соседние файлы засевают её сотнями строк
    // будущей датой, и первая страница им и принадлежит.
    const all = await journal({ search: '  ', vehicleId: ctx.vehicle.id });
    expect(all.map((w) => w.id)).toEqual(expect.arrayContaining([sheet.id, other.id]));
  }, 60_000);

  /**
   * Цифры серии не должны утаскивать за собой весь журнал. Префикс бланка («260604-646-») состоит
   * из цифр, и подстрока, ищущая по склейке «серия + номер», на запрос «646» вернула бы каждую
   * строку этой серии — то есть поиск, который «всегда что-то находит», а значит ничего не
   * отвечает. Поэтому одни цифры ищутся в самом номере, и только ввод со знаками (дефисом) —
   * в напечатанном номере целиком.
   */
  it('цифры из префикса серии журнал не сужают, а напечатанный номер целиком — сужает', async () => {
    const prefix = '260604-646-';
    await ctx.db.execute(sql`UPDATE waybill_series SET prefix = ${prefix} WHERE code = 'esm2'`);
    try {
      const sheet = await issueWaybill();
      expect(sheet.number.startsWith(prefix)).toBe(true);

      // «646» есть в префиксе каждой строки серии и отсутствует в самом номере — находиться
      // нечему.
      const byPrefix = await journal({ search: '646' });
      expect(byPrefix.map((w) => w.id)).not.toContain(sheet.id);

      // А номер, скопированный из бланка вместе с серией, лист находит.
      const whole = await journal({ search: sheet.number });
      expect(whole.map((w) => w.id)).toContain(sheet.id);
    } finally {
      await ctx.db.execute(sql`UPDATE waybill_series SET prefix = '' WHERE code = 'esm2'`);
    }
  }, 60_000);

  it('сортировка по номеру разворачивает журнал, а не оставляет его как был', async () => {
    // Три подряд выданных номера — самые большие в серии на этот момент: счётчик только растёт, и
    // всё, что лежит в базе от прежних прогонов, заведомо младше.
    const first = await issueWaybill();
    const second = await issueWaybill();
    const third = await issueWaybill();

    /*
     * Журнал сужается своим машинистом. Серия ЭСМ-2 у портала одна, а файлы db-тестов идут
     * параллельно и берут из неё номера тоже (заказ техники в работе выписывает недельный лист
     * сам): без сужения «самые свежие три» в общем журнале оказывались бы чужими, и порядок
     * сортировки проверялся бы не на той бумаге. Свой человек здесь и есть граница: заявки этого
     * файла выписываются на него (`requestInWork`).
     */
    const mine = { driverPersonId: ctx.personId };

    // По убыванию свежие номера открывают журнал…
    const descending = await journalPage({ sortBy: 'number', sortOrder: 'desc', ...mine });
    expect(descending.items.slice(0, 3).map((w) => w.id)).toEqual([third.id, second.id, first.id]);

    // …а по возрастанию — закрывают его, и страницей это может быть уже не первая.
    const ascending = await journalPage({
      sortBy: 'number',
      sortOrder: 'asc',
      ...mine,
      page: String(Math.ceil(descending.total / descending.pageSize)),
    });
    expect(ascending.items.slice(-3).map((w) => w.id)).toEqual([first.id, second.id, third.id]);

    // Страница отсортирована целиком, а не только своим хвостом. Порядок сверяется по числу из
    // базы, а не по напечатанному номеру: сортирует сервер именно число, и на разных сериях
    // строковый порядок разошёлся бы с ним.
    const numbers = await numbersOf(ascending.items.map((w) => w.id));
    const ascNumbers = ascending.items.map((w) => numbers.get(w.id)!);
    expect(ascNumbers).toEqual([...ascNumbers].sort((a, b) => a - b));
  }, 60_000);

  it('аннулированный лист не выгружается и не печатается', async () => {
    const sheet = await issueWaybill();
    await cancel(sheet.id);

    for (const path of ['export', 'print']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/waybills/${sheet.id}/${path}`,
        headers: ctx.auth,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().message).toBe(WAYBILL_CANCELLED_PRINT_MESSAGE);
    }
  }, 60_000);

  it('выданный лист бумагу отдаёт: выгрузка файлом и печать не упираются в аннулирование', async () => {
    const sheet = await issueWaybill();

    const exported = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waybills/${sheet.id}/export`,
      headers: ctx.auth,
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers['content-disposition']).toContain('attachment');

    // Печать зовёт LibreOffice, и в среде без него ручка честно отвечает 409 «не удалось
    // подготовить бланк». Это отказ конвертера, а не запрет на аннулированный лист, поэтому
    // проверяется не успех, а то, что бланк не приняли за списанный.
    const printed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waybills/${sheet.id}/print`,
      headers: ctx.auth,
    });
    if (printed.statusCode === 200) {
      expect(printed.headers['content-type']).toContain('application/pdf');
    } else {
      expect(printed.statusCode, printed.body).toBe(409);
      expect(printed.json().message).not.toBe(WAYBILL_CANCELLED_PRINT_MESSAGE);
    }
  }, 120_000);

  it('пачка с аннулированным листом не печатается и называет его номер', async () => {
    const good = await issueWaybill();
    const spoiled = await issueWaybill();
    await cancel(spoiled.id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/waybills/print-batch',
      headers: ctx.auth,
      payload: { ids: [good.id, spoiled.id] },
    });
    expect(res.statusCode, res.body).toBe(409);
    // Номер в тексте — единственное, чем человек поймёт, какой лист убрать из выбора.
    expect(res.json().message).toContain(spoiled.number);
    expect(res.json().message).toContain(WAYBILL_CANCELLED_PRINT_MESSAGE);
  }, 60_000);

  it('пачка без листов и пачка с несуществующим листом печататься не начинают', async () => {
    const empty = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/waybills/print-batch',
      headers: ctx.auth,
      payload: { ids: [] },
    });
    // Пустой выбор отсекает схема — до ручки запрос не доходит.
    expect(empty.statusCode, empty.body).toBe(400);
    expect(empty.json().code).toBe('validation_error');

    // Лист, стёртый из журнала соседней вкладкой: пачка не печатается частично, а отказывается
    // целиком — иначе со стола забрали бы неполный комплект, не зная об этом.
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/waybills/print-batch',
      headers: ctx.auth,
      payload: { ids: ['00000000-0000-4000-8000-000000000000'] },
    });
    expect(unknown.statusCode, unknown.body).toBe(404);
  });

  /**
   * Документ листа выбирается должностью (ADR 0095): у машиниста экскаватора это удостоверение
   * тракториста-машиниста, у прочих — водительское. В снимке недельного листа оба лежат в одних и
   * тех же ключах — графа в бланке одна, а вид документа её не меняет.
   *
   * Проверяется именно снимок, а не бумага: граф под удостоверение форма ЭСМ-2 не содержит, и
   * клетки в шаблоне не размечены намеренно (`waybill-template.test.ts`). Ключи снимка от разметки
   * не зависят — лист обязан помнить, по какому документу работали, иначе размеченная когда-нибудь
   * клетка печатала бы пустое место у листов, выданных до неё.
   */
  it('снимок ЭСМ-2 берёт документ по должности: тракторное у машиниста, ВУ у прочих', async () => {
    const machinistSheet = await issueWaybill(ctx.machinistPersonId);
    const driverSheet = await issueWaybill();

    const rows = await ctx.db.execute<{ id: string; data: Record<string, string> }>(
      sql`SELECT id, data FROM waybills WHERE id IN (${machinistSheet.id}, ${driverSheet.id})`,
    );
    const dataById = new Map(rows.rows.map((row) => [row.id, row.data]));

    /*
     * Водительское удостоверение читается из базы, а не берётся константой: база db-тестов общая,
     * человек ищется по СНИЛС, и завести его мог соседний файл со своими реквизитами. Тракторное
     * сверяется с константами — этого машиниста заводит только здешний сид.
     */
    const licenses = await ctx.db.execute<{ requisites: string; issued_on: string }>(sql`
      SELECT btrim(c.series || ' ' || c.number) AS requisites,
             to_char(c.issued_on, 'YYYY-MM-DD') AS issued_on
      FROM person_credentials c
      JOIN credential_types t ON t.id = c.credential_type_id
      WHERE c.person_id = ${ctx.personId} AND c.deleted_at IS NULL AND t.code = 'driver_license'`);
    const license = licenses.rows[0]!;

    const machinist = dataById.get(machinistSheet.id)!;
    expect(machinist.driver_license_number).toBe(
      `${TRACTOR_LICENSE_SERIES} ${TRACTOR_LICENSE_NUMBER}`,
    );
    expect(machinist.driver_license_issued_on).toBe(TRACTOR_LICENSE_ISSUED_ON);
    // Водительского у этого человека нет вовсе, и чужой документ в графу не подставляется.
    expect(machinist.driver_license_number).not.toBe(license.requisites);

    // А у должности, которой требуется ВУ, в тех же ключах стоит оно: тракторное удостоверение не
    // «побеждает» просто потому, что бланк недельный.
    const driver = dataById.get(driverSheet.id)!;
    expect(driver.driver_license_number).toBe(license.requisites);
    expect(driver.driver_license_issued_on).toBe(license.issued_on);

    // СНИЛС пуст у обоих: этой графы в бланке ЭСМ-2 нет, и реквизит этот — листа на рейс.
    expect(machinist.driver_snils).toBe('');
    expect(driver.driver_snils).toBe('');
  }, 60_000);

  it('выгрузка отмечается в журнале у своего листа и только у него', async () => {
    const sheet = await issueWaybill();
    const neighbour = await issueWaybill();

    const before = await journal({ search: sheet.number });
    expect(before[0]!.exportedAt).toBeNull();

    const exported = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waybills/${sheet.id}/export`,
      headers: ctx.auth,
    });
    expect(exported.statusCode, exported.body).toBe(200);

    // Та же причина, что и в `issueWaybill`: без отбора по машине свежие листы не попадают на
    // первую страницу накопленной базы.
    const rows = await journal({ vehicleId: ctx.vehicle.id });
    const mine = rows.find((w) => w.id === sheet.id)!;
    const other = rows.find((w) => w.id === neighbour.id)!;
    expect(mine.exportedAt).not.toBeNull();
    // Печати не было: отметки считаются по событиям, а не по факту «бумага уходила вообще».
    expect(mine.printedAt).toBeNull();
    expect(other.exportedAt).toBeNull();
  }, 60_000);
});
