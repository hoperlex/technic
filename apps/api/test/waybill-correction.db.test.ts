import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { describeReadModes, inLegacy, useReadModeDatabase } from './assignment-read-mode';
import {
  moscowDateKeyOf,
  shiftDateKey,
  WAYBILL_CANCELLED_PRINT_MESSAGE,
  WAYBILL_CORRECTION_DAYS,
  weekStartKey,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Коррекция задним числом: списание бланка прошедшего дня и гонка печати (ADR 0101, Р20 и Р39).
 *
 * Всё здешнее проверяется на живой схеме и настоящим HTTP-путём, потому что предмет проверки — не
 * предикат, а сцепка предиката с транзакцией, ограничениями базы и правами субъекта.
 *
 * **Списание задним числом.** До ADR 0101 прошедший день был закрыт всем ролям одним `409`. Теперь
 * граница двойная: до конца дня листа — обычная работа, дальше — коррекция под своим правом, с
 * причиной и записью операции. Ошибка здесь не роняет запрос, а тихо меняет, кому что позволено:
 * забытая проверка права открыла бы бланк любому, а лишняя — заперла бы диспетчера.
 *
 * **Идемпотентность (Р31).** Коррекция трогает бланк строгой отчётности, а сеть рвётся. Повтор
 * обязан вернуть прежний результат, а другая команда под тем же ключом — 409; проверить это можно
 * только через настоящий уникальный индекс и настоящую транзакцию.
 *
 * **Гонка печати (Р39).** Между проверкой статуса и отдачей файла лежит сборка PDF — секунды, в
 * которые укладывается коррекция. Здесь конвертер подменён: он и есть то самое окно, и внутри него
 * лист аннулируется. Без перечитывания статуса после рендера бумага уехала бы аннулированной.
 *
 * **Сокращённый период (Р12 плана «закрытие фактической датой»).** Третий источник той же метки:
 * лист, у которого закрытие заявки отняло дни с конца, для журнала такая же коррекция, как
 * списанный задним числом, — своей метки заказчик заводить не стал. Отсюда два случая в конце
 * файла: метка со следом правки в ответе и обе ветви седьмого фильтра. Живая схема тут нужна не
 * ради предиката, а ради условия запроса: расходится оно молча, отбор просто начинает показывать
 * не то.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

/*
 * ЭСМ2-РАЗРЕЗ. Файл заводит свою базу механикой двух режимов: режим чтения живёт в управляющей строке, одной на базу.
 */
const readMode = useReadModeDatabase('wbcorr');
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

/**
 * Что происходит внутри сборки PDF. Обычно ничего — тогда конвертер просто отдаёт байты, и печать
 * идёт своим чередом; в тесте гонки сюда кладут аннулирование листа. Настоящий LibreOffice здесь
 * не нужен вовсе: предмет проверки — статус, перечитанный после рендера, а не сам бланк. Заодно
 * файл перестаёт зависеть от того, установлен ли конвертер в среде.
 */
let duringRender: (() => Promise<void>) | null = null;

vi.mock('../src/services/office-pdf', () => ({
  renderPdf: async () => {
    await duringRender?.();
    return new Uint8Array([1, 2, 3]);
  },
  renderPdfBatch: async (docs: readonly Uint8Array[]) => {
    await duringRender?.();
    return docs.map(() => new Uint8Array([1, 2, 3]));
  },
  // Класс отмены (ADR 0148) обязан быть в моке: ручка печати сверяет с ним пойманное
  // (`abandonPrint`), и без экспорта любой отказ превращался бы в 500 вместо ответа по делу.
  // Свой класс, а не настоящий: сверка идёт по `instanceof`, а ручка берёт его из этого же мока —
  // бросать отмену здесь всё равно некому, конвертер подменён целиком.
  PrintAborted: class PrintAborted extends Error {},
}));

// Склейка настоящих PDF на выдуманных байтах развалилась бы, а к делу она отношения не имеет:
// пачка проверяется на том, что отказ приходит по всем её листам, а не по первому.
vi.mock('../src/services/pdf-merge', () => ({
  mergePdfs: async (pdfs: readonly Uint8Array[]) => pdfs[0] ?? new Uint8Array(),
}));

/** Свой человек у файла: база db-тестов общая, и работник ищется по СНИЛС — он его ключ. */
const DRIVER_SNILS = '44444444479';
const PASSWORD = 'db-test-password-123';
const ADMIN_EMAIL = 'db-correction-admin@example.invalid';
const DISPATCHER_EMAIL = 'db-correction-dispatcher@example.invalid';
const MANAGER_EMAIL = 'db-correction-manager@example.invalid';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Три субъекта: у администратора глубина без предела, у диспетчера 30 дней, у менеджера нет прав вовсе. */
  admin: { authorization: string };
  dispatcher: { authorization: string };
  manager: { authorization: string };
  adminId: string;
  vehicle: { id: string; typeId: string; categoryId: string | null };
  objectId: string;
  personId: string;
  today: string;
}

