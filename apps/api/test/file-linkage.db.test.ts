import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as ReadingsNs from '../src/services/readings';

/**
 * Жизненный цикл файла: связи и уборка (план `docs/driver-portal-plan.md`, §4 Р18; миграция 0133).
 *
 * Зачем база. Перечень таблиц привязки перестал быть кодом: он живёт в функции БД
 * `file_is_linked(uuid)`, и все три её читателя — проверка привязываемости, решение о доступе к
 * файлу и уборка в воркере — спрашивают именно её. Проверить полноту этого перечня на подменах
 * нельзя в принципе: подмена вернёт то, что в неё положили, а вопрос стоит ровно обратный — знает
 * ли **настоящая** функция про **настоящие** таблицы связи. Цена ошибки здесь не «лишний доступ»:
 * забытая таблица означает, что уборка сочтёт подшитый документ сиротой и поставит задачу на снос
 * объекта из S3.
 *
 * Тем же объясняется и третий блок. Уборка отбирает кандидатов ОДНИМ запросом, где `NOT
 * file_is_linked` стоит до `LIMIT`, — и это не стилистика: перенеси фильтр за выборку, и две сотни
 * старых связанных файлов займут батч целиком, а до настоящих сирот очередь не дойдёт никогда.
 * Утверждение про «до `LIMIT`» проверяемо только на данных, где связанных больше, чем батч.
 *
 * Запуск — как у остальных db-тестов:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test file-linkage
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-file-linkage-admin@example.invalid';
/** Метка своих карточек и машин: база у db-тестов общая и переживает повторный запуск. */
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: связи файлов';
/**
 * Общий префикс ключей объектов. По нему же идёт уборка — и перед прогоном тоже: упавший прогон
 * оставляет файлы, а следующий считал бы их чужими сиротами.
 */
const KEY_PREFIX = 'db-file-linkage/';
/** Номера бланков — из заведомо свободного диапазона: серия общая с остальной базой. */
const WAYBILL_NUMBER_BASE = 910_000_000;

/**
 * Исходник воркера читается как текст: запрос уборки берётся из него, а не переписывается в тест.
 * Импортировать модуль нельзя — последней строкой он запускает бесконечный цикл (`void loop()`), а
 * копия запроса в тесте отвечала бы за себя, а не за воркер, и «фильтр до `LIMIT`» проверялся бы
 * на копии, в которой он и так стоит правильно.
 */
const WORKER_SOURCE = new URL('../../worker/src/index.ts', import.meta.url);

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  readings: typeof ReadingsNs;
  closeDb: () => Promise<void>;
  adminId: string;
  objectId: string;
  typeId: string;
  organizationId: string;
  seriesId: string;
  /** Родители связей — по одному на каждую таблицу из `file_is_linked`. */
  parents: {
    wasteRequestId: string;
    vehicleRequestId: string;
    waybillId: string;
    serviceRequestId: string;
    readingId: string;
    maintenanceId: string;
  };
  /** Работник и машина для отчёта, который сдаётся настоящим сервисом (проверка `pending`). */
  submit: { personId: string; vehicleId: string; date: string };
}

