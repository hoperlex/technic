import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, type AutoPartReceiptDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as TokensNs from '../src/auth/tokens';
import type * as JobsNs from '../src/lib/jobs';

/**
 * Чеки на автозапчасти — полный контур на живой схеме (план `docs/auto-part-receipts-plan.md`,
 * §10; решения Р6, Р8—Р14, Р19—Р21; миграция `0243`).
 *
 * **Зачем этому набору база, а не подмены.** Раздел отвечает на один вопрос — «сколько вложено в
 * эту машину», — и весь ответ считает СЕРВЕР запросом: итог чека, «не отнесено», цена за единицу,
 * суммы по машинам с отсечкой по дню среза. Подменить это нечем: тест на подменах согласовал бы
 * расчёт сам с собой, а не с тем, что портал покажет человеку, — и позеленел бы ровно тогда, когда
 * портал начал бы врать. Ровно так же неподменяемы ещё три предмета:
 *
 * 1. `file_is_linked(uuid)` — перечень таблиц привязки живёт в базе, и вопрос стоит не «есть ли в
 *    коде ветка», а «знает ли НАСТОЯЩАЯ функция про НАСТОЯЩУЮ таблицу» (Р20). Миграция `0243`
 *    переписывает тело функции ЦЕЛИКОМ, и потерянная прежняя ветка сняла бы защиту с чужого модуля
 *    молча — сегодня в первую очередь с механизации (`mech_request_files`, миграция 0238).
 * 2. Права: `garage.read` читает, `autoParts.manage` ведёт, `autoParts.delete` удаляет (Р5, Р4а).
 *    Разница между «может пометить» и «может удалить» видна только на настоящих стражах ручек.
 * 3. Аудит: пять мутаций пишут строку в той же транзакции (Р19), и метаданные удаления — всё, что
 *    остаётся от денежного документа. Проверять это на подмене значило бы проверять подмену.
 *
 * Все данные заводятся ручками, а не вставками: `total` считает сервер, `seq` проставляет сервер,
 * версия поднимается сервером — вставки согласовали бы тест с собственным представлением о записи.
 * Вставками заводятся только чужие предметы (родители девяти прежних ветвей `file_is_linked`) и
 * справочная обстановка — машины, люди, файлы.
 *
 * Запуск — по ОДНОМУ файлу на своей базе: полный прогон по общей базе врёт (замерено в
 * `docs/assignment-periods-plan.md` §16.2).
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_receipts_test \
 *     npx vitest run test/auto-part-receipts.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `db-auto-part-receipts-${RUN}`;
/** По этому префиксу идёт уборка файлов и задач на их снос: упавший прогон оставляет и то, и другое. */
const KEY_PREFIX = `db-auto-part-receipts/${RUN}/`;
/** Метка своих машин и людей: справочники общие с остальной базой. */
const MARK = `ТЕСТОВЫЕ ДАННЫЕ: чеки автозапчастей ${RUN}`;
/** Номера бланков — из заведомо свободного диапазона: серия общая с остальной базой. */
const WAYBILL_NUMBER_BASE = 940_000_000 + Math.floor(Math.random() * 900) * 1_000;

const TODAY = moscowDateKeyOf(new Date());
const DAY_MS = 24 * 60 * 60 * 1000;

/** День от сегодняшнего назад: сценарии живут на своих машинах, и дни у них пересекаются свободно. */
function ago(days: number): string {
  return shiftDateKey(TODAY, -days);
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  tokens: typeof TokensNs;
  jobs: typeof JobsNs;
  closeDb: () => Promise<void>;
  users: {
    /** Единственный держатель `autoParts.delete` (Р4а): право неназначаемо и достаётся роли `admin`. */
    admin: string;
    /** `garage.read` + `autoParts.manage`: заводит, правит, помечает — но не удаляет. */
    mech: string;
    /** `garage.read` без единого права ведения (роль `manager`): читает и не пишет (Р5). */
    reader: string;
    /** Ни гаража, ни запчастей (роль `site`): чек ему не виден вовсе. */
    outsider: string;
    /** Подшивает скан механиком, а потом теряет гараж — ветка `uploadedBy` его не спасёт (Р20). */
    exMech: string;
  };
  objectId: string;
  vehicleTypeId: string;
  organizationId: string;
  seriesId: string;
  credentialTypeId: string;
  lessorId: string;
}

let ctx: Ctx;
let seq = 0;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // Ссылка на скачивание подписывается локально, в хранилище никто не ходит: заглушки нерабочие
  // намеренно — предмет теста решение о доступе, а не S3.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.MAIL_ENABLED = 'false';
  process.env.RATE_LIMIT_MAX ??= '100000';
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
 * Уборка своих строк — и перед прогоном тоже. Порядок обратный ссылкам: сначала то, что ссылается
 * на файлы и машины, потом сами файлы, машины и люди, и в самом конце учётки — на них ссылается
 * всё созданное.
 *
 * Наблюдение аудита талонов снимается ОТДЕЛЬНОЙ строкой: у него `file_id` не `CASCADE`, а `SET
 * NULL` (скан наблюдения переживает и талон, и заявку), и без этой строки в базе оставался бы
 * мусор с обнулённой ссылкой.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const emailLike = `${EMAIL_PREFIX}%`;
  const keyLike = `${KEY_PREFIX}%`;
  const users = sql`(SELECT id FROM users WHERE email LIKE ${emailLike})`;
  const own = sql`(SELECT id FROM vehicles WHERE note = ${MARK})`;
  const people = sql`(SELECT id FROM persons WHERE comment = ${MARK})`;
  const mine = sql`(SELECT id FROM files WHERE object_key LIKE ${keyLike})`;
  await db.execute(sql`DELETE FROM jobs WHERE payload->>'objectKey' LIKE ${keyLike}`);
  await db.execute(sql`DELETE FROM waste_ticket_field_events WHERE file_id IN ${mine}`);
  await db.execute(sql`DELETE FROM auto_part_receipts WHERE created_by IN ${users}`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN ${users}`);
  await db.execute(sql`DELETE FROM mech_requests WHERE created_by IN ${users}`);
  await db.execute(sql`DELETE FROM service_requests WHERE created_by IN ${users}`);
  await db.execute(sql`DELETE FROM waste_requests WHERE created_by IN ${users}`);
  await db.execute(sql`DELETE FROM vehicle_maintenance WHERE created_by IN ${users}`);
  await db.execute(sql`DELETE FROM person_credentials WHERE person_id IN ${people}`);
  await db.execute(sql`DELETE FROM vehicle_readings WHERE created_by IN ${users}`);
  await db.execute(sql`DELETE FROM driver_daily_reports WHERE created_by IN ${users}`);
  await db.execute(sql`DELETE FROM waybills WHERE issued_by IN ${users}`);
  await db.execute(sql`DELETE FROM vehicle_routes WHERE created_by IN ${users}`);
  await db.execute(sql`DELETE FROM vehicle_requests WHERE created_by IN ${users}`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE ${keyLike}`);
  await db.execute(sql`DELETE FROM vehicles WHERE id IN ${own}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${MARK}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${emailLike}`);
}

// ── Подопытные ──

async function newUser(tag: string, role: 'admin' | 'manager' | 'site' | 'mechanic') {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${EMAIL_PREFIX}-${seq}-${tag}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Сотрудник',
      middleName: tag,
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  return row!.id;
}

/**
 * Своя машина. Госномер и есть её подпись (`vehicleLabel`), и он же различает машины в ответах —
 * поэтому уникален на прогон. У собственной техники описание пусто и цен нет: этого требует
 * `vehicles_own_fields_check`.
 */