/** Лист в том виде, в каком его читает тест. */
interface Sheet {
  id: string;
  number: string;
}

let ctx: Ctx;

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

/** Учётка с ролью: права у трёх субъектов разные, и в этом весь смысл файла. */
async function seedUser(email: string, role: 'admin' | 'dispatcher' | 'manager'): Promise<string> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${email}`);
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: role,
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/** Машинист: специализация, должность и удостоверение — тем же порядком, что и в журнале листов. */
async function seedPerson(): Promise<string> {
  const { db } = await import('../src/db/client');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(sql`${schema.persons.snils} = ${DRIVER_SNILS}`);
  if (existing) return existing.id;

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  const [licenseType] = await db
    .select({ id: schema.credentialTypes.id })
    .from(schema.credentialTypes)
    .where(sql`${schema.credentialTypes.code} = 'driver_license'`);
  const categories = await db
    .select({ id: schema.qualificationCategories.id })
    .from(schema.qualificationCategories)
    .where(
      sql`${schema.qualificationCategories.credentialTypeId} = ${licenseType!.id}
          AND ${schema.qualificationCategories.code} = ANY(ARRAY['b','c']::text[])`,
    );

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.persons)
      .values({
        lastName: 'Тестовый',
        firstName: 'Коррекционный',
        middleName: 'Интеграционный',
        snils: DRIVER_SNILS,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: интеграционный тест коррекции',
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
      personnelNo: 'Т-401',
      jobTitle: 'Машинист',
      startedOn: '2024-01-15',
    });
    const [credential] = await tx
      .insert(schema.personCredentials)
      .values({
        personId,
        credentialTypeId: licenseType!.id,
        series: '00 04',
        number: '000401',
        issuedOn: '2021-03-12',
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
        validFrom: '2021-03-12',
      })),
    );
    return personId;
  });
}

/**
 * Выписанный недельный лист: заявку на технику берут в работу, и портал выписывает бланк сам —
 * отдельной ручки «выписать» у журнала нет.
 */
/*
 * ЭСМ2-РАЗРЕЗ. Сцена собирается **в сегодняшнем мире** (`inLegacy`), а проверяется в назначенном
 * режиме. Причина: заказ заводится статусной ручкой, а в `history` её останавливает бэкстоп (Р22) —
 * история назначения стала источником истины, и чужая дверь её не достраивает. Предмет файла —
 * списание бланка задним числом, к подготовке заказа он отношения не имеет.
 */
async function issueWaybill(): Promise<Sheet> {
  return inLegacy(readMode, issueWaybillNow);
}

async function issueWaybillNow(): Promise<Sheet> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.admin,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicle.typeId,
      vehicleCategoryId: ctx.vehicle.categoryId,
      dateFrom: ctx.today,
      dateTo: ctx.today,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();

  const approved = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.admin,
    payload: { approved: true, version: request.version },
  });
  expect(approved.statusCode, approved.body).toBe(200);

  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.admin,
    payload: {
      status: 'confirmed',
      comment: '',
      version: approved.json().version,
      assignment: {
        vehicleId: ctx.vehicle.id,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.personId,
      },
      schedule: { requestType: 'special_equipment', dateFrom: ctx.today, dateTo: ctx.today },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);

  const rows = await ctx.db.execute<{ id: string; number: string; prefix: string; width: number }>(
    sql`SELECT w.id, w.number, s.prefix, s.number_width AS width
        FROM waybills w
        JOIN waybill_series s ON s.id = w.series_id
        WHERE w.source_request_id = ${request.id} AND w.status <> 'cancelled'`,
  );
  expect(rows.rows.length, 'заявка в работе выписывает ровно один недельный лист').toBe(1);
  const row = rows.rows[0]!;
  return { id: row.id, number: `${row.prefix}${String(row.number).padStart(row.width, '0')}` };
}

/**
 * Тот же лист, но отработанной неделей.
 *
 * Заявку задним числом сервер пока не принимает (это следующий этап плана), поэтому прошлое
 * делается сдвигом самих дат бланка — ровно то состояние, в котором лист застаёт коррекция:
 * неделя кончилась, работа состоялась, бумага побывала на объекте. Границы берутся понедельником и
 * воскресеньем: `waybills_period_check` держит лист внутри одной календарной недели.
 */
async function movePast(sheet: Sheet, daysAgo: number): Promise<{ from: string; to: string }> {
  const monday = weekStartKey(shiftDateKey(ctx.today, -daysAgo));
  const sunday = shiftDateKey(monday, 6);
  await ctx.db.execute(
    sql`UPDATE waybills
        SET issued_for_date = ${monday}, period_from = ${monday}, period_to = ${sunday}
        WHERE id = ${sheet.id}`,
  );
  return { from: monday, to: sunday };
}

/**
 * Тот же лист, но с сокращённым периодом (Р12 плана «закрытие фактической датой»): бланк выдан на
 * неделю, а действует по среду — заказ закрыли фактической датой, и дни с конца отняли.
 *
 * Пишется прямой записью в колонки следа (миграция `0292`), а не дверью: двери, которая сокращает
 * период, в этой ветке ещё нет — она заводится этапом Э9, — а предмет здешних случаев не в том,
 * **кто** правит лист, а в том, что журнал видит правленый лист правленым. Ровно тем же приёмом и
 * по той же причине этот файл двигает даты бланка в прошлое (`movePast`).
 *
 * Границы недели берутся понедельником и воскресеньем: `waybills_period_check` держит лист внутри
 * одной календарной недели, а `waybills_period_trim_check` требует, чтобы прежний конец был строго
 * больше нынешнего. Версия поднимается вместе со следом — так же, как её поднимает настоящая
 * правка (Р21): бланк, собранный из прежнего снимка, документом больше не подтверждается.
 */
async function trimPeriod(
  sheet: Sheet,
  reason: string,
): Promise<{ periodTo: string; periodToOriginal: string }> {
  const monday = weekStartKey(ctx.today);
  const wednesday = shiftDateKey(monday, 2);
  const sunday = shiftDateKey(monday, 6);
  await ctx.db.execute(
    sql`UPDATE waybills
        SET issued_for_date = ${monday}, period_from = ${monday}, period_to = ${wednesday},
            period_to_original = ${sunday}, period_trimmed_at = now(),
            period_trimmed_by = ${ctx.adminId}, period_trim_reason = ${reason},
            version = version + 1
        WHERE id = ${sheet.id}`,
  );
  return { periodTo: wednesday, periodToOriginal: sunday };
}

async function cancel(
  auth: { authorization: string },
  id: string,
  payload: Record<string, unknown>,
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/waybills/${id}/cancel`,
    headers: auth,
    payload,
  });
}