let ctx: Ctx;
let fileNo = 0;
let waybillNo = 0;

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
 * Уборка своих данных. Порядок обратный ссылкам: сначала отчёты (за ними каскадом строки, показания
 * и связи с файлами), затем документы и заявки, потом сами файлы, машины и люди. Учётка идёт
 * последней: на неё ссылается всё созданное.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const admin = sql`(SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`;
  await db.execute(sql`DELETE FROM driver_daily_reports WHERE created_by IN ${admin}`);
  // По метке, а не только по автору: документы этой машины мог выписать прежний прогон под другой
  // учёткой — а `RESTRICT` у листа и рейса не даст снести машину, пока они живы.
  const marked = sql`(SELECT id FROM vehicles WHERE note = ${MARK})`;
  await db.execute(
    sql`DELETE FROM waybills WHERE issued_by IN ${admin} OR vehicle_id IN ${marked}`,
  );
  await db.execute(
    sql`DELETE FROM vehicle_routes WHERE created_by IN ${admin} OR vehicle_id IN ${marked}`,
  );
  await db.execute(sql`DELETE FROM service_requests WHERE created_by IN ${admin}`);
  await db.execute(sql`DELETE FROM waste_requests WHERE created_by IN ${admin}`);
  await db.execute(sql`DELETE FROM vehicle_requests WHERE created_by IN ${admin}`);
  // Строки связей уходят каскадом вместе с файлом (`ON DELETE CASCADE` у всех шести таблиц).
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${KEY_PREFIX}%`}`);
  // Записи ТО — раньше машин по той же причине, что и отчёты дня: акт обслуживания держит машину
  // `RESTRICT`'ом намеренно (миграция 0147), он переживает вывод единицы из парка.
  await db.execute(sql`DELETE FROM vehicle_maintenance WHERE vehicle_id IN ${marked}`);
  // Отчёты дня сносятся раньше машин и людей — и это не порядок ради порядка: показания держат
  // машину и работника `RESTRICT`'ом намеренно (ADR 0103), учётный факт не должен исчезать вместе
  // со справочной строкой. Уборка теста обязана разбирать свои следы в том же порядке, в каком их
  // разбирал бы администратор.
  await db.execute(
    sql`DELETE FROM driver_daily_reports WHERE person_id IN (SELECT id FROM persons WHERE comment = ${MARK})`,
  );
  await db.execute(sql`DELETE FROM vehicles WHERE note = ${MARK}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${MARK}`);
  await db.execute(sql`DELETE FROM users WHERE email = ${ADMIN_EMAIL}`);
}

async function seedAdmin(db: typeof AppDb, schema: typeof SchemaNs): Promise<string> {
  const { hashPassword } = await import('../src/auth/password');
  const [created] = await db
    .insert(schema.users)
    .values({
      email: ADMIN_EMAIL,
      lastName: 'Тестовый',
      firstName: 'Администратор',
      middleName: 'Файлов',
      passwordHash: await hashPassword('db-test-password-123'),
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/**
 * Файл. `createdAt` задаётся явно: оба прохода уборки отбирают по возрасту, и «старый» — это
 * условие теста, а не то, что успело настояться в базе.
 */
async function newFile(
  options: { status?: 'pending' | 'active'; ageDays?: number; id?: string } = {},
): Promise<{ id: string; objectKey: string }> {
  fileNo += 1;
  const objectKey = `${KEY_PREFIX}${randomUUID()}`;
  const created = new Date(Date.now() - (options.ageDays ?? 0) * 24 * 60 * 60 * 1000);
  const [row] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      ...(options.id ? { id: options.id } : {}),
      bucket: 'test',
      objectKey,
      filename: `скан-${fileNo}.pdf`,
      contentType: 'application/pdf',
      size: 1024,
      status: options.status ?? 'active',
      uploadedBy: ctx.adminId,
      createdAt: created,
    })
    .returning({ id: ctx.schema.files.id, objectKey: ctx.schema.files.objectKey });
  return row!;
}

async function isLinked(fileId: string): Promise<boolean> {
  const res = await ctx.db.execute<{ linked: boolean }>(
    sql`SELECT file_is_linked(${fileId}) AS linked`,
  );
  return res.rows[0]!.linked;
}

async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Файлов', firstName, middleName: 'Тестович', comment: MARK })
    .returning({ id: ctx.schema.persons.id });
  return person!.id;
}

/** Своя машина: у собственной описание пустое и цен нет — этого требует `vehicles_own_fields_check`. */
async function newVehicle(): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({ ownership: 'own', vehicleTypeId: ctx.typeId, status: 'active', note: MARK })
    .returning({ id: ctx.schema.vehicles.id });
  return vehicle!.id;
}

async function newVehicleRequest(): Promise<string> {
  const [request] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.typeId,
      createdBy: ctx.adminId,
      comment: MARK,
    })
    .returning({ id: ctx.schema.vehicleRequests.id });
  return request!.id;
}

/**
 * Лист 4-П по рейсу: `waybills_form_source_check` требует у него заполненный `route_id`. Выписка
 * идёт фикстурой рейса, потому что кабинет строго документален (ADR 0105, Р5) — рейс без
 * действительного листа в задание не входит, а без строки ожидания отчёт нечем сдать и файл не к
 * чему привязать.
 */
