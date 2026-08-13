import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

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
async function issueWaybill(): Promise<Sheet> {
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
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

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
    await ctx?.app.close();
    await ctx?.closeDb();
  });

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
});