/** Строка журнала как её видит портал. */
async function journalRow(id: string) {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waybills/${id}`,
    headers: ctx.admin,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    isCorrection: boolean;
    correctionReason: string;
    cancelReason: string;
    correctsNumber: string | null;
    correctedByNumber: string | null;
    status: string;
    /** След сокращения периода (Р12): портал показывает им обе даты и причину правки. */
    periodTo: string | null;
    periodToOriginal: string | null;
    trimmedAt: string | null;
    trimReason: string;
  };
}

/** Есть ли лист в журнале при заданном отборе — им проверяется седьмой фильтр. */
async function journalHas(id: string, query: Record<string, string>): Promise<boolean> {
  const params = new URLSearchParams({ pageSize: '100', ...query });
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waybills?${params.toString()}`,
    headers: ctx.admin,
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as { id: string }[]).some((row) => row.id === id);
}

/** Строки операций по ключу: их обязана быть ровно одна, сколько бы раз запрос ни повторили. */
async function correctionsOf(operationId: string) {
  const rows = await ctx.db.execute<{
    id: string;
    kind: string;
    reason: string;
    actor_user_id: string;
    payload: Record<string, unknown>;
  }>(
    sql`SELECT id, kind, reason, actor_user_id, payload FROM waybill_corrections
        WHERE operation_id = ${operationId}`,
  );
  return rows.rows;
}

function uuid(): string {
  return crypto.randomUUID();
}