async function issueWaybillFor(
  routeId: string,
  vehicleId: string,
  personId: string,
  date: string,
): Promise<string> {
  waybillNo += 1;
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: WAYBILL_NUMBER_BASE + waybillNo,
      formCode: '4p',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId,
      driverPersonId: personId,
      issuedForDate: date,
      routeId,
      issuedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.waybills.id });
  return waybill!.id;
}

/**
 * Рейс-перегон с выписанным по нему листом: `vehicle_routes_source_request_check` требует у него
 * заявку-основание, а кабинет — документ (ADR 0105, Р5).
 */
async function newRoute(vehicleId: string, personId: string, date: string): Promise<string> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId,
      routeDate: date,
      purpose: 'delivery',
      sourceRequestId: await newVehicleRequest(),
      moveFrom: 'База',
      moveTo: 'Объект',
      driverPersonId: personId,
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id });
  await issueWaybillFor(route!.id, vehicleId, personId, date);
  return route!.id;
}

/** Недельный ЭСМ-2: `waybills_form_source_check` требует заявку-источник и обе границы недели. */
async function newEsm2(vehicleId: string, personId: string, day: string): Promise<string> {
  waybillNo += 1;
  const from = weekStartKey(day);
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: WAYBILL_NUMBER_BASE + waybillNo,
      formCode: 'esm2',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId,
      driverPersonId: personId,
      issuedForDate: from,
      sourceRequestId: await newVehicleRequest(),
      periodFrom: from,
      periodTo: shiftDateKey(from, 6),
      issuedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.waybills.id });
  return waybill!.id;
}

/**
 * Показание — прямой вставкой: здесь оно родитель связи, а не предмет проверки. Составной ключ
 * снимка (`vehicle_readings_snapshot_fk`) требует, чтобы машина, дата и позиция смены совпадали со
 * строкой ожидания, — поэтому строка заводится тем же набором значений.
 */
async function newReading(vehicleId: string, personId: string, waybillId: string, day: string) {
  const [report] = await ctx.db
    .insert(ctx.schema.driverDailyReports)
    .values({ personId, reportDate: day, createdBy: ctx.adminId })
    .returning({ id: ctx.schema.driverDailyReports.id });
  const [item] = await ctx.db
    .insert(ctx.schema.driverDailyReportItems)
    .values({
      reportId: report!.id,
      sourceKind: 'esm2',
      waybillId,
      vehicleId,
      reportDate: day,
      shiftOrder: 1,
    })
    .returning({ id: ctx.schema.driverDailyReportItems.id });
  const [reading] = await ctx.db
    .insert(ctx.schema.vehicleReadings)
    .values({
      itemId: item!.id,
      reportId: report!.id,
      vehicleId,
      reportDate: day,
      shiftOrder: 1,
      kind: 'values',
      odometerKm: 1000,
      source: 'staff',
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.vehicleReadings.id });
  return reading!.id;
}

/** Запись ТО (миграция 0147): к ней подшивают скан акта выполненных работ. */
async function newMaintenance(vehicleId: string, day: string): Promise<string> {
  const [record] = await ctx.db
    .insert(ctx.schema.vehicleMaintenance)
    .values({ vehicleId, performedOn: day, documentNumber: 'АКТ-1', createdBy: ctx.adminId })
    .returning({ id: ctx.schema.vehicleMaintenance.id });
  return record!.id;
}

/**
 * Таблицы связи и способ завести в каждой строку. Список повторяет тело `file_is_linked` — но
 * повторяет намеренно и с другой стороны: функция утверждает «эти шесть таблиц я вижу», а тест
 * заводит настоящую строку и спрашивает функцию заново. Расходятся такие списки ровно тогда, когда
 * ветку в функцию дописали неверно — а не тогда, когда её забыли (это ловит соседний тест).
 */