async function newOwnVehicle(
  tag: string,
  status: 'active' | 'retired' = 'active',
): Promise<{ id: string; label: string }> {
  seq += 1;
  const label = `ТЕСТ${RUN}${seq}${tag}`;
  const [row] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({
      ownership: 'own',
      vehicleTypeId: ctx.vehicleTypeId,
      status,
      registrationNumber: label,
      note: MARK,
    })
    .returning({ id: ctx.schema.vehicles.id });
  return { id: row!.id, label };
}

/** Арендная машина: она есть в справочнике, и `RESTRICT` внешнего ключа пропустил бы её строкой чека. */
async function newRentalVehicle(): Promise<{ id: string; label: string }> {
  seq += 1;
  const label = `Аренда ${RUN}-${seq}`;
  const [row] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({
      ownership: 'rental',
      vehicleTypeId: ctx.vehicleTypeId,
      status: 'active',
      lessorId: ctx.lessorId,
      lessorType: 'vehicle_lessor',
      // Пара с `lessorId` (`vehicles_lessor_active_pair_check`): «арендодатель есть, а жив ли он —
      // неизвестно» законным состоянием строки не бывает.
      lessorIsActive: true,
      pricePerShift: '10000.00',
      description: label,
      note: MARK,
    })
    .returning({ id: ctx.schema.vehicles.id });
  return { id: row!.id, label };
}

async function newPerson(): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.persons)
    .values({
      lastName: 'Механиков',
      firstName: `Тест${seq}`,
      middleName: 'Тестович',
      comment: MARK,
    })
    .returning({ id: ctx.schema.persons.id });
  return row!.id;
}

/**
 * Загруженный скан. Вставкой, а не загрузкой: предмет теста — что происходит со строкой `files`
 * дальше. `active` потому, что чек подшивает только завершённую загрузку (`requireActive`), а
 * `pending` — файл, объекта которого в хранилище может не быть вовсе.
 */
async function newFile(uploaderId = ctx.users.mech): Promise<{ id: string; objectKey: string }> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey: `${KEY_PREFIX}${randomUUID()}`,
      filename: `чек-${seq}.pdf`,
      contentType: 'application/pdf',
      size: 4096,
      status: 'active',
      uploadedBy: uploaderId,
    })
    .returning({ id: ctx.schema.files.id, objectKey: ctx.schema.files.objectKey });
  return row!;
}

// ── HTTP ──

type Headers = { authorization: string };

async function headersOf(userId: string): Promise<Headers> {
  const [row] = await ctx.db
    .select({ role: ctx.schema.users.role, authVersion: ctx.schema.users.authVersion })
    .from(ctx.schema.users)
    .where(eq(ctx.schema.users.id, userId));
  const token = await ctx.tokens.signAccessToken({
    sub: userId,
    role: row!.role,
    av: row!.authVersion,
  });
  return { authorization: `Bearer ${token}` };
}

interface LineBody {
  vehicleId?: string | null;
  name?: string;
  quantity?: number;
  unit?: string;
  amount?: number;
  note?: string;
}

/** Строка чека: минимум, поверх которого сценарий меняет одно поле. */
function line(over: LineBody = {}): Record<string, unknown> {
  return { name: 'Фильтр масляный', quantity: 1, amount: 1000, ...over };
}

function receiptBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    purchasedOn: TODAY,
    sellerName: `Магазин ${RUN}`,
    documentNumber: `ЧЕК-${RUN}`,
    lines: [line()],
    ...over,
  };
}

function post(headers: Headers, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auto-part-receipts',
    headers,
    payload,
  });
}

/** Заведение с проверкой успеха: почти каждому сценарию чек нужен как обстановка, а не как предмет. */
async function createReceipt(
  headers: Headers,
  payload: Record<string, unknown>,
): Promise<AutoPartReceiptDto> {
  const res = await post(headers, payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as AutoPartReceiptDto;
}

function patch(headers: Headers, id: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/auto-part-receipts/${id}`,
    headers,
    payload,
  });
}

function mark(headers: Headers, id: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/auto-part-receipts/${id}/deletion-mark`,
    headers,
    payload,
  });
}

function unmark(headers: Headers, id: string, version: number) {
  return ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/auto-part-receipts/${id}/deletion-mark?version=${version}`,
    headers,
  });
}

function remove(headers: Headers, id: string, version: number) {
  return ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/auto-part-receipts/${id}?version=${version}`,
    headers,
  });
}

function card(headers: Headers, id: string) {
  return ctx.app.inject({ method: 'GET', url: `/api/v1/auto-part-receipts/${id}`, headers });
}

function feed(headers: Headers, query = '') {
  return ctx.app.inject({ method: 'GET', url: `/api/v1/auto-part-receipts${query}`, headers });
}

function summary(headers: Headers, query = '') {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/auto-part-receipts/summary${query}`,
    headers,
  });
}

function snapshot(headers: Headers, ids: string[], to?: string) {
  const at = to === undefined ? '' : `&to=${to}`;
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/auto-part-receipts/vehicles/snapshot?ids=${ids.join(',')}${at}`,
    headers,
  });
}