describe.skipIf(!DB_URL)('коррекция задним числом: списание и печать (живая схема)', () => {
  beforeAll(async () => {
    // Окружение и своя база готовы хуком механики (`useReadModeDatabase`).

    const adminId = await seedUser(ADMIN_EMAIL, 'admin');
    await seedUser(DISPATCHER_EMAIL, 'dispatcher');
    await seedUser(MANAGER_EMAIL, 'manager');
    const personId = await seedPerson();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    };

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

    ctx = {
      app,
      db,
      closeDb,
      admin: await login(ADMIN_EMAIL),
      dispatcher: await login(DISPATCHER_EMAIL),
      manager: await login(MANAGER_EMAIL),
      adminId,
      vehicle: { id: vehicle.id, typeId: vehicle.type_id, categoryId: vehicle.category_id },
      objectId: object.id,
      personId,
      today: moscowDateKeyOf(new Date()),
    };
  }, 180_000);

  afterAll(async () => {
    duringRender = null;
    if (ctx?.db) {
      /*
       * Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а здесь почти
       * каждый случай начинается с выписки листа — за прогон в ней оседало по девять заказов со
       * всей их бумагой и по три следа операций.
       *
       * Метка — собственные учётки файла: всё, что тут заводится, заводят они, а чужого под ними не
       * бывает. Списком заведённого уборка не пользуется намеренно — прибирать надо и за упавшим
       * прогоном, который до записи в список мог не дойти. Сами учётки уборка не трогает: их
       * `beforeAll` ищет по адресам и заводит один раз на все прогоны.
       *
       * Порядок обратен ссылкам: лист держит и заказ, и рейс ключами `restrict`, состав рейса —
       * заказ, а след операции — автора. Талоны листа, детали и история заказа уходят каскадом со
       * своей головной строкой.
       *
       * Человек и его документы остаются: он ищется по СНИЛС и заводится один раз на все прогоны —
       * то есть не накапливается.
       */
      const ourUsers = sql`
        SELECT id FROM users WHERE email IN (${ADMIN_EMAIL}, ${DISPATCHER_EMAIL}, ${MANAGER_EMAIL})`;
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
      await ctx.db.execute(sql`
        DELETE FROM waybill_corrections WHERE actor_user_id IN (${ourUsers})`);
      // Журнал — по автору: писали в него только здешние учётки, а видов записей у них несколько.
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  }, 60_000);

  /*
   * Случаи гоняются в обоих режимах чтения; инфраструктура файла (`beforeAll`/`afterAll`) остаётся
   * снаружи — два блока означали бы два `afterAll`, и первый закрыл бы соединение.
   *
   * Сегодня половины совпадают: глубину и право коррекция считает по датам, а не по бумаге. На этапе 5 расходится фикстура movePast — её надо переписать на отрезок (например ср–пт), иначе файл будет мерить глубину только по воскресеньям.
   */
  describeReadModes(readMode, 'списание задним числом', (mode) => {
    void mode;

  it('без права прошедший день закрыт, а сегодняшний лист тот же человек списывает', async () => {
    const past = await issueWaybill();
    await movePast(past, 10);

    const denied = await cancel(ctx.manager, past.id, { reason: 'Рейс не состоялся' });
    // 403, а не 409: помочь может только другой человек — тот, у кого есть право на коррекцию.
    expect(denied.statusCode, denied.body).toBe(403);
    expect((await journalRow(past.id)).status).toBe('issued');

    // Граница не сдвинулась: сегодняшний испорченный бланк списывается как прежде, без права,
    // причины операции и записи в журнале коррекций.
    const today = await issueWaybill();
    const ok = await cancel(ctx.manager, today.id, { reason: 'Испорчен при печати' });
    expect(ok.statusCode, ok.body).toBe(200);
    const row = await journalRow(today.id);
    expect(row.status).toBe('cancelled');
    expect(row.isCorrection, 'сегодняшнее списание коррекцией не является').toBe(false);
  }, 120_000);

  it('с правом лист прошедшего дня списывается — с ключом операции, причиной и следом', async () => {
    const sheet = await issueWaybill();
    await movePast(sheet, 8);
    const reason = 'На объект выехала другая машина';

    // Ключ обязателен: без него повтор после обрыва связи списал бы номер второй раз.
    const noKey = await cancel(ctx.admin, sheet.id, { reason });
    expect(noKey.statusCode, noKey.body).toBe(422);
    expect(noKey.json().fields?.operationId).toBeTruthy();

    const operationId = uuid();
    const done = await cancel(ctx.admin, sheet.id, { reason, operationId });
    expect(done.statusCode, done.body).toBe(200);

    const row = await journalRow(sheet.id);
    expect(row.status).toBe('cancelled');
    // Причина операции уходит в `cancel_reason` (Р35): у списанного бланка колонка причины уже
    // есть, и второй такой же заводить незачем.
    expect(row.cancelReason).toBe(reason);
    expect(row.isCorrection, 'признак считается по ссылке на операцию').toBe(true);
    // Замены у списания нет — и в фильтр оно попадает именно поэтому по операции, а не по ссылке.
    expect(row.correctsNumber).toBeNull();
    expect(row.correctedByNumber).toBeNull();

    const corrections = await correctionsOf(operationId);
    expect(corrections.length).toBe(1);
    expect(corrections[0]!.kind).toBe('cancel');
    expect(corrections[0]!.reason).toBe(reason);
    expect(corrections[0]!.actor_user_id).toBe(ctx.adminId);
    // Снимок «было → стало»: через месяцы по нему объясняют, чем номер был на момент списания.
    expect((corrections[0]!.payload as { waybill?: { number?: string } }).waybill?.number).toBe(
      sheet.number,
    );

    expect(await journalHas(sheet.id, { correction: 'true' })).toBe(true);
    expect(await journalHas(sheet.id, { correction: 'false' })).toBe(false);
  }, 120_000);

  it('повтор с тем же ключом ничего не выполняет, с другим телом и от другого лица — 409', async () => {
    const sheet = await issueWaybill();
    await movePast(sheet, 5);
    const reason = 'Лист выписан на не ту неделю';
    const operationId = uuid();

    const first = await cancel(ctx.admin, sheet.id, { reason, operationId });
    expect(first.statusCode, first.body).toBe(200);
    const cancelledAt = (first.json() as { cancelledAt: string }).cancelledAt;

    // Ретрай после обрыва связи: тот же ключ, то же тело — прежний результат, собранный из
    // текущего состояния листа, и ни одной новой строки операции.
    const repeat = await cancel(ctx.admin, sheet.id, { reason, operationId });
    expect(repeat.statusCode, repeat.body).toBe(200);
    expect((repeat.json() as { cancelledAt: string }).cancelledAt).toBe(cancelledAt);
    expect((await correctionsOf(operationId)).length).toBe(1);

    // Тот же ключ с другой причиной — не повтор, а другая команда: молчаливая отдача чужого
    // результата означала бы, что вторая команда «выполнилась», не выполнившись.
    const other = await cancel(ctx.admin, sheet.id, { reason: 'Другая причина', operationId });
    expect(other.statusCode, other.body).toBe(409);

    // Чужим пользователем — тоже 409, даже с тем же телом: ключ принадлежит автору.
    const foreign = await cancel(ctx.dispatcher, sheet.id, { reason, operationId });
    expect(foreign.statusCode, foreign.body).toBe(409);
  }, 120_000);

  it('глубже предела диспетчер не правит, а администратор правит', async () => {
    const sheet = await issueWaybill();
    await movePast(sheet, WAYBILL_CORRECTION_DAYS + 15);
    const reason = 'Бланк списан по акту инвентаризации';

    // У диспетчера есть `waybills.correct`, но не `waybills.correctBeyondLimit`: 422, а не 403 —
    // право у него есть, не хватает глубины, и поручение отсюда другое.
    const tooDeep = await cancel(ctx.dispatcher, sheet.id, { reason, operationId: uuid() });
    expect(tooDeep.statusCode, tooDeep.body).toBe(422);
    expect(tooDeep.json().message).toContain(String(WAYBILL_CORRECTION_DAYS));
    expect((await journalRow(sheet.id)).status).toBe('issued');

    const byAdmin = await cancel(ctx.admin, sheet.id, { reason, operationId: uuid() });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect((await journalRow(sheet.id)).status).toBe('cancelled');
  }, 120_000);

  it('лист, аннулированный во время сборки PDF, на бумагу не уходит', async () => {
    const sheet = await issueWaybill();

    // Печать без гонки: подменённый конвертер отдаёт бланк, и проверка после рендера ей не мешает.
    const printed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waybills/${sheet.id}/print`,
      headers: ctx.admin,
    });
    expect(printed.statusCode, printed.body).toBe(200);
    expect(printed.headers['content-type']).toContain('application/pdf');

    const raced = await issueWaybill();
    duringRender = async () => {
      // Ровно то, что делает коррекция соседней вкладкой, пока LibreOffice собирает бумагу.
      await ctx.db.execute(
        sql`UPDATE waybills
            SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${ctx.adminId},
                cancel_reason = 'Коррекция во время печати'
            WHERE id = ${raced.id}`,
      );
    };
    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/waybills/${raced.id}/print`,
        headers: ctx.admin,
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().message).toBe(WAYBILL_CANCELLED_PRINT_MESSAGE);
    } finally {
      duringRender = null;
    }

    // Отметки «печатали» у неотданной бумаги быть не должно: она никуда не уехала.
    const row = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waybills/${raced.id}`,
      headers: ctx.admin,
    });
    expect((row.json() as { printedAt: string | null }).printedAt).toBeNull();
  }, 180_000);

  it('пачка сторожится по всем листам, а не по первому, и называет номер', async () => {
    const first = await issueWaybill();
    const second = await issueWaybill();

    duringRender = async () => {
      await ctx.db.execute(
        sql`UPDATE waybills
            SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${ctx.adminId},
                cancel_reason = 'Коррекция во время печати пачки'
            WHERE id = ${second.id}`,
      );
    };
    try {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/waybills/print-batch',
        headers: ctx.admin,
        payload: { ids: [first.id, second.id] },
      });
      expect(res.statusCode, res.body).toBe(409);
      // Номер в тексте — единственное, чем человек поймёт, какой лист убрать из выбора.
      expect(res.json().message).toContain(second.number);
    } finally {
      duringRender = null;
    }
  }, 180_000);
  /*
   * Сокращение периода в журнале (Р12). Отдельной метки у него нет — решение заказчика по В3:
   * бухгалтерии важно не то, каким механизмом бланк привели к нынешнему виду, а то, что он не
   * такой, каким выдан. Значит, весь вес ложится на существующий признак и существующий фильтр, и
   * оба обязаны знать про третий источник.
   *
   * Проверяется на живой схеме и настоящим HTTP-путём по той же причине, что и остальной файл:
   * ломается здесь не предикат, а сборка выдачи и условие запроса. Ошибка не роняет ничего —
   * ответ остаётся успешным, в нём просто тихо не хватает метки либо строки.
   */
  it('сокращённый лист — коррекция для журнала, и след правки приезжает в ответе', async () => {
    const sheet = await issueWaybill();
    const { periodTo, periodToOriginal } = await trimPeriod(sheet, 'машина ушла с объекта раньше');

    const row = await journalRow(sheet.id);
    // Третий источник метки: операции коррекции у листа нет вовсе — ни причины, ни замены, — а
    // признак поднят. Проверять его вместе с пустыми полями операции обязательно: иначе тест
    // прошёл бы и на портале, который метит коррекцией всё подряд.
    expect(row.isCorrection, 'признак поднимает сам факт правки периода').toBe(true);
    expect(row.correctionReason).toBe('');
    expect(row.correctsNumber).toBeNull();
    expect(row.correctedByNumber).toBeNull();
    // Номер не сгорел и лист остался действующим: сокращение — правка на месте, а не пара
    // «аннулировать плюс выписать».
    expect(row.status).toBe('issued');

    // Обе даты сразу: одно только «сокращён» не отвечает на вопрос, ради которого поле и заведено,
    // — насколько печатная графа шире действующего срока (Р13).
    expect(row.periodTo).toBe(periodTo);
    expect(row.periodToOriginal).toBe(periodToOriginal);
    expect(row.trimReason).toBe('машина ушла с объекта раньше');
    expect(row.trimmedAt, 'время правки — то, чем считается третий источник').not.toBeNull();
  }, 180_000);

  it('обе ветви фильтра знают о сокращении: `true` показывает такой лист, `false` его прячет', async () => {
    const trimmed = await issueWaybill();
    await trimPeriod(trimmed, 'заказ закрыт фактической датой');
    // Обычный лист рядом — контроль: без него проверка прошла бы и на фильтре, который вернул всё
    // подряд, и на фильтре, который не вернул ничего.
    const plain = await issueWaybill();

    expect(await journalHas(trimmed.id, { correction: 'true' })).toBe(true);
    expect(await journalHas(plain.id, { correction: 'true' })).toBe(false);

    /*
     * Вторая ветвь — не «всё остальное», а собственный вопрос «что шло обычным порядком», и
     * забытое в ней третье условие соврало бы молча: сокращённый лист стоял бы среди обычных, а
     * ошибки не случилось бы ни в какой момент.
     */
    expect(await journalHas(trimmed.id, { correction: 'false' })).toBe(false);
    expect(await journalHas(plain.id, { correction: 'false' })).toBe(true);

    // Без отбора журнал показывает оба: фильтр сужает выдачу, а не прячет бумагу из учёта.
    expect(await journalHas(trimmed.id, {})).toBe(true);
    expect(await journalHas(plain.id, {})).toBe(true);
  }, 180_000);

  /*
   * ПОВТОРНОЕ СОКРАЩЕНИЕ ЛИСТА — по колонкам (Р12, таблица «При второй и следующей правке»).
   *
   * Два случая ниже отличаются от соседних предметом: те спрашивают, как журнал ПОКАЗЫВАЕТ уже
   * правленый лист, и потому пишут след руками (`trimPeriod`); эти спрашивают, что настоящая
   * правка делает со следом, который на листе УЖЕ стоит. Рукой такое не проверить по определению:
   * предмет — само выражение `coalesce(period_to_original, period_to)` и условие
   * `context.kind !== 'ordinary'`, то есть код, который правку и пишет.
   *
   * Поэтому обе правки идут настоящей недельной сверкой (`syncEsm2Waybills`) — тем самым входом,
   * которым бумагу этой заявки ведут все её двери в режиме `legacy`. Неординарность выражается
   * ровно так, как её выражает боевой путь: сверка, позванная с проверенной операцией коррекции,
   * исполняет план видом `backdate`, без неё — видом `ordinary`. Дверь закрытия фактической датой
   * приносит ту же пару своим исходом (`assignment_tail`/`crew` против `none`), и ставит она тот
   * же самый `period_trim_correction_id` тем же исполнителем.
   *
   * Обе последовательности Р12 названы поимённо и обе стали случаями: неординарная → обычная
   * (ссылка **снимается**) и обычная → неординарная (ссылка **появляется**). Общего у них три
   * утверждения, и каждое — отдельный способ соврать в бланке строгой отчётности:
   * `period_to_original` помнит выписку, а не прошлую правку; тройка «когда, кто, почему»
   * описывает последнюю; версия растёт каждой правкой, иначе сторож печати (Р21) стоит вхолостую.
   */

  /**
   * Понедельник недели, целиком лежащей внутри одного месяца.
   *
   * Берётся следующая неделя, а не текущая: во-первых, лист будущей недели заведомо не отработан
   * и правится обычным порядком — сцена не зависит от дня, в который её запустили; во-вторых,
   * месячный разрез (ADR 0142) разбил бы неделю на два листа, и правился бы уже не тот лист,
   * который выдан. Две недели подряд границу месяца пересечь не могут — в месяце больше семи дней,
   * — поэтому запасной вариант ровно один.
   */
  function wholeMonthWeek(): string {
    const next = shiftDateKey(weekStartKey(ctx.today), 7);
    return next.slice(0, 7) === shiftDateKey(next, 6).slice(0, 7) ? next : shiftDateKey(next, 7);
  }

  /** Учётка по адресу: вторая правка обязана быть чужой — иначе «кто» ничего не доказывает. */
  async function userIdOf(email: string): Promise<string> {
    const rows = await ctx.db.execute<{ id: string }>(
      sql`SELECT id FROM users WHERE email = ${email}`,
    );
    return rows.rows[0]!.id;
  }

  /**
   * Строка операции журнала. Заводится прямой записью: предмет случая — след правки на листе, а не
   * дверь, эту операцию порождающая; проходить дверь ради ссылки значило бы проверять чужой модуль.
   * Вид `esm2` — тот самый, под которым бумагу заявки правят задним числом.
   */
  async function correctionRow(actorUserId: string, reason: string): Promise<string> {
    const rows = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO waybill_corrections (operation_id, fingerprint, kind, reason, actor_user_id)
      VALUES (${uuid()}, ${'тест: отпечаток не проверяется'}, 'esm2', ${reason}, ${actorUserId})
      RETURNING id`);
    return rows.rows[0]!.id;
  }

  /** Настоящая недельная сверка: с проверенной операцией — неординарная, без неё — обычная. */
  async function syncPaper(
    requestId: string,
    reason: string,
    options: { actorId?: string; correctionId?: string } = {},
  ): Promise<void> {
    const { syncEsm2Waybills } = await import('../src/services/waybill-esm2');
    await ctx.db.transaction(async (tx) => {
      await syncEsm2Waybills(tx, {
        requestId,
        actor: { id: options.actorId ?? ctx.adminId },
        reason,
        ...(options.correctionId
          ? { correction: { id: options.correctionId, unlockWaybillIds: [] } }
          : {}),
      });
    });
  }

  /** Срок заказа: его и двигают все входы сокращения — правка листа идёт следом за ним. */
  async function setTermTo(requestId: string, dateTo: string): Promise<void> {
    await ctx.db.execute(sql`
      UPDATE special_equipment_request_details SET date_to = ${dateTo}
       WHERE request_id = ${requestId}`);
  }

  /** Действующие листы заказа: правка не расходует номера, и их число обязано остаться прежним. */
  async function activeSheetIds(requestId: string): Promise<string[]> {
    const rows = await ctx.db.execute<{ id: string }>(sql`
      SELECT id FROM waybills
       WHERE source_request_id = ${requestId} AND status <> 'cancelled'
       ORDER BY period_from`);
    return rows.rows.map((row) => row.id);
  }

  /** След правки прямо из строки листа: журнал показывает его же, но держит именно она. */
  async function trimTrail(sheetId: string): Promise<{
    periodTo: string;
    periodToOriginal: string | null;
    reason: string;
    trimmedBy: string | null;
    trimmedAt: string | null;
    correctionId: string | null;
    version: number;
  }> {
    const rows = await ctx.db.execute<{
      period_to: string;
      period_to_original: string | null;
      period_trim_reason: string;
      period_trimmed_by: string | null;
      period_trimmed_at: string | null;
      period_trim_correction_id: string | null;
      version: number;
    }>(sql`
      SELECT period_to, period_to_original, period_trim_reason, period_trimmed_by,
             period_trimmed_at::text AS period_trimmed_at, period_trim_correction_id, version
        FROM waybills WHERE id = ${sheetId}`);
    const row = rows.rows[0]!;
    return {
      periodTo: row.period_to,
      periodToOriginal: row.period_to_original,
      reason: row.period_trim_reason,
      trimmedBy: row.period_trimmed_by,
      trimmedAt: row.period_trimmed_at,
      correctionId: row.period_trim_correction_id,
      version: Number(row.version),
    };
  }

  /**
   * Заказ, у которого выдан один лист на всю неделю, — сцена обеих последовательностей.
   *
   * Срок переставляется прямой записью, а лист выписывается настоящей сверкой по нему: заводить
   * заказ будущей неделей через дверь нельзя (`issueWaybill` берёт заявку в работу сегодняшним
   * днём), а выписывать бланк руками — значит проверять правку на бумаге, которой портал не
   * выписывал.
   */
  async function weekSheet(): Promise<{
    requestId: string;
    sheetId: string;
    from: string;
    to: string;
  }> {
    const issued = await issueWaybill();
    const owner = await ctx.db.execute<{ request_id: string }>(
      sql`SELECT source_request_id AS request_id FROM waybills WHERE id = ${issued.id}`,
    );
    const requestId = owner.rows[0]!.request_id;
    const from = wholeMonthWeek();
    const to = shiftDateKey(from, 6);
    await ctx.db.execute(sql`
      UPDATE special_equipment_request_details SET date_from = ${from}, date_to = ${to}
       WHERE request_id = ${requestId}`);
    await syncPaper(requestId, 'сцена теста: бумага на всю неделю');

    const active = await ctx.db.execute<{
      id: string;
      period_from: string;
      period_to: string;
    }>(sql`
      SELECT id, period_from, period_to FROM waybills
       WHERE source_request_id = ${requestId} AND status <> 'cancelled'`);
    expect(active.rows.length, 'у заказа ровно один действующий недельный лист').toBe(1);
    const sheet = active.rows[0]!;
    expect(sheet.period_from).toBe(from);
    expect(sheet.period_to).toBe(to);
    const trail = await trimTrail(sheet.id);
    expect(trail.periodToOriginal, 'выданный лист следа правки не носит').toBeNull();
    return { requestId, sheetId: sheet.id, from, to };
  }

  it('неординарная правка, а следом обычная: ссылка на операцию снимается, «каким выдан» помнит выписку', async () => {
    const { requestId, sheetId, from, to } = await weekSheet();
    const issuedVersion = (await trimTrail(sheetId)).version;
    const dispatcherId = await userIdOf(DISPATCHER_EMAIL);
    const correctionId = await correctionRow(dispatcherId, 'операция: неделя переоформлена');

    // Первая правка — неординарная: сверка идёт под проверенной операцией, и лист обязан на неё
    // сослаться (Р12: `assignment_tail` — такая же операция журнала, как `crew`).
    await setTermTo(requestId, shiftDateKey(from, 4));
    await syncPaper(requestId, 'ТЕСТ: сокращение под операцией журнала', {
      actorId: dispatcherId,
      correctionId,
    });
    const first = await trimTrail(sheetId);
    expect(first.periodTo).toBe(shiftDateKey(from, 4));
    expect(first.periodToOriginal, 'первая правка и запоминает, каким лист выдан').toBe(to);
    expect(first.correctionId).toBe(correctionId);
    expect(first.trimmedBy).toBe(dispatcherId);
    expect(first.reason).toBe('ТЕСТ: сокращение под операцией журнала');
    expect(first.version).toBe(issuedVersion + 1);

    // Вторая — обычная, другим человеком и с другой причиной.
    await setTermTo(requestId, shiftDateKey(from, 2));
    await syncPaper(requestId, 'ТЕСТ: заказ закрыт фактической датой', { actorId: ctx.adminId });
    const second = await trimTrail(sheetId);
    expect(second.periodTo).toBe(shiftDateKey(from, 2));
    /*
     * Главное утверждение последовательности: ссылка снята. Оставь её обычная правка — журнал
     * объяснял бы нынешний вид листа чужим действием, которое к нему уже не относится, а отбор
     * «что делали задним числом» показывал бы бланк, задним числом не правленый.
     */
    expect(second.correctionId, 'обычная правка ссылку на операцию снимает').toBeNull();
    // «Каким выдан» переписать нельзя: печатная графа на площадке по-прежнему говорит про воскресенье.
    expect(second.periodToOriginal, 'колонка помнит выписку, а не прошлую правку').toBe(to);
    // Тройка «когда, кто, почему» описывает последнюю правку целиком, а не по частям.
    expect(second.trimmedBy).toBe(ctx.adminId);
    expect(second.reason).toBe('ТЕСТ: заказ закрыт фактической датой');
    expect(second.trimmedAt! >= first.trimmedAt!).toBe(true);
    // Версия растёт каждой правкой: на ней стоит сторож печати (Р21).
    expect(second.version).toBe(issuedVersion + 2);
    // Номер не сгорел и лист остался тем же: правка — на месте, а не пара «аннулировать плюс выписать».
    expect(await activeSheetIds(requestId)).toEqual([sheetId]);
  }, 180_000);

  it('обычная правка, а следом неординарная: ссылка на операцию появляется, а «каким выдан» не двигается', async () => {
    const { requestId, sheetId, from, to } = await weekSheet();
    const issuedVersion = (await trimTrail(sheetId)).version;
    const dispatcherId = await userIdOf(DISPATCHER_EMAIL);

    await setTermTo(requestId, shiftDateKey(from, 4));
    await syncPaper(requestId, 'ТЕСТ: обычное сокращение срока', { actorId: ctx.adminId });
    const first = await trimTrail(sheetId);
    expect(first.periodTo).toBe(shiftDateKey(from, 4));
    expect(first.periodToOriginal).toBe(to);
    expect(first.correctionId, 'обычной правке ссылаться не на что').toBeNull();
    expect(first.trimmedBy).toBe(ctx.adminId);
    expect(first.version).toBe(issuedVersion + 1);

    const correctionId = await correctionRow(dispatcherId, 'операция: неделя переоформлена');
    await setTermTo(requestId, shiftDateKey(from, 2));
    await syncPaper(requestId, 'ТЕСТ: сокращение под операцией журнала', {
      actorId: dispatcherId,
      correctionId,
    });
    const second = await trimTrail(sheetId);
    expect(second.periodTo).toBe(shiftDateKey(from, 2));
    // Обратная сторона того же правила: ссылка появляется у листа, который её не имел.
    expect(second.correctionId, 'неординарная правка ссылку ставит').toBe(correctionId);
    expect(second.periodToOriginal, 'колонка помнит выписку, а не прошлую правку').toBe(to);
    expect(second.trimmedBy).toBe(dispatcherId);
    expect(second.reason).toBe('ТЕСТ: сокращение под операцией журнала');
    expect(second.trimmedAt! >= first.trimmedAt!).toBe(true);
    expect(second.version).toBe(issuedVersion + 2);
    expect(await activeSheetIds(requestId)).toEqual([sheetId]);

    // И журнал видит правленый лист правленым обеими правками подряд: метку поднимает сам факт
    // правки периода, а не ссылка на операцию (Э11).
    const row = await journalRow(sheetId);
    expect(row.isCorrection).toBe(true);
    expect(row.periodToOriginal).toBe(to);
    expect(row.trimReason).toBe('ТЕСТ: сокращение под операцией журнала');
  }, 180_000);
  });
});