const LINK_CASES: { table: string; link: (fileId: string) => Promise<void> }[] = [
  {
    table: 'request_files',
    link: async (fileId) => {
      await ctx.db
        .insert(ctx.schema.requestFiles)
        .values({ requestId: ctx.parents.wasteRequestId, fileId });
    },
  },
  {
    table: 'vehicle_request_files',
    link: async (fileId) => {
      await ctx.db
        .insert(ctx.schema.vehicleRequestFiles)
        .values({ vehicleRequestId: ctx.parents.vehicleRequestId, fileId });
    },
  },
  {
    table: 'waybill_files',
    link: async (fileId) => {
      await ctx.db
        .insert(ctx.schema.waybillFiles)
        .values({ waybillId: ctx.parents.waybillId, fileId });
    },
  },
  {
    table: 'service_request_files',
    link: async (fileId) => {
      await ctx.db
        .insert(ctx.schema.serviceRequestFiles)
        .values({ requestId: ctx.parents.serviceRequestId, fileId });
    },
  },
  {
    table: 'vehicle_reading_files',
    link: async (fileId) => {
      await ctx.db
        .insert(ctx.schema.vehicleReadingFiles)
        .values({ readingId: ctx.parents.readingId, fileId });
    },
  },
  {
    table: 'vehicle_maintenance_files',
    link: async (fileId) => {
      await ctx.db
        .insert(ctx.schema.vehicleMaintenanceFiles)
        .values({ maintenanceId: ctx.parents.maintenanceId, fileId });
    },
  },
];

/** Таблицы, ссылающиеся на `files` внешним ключом, — то есть все связи, какие есть в схеме. */
async function fileLinkTables(): Promise<string[]> {
  const res = await ctx.db.execute<{ table: string }>(sql`
    SELECT DISTINCT c.conrelid::regclass::text AS table
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.confrelid = 'files'::regclass
     ORDER BY 1`);
  return res.rows.map((r) => r.table);
}

/** Таблицы, названные в теле функции: определение читается у самой базы, а не из файла миграции. */
async function tablesKnownToFunction(): Promise<string[]> {
  const res = await ctx.db.execute<{ def: string }>(
    sql`SELECT pg_get_functiondef('file_is_linked(uuid)'::regprocedure) AS def`,
  );
  const body = res.rows[0]!.def;
  return [...body.matchAll(/FROM\s+([a-z_]+)/gu)].map((m) => m[1]!).sort();
}

/**
 * Запрос отбора кандидатов уборки — дословно из исходника воркера. Размер батча там подставляется
 * шаблоном, поэтому он читается оттуда же: подставить в тесте своё число значило бы проверять
 * границу, которой у воркера нет.
 */
function workerCandidateQuery(): string {
  const source = readFileSync(WORKER_SOURCE, 'utf8');
  const batch = /const FILE_CLEANUP_BATCH = (\d+);/u.exec(source);
  const query = /`(SELECT id FROM files\b[\s\S]*?FOR UPDATE SKIP LOCKED)`/u.exec(source);
  if (!batch || !query) {
    throw new Error('В исходнике воркера не найден запрос отбора кандидатов уборки файлов');
  }
  return query[1]!.replace('${FILE_CLEANUP_BATCH}', batch[1]!);
}