function spend(headers: Headers, vehicleId: string, query = '') {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/auto-part-receipts/vehicles/${vehicleId}${query}`,
    headers,
  });
}

function download(headers: Headers, fileId: string) {
  return ctx.app.inject({ method: 'GET', url: `/api/v1/files/${fileId}/download`, headers });
}

// ── Вопросы к базе ──

/** Ответ НАСТОЯЩЕЙ функции БД, а не пересказ её перечня таблиц в тесте. */
async function isLinked(fileId: string): Promise<boolean> {
  const res = await ctx.db.execute<{ linked: boolean }>(
    sql`SELECT file_is_linked(${fileId}) AS linked`,
  );
  return res.rows[0]!.linked;
}

/** Таблицы, названные в теле функции: определение читается у самой базы, а не из файла миграции. */
async function tablesKnownToFunction(): Promise<string[]> {
  const res = await ctx.db.execute<{ def: string }>(
    sql`SELECT pg_get_functiondef('file_is_linked(uuid)'::regprocedure) AS def`,
  );
  return [...res.rows[0]!.def.matchAll(/FROM\s+([a-z_]+)/gu)].map((m) => m[1]!).sort();
}

async function linesOf(receiptId: string) {
  return ctx.db
    .select({
      seq: ctx.schema.autoPartReceiptLines.seq,
      name: ctx.schema.autoPartReceiptLines.name,
      amount: ctx.schema.autoPartReceiptLines.amount,
    })
    .from(ctx.schema.autoPartReceiptLines)
    .where(eq(ctx.schema.autoPartReceiptLines.receiptId, receiptId))
    .orderBy(ctx.schema.autoPartReceiptLines.seq);
}

async function scanLinksOf(receiptId: string): Promise<number> {
  const rows = await ctx.db
    .select({ fileId: ctx.schema.autoPartReceiptFiles.fileId })
    .from(ctx.schema.autoPartReceiptFiles)
    .where(eq(ctx.schema.autoPartReceiptFiles.receiptId, receiptId));
  return rows.length;
}

async function fileRow(fileId: string) {
  const [row] = await ctx.db
    .select({ status: ctx.schema.files.status, deletedAt: ctx.schema.files.deletedAt })
    .from(ctx.schema.files)
    .where(eq(ctx.schema.files.id, fileId));
  return row;
}

/** Задача на снос объекта из S3: по ней различаются отложенный и немедленный пути. */
async function deletionJob(objectKey: string) {
  const rows = await ctx.db
    .select({ type: ctx.schema.jobs.type, nextRunAt: ctx.schema.jobs.nextRunAt })
    .from(ctx.schema.jobs)
    .where(sql`${ctx.schema.jobs.payload}->>'objectKey' = ${objectKey}`);
  expect(rows, `задача на снос ${objectKey}`).toHaveLength(1);
  return rows[0]!;
}

async function auditOf(receiptId: string) {
  return ctx.db
    .select({
      action: ctx.schema.auditLog.action,
      actorUserId: ctx.schema.auditLog.actorUserId,
      metadata: ctx.schema.auditLog.metadata,
    })
    .from(ctx.schema.auditLog)
    .where(
      and(
        eq(ctx.schema.auditLog.entityType, 'autoPartReceipt'),
        eq(ctx.schema.auditLog.entityId, receiptId),
      ),
    )
    .orderBy(ctx.schema.auditLog.createdAt);
}

// ── Родители девяти прежних ветвей `file_is_linked` ──
//
// Заводятся вставками намеренно: предмет здесь не их модули, а один вопрос — знает ли функция БД
// про их таблицу связи. Ходить ради этого их ручками значило бы тащить в набор чеков цикл заявок,
// выписку бланков и приёмку показаний.

interface Parents {
  wasteRequestId: string;
  vehicleRequestId: string;
  waybillId: string;
  serviceRequestId: string;
  readingId: string;
  credentialId: string;
  maintenanceId: string;
  mechRequestId: string;
}

let parents: Parents;

async function seedLinkParents(): Promise<Parents> {
  const { db, schema } = ctx;
  const vehicle = await newOwnVehicle('link');
  const person = await newPerson();

  const [wasteRequest] = await db
    .insert(schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType: 'waste_removal',
      deliveryAt: new Date(),
      createdBy: ctx.users.admin,
      comment: MARK,
    })
    .returning({ id: schema.wasteRequests.id });

  const [vehicleRequest] = await db
    .insert(schema.vehicleRequests)
    .values({
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicleTypeId,
      createdBy: ctx.users.admin,
      comment: MARK,
    })
    .returning({ id: schema.vehicleRequests.id });

  // Рейс-перегон: `purpose = 'freight'` — единственный, которому не нужна заявка-основание.
  const [route] = await db
    .insert(schema.vehicleRoutes)
    .values({
      vehicleId: vehicle.id,
      routeDate: TODAY,
      purpose: 'freight',
      createdBy: ctx.users.admin,
    })
    .returning({ id: schema.vehicleRoutes.id });

  const [waybill] = await db
    .insert(schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: WAYBILL_NUMBER_BASE + 1,
      formCode: '4p',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId: vehicle.id,
      driverPersonId: person,
      issuedForDate: TODAY,
      routeId: route!.id,
      issuedBy: ctx.users.admin,
    })
    .returning({ id: schema.waybills.id });

  const [serviceRequest] = await db
    .insert(schema.serviceRequests)
    .values({
      // Место аппарата обязательно (`service_requests_subject_check`): заявка без него не
      // отвечает, куда ехать.
      equipmentObjectId: ctx.objectId,
      equipmentName: `МФУ ${RUN}`,
      description: 'Не печатает',
      createdBy: ctx.users.admin,
      comment: MARK,
    })
    .returning({ id: schema.serviceRequests.id });

  const [report] = await db
    .insert(schema.driverDailyReports)
    .values({ personId: person, reportDate: TODAY, createdBy: ctx.users.admin })
    .returning({ id: schema.driverDailyReports.id });
  const [item] = await db
    .insert(schema.driverDailyReportItems)
    .values({
      reportId: report!.id,
      sourceKind: 'route',
      routeId: route!.id,
      vehicleId: vehicle.id,
      reportDate: TODAY,
      shiftOrder: 1,
    })
    .returning({ id: schema.driverDailyReportItems.id });
  const [reading] = await db
    .insert(schema.vehicleReadings)
    .values({
      itemId: item!.id,
      reportId: report!.id,
      vehicleId: vehicle.id,
      reportDate: TODAY,
      shiftOrder: 1,
      kind: 'values',
      source: 'staff',
      odometerKm: 100_000,
      createdBy: ctx.users.admin,
    })
    .returning({ id: schema.vehicleReadings.id });

  const [credential] = await db
    .insert(schema.personCredentials)
    .values({ personId: person, credentialTypeId: ctx.credentialTypeId })
    .returning({ id: schema.personCredentials.id });

  const [maintenance] = await db
    .insert(schema.vehicleMaintenance)
    .values({ vehicleId: vehicle.id, performedOn: TODAY, createdBy: ctx.users.admin })
    .returning({ id: schema.vehicleMaintenance.id });

  const [mechRequest] = await db
    .insert(schema.mechRequests)
    .values({
      objectId: ctx.objectId,
      // Модель не ставится: предмет аренды здесь не проверяется вовсе, а колонка ссылки
      // необязательна (уборка Э3 сняла написание, ADR 0156).
      plannedFrom: TODAY,
      plannedTo: shiftDateKey(TODAY, 3),
      responsibleName: 'Иванов Иван',
      responsiblePhone: '9261234567',
      createdBy: ctx.users.admin,
      comment: MARK,
    })
    .returning({ id: schema.mechRequests.id });

  return {
    wasteRequestId: wasteRequest!.id,
    vehicleRequestId: vehicleRequest!.id,
    waybillId: waybill!.id,
    serviceRequestId: serviceRequest!.id,
    readingId: reading!.id,
    credentialId: credential!.id,
    maintenanceId: maintenance!.id,
    mechRequestId: mechRequest!.id,
  };
}

/**
 * Десять ветвей `file_is_linked(uuid)` — каждая своим случаем (§10 п. 5).
 *
 * Перечень поимённый и полный намеренно: миграция `0243` заменяет тело функции ЦЕЛИКОМ (`CREATE OR
 * REPLACE`), и потерянная прежняя ветка не ломает ничего заметного — она снимает защиту с чужого
 * модуля молча. Заметили бы это не по ошибке, а по чужому файлу, открывшемуся постороннему, либо по
 * снесённому уборкой документу.
 */
const LINK_CASES: { table: string; link: (fileId: string) => Promise<void> }[] = [
  {
    table: 'request_files',
    link: async (fileId) => {
      await ctx.db
        .insert(ctx.schema.requestFiles)
        .values({ requestId: parents.wasteRequestId, fileId });
    },
  },
  {
    table: 'vehicle_request_files',
    link: async (fileId) => {
      await ctx.db
        .insert(ctx.schema.vehicleRequestFiles)
        .values({ vehicleRequestId: parents.vehicleRequestId, fileId });
    },
  },
  {
    table: 'waybill_files',
    link: async (fileId) => {
      await ctx.db.insert(ctx.schema.waybillFiles).values({ waybillId: parents.waybillId, fileId });
    },
  },
  {
    table: 'service_request_files',
    link: async (fileId) => {
      await ctx.db
        .insert(ctx.schema.serviceRequestFiles)
        .values({ requestId: parents.serviceRequestId, fileId });
    },
  },
  {
    table: 'vehicle_reading_files',
    link: async (fileId) => {
      await ctx.db
        .insert(ctx.schema.vehicleReadingFiles)
        .values({ readingId: parents.readingId, fileId });
    },
  },
  {
    table: 'person_credential_files',
    link: async (fileId) => {
      await ctx.db
        .insert(ctx.schema.personCredentialFiles)
        .values({ credentialId: parents.credentialId, fileId });
    },
  },
  {
    table: 'vehicle_maintenance_files',
    link: async (fileId) => {
      await ctx.db
        .insert(ctx.schema.vehicleMaintenanceFiles)
        .values({ maintenanceId: parents.maintenanceId, fileId });
    },
  },
  {
    table: 'waste_ticket_field_events',
    link: async (fileId) => {
      // Наблюдение качества распознавания: единственная ветвь, где файл держит не связь «документ —
      // скан», а строка журнала, пережившая и талон, и заявку.
      await ctx.db
        .insert(ctx.schema.wasteTicketFieldEvents)
        .values({ event: 'edited', field: 'number', newValue: '1234', fileId });
    },
  },
  {
    table: 'mech_request_files',
    link: async (fileId) => {
      // Самая свежая прежняя ветка (`0238`) и потому самая уязвимая: перечень переписывается
      // целиком, и именно её потеря стоила бы дороже всего — вложения механизации остались бы без
      // защиты, а увидели бы это по чужому счёту, открывшемуся постороннему.
      await ctx.db
        .insert(ctx.schema.mechRequestFiles)
        .values({ requestId: parents.mechRequestId, fileId });
    },
  },
  {
    table: 'auto_part_receipt_files',
    link: async (fileId) => {
      // Десятая ветвь — сам предмет выпуска. Чек заводится РУЧКОЙ: связь ставит модуль, а не тест.
      await createReceipt(await headersOf(ctx.users.mech), receiptBody({ fileIds: [fileId] }));
    },
  },
];

describe.skipIf(!DB_URL)('чеки на автозапчасти: ведение, суммы, доступ и след (план, §10)', () => {
  let admin: Headers;
  let mech: Headers;
  let reader: Headers;
  let outsider: Headers;

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const tokens = await import('../src/auth/tokens');
    const jobs = await import('../src/lib/jobs');
    const app = await buildApp();

    const pick = async (query: ReturnType<typeof sql>): Promise<string> => {
      const res = await db.execute<{ id: string }>(query);
      const id = res.rows[0]?.id;
      if (!id) throw new Error('В базе нет справочной обстановки для набора');
      return id;
    };

    ctx = {
      app,
      db,
      schema,
      tokens,
      jobs,
      closeDb,
      users: {} as Ctx['users'],
      objectId: await pick(sql`SELECT id FROM construction_objects ORDER BY code LIMIT 1`),
      vehicleTypeId: await pick(sql`SELECT id FROM vehicle_types ORDER BY code LIMIT 1`),
      organizationId: await pick(sql`SELECT id FROM organizations ORDER BY id LIMIT 1`),
      seriesId: await pick(sql`SELECT id FROM waybill_series ORDER BY code LIMIT 1`),
      credentialTypeId: await pick(sql`SELECT id FROM credential_types ORDER BY code LIMIT 1`),
      lessorId: await pick(
        sql`SELECT id FROM counterparties WHERE type = 'vehicle_lessor' ORDER BY name LIMIT 1`,
      ),
    };
    await cleanup(db);

    ctx.users = {
      admin: await newUser('admin', 'admin'),
      mech: await newUser('mech', 'mechanic'),
      reader: await newUser('reader', 'manager'),
      outsider: await newUser('outsider', 'site'),
      exMech: await newUser('exmech', 'mechanic'),
    };
    admin = await headersOf(ctx.users.admin);
    mech = await headersOf(ctx.users.mech);
    reader = await headersOf(ctx.users.reader);
    outsider = await headersOf(ctx.users.outsider);
    parents = await seedLinkParents();
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── 1—2. Заведение и «не отнесено» ──

  it('чек заводится со строками и сканами; оба итога считает сервер (Р8, Р9, Р11)', async () => {
    const kamaz = await newOwnVehicle('K');
    const gazel = await newOwnVehicle('G');
    const scans = [await newFile(), await newFile()];

    const dto = await createReceipt(
      mech,
      receiptBody({
        purchasedOn: ago(3),
        documentNumber: 'ЧЕК-0001',
        note: 'Куплено за наличные',
        fileIds: scans.map((f) => f.id),
        lines: [
          line({ vehicleId: kamaz.id, name: 'Фильтр масляный MANN', quantity: 2, amount: 1250.34 }),
          line({ vehicleId: gazel.id, name: 'Свеча', quantity: 3, amount: 1000 }),
          // Строка без машины законна (Р8): общий инструмент, расходники гаража, позиция, которую
          // механик не стал разбирать.
          line({ name: 'Ветошь', quantity: 1, unit: 'кг', amount: 240 }),
        ],
      }),
    );

    // Итог — `Σ amount` строк, и приходит он ОТВЕТОМ: клиентская цифра это предпросмотр (Р11).
    expect(dto.total).toBe(2490.34);
    // Второе число не выводится из первого: сумма по машинам законно меньше суммы чека (Р8).
    expect(dto.unassignedTotal).toBe(240);
    expect(dto.version).toBe(0);
    expect(dto.updatedByName).toBe('');
    expect(dto.deletion).toBeNull();
    expect(dto.files).toHaveLength(2);

    // `seq` проставляет сервер по порядку массива — одно утверждение о порядке вместо двух (§6).
    expect(dto.lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    // Цена за единицу производна и округлена сервером до копейки.
    expect(dto.lines[0]!.unitPrice).toBe(625.17);
    // И вот зачем хранится сумма, а не цена (Р9): 1000 / 3 округляется до 333,33, а «3 × 333,33 =
    // 999,99» разошлось бы с бумагой на копейку в каждом разговоре о цифрах.
    expect(dto.lines[1]!.unitPrice).toBe(333.33);
    expect(dto.lines[0]!.vehicleLabel).toBe(kamaz.label);
    expect(dto.lines[1]!.vehicleLabel).toBe(gazel.label);
    // У неотнесённой строки пусты ОБА поля: подпись портал показывает, а решает по `vehicleId`.
    expect(dto.lines[2]!.vehicleId).toBeNull();
    expect(dto.lines[2]!.vehicleLabel).toBe('');
    expect(dto.lines[2]!.unit).toBe('кг');

    // Карточка после сохранения отвечает тем же — второго места, где портал узнаёт сумму, нет.
    const again = await card(reader, dto.id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual(dto);

    // Лента и сводка считают тем же правилом: «Сумма» над списком и итог карточки не расходятся.
    const list = await feed(reader, `?search=${encodeURIComponent('ЧЕК-0001')}`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({
      total: 2490.34,
      linesCount: 3,
      filesCount: 2,
      vehiclesLabel: `${kamaz.label}, ${gazel.label}`,
      deletion: null,
    });
    const sums = await summary(reader, `?search=${encodeURIComponent('ЧЕК-0001')}`);
    expect(sums.json()).toEqual({
      receiptsCount: 1,
      total: 2490.34,
      unassignedTotal: 240,
      deletionMarkedCount: 0,
    });
  });

  it('чек целиком «не отнесён»: сумма по машинам законно ноль (Р8)', async () => {
    const file = await newFile();
    const dto = await createReceipt(
      mech,
      receiptBody({
        documentNumber: `ЧЕК-НЕОТН-${RUN}`,
        fileIds: [file.id],
        lines: [line({ name: 'Перчатки', quantity: 10, amount: 350 })],
      }),
    );
    // Оба итога совпали — и это не вырожденный случай, а обычная покупка расходников гаража.
    expect(dto.total).toBe(350);
    expect(dto.unassignedTotal).toBe(350);
    const list = await feed(reader, `?search=${encodeURIComponent(`ЧЕК-НЕОТН-${RUN}`)}`);
    // Колонка «Машины» пуста, а не прочерк и не «—»: собирать подпись из ничего незачем.
    expect(list.json().items[0].vehiclesLabel).toBe('');
  });

  // ── 3. Правка целиком ──

  it('правка переписывает набор строк целиком; чужая версия — 409 (Р12)', async () => {
    const kamaz = await newOwnVehicle('P1');
    const gazel = await newOwnVehicle('P2');
    const file = await newFile();
    const dto = await createReceipt(
      mech,
      receiptBody({
        documentNumber: `ЧЕК-ПРАВКА-${RUN}`,
        fileIds: [file.id],
        lines: [
          line({ vehicleId: kamaz.id, name: 'Первая', amount: 100 }),
          line({ vehicleId: kamaz.id, name: 'Вторая', amount: 200 }),
        ],
      }),
    );

    const edited = await patch(mech, dto.id, {
      ...receiptBody({
        documentNumber: `ЧЕК-ПРАВКА-${RUN}`,
        fileIds: [file.id],
        // Первая снята, вторая исправлена, третья добавлена — и всё это одним набором.
        lines: [
          line({ vehicleId: kamaz.id, name: 'Вторая', amount: 250 }),
          line({ vehicleId: gazel.id, name: 'Третья', amount: 500 }),
        ],
      }),
      version: dto.version,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const after = edited.json() as AutoPartReceiptDto;
    expect(after.version).toBe(1);
    expect(after.total).toBe(750);
    expect(after.updatedByName).not.toBe('');
    // Строки пересозданы, а не сдвинуты: `seq` считается по порядку массива заново.
    expect(after.lines.map((l) => [l.seq, l.name, l.amount])).toEqual([
      [1, 'Вторая', 250],
      [2, 'Третья', 500],
    ]);
    // В базе — ровно две строки: снятая ушла, а не осталась «нулевой».
    expect(await linesOf(dto.id)).toHaveLength(2);

    // Второй механик, открывший тот же чек до правки, не затирает её молча.
    const stale = await patch(mech, dto.id, {
      ...receiptBody({ documentNumber: 'ЧЕК-ЗАТЁРТЫЙ', fileIds: [file.id] }),
      version: dto.version,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().code).toBe('version_conflict');
    // И чек остался тем, чем был: отбитая правка не переписала ни строк, ни реквизитов.
    expect((await card(mech, dto.id)).json()).toMatchObject({
      documentNumber: `ЧЕК-ПРАВКА-${RUN}`,
      version: 1,
      total: 750,
    });
  });

  // ── 4. Удаление ──

  it('удаление уносит строки каскадом и отвязывает сканы ЯВНО (Р6, Р12)', async () => {
    const vehicle = await newOwnVehicle('D');
    const file = await newFile();
    const dto = await createReceipt(
      mech,
      receiptBody({
        documentNumber: `ЧЕК-УДАЛ-${RUN}`,
        fileIds: [file.id],
        lines: [line({ vehicleId: vehicle.id, amount: 700 })],
      }),
    );
    expect(await isLinked(file.id)).toBe(true);

    const removed = await remove(admin, dto.id, dto.version);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toEqual({ ok: true });

    expect((await card(admin, dto.id)).statusCode).toBe(404);
    // Строки — часть документа, а не его история: их уносит каскад.
    expect(await linesOf(dto.id)).toHaveLength(0);
    expect(await scanLinksOf(dto.id)).toBe(0);
    // А вот скан отвязывается ЯВНО: положись здесь на каскад — строка связи ушла бы молча, и объект
    // остался бы в хранилище сиротой, которую уборка заберёт без следа в журнале.
    expect(await isLinked(file.id)).toBe(false);
    const row = await fileRow(file.id);
    expect(row?.status).toBe('deleted');
    expect(row?.deletedAt).not.toBeNull();
    const job = await deletionJob(file.objectKey);
    expect(job.type).toBe(ctx.jobs.JOB_DELETE_S3_OBJECT);
    // Снос ОТЛОЖЕН на 30 дней, как у вложений во всех модулях: удалённый по ошибке чек обязан
    // пережить эту ошибку хотя бы бумагой.
    expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);
    // Машина при этом цела: `RESTRICT` держит ссылку на технику, а не наоборот.
    const [alive] = await ctx.db
      .select({ id: ctx.schema.vehicles.id })
      .from(ctx.schema.vehicles)
      .where(eq(ctx.schema.vehicles.id, vehicle.id));
    expect(alive).toBeDefined();
  });

  // ── 5. Десятая ветвь `file_is_linked` ──

  describe('перечень связей файла: десятая ветвь и девять прежних (Р20)', () => {
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

    it('в теле функции названы ровно десять таблиц, и они названы поимённо', async () => {
      // Утверждение о ПОЛНОТЕ перечня, а не о наличии новой строки. `CREATE OR REPLACE` заменяет
      // тело целиком, и забытая прежняя ветка — тихая потеря защиты: сравнение множеством ловит и
      // пропавшую ветку, и лишнюю (второй ответ на тот же вопрос запирает файл навсегда в первом же
      // расклеившемся случае).
      expect(await tablesKnownToFunction()).toEqual([
        'auto_part_receipt_files',
        'mech_request_files',
        'person_credential_files',
        'request_files',
        'service_request_files',
        'vehicle_maintenance_files',
        'vehicle_reading_files',
        'vehicle_request_files',
        'waste_ticket_field_events',
        'waybill_files',
      ]);
    });
  });

  // ── 6—7. Суммы по машинам ──

  describe('сколько вложено в эту машину (Р14, Р15)', () => {
    let first: { id: string; label: string };
    let second: { id: string; label: string };
    let untouched: { id: string; label: string };
    let older: AutoPartReceiptDto;
    let newer: AutoPartReceiptDto;

    beforeAll(async () => {
      first = await newOwnVehicle('S1');
      second = await newOwnVehicle('S2');
      untouched = await newOwnVehicle('S3');
      older = await createReceipt(
        mech,
        receiptBody({
          purchasedOn: ago(10),
          documentNumber: `ЧЕК-СУММА-A-${RUN}`,
          fileIds: [(await newFile()).id],
          lines: [
            // Две строки одного чека на одну машину — обычное дело (Р7), и покупка это ОДНА.
            line({ vehicleId: first.id, name: 'Колодки', amount: 1000 }),
            line({ vehicleId: first.id, name: 'Диски', amount: 500 }),
            line({ vehicleId: second.id, name: 'Лампа', amount: 200 }),
            line({ name: 'Ветошь', amount: 90 }),
          ],
        }),
      );
      newer = await createReceipt(
        mech,
        receiptBody({
          purchasedOn: ago(2),
          documentNumber: `ЧЕК-СУММА-Б-${RUN}`,
          fileIds: [(await newFile()).id],
          lines: [line({ vehicleId: first.id, name: 'Масло', amount: 300 })],
        }),
      );
    });

    it('снапшот считает пакетом, отсекает по дню среза и держит порядок запроса', async () => {
      const cut = await snapshot(reader, [first.id, second.id, untouched.id], ago(5));
      expect(cut.statusCode, cut.body).toBe(200);
      expect(cut.json().to).toBe(ago(5));
      expect(cut.json().items).toEqual([
        // Августовская покупка не должна показываться в мартовском срезе: в сумму идут чеки НЕ
        // ПОЗЖЕ дня среза, и `newer` за него выпал целиком.
        {
          vehicleId: first.id,
          total: 1500,
          // Чеков, а не строк: две позиции одного чека — это одна покупка.
          receiptsCount: 1,
          lastPurchasedOn: ago(10),
        },
        { vehicleId: second.id, total: 200, receiptsCount: 1, lastPurchasedOn: ago(10) },
        // Машина без чеков из ответа ВЫПАДАЕТ: колонка рисует прочерк, а не «0 ₽» — ноль был бы
        // утверждением «на машину не тратили».
      ]);

      const today = await snapshot(reader, [second.id, first.id]);
      expect(today.json().to).toBe(TODAY);
      // Порядок ответа — порядок запрошенных машин: колонка ставится против строк страницы.
      expect(today.json().items.map((i: { vehicleId: string }) => i.vehicleId)).toEqual([
        second.id,
        first.id,
      ]);
      expect(today.json().items[1]).toEqual({
        vehicleId: first.id,
        total: 1800,
        receiptsCount: 2,
        lastPurchasedOn: ago(2),
      });

      // Пустая страница гаража спрашивать базу не должна, и отказом это не является.
      const empty = await snapshot(reader, []);
      expect(empty.statusCode, empty.body).toBe(200);
      expect(empty.json().items).toEqual([]);
    });

    it('окно машины: период сужает перечень, «за всё время» остаётся вторым числом', async () => {
      const all = await spend(reader, first.id);
      expect(all.statusCode, all.body).toBe(200);
      const dto = all.json();
      expect(dto.vehicleLabel).toBe(first.label);
      expect(dto.total).toBe(1800);
      expect(dto.totalAllTime).toBe(1800);
      // Свежая покупка сверху, а внутри чека — порядок бумаги.
      expect(dto.rows.map((r: { name: string }) => r.name)).toEqual(['Масло', 'Колодки', 'Диски']);
      expect(dto.rows[0]).toMatchObject({
        receiptId: newer.id,
        purchasedOn: ago(2),
        documentNumber: `ЧЕК-СУММА-Б-${RUN}`,
        amount: 300,
      });

      const period = await spend(reader, first.id, `?from=${ago(12)}&to=${ago(5)}`);
      const narrowed = period.json();
      // Два числа сняты одним проходом и стоят рядом на экране («За период: N ₽ · Всего: M ₽»):
      // вторым запросом они были бы парой снимков из разных моментов.
      expect(narrowed.total).toBe(1500);
      expect(narrowed.totalAllTime).toBe(1800);
      expect(narrowed.rows).toHaveLength(2);
      expect(narrowed.rows.every((r: { receiptId: string }) => r.receiptId === older.id)).toBe(
        true,
      );

      // Машина без единой покупки и машина, которой нет, — разные ответы, и окно их различает.
      const none = await spend(reader, untouched.id);
      expect(none.statusCode).toBe(200);
      expect(none.json()).toMatchObject({ total: 0, totalAllTime: 0, rows: [] });
      expect((await spend(reader, randomUUID())).statusCode).toBe(404);
    });
  });

  // ── 8—9. Границы полей и лишние поля ──

  it('границы полей отбиваются схемой, полем и до записи (Р10, Р13, ADR 0094)', async () => {
    const file = await newFile();
    const body = (over: Record<string, unknown>) =>
      receiptBody({ documentNumber: `ЧЕК-ГРАН-${RUN}`, fileIds: [file.id], ...over });

    const cases: { name: string; payload: Record<string, unknown>; field: string }[] = [
      {
        name: 'дата чека в будущем',
        payload: body({ purchasedOn: shiftDateKey(TODAY, 1) }),
        field: 'purchasedOn',
      },
      {
        name: 'количество ноль',
        payload: body({ lines: [line({ quantity: 0 })] }),
        field: 'lines',
      },
      {
        name: 'количество дробное',
        payload: body({ lines: [line({ quantity: 4.75 })] }),
        field: 'lines',
      },
      {
        // Тот самый случай, ради которого потолок и заведён: `z.int()` пропускает это число, а
        // `integer` в PostgreSQL — нет, и без границы отказ пришёл бы пятисоткой из глубины
        // транзакции вместо имени поля.
        name: 'количество 3 000 000 000',
        payload: body({ lines: [line({ quantity: 3_000_000_000 })] }),
        field: 'lines',
      },
      {
        name: 'сумма отрицательная',
        payload: body({ lines: [line({ amount: -1 })] }),
        field: 'lines',
      },
      {
        name: 'сумма сверх максимума',
        payload: body({ lines: [line({ amount: 10_000_000 })] }),
        field: 'lines',
      },
      {
        // Без `multipleOf` число уехало бы в `numeric(14,2)` и молча округлилось базой — портал
        // показал бы не то, что набрали.
        name: 'сумма с тремя знаками',
        payload: body({ lines: [line({ amount: 1250.355 })] }),
        field: 'lines',
      },
      {
        name: 'пустой номер чека',
        payload: body({ documentNumber: '   ' }),
        field: 'documentNumber',
      },
      {
        name: 'пустое наименование',
        payload: body({ lines: [line({ name: '  ' })] }),
        field: 'lines',
      },
    ];

    for (const testCase of cases) {
      const res = await post(mech, testCase.payload);
      expect(res.statusCode, `${testCase.name}: ${res.body}`).toBe(400);
      expect(res.json().code).toBe('validation_error');
      // Отказ называет ПОЛЕ, а не «некорректный запрос»: форма подсвечивает ячейку.
      expect(Object.keys(res.json().fields).join(' '), testCase.name).toContain(testCase.field);
    }

    // Ни один отказ не подшил скан: проверка стоит до обработчика, и файл остался свободным.
    expect(await isLinked(file.id)).toBe(false);
  });

  it('лишнее поле получает 400 с именем, а не молчаливое отбрасывание (Р11, §6)', async () => {
    const file = await newFile();
    // Свой итог прислать НЕЛЬЗЯ, и это «нельзя» держится `.strict()`: в обычном `z.object` поле
    // отбросилось бы молча, и портал ответил бы «сохранено» на тело, половину которого не прочитал.
    const withTotal = await post(
      mech,
      receiptBody({ documentNumber: `ЧЕК-СТРОГ-${RUN}`, fileIds: [file.id], total: 9999 }),
    );
    expect(withTotal.statusCode, withTotal.body).toBe(400);
    expect(JSON.stringify(withTotal.json().fields)).toContain('total');

    // Порядок строк задаёт массив: присланный `seq` пришлось бы сверять с ним и решать, кто прав.
    const withSeq = await post(
      mech,
      receiptBody({
        documentNumber: `ЧЕК-СТРОГ-${RUN}`,
        fileIds: [file.id],
        lines: [line({}), { ...line({}), seq: 1 }],
      }),
    );
    expect(withSeq.statusCode, withSeq.body).toBe(400);
    expect(JSON.stringify(withSeq.json().fields)).toContain('seq');

    // А в ОТВЕТЕ `seq` есть и равен `index + 1` — им карточка печатает нумерацию.
    const ok = await createReceipt(
      mech,
      receiptBody({
        documentNumber: `ЧЕК-СТРОГ-${RUN}`,
        fileIds: [file.id],
        lines: [line({ name: 'Раз' }), line({ name: 'Два' }), line({ name: 'Три' })],
      }),
    );
    expect(ok.lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  // ── 10. Без скана чека не существует ──

  it('чек без скана не заводится, а правкой последний скан не снять (Р6)', async () => {
    const first = await newFile();
    const second = await newFile();

    const noFiles = await post(
      mech,
      receiptBody({ documentNumber: `ЧЕК-БЕЗ-${RUN}`, fileIds: [] }),
    );
    expect(noFiles.statusCode, noFiles.body).toBe(400);
    expect(JSON.stringify(noFiles.json().fields)).toContain('fileIds');

    const dto = await createReceipt(
      mech,
      receiptBody({ documentNumber: `ЧЕК-БЕЗ-${RUN}`, fileIds: [first.id, second.id] }),
    );

    // Снятие НЕПОСЛЕДНЕГО скана свободно (длинный чек фотографируют в два кадра, и один кадр
    // бывает лишним) — иначе правило Р6 читалось бы как «файлы не трогать вовсе».
    const dropped = await patch(mech, dto.id, {
      ...receiptBody({ documentNumber: `ЧЕК-БЕЗ-${RUN}`, fileIds: [second.id] }),
      version: dto.version,
    });
    expect(dropped.statusCode, dropped.body).toBe(200);
    expect(dropped.json().files).toHaveLength(1);
    expect(await isLinked(first.id)).toBe(false);
    // Снятый по ошибке скан обязан пережить эту ошибку: снос отложенный, как во всех модулях.
    const job = await deletionJob(first.objectKey);
    expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);

    // А последний — не снять: без этого правила первое держалось бы ровно до первой правки.
    const emptied = await patch(mech, dto.id, {
      ...receiptBody({ documentNumber: `ЧЕК-БЕЗ-${RUN}`, fileIds: [] }),
      version: dropped.json().version,
    });
    expect(emptied.statusCode, emptied.body).toBe(400);
    expect(JSON.stringify(emptied.json().fields)).toContain('fileIds');
    // Отбитая правка ничего не изменила: скан на месте, версия та же.
    expect((await card(mech, dto.id)).json()).toMatchObject({
      version: dropped.json().version,
      files: [expect.objectContaining({ id: second.id })],
    });
  });

  // ── 11. Пометка на удаление ──

  it('пометка называет просьбу и не двигает ни одной цифры (Р12)', async () => {
    const vehicle = await newOwnVehicle('M');
    const dto = await createReceipt(
      mech,
      receiptBody({
        documentNumber: `ЧЕК-ПОМЕТКА-${RUN}`,
        fileIds: [(await newFile()).id],
        lines: [line({ vehicleId: vehicle.id, amount: 1500 })],
      }),
    );
    const before = (await snapshot(reader, [vehicle.id])).json().items[0];

    const noReason = await mark(mech, dto.id, { reason: '   ', version: dto.version });
    expect(noReason.statusCode, noReason.body).toBe(400);

    const stale = await mark(mech, dto.id, { reason: 'дубль', version: dto.version + 5 });
    expect(stale.statusCode, stale.body).toBe(409);

    const marked = await mark(mech, dto.id, { reason: 'Дубль чека 0001', version: dto.version });
    expect(marked.statusCode, marked.body).toBe(200);
    const withMark = marked.json() as AutoPartReceiptDto;
    expect(withMark.deletion).toMatchObject({ reason: 'Дубль чека 0001' });
    expect(withMark.deletion?.requestedByName).not.toBe('');
    // Версия поднимается: иначе отличить «эту просьбу я прочитал» от «пришла новая» было бы нечем.
    expect(withMark.version).toBe(dto.version + 1);

    // Помеченный чек из ленты НЕ исчезает: пометка — просьба к администратору, а не изъятие
    // документа из учёта.
    const list = await feed(reader, `?search=${encodeURIComponent(`ЧЕК-ПОМЕТКА-${RUN}`)}`);
    expect(list.json().items[0].deletion).toMatchObject({ reason: 'Дубль чека 0001' });
    const queue = await summary(reader, `?deletionMarked=true`);
    expect(queue.json().deletionMarkedCount).toBeGreaterThanOrEqual(1);
    // И ни одной цифры пометка не поменяла — иначе гасить кэш сумм по машинам пришлось бы тоже
    // (Р18), то есть обещать, что меняет.
    expect((await snapshot(reader, [vehicle.id])).json().items[0]).toEqual(before);

    // Повторная пометка отбивается, а не переписывает чужую причину: администратор прочитал бы не
    // ту просьбу, на которую отвечает.
    const again = await mark(mech, dto.id, { reason: 'другая', version: withMark.version });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().code).toBe('receipt_already_marked');

    // Правка пометку НЕ снимает (§2.3): очередь администратора не опустошается заодно с
    // исправлением опечатки.
    const edited = await patch(mech, dto.id, {
      ...receiptBody({
        documentNumber: `ЧЕК-ПОМЕТКА-${RUN}`,
        fileIds: withMark.files.map((f) => f.id),
        lines: [line({ vehicleId: vehicle.id, amount: 1600 })],
      }),
      version: withMark.version,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().deletion).toMatchObject({ reason: 'Дубль чека 0001' });

    const cleared = await unmark(mech, dto.id, edited.json().version);
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().deletion).toBeNull();
    // Снимать нечего — 409: поднятая версия означала бы правку документа, которой не было.
    const twice = await unmark(mech, dto.id, cleared.json().version);
    expect(twice.statusCode, twice.body).toBe(409);
    expect(twice.json().code).toBe('receipt_not_marked');
  });

  // ── 12—13. Права ──

  it('удаляет только `autoParts.delete`; ведущий чеки — помечает (Р4а, Р12)', async () => {
    const dto = await createReceipt(
      mech,
      receiptBody({ documentNumber: `ЧЕК-ПРАВА-${RUN}`, fileIds: [(await newFile()).id] }),
    );

    // Механик ведёт чеки и просит их удалить — но не уничтожает: перед необратимым действием обязан
    // остаться второй шаг.
    const denied = await remove(mech, dto.id, dto.version);
    expect(denied.statusCode, denied.body).toBe(403);
    const asked = await mark(mech, dto.id, { reason: 'Ошибка ввода', version: dto.version });
    expect(asked.statusCode, asked.body).toBe(200);
    // Отказ удалить не убил и карточку: две ручки — два разных ответа одному и тому же человеку.
    expect((await card(mech, dto.id)).statusCode).toBe(200);

    const removed = await remove(admin, dto.id, asked.json().version);
    expect(removed.statusCode, removed.body).toBe(200);

    // Непомеченный чек администратор удаляет так же — пометка не предусловие, а просьба.
    const plain = await createReceipt(
      mech,
      receiptBody({ documentNumber: `ЧЕК-ПРАВА2-${RUN}`, fileIds: [(await newFile()).id] }),
    );
    expect((await remove(admin, plain.id, plain.version)).statusCode).toBe(200);
  });

  it('`garage.read` читает раздел и не пишет в него (Р5)', async () => {
    const dto = await createReceipt(
      mech,
      receiptBody({ documentNumber: `ЧЕК-ЧТЕНИЕ-${RUN}`, fileIds: [(await newFile()).id] }),
    );

    // Вопрос «сколько вложено в эту машину» задаёт всякий, кому виден гараж: и механик, и
    // диспетчер, и менеджер. Персональных данных в чеке нет.
    expect((await feed(reader)).statusCode).toBe(200);
    expect((await summary(reader)).statusCode).toBe(200);
    expect((await card(reader, dto.id)).statusCode).toBe(200);

    // А писать — нет, и это все четыре мутации, а не только заведение. Тела здесь ЗАКОННЫЕ: разбор
    // схемы у Fastify идёт до стража ручки, и телом с ошибкой отказ пришёл бы четырёхсотым — то
    // есть проверял бы схему, а не право.
    expect((await post(reader, receiptBody({ fileIds: [(await newFile()).id] }))).statusCode).toBe(
      403,
    );
    const sameAgain = {
      ...receiptBody({
        documentNumber: `ЧЕК-ЧТЕНИЕ-${RUN}`,
        fileIds: dto.files.map((f) => f.id),
      }),
      version: dto.version,
    };
    expect((await patch(reader, dto.id, sameAgain)).statusCode).toBe(403);
    expect((await mark(reader, dto.id, { reason: 'нет', version: dto.version })).statusCode).toBe(
      403,
    );
    expect((await unmark(reader, dto.id, dto.version)).statusCode).toBe(403);
    expect((await remove(reader, dto.id, dto.version)).statusCode).toBe(403);

    // Учётке без гаража раздел закрыт целиком — включая суммы по машинам.
    expect((await feed(outsider)).statusCode).toBe(403);
    expect((await card(outsider, dto.id)).statusCode).toBe(403);
    expect((await snapshot(outsider, [])).statusCode).toBe(403);
  });

  // ── 14. Собственная техника ──

  it('арендную машину строкой чека не провести, а выведенную из парка — можно (Р21)', async () => {
    const own = await newOwnVehicle('R1');
    const retired = await newOwnVehicle('R2', 'retired');
    const rental = await newRentalVehicle();
    const file = await newFile();

    const rejected = await post(
      mech,
      receiptBody({
        documentNumber: `ЧЕК-АРЕНДА-${RUN}`,
        fileIds: [file.id],
        lines: [line({ vehicleId: own.id }), line({ vehicleId: rental.id })],
      }),
    );
    // `RESTRICT` внешнего ключа пропустил бы любую строку справочника, включая арендную, — а поймай
    // он что-нибудь, человек прочитал бы имя ограничения вместо номера строки.
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.json().message).toBe(`Строка 2: ${rental.label} — арендная техника`);
    expect(rejected.json().fields['lines.1.vehicleId']).toContain('арендная');

    // Машина, которой нет в справочнике вовсе (устаревшая вкладка либо тело мимо формы), тоже
    // называет строку — а не падает внешним ключом.
    const missing = await post(
      mech,
      receiptBody({
        documentNumber: `ЧЕК-АРЕНДА-${RUN}`,
        fileIds: [file.id],
        lines: [line({ vehicleId: randomUUID() })],
      }),
    );
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json().fields['lines.0.vehicleId']).toContain('Строка 1');

    // Статус машины не спрашивается вовсе: чек законно выписан на машину, которую позже вывели из
    // парка, и правка старого чека не должна упираться в то, что случилось после покупки.
    const accepted = await createReceipt(
      mech,
      receiptBody({
        purchasedOn: ago(400),
        documentNumber: `ЧЕК-СТАРЫЙ-${RUN}`,
        fileIds: [file.id],
        lines: [line({ vehicleId: retired.id, amount: 4200 })],
      }),
    );
    expect(accepted.lines[0]!.vehicleLabel).toBe(retired.label);
    expect(accepted.total).toBe(4200);
  });

  // ── 15. Версия у всех четырёх мутаций ──

  it('чужую версию отбивают все четыре мутации, а не только правка (Р12)', async () => {
    const dto = await createReceipt(
      mech,
      receiptBody({ documentNumber: `ЧЕК-ВЕРСИЯ-${RUN}`, fileIds: [(await newFile()).id] }),
    );
    const stale = dto.version + 7;
    const body = {
      ...receiptBody({
        documentNumber: `ЧЕК-ВЕРСИЯ-${RUN}`,
        fileIds: dto.files.map((f) => f.id),
      }),
      version: stale,
    };

    expect((await patch(mech, dto.id, body)).statusCode).toBe(409);
    expect((await mark(mech, dto.id, { reason: 'дубль', version: stale })).statusCode).toBe(409);
    // Пометку поставим по верной версии — снятие обязано спрашивать свою.
    const marked = await mark(mech, dto.id, { reason: 'дубль', version: dto.version });
    expect(marked.statusCode, marked.body).toBe(200);
    expect((await unmark(mech, dto.id, stale)).statusCode).toBe(409);
    // Удаляет админ не строку, а документ, содержание которого прочитал: слепое удаление по
    // открытой полчаса назад карточке — то же расхождение, что и слепая правка.
    expect((await remove(admin, dto.id, stale)).statusCode).toBe(409);
    // Ни одна отбитая мутация ничего не сделала: чек цел и помечен ровно один раз.
    expect((await card(mech, dto.id)).json()).toMatchObject({
      version: marked.json().version,
      deletion: { reason: 'дубль' },
    });
  });

  // ── 16. Скачивание скана ──

  it('скан чека открывает держатель гаража — и только он (Р20)', async () => {
    const exMech = await headersOf(ctx.users.exMech);
    const own = await newFile(ctx.users.exMech);
    const foreign = await newFile();

    // Пока файл ничей, его видит автор загрузки — так работает форма: скан грузится до сохранения.
    expect((await download(exMech, own.id)).statusCode).toBe(200);
    await createReceipt(
      exMech,
      receiptBody({ documentNumber: `ЧЕК-СКАН-A-${RUN}`, fileIds: [own.id] }),
    );
    await createReceipt(
      mech,
      receiptBody({ documentNumber: `ЧЕК-СКАН-Б-${RUN}`, fileIds: [foreign.id] }),
    );

    // Держатель `garage.read` открывает скан ЛЮБОГО чека: областей у гаража нет, парк один — та же
    // граница, что у журнала ТО, и другой в разделе не заводится.
    expect((await download(reader, foreign.id)).statusCode).toBe(200);
    expect((await download(admin, own.id)).statusCode).toBe(200);
    // Учётка без гаража не открывает ничего: без ветки `visibleReceipt` она и не должна. Отказ —
    // `404` (ADR 0160, решение 6): код «есть, но не тебе» отличался бы от «нет такого файла» и
    // работал бы оракулом при переборе идентификаторов. Правило общее для всех модулей.
    expect((await download(outsider, foreign.id)).statusCode).toBe(404);

    // А теперь главное: подшивший скан теряет гараж — и теряет доступ к собственному файлу.
    // Собственный `uploadedBy` работает только у файла, не привязанного НИКУДА; привязанный сразу
    // становится «чужим», и открывает его одно право чтения гаража.
    await ctx.db
      .update(ctx.schema.users)
      .set({ role: 'site' })
      .where(eq(ctx.schema.users.id, ctx.users.exMech));
    const demoted = await headersOf(ctx.users.exMech);
    expect((await download(demoted, own.id)).statusCode).toBe(404);
  });

  // ── 17. Аудит ──

  it('все пять мутаций пишут строку, и удаление уносит реквизиты в метаданные (Р19)', async () => {
    const vehicle = await newOwnVehicle('A');
    const file = await newFile();
    const created = await createReceipt(
      mech,
      receiptBody({
        purchasedOn: ago(4),
        sellerName: `Автодеталь ${RUN}`,
        documentNumber: `ЧЕК-АУДИТ-${RUN}`,
        fileIds: [file.id],
        lines: [line({ vehicleId: vehicle.id, name: 'Ремень', amount: 2500 })],
      }),
    );

    const edited = await patch(mech, created.id, {
      ...receiptBody({
        purchasedOn: ago(4),
        sellerName: `Автодеталь ${RUN}`,
        documentNumber: `ЧЕК-АУДИТ-ИСПР-${RUN}`,
        fileIds: [file.id],
        lines: [line({ vehicleId: vehicle.id, name: 'Ремень', amount: 2600 })],
      }),
      version: created.version,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const marked = await mark(mech, created.id, {
      reason: 'Продавец выписал повторно',
      version: edited.json().version,
    });
    expect(marked.statusCode, marked.body).toBe(200);
    const cleared = await unmark(mech, created.id, marked.json().version);
    expect(cleared.statusCode, cleared.body).toBe(200);
    const removed = await remove(admin, created.id, cleared.json().version);
    expect(removed.statusCode, removed.body).toBe(200);

    const trail = await auditOf(created.id);
    expect(trail.map((row) => row.action)).toEqual([
      'autoPartReceipt.create',
      'autoPartReceipt.update',
      'autoPartReceipt.deletionMark',
      'autoPartReceipt.deletionUnmark',
      'autoPartReceipt.delete',
    ]);
    expect(trail[0]!.actorUserId).toBe(ctx.users.mech);
    expect(trail[4]!.actorUserId).toBe(ctx.users.admin);

    // Правка чека — переписанный документ целиком: прежние номер и итог не хранятся больше нигде.
    const changes = (
      trail[1]!.metadata as { changes: { field: string; from: string; to: string }[] }
    ).changes;
    expect(changes).toContainEqual({
      field: 'documentNumber',
      from: `ЧЕК-АУДИТ-${RUN}`,
      to: `ЧЕК-АУДИТ-ИСПР-${RUN}`,
    });
    expect(changes).toContainEqual({ field: 'total', from: '2500.00', to: '2600.00' });

    // Разговор двух людей о судьбе документа: «предлагаю удалить, вот почему» — «отказал». Причина
    // снятой пометки стирается парой `CHECK`, и без этих строк от первой реплики не осталось бы
    // ничего.
    expect(trail[2]!.metadata).toMatchObject({ reason: 'Продавец выписал повторно' });
    expect(trail[3]!.metadata).toMatchObject({ reason: 'Продавец выписал повторно' });

    // После удаления от денежного документа в портале не остаётся НИЧЕГО, кроме этой строки, —
    // поэтому она несёт дату, продавца, номер и сумму.
    expect(trail[4]!.metadata).toMatchObject({
      purchasedOn: ago(4),
      sellerName: `Автодеталь ${RUN}`,
      documentNumber: `ЧЕК-АУДИТ-ИСПР-${RUN}`,
      total: '2600.00',
      lines: 1,
      files: [file.id],
    });
  });
});