describe.skipIf(!DB_URL)('жизненный цикл файла: связи и уборка (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const readings = await import('../src/services/readings');
    await cleanup(db);

    const adminId = await seedAdmin(db, schema);
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY id LIMIT 1`,
    );
    const types = await db.execute<{ id: string }>(
      sql`SELECT vt.id FROM vehicle_types vt
          JOIN vehicle_kinds vk ON vk.id = vt.kind_id
          WHERE vk.code = 'freight_transport' ORDER BY vt.code LIMIT 1`,
    );
    const organizations = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
    );
    const series = await db.execute<{ id: string }>(
      sql`SELECT id FROM waybill_series ORDER BY code LIMIT 1`,
    );
    // Оргтехника берётся свободная: открытая заявка на обслуживание у единицы техники может быть
    // только одна (`service_requests_open_per_equipment_unique`), и занятая соседним прогоном
    // единица уронила бы фикстуру уникальностью, а не по существу.
    const equipment = await db.execute<{ id: string; object_id: string; name: string }>(
      sql`SELECT e.id, e.object_id, e.name FROM office_equipment e
           WHERE e.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM service_requests s
                WHERE s.office_equipment_id = e.id
                  AND s.deleted_at IS NULL
                  AND s.status NOT IN ('accepted', 'cancelled'))
           ORDER BY e.id LIMIT 1`,
    );
    if (
      !objects.rows[0] ||
      !types.rows[0] ||
      !organizations.rows[0] ||
      !series.rows[0] ||
      !equipment.rows[0]
    ) {
      throw new Error('В базе нет объекта, типа ТС, организации, серии бланков или оргтехники');
    }

    ctx = {
      db,
      schema,
      readings,
      closeDb,
      adminId,
      objectId: objects.rows[0].id,
      typeId: types.rows[0].id,
      organizationId: organizations.rows[0].id,
      seriesId: series.rows[0].id,
      parents: {
        wasteRequestId: '',
        vehicleRequestId: '',
        waybillId: '',
        serviceRequestId: '',
        readingId: '',
        maintenanceId: '',
      },
      submit: { personId: '', vehicleId: '', date: moscowDateKeyOf(new Date()) },
    };

    const day = ctx.submit.date;
    const docsPerson = await newPerson('Документов');
    const docsVehicle = await newVehicle();
    const waybillId = await newEsm2(docsVehicle, docsPerson, day);

    // Металлолом — самая простая заявка вывоза: `waste_requests_metal_no_subject_check` запрещает
    // ей контейнер, вид отхода и цену, то есть всё, что пришлось бы искать в справочниках.
    const [waste] = await ctx.db
      .insert(ctx.schema.wasteRequests)
      .values({
        objectId: ctx.objectId,
        requestType: 'metal_removal',
        deliveryAt: new Date(),
        createdBy: ctx.adminId,
      })
      .returning({ id: ctx.schema.wasteRequests.id });
    const [service] = await ctx.db
      .insert(ctx.schema.serviceRequests)
      .values({
        officeEquipmentId: equipment.rows[0].id,
        equipmentObjectId: equipment.rows[0].object_id,
        equipmentName: equipment.rows[0].name,
        description: MARK,
        createdBy: ctx.adminId,
      })
      .returning({ id: ctx.schema.serviceRequests.id });

    ctx.parents = {
      wasteRequestId: waste!.id,
      vehicleRequestId: await newVehicleRequest(),
      waybillId,
      serviceRequestId: service!.id,
      readingId: await newReading(docsVehicle, docsPerson, waybillId, day),
      maintenanceId: await newMaintenance(docsVehicle, day),
    };

    // Отдельные работник и машина для отчёта, который сдаётся сервисом: строка ожидания занимает
    // источник глобально, и делить его с фикстурой выше нельзя.
    ctx.submit.personId = await newPerson('Отчётов');
    ctx.submit.vehicleId = await newVehicle();
    await newRoute(ctx.submit.vehicleId, ctx.submit.personId, day);
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.closeDb();
  });

  /**
   * Полнота перечня (Р18). Это и есть причина, по которой перечень уехал в базу: до неё копий
   * списка в коде было две, они разъехались (`waybill_files` завели в одной и забыли в другой), и
   * подшитый к путевому листу скан оставался виден загрузившему по прямой ссылке бессрочно.
   */
  describe('перечень таблиц привязки', () => {
    it.each(LINK_CASES.map((c) => [c.table, c] as const))(
      'связь в %s делает файл привязанным для функции',
      async (_table, testCase) => {
        const file = await newFile();
        // До связи файл — сирота: без этой половины проверка сошлась бы и на функции, которая
        // всегда отвечает «привязан», а такая функция просто выключила бы уборку целиком.
        expect(await isLinked(file.id)).toBe(false);

        await testCase.link(file.id);

        expect(await isLinked(file.id)).toBe(true);
      },
    );

    it('в функции названы все таблицы, ссылающиеся на files внешним ключом', async () => {
      // Сверка идёт со схемой, а не со списком в тесте: новая таблица связи заводится вместе с
      // новым модулем, и её обязаны дописать в функцию той же миграцией. Список в тесте пришлось
      // бы пополнять руками — то есть он молчал бы ровно в том случае, ради которого написан.
      const known = await tablesKnownToFunction();
      const missing = (await fileLinkTables()).filter((t) => !known.includes(t));

      // Исключений нет: перечень собирают по внешним ключам к `files`, а не по тому, какие ручки
      // уже написаны. `person_credential_files` (миграция 0019) — тот случай, ради которого это
      // правило и заведено: строк в таблицу пока не пишет ни одна ручка портала, и обе прежние
      // копии перечня о ней не знали, — а появись загрузка сканов при неполной функции, второй
      // проход уборки счёл бы удостоверения и медсправки сиротами и снёс их из хранилища через
      // неделю после загрузки.
      expect(missing).toEqual([]);
    });
  });

  /**
   * Незавершённая загрузка (Р18). `pending` — это файл, объекта которого в хранилище может не быть
   * вовсе (загрузку оборвали) и который через сутки заберёт уборка. Заявкам этого хватало
   * исторически: форма грузит файл и сохраняется одним движением. Показанию не хватает: ссылка на
   * несуществующий объект в учётном документе внешне неотличима от фотографии — до дня, когда её
   * попробуют открыть.
   */
  describe('привязка файла к показанию', () => {
    async function submitWithFile(fileId: string) {
      const report = await ctx.readings.openReport(
        ctx.submit.personId,
        ctx.submit.date,
        ctx.adminId,
      );
      return ctx.readings.submitReport(
        ctx.submit.personId,
        ctx.submit.date,
        {
          version: report.version,
          items: [
            {
              itemId: report.items[0]!.id,
              reading: {
                kind: 'values',
                odometerKm: 2000,
                engineHours: null,
                fuelFilledLiters: null,
                comment: '',
              },
              fileIds: [fileId],
              confirmOdometerAnomaly: false,
              confirmEngineHoursAnomaly: false,
            },
          ],
          reason: '',
        },
        ctx.adminId,
        null,
      );
    }

    it('незавершённая загрузка отвергается вместе со всей отправкой', async () => {
      const pending = await newFile({ status: 'pending' });

      await expect(submitWithFile(pending.id)).rejects.toThrow('Загрузка файла не завершена');

      // Отказ уносит всю транзакцию: показание не сохранилось, связь не завелась — иначе в отчёте
      // осталось бы число со ссылкой на файл, который завтра заберёт уборка.
      expect(await isLinked(pending.id)).toBe(false);
    });

    it('завершённая — привязывается и перестаёт быть сиротой', async () => {
      const active = await newFile({ status: 'active' });

      const report = await submitWithFile(active.id);

      expect(report.state).toBe('submitted');
      expect(await isLinked(active.id)).toBe(true);
    });
  });

  /**
   * Уборка (Р18). Проверяется не «убирает ли она сирот» — это видно и по одному файлу, — а порядок
   * условий в её запросе: фильтр связанности стоит ДО `LIMIT`. Ошибка здесь не ломает ничего
   * заметного: уборка идёт, лог пишет «убрано 0», а сироты копятся в хранилище годами, потому что
   * батч каждый час занимают одни и те же старые связанные файлы.
   */
  describe('отбор кандидатов уборки', () => {
    it('двести связанных файлов не заслоняют сироту', async () => {
      const batch = 200;
      // Идентификаторы задаются явно: запрос уборки упорядочен по `id`, и «двести связанных ПЕРЕД
      // сиротой» — это условие теста, а не то, как лягут случайные UUID.
      const linked = await Promise.all(
        Array.from({ length: batch }, (_, i) =>
          newFile({
            ageDays: 30,
            id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          }),
        ),
      );
      for (const file of linked) {
        await ctx.db
          .insert(ctx.schema.requestFiles)
          .values({ requestId: ctx.parents.wasteRequestId, fileId: file.id });
      }
      const orphan = await newFile({
        ageDays: 30,
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      });

      // Запрос идёт своим соединением и с теми же параметрами, что у воркера ($1 — статус, $2 —
      // возраст): подставить их литералами значило бы переписать запрос, а проверяется он как
      // есть. `FOR UPDATE SKIP LOCKED` без явной транзакции — один оператор, блокировка снимается
      // сразу за ним.
      const client = new pg.Client({ connectionString: DB_URL! });
      await client.connect();
      let candidates: { id: string }[];
      try {
        const res = await client.query<{ id: string }>(workerCandidateQuery(), [
          'active',
          '7 days',
        ]);
        candidates = res.rows;
      } finally {
        await client.end();
      }

      expect(candidates.map((r) => r.id)).toContain(orphan.id);

      // И тот же отбор без фильтра — то есть с проверкой связанности после выборки: сирота в него
      // не попадает вовсе. Ловушка настоящая, а не воображаемая, и стоит ровно на этих данных.
      const naive = await ctx.db.execute<{ id: string }>(sql`
        SELECT id FROM files
         WHERE status = 'active' AND created_at < now() - '7 days'::interval
         ORDER BY id
         LIMIT ${sql.raw(String(batch))}`);
      expect(naive.rows.map((r) => r.id)).not.toContain(orphan.id);
    });
  });
});
