import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type { buildApp } from '../src/app';

/**
 * ВСЕ ПУТИ К ЗАПЕРТОМУ ФАЙЛУ — настоящими ручками, модуль за модулем.
 *
 * Файл начинался как одноразовая атака на карантин: проверяющий волны пробовал добраться до улики и
 * до имени не чтением кода, а запросами к поднятому приложению, — и именно так нашёл два пути, которых
 * не было ни в одном списке (имя в истории заявки и невозможность закарантинить уже снятое вложение).
 * Поэтому он оставлен постоянным: у тестов исполнителей другая оптика — они проверяют своё место, а
 * здесь проверяется, что к содержимому и к имени НЕ ВЕДЁТ НИ ОДНА дорога, включая чужие модули.
 *
 * У каждого случая рядом идёт обычный файл-близнец: зелёный ответ, полученный на пустой фикстуре,
 * ничего не доказывает.
 *
 * Отдельный файл и свои метки: чужие уборки по своему `LIKE` не должны уносить фикстуры посреди
 * прогона.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const ADMIN_EMAIL = 'zz-judge-q2-admin@example.invalid';
const VIEWER_EMAIL = 'zz-judge-q2-viewer@example.invalid';
const PASSWORD = 'db-test-password-123';
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: судья круга 2';
const KEY_PREFIX = 'zz-judge-q2/';
const OBJECT_CODE = 'ZZJQ2';

const WORKER_SOURCE = new URL('../../worker/src/index.ts', import.meta.url);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  viewerAuth: { authorization: string };
  adminId: string;
  viewerId: string;
  objectId: string;
  vehicleId: string;
  vehicleTypeId: string;
  organizationId: string;
  seriesId: string;
  personId: string;
}

let ctx: Ctx;
let fileNo = 0;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://127.0.0.1:9';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.MAIL_ENABLED = 'false';
  process.env.TICKET_OCR_ENABLED = 'true';
  process.env.AI_PROVIDER_MODE = 'stub';
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

async function cleanup(db: typeof AppDb): Promise<void> {
  const mine = sql`(SELECT id FROM users WHERE email IN (${ADMIN_EMAIL}, ${VIEWER_EMAIL}))`;
  await db.execute(sql`
    DELETE FROM jobs
     WHERE (type = 'delete_s3_object' AND payload->>'objectKey' LIKE ${`${KEY_PREFIX}%`})
        OR (type = 'recognize_waste_ticket_file'
            AND payload->>'requestId' IN (SELECT id::text FROM waste_requests WHERE created_by IN ${mine}))`);
  await db.execute(sql`DELETE FROM waste_requests WHERE created_by IN ${mine}`);
  await db.execute(sql`DELETE FROM mech_requests WHERE created_by IN ${mine}`);
  // Заявки оргтехники — до файлов и до площадки: связи вложений уходят каскадом за заявкой.
  await db.execute(sql`DELETE FROM service_requests WHERE created_by IN ${mine}`);
  // Порядок задан внешними ключами: показания держит строка отчёта, строку — лист, лист — заказ.
  await db.execute(sql`DELETE FROM vehicle_readings WHERE created_by IN ${mine}`);
  await db.execute(sql`DELETE FROM driver_daily_reports WHERE created_by IN ${mine}`);
  await db.execute(sql`DELETE FROM waybills WHERE issued_by IN ${mine}`);
  await db.execute(sql`DELETE FROM vehicle_requests WHERE created_by IN ${mine}`);
  await db.execute(sql`DELETE FROM vehicle_maintenance WHERE created_by IN ${mine}`);
  await db.execute(sql`DELETE FROM auto_part_receipts WHERE created_by IN ${mine}`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${KEY_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN ${mine}`);
  await db.execute(sql`DELETE FROM persons WHERE last_name = 'Судейкин'`);
  await db.execute(sql`DELETE FROM users WHERE email IN (${ADMIN_EMAIL}, ${VIEWER_EMAIL})`);
  await db.execute(sql`DELETE FROM vehicles WHERE registration_number = 'ЗЗ777СД'`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code = ${OBJECT_CODE}`);
}

// ── Фикстуры ──

interface TestFile {
  id: string;
  filename: string;
  objectKey: string;
}

async function newFile(
  options: { ageDays?: number; status?: 'pending' | 'active'; uploadedBy?: string } = {},
): Promise<TestFile> {
  fileNo += 1;
  // Имя заведомо узнаваемое и уникальное: его ищут по всему телу ответа целиком.
  const filename = `СУДЬЯ-УЛИКА-${fileNo}-${randomUUID().slice(0, 8)}.pdf`;
  const objectKey = `${KEY_PREFIX}${randomUUID()}`;
  const createdAt = new Date(Date.now() - (options.ageDays ?? 0) * 24 * 60 * 60 * 1000);
  const [row] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey,
      filename,
      contentType: 'application/pdf',
      size: 2048,
      status: options.status ?? 'active',
      uploadedBy: options.uploadedBy ?? ctx.adminId,
      createdAt,
    })
    .returning({ id: ctx.schema.files.id });
  return { id: row!.id, filename, objectKey };
}

async function quarantine(fileId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/files/${fileId}/quarantine`,
    headers: ctx.auth,
    payload: { reason: 'Судья круга 2: в заявку попал чужой документ с персональными данными' },
  });
  expect(res.statusCode, `постановка в карантин: ${res.body}`).toBe(200);
}

async function get(url: string, headers = ctx.auth): Promise<{ raw: string; body: unknown }> {
  const res = await ctx.app.inject({ method: 'GET', url, headers });
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return { raw: res.body, body: res.json() };
}

/**
 * Главная проверка имени: ответ ручки СТРОКОЙ ЦЕЛИКОМ не содержит имени запертого файла и содержит
 * имя обычного. Так проверяется не знание формы ответа, а факт: имя наружу не ушло нигде — ни в
 * списке вложений, ни в истории, ни в каком-нибудь соседнем поле того же тела.
 *
 * Вторая половина (имя обычного файла ОБЯЗАНО быть) — страховка от пустого ответа: без неё «имени
 * нет» одинаково хорошо объяснялось бы фикстурой, которой ручка не увидела вовсе.
 */
function expectNameHidden(raw: string, locked: TestFile, plain: TestFile, what: string): void {
  expect(raw.includes(plain.filename), `${what}: обычное вложение видно`).toBe(true);
  expect(raw.includes(locked.filename), `${what}: имя карантинного файла УШЛО НАРУЖУ`).toBe(false);
}

/**
 * Заявка оргтехники без аппарата: проверяется сборщик вложений, а не предмет заявки, и
 * `office_equipment_id` у заявки необязателен (заявка «от отдела»). Так фикстуре не нужны ни
 * карточка парка, ни её тип, ни порядок уборки между ними.
 */
async function newServiceRequest(): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.serviceRequests)
    .values({
      equipmentObjectId: ctx.objectId,
      equipmentName: '',
      description: `${MARK}: заявка оргтехники`,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.serviceRequests.id });
  return row!.id;
}

async function newWasteRequest(status: 'new' | 'done' = 'new'): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType: 'metal_removal',
      deliveryAt: new Date(),
      status,
      createdBy: ctx.adminId,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      comment: MARK,
    })
    .returning({ id: ctx.schema.wasteRequests.id });
  return row!.id;
}

async function newVehicleRequest(): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'special_equipment',
      vehicleTypeId: ctx.vehicleTypeId,
      objectId: ctx.objectId,
      createdBy: ctx.adminId,
      comment: MARK,
    })
    .returning({ id: ctx.schema.vehicleRequests.id });
  return row!.id;
}

/**
 * Путевой лист формы ЭСМ-2: у него `source_request_id` вместо рейса (`waybills_form_source_check`),
 * и это самая короткая законная фикстура листа — рейс тянул бы за собой заказ, назначение и точки.
 */
async function newWaybill(): Promise<string> {
  const nums = await ctx.db.execute<{ n: string }>(
    sql`SELECT COALESCE(max(number), 900000) + 1 AS n FROM waybills`,
  );
  const [row] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: Number(nums.rows[0]!.n),
      formCode: 'esm2',
      organizationId: ctx.organizationId,
      vehicleId: ctx.vehicleId,
      driverPersonId: ctx.personId,
      issuedForDate: '2026-09-02',
      sourceRequestId: await newVehicleRequest(),
      periodFrom: '2026-09-01',
      periodTo: '2026-09-05',
      issuedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.waybills.id });
  return row!.id;
}

async function requestVersion(requestId: string): Promise<number> {
  const res = await ctx.db.execute<{ version: number }>(
    sql`SELECT version FROM waste_requests WHERE id = ${requestId}`,
  );
  return res.rows[0]!.version;
}

async function patchWaste(requestId: string, body: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/waste-requests/${requestId}`,
    headers: ctx.auth,
    payload: { ...body, version: await requestVersion(requestId) },
  });
}

async function fileState(fileId: string) {
  const res = await ctx.db.execute<{
    status: string;
    deleted_at: Date | null;
    quarantined_at: Date | null;
  }>(sql`SELECT status, deleted_at, quarantined_at FROM files WHERE id = ${fileId}`);
  return res.rows[0];
}

async function deletionJobs(objectKey: string): Promise<number> {
  const res = await ctx.db.execute<{ c: string }>(sql`
    SELECT count(*) AS c FROM jobs
     WHERE type = 'delete_s3_object' AND payload->>'objectKey' = ${objectKey}`);
  return Number(res.rows[0]!.c);
}

// ── Запросы уборки, взятые ТЕКСТОМ из исходника воркера ──

function workerQuery(re: RegExp, what: string): string {
  const text = readFileSync(WORKER_SOURCE, 'utf8');
  const found = re.exec(text);
  if (!found?.[1]) throw new Error(`В исходнике воркера не найден ${what}`);
  return found[1];
}

function candidateQuery(): string {
  const text = readFileSync(WORKER_SOURCE, 'utf8');
  const batch = /const FILE_CLEANUP_BATCH = (\d+);/u.exec(text);
  if (!batch) throw new Error('не найден размер батча уборки');
  return workerQuery(
    /`(SELECT id FROM files\b[\s\S]*?FOR UPDATE SKIP LOCKED)`/u,
    'отбор кандидатов уборки',
  ).replace('${FILE_CLEANUP_BATCH}', batch[1]!);
}

function confirmQuery(): string {
  return workerQuery(
    /`(SELECT id, object_key FROM files\b[\s\S]*?)`/u,
    'подтверждение уборки под блокировкой',
  );
}

/** Тот же запрос без карантинного условия: «наивный» двойник обязан забрать запертый файл. */
function naive(query: string): string {
  const stripped = query.replace(/\s*AND\s+quarantined_at IS NULL/gu, '');
  expect(stripped, 'в запросе воркера нет карантинного условия вовсе').not.toBe(query);
  return stripped;
}

async function runQuery(query: string, params: unknown[]): Promise<string[]> {
  const res = await ctx.db.execute<{ id: string }>(sql.raw(bind(query, params)));
  return res.rows.map((r) => r.id);
}

/** Подстановка параметров текстом: `db.execute` в drizzle позиционных параметров не принимает. */
function bind(query: string, params: unknown[]): string {
  return query.replace(/\$(\d+)(::[a-z[\]]+)?/gu, (_m, n: string, cast: string | undefined) => {
    const v = params[Number(n) - 1];
    const lit = `'${String(v).replace(/'/gu, "''")}'`;
    return cast ? `${lit}${cast}` : lit;
  });
}

describe.skipIf(!DB_URL)('СУДЬЯ круга 2: улика и имя', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    await cleanup(db);

    const { hashPassword } = await import('../src/auth/password');
    const hash = await hashPassword(PASSWORD);
    const [admin] = await db
      .insert(schema.users)
      .values({
        email: ADMIN_EMAIL,
        lastName: 'Судья',
        firstName: 'Второго',
        middleName: 'Круга',
        passwordHash: hash,
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });
    // Вторая учётка — БЕЗ права разбора карантина: она и есть «все остальные».
    const [viewer] = await db
      .insert(schema.users)
      .values({
        email: VIEWER_EMAIL,
        lastName: 'Смотрящий',
        firstName: 'Без',
        middleName: 'Права',
        passwordHash: hash,
        role: 'manager',
        isActive: true,
      })
      .returning({ id: schema.users.id });

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: OBJECT_CODE,
        name: 'Площадка судьи круга 2',
        address: 'г Москва, ул Судейская, д 2',
      })
      .returning({ id: schema.constructionObjects.id });

    const types = await db.execute<{ id: string }>(sql`SELECT id FROM vehicle_types LIMIT 1`);
    const orgs = await db.execute<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`);
    const series = await db.execute<{ id: string }>(sql`SELECT id FROM waybill_series LIMIT 1`);
    const [vehicle] = await db
      .insert(schema.vehicles)
      .values({ vehicleTypeId: types.rows[0]!.id, registrationNumber: 'ЗЗ777СД' })
      .returning({ id: schema.vehicles.id });
    const [person] = await db
      .insert(schema.persons)
      .values({ lastName: 'Судейкин', firstName: 'Водитель', isDriver: true })
      .returning({ id: schema.persons.id });

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    const login = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken as string}` };
    };

    ctx = {
      app,
      db,
      schema,
      closeDb,
      auth: await login(ADMIN_EMAIL),
      viewerAuth: await login(VIEWER_EMAIL),
      adminId: admin!.id,
      viewerId: viewer!.id,
      objectId: object!.id,
      vehicleId: vehicle!.id,
      vehicleTypeId: types.rows[0]!.id,
      organizationId: orgs.rows[0]!.id,
      seriesId: series.rows[0]!.id,
      personId: person!.id,
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ══════════════════════════════ 1. УНОС УЛИКИ ══════════════════════════════

  it('штатное снятие вложения заявки не уносит запертый файл, обычный — уносит', async () => {
    const requestId = await newWasteRequest();
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.requestFiles).values([
      { requestId, fileId: locked.id, kind: 'attachment' },
      { requestId, fileId: plain.id, kind: 'attachment' },
    ]);
    await quarantine(locked.id);

    const res = await patchWaste(requestId, { removeFileIds: [locked.id, plain.id] });
    expect(res.statusCode, res.body).toBe(200);

    const lockedRow = await fileState(locked.id);
    expect(lockedRow?.status, 'запертый файл остался живым').toBe('active');
    expect(lockedRow?.deletedAt ?? lockedRow?.deleted_at).toBeNull();
    expect(await deletionJobs(locked.objectKey), 'задачи на снос объекта нет').toBe(0);

    const plainRow = await fileState(plain.id);
    expect(plainRow?.status, 'регресс: обычный файл снят как прежде').toBe('deleted');
    expect(await deletionJobs(plain.objectKey)).toBe(1);
  });

  it('жёсткое удаление заявки не уносит запертый файл, обычный — уносит', async () => {
    const requestId = await newWasteRequest('new');
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.requestFiles).values([
      { requestId, fileId: locked.id, kind: 'attachment' },
      { requestId, fileId: plain.id, kind: 'attachment' },
    ]);
    await quarantine(locked.id);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/waste-requests/${requestId}`,
      headers: ctx.auth,
    });
    expect(res.statusCode, res.body).toBe(200);

    expect(await fileState(locked.id), 'строка запертого файла жива').toBeDefined();
    expect(await fileState(plain.id), 'регресс: обычный файл удалён насовсем').toBeUndefined();
  });

  it('уборка воркера: оба прохода и ОБА запроса запертый файл не берут', async () => {
    const passes = [
      { status: 'pending', interval: '1 day', age: 3 },
      { status: 'active', interval: '7 days', age: 10 },
    ] as const;
    for (const pass of passes) {
      const locked = await newFile({ status: pass.status, ageDays: pass.age });
      const plain = await newFile({ status: pass.status, ageDays: pass.age });
      await quarantine(locked.id);

      const candidates = await runQuery(candidateQuery(), [pass.status, pass.interval]);
      expect(candidates, `${pass.status}: отбор не берёт запертый`).not.toContain(locked.id);
      expect(candidates, `${pass.status}: регресс, обычный кандидат на месте`).toContain(plain.id);
      expect(
        await runQuery(naive(candidateQuery()), [pass.status, pass.interval]),
        `${pass.status}: без условия отбор забрал бы запертый — значит условие и держит`,
      ).toContain(locked.id);

      const confirmed = await runQuery(confirmQuery(), [`{${locked.id},${plain.id}}`, pass.status]);
      expect(confirmed, `${pass.status}: подтверждение не берёт запертый`).not.toContain(locked.id);
      expect(confirmed, `${pass.status}: регресс подтверждения`).toContain(plain.id);
      expect(
        await runQuery(naive(confirmQuery()), [`{${locked.id},${plain.id}}`, pass.status]),
        `${pass.status}: без условия подтверждение забрало бы запертый`,
      ).toContain(locked.id);
    }
  });

  it('подшивка запертого файла в другую заявку отбивается, обычного — проходит', async () => {
    const first = await newWasteRequest();
    const second = await newWasteRequest();
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db
      .insert(ctx.schema.requestFiles)
      .values({ requestId: first, fileId: locked.id, kind: 'attachment' });
    await quarantine(locked.id);
    // Связь снимаем штатно: только ничейный файл и можно пробовать подшить куда-то ещё.
    expect((await patchWaste(first, { removeFileIds: [locked.id] })).statusCode).toBe(200);

    const denied = await patchWaste(second, { addFileIds: [locked.id] });
    expect(denied.statusCode, denied.body).toBe(422);
    expect(denied.body).toContain('карантин');

    const allowed = await patchWaste(second, { addFileIds: [plain.id] });
    expect(allowed.statusCode, `регресс подшивки: ${allowed.body}`).toBe(200);
  });

  it('прямая ручка удаления файла запертый не удаляет, обычный — удаляет', async () => {
    const locked = await newFile();
    const plain = await newFile();
    await quarantine(locked.id);
    const denied = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/files/${locked.id}`,
      headers: ctx.auth,
    });
    expect(denied.statusCode, denied.body).toBe(409);
    expect((await fileState(locked.id))?.status).toBe('active');

    const ok = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/files/${plain.id}`,
      headers: ctx.auth,
    });
    expect(ok.statusCode, `регресс удаления: ${ok.body}`).toBe(200);
  });

  it('ссылка на содержимое: автору 404, держателю права разбора — ссылка и запись журнала', async () => {
    const requestId = await newWasteRequest();
    const locked = await newFile({ uploadedBy: ctx.viewerId });
    await ctx.db
      .insert(ctx.schema.requestFiles)
      .values({ requestId, fileId: locked.id, kind: 'attachment' });
    await quarantine(locked.id);

    const asAuthor = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/files/${locked.id}/download`,
      headers: ctx.viewerAuth,
    });
    expect(asAuthor.statusCode, `автор загрузки: ${asAuthor.body}`).toBe(404);
    expect(asAuthor.body, 'имя файла не уходит и в отказе').not.toContain(locked.filename);

    const asAudit = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/files/${locked.id}/download`,
      headers: ctx.auth,
    });
    expect(asAudit.statusCode, `право разбора: ${asAudit.body}`).toBe(200);
    const audit = await ctx.db.execute<{ c: string }>(sql`
      SELECT count(*) AS c FROM audit_log
       WHERE action = 'file.quarantine_access' AND entity_id = ${locked.id}`);
    expect(Number(audit.rows[0]!.c), 'каждое открытие пишется в журнал').toBe(1);
  });

  it('кнопка «перераспознать»: запертый талон отбивается, обычный уходит в очередь', async () => {
    // Заявка сразу «выполненная»: разбор талонов открыт только у неё, а путь закрытия заявки к
    // карантину отношения не имеет — предмет проверки здесь постановка задачи.
    const requestId = await newWasteRequest('done');
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.requestFiles).values([
      { requestId, fileId: locked.id, kind: 'ticket' },
      { requestId, fileId: plain.id, kind: 'ticket' },
    ]);
    await quarantine(locked.id);

    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${requestId}/ticket-files/${locked.id}/recognize`,
      headers: ctx.auth,
    });
    expect(denied.statusCode, `запертый талон: ${denied.body}`).toBe(422);
    expect(denied.body).toContain('карантин');

    const allowed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/waste-requests/${requestId}/ticket-files/${plain.id}/recognize`,
      headers: ctx.auth,
    });
    expect(allowed.statusCode, `регресс распознавания: ${allowed.body}`).toBe(200);

    const jobs = await ctx.db.execute<{ file_id: string }>(sql`
      SELECT payload->>'fileId' AS file_id FROM jobs
       WHERE type = 'recognize_waste_ticket_file' AND payload->>'requestId' = ${requestId}`);
    const queued = jobs.rows.map((r) => r.file_id);
    expect(queued, 'запертый талон в очередь не попал').not.toContain(locked.id);
    expect(queued, 'регресс: обычный талон в очереди').toContain(plain.id);
  });

  it('постановка пачкой (закрытие заявки) запертый талон пропускает, а не роняет закрытие', async () => {
    const requestId = await newWasteRequest('done');
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.requestFiles).values([
      { requestId, fileId: locked.id, kind: 'ticket' },
      { requestId, fileId: plain.id, kind: 'ticket' },
    ]);
    await quarantine(locked.id);
    const tickets = await import('../src/services/waste-tickets');
    await ctx.db.transaction(async (tx) => {
      await tickets.enqueueTicketRecognition(tx, requestId, [locked.id, plain.id]);
    });
    const jobs = await ctx.db.execute<{ file_id: string }>(sql`
      SELECT payload->>'fileId' AS file_id FROM jobs
       WHERE type = 'recognize_waste_ticket_file' AND payload->>'requestId' = ${requestId}`);
    const queued = jobs.rows.map((r) => r.file_id);
    expect(queued).not.toContain(locked.id);
    expect(queued).toContain(plain.id);
  });

  // ══════════════════════════════ 2. УТЕЧКА ИМЕНИ ══════════════════════════════

  it('откат заявки в «Новую» запертый талон отвязывает, но не уносит', async () => {
    const requestId = await newWasteRequest('done');
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.requestFiles).values([
      { requestId, fileId: locked.id, kind: 'ticket' },
      { requestId, fileId: plain.id, kind: 'ticket' },
    ]);
    await quarantine(locked.id);
    // Стирающий откат — это `confirmed → new` (`transitionResetsWork`), и только он отвязывает
    // талоны; статус ставится фикстурой, потому что предмет проверки — судьба файла при откате.
    await ctx.db.execute(
      sql`UPDATE waste_requests SET status = 'confirmed' WHERE id = ${requestId}`,
    );
    const back = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/waste-requests/${requestId}/status`,
      headers: ctx.auth,
      payload: {
        status: 'new',
        comment: 'Откат прогона судьи: проверка судьбы запертого талона',
        version: await requestVersion(requestId),
      },
    });
    expect(back.statusCode, `откат заявки: ${back.body}`).toBe(200);
    expect((await fileState(locked.id))?.status, 'запертый талон жив').toBe('active');
    expect(await deletionJobs(locked.objectKey)).toBe(0);
    expect((await fileState(plain.id))?.status, 'регресс: обычный талон снят').toBe('deleted');
  });

  it('вывоз мусора: карточка и список', async () => {
    const requestId = await newWasteRequest();
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.requestFiles).values([
      { requestId, fileId: locked.id, kind: 'attachment' },
      { requestId, fileId: plain.id, kind: 'attachment' },
    ]);
    await quarantine(locked.id);
    const card = await get(`/api/v1/waste-requests/${requestId}`);
    expectNameHidden(card.raw, locked, plain, 'вывоз, карточка');
    const list = await get('/api/v1/waste-requests?limit=100');
    expectNameHidden(list.raw, locked, plain, 'вывоз, список');
    // Признак и ссылка обязаны остаться: строка файла — это факт, а не только имя.
    const dto = card.body as { files: { id: string; filename: string; quarantined?: boolean }[] };
    const seen = dto.files.find((f) => f.id === locked.id);
    expect(seen?.filename).toBe('');
    expect(seen?.quarantined).toBe(true);
  });

  /**
   * ОРГТЕХНИКА — МОДУЛЬ, РАДИ КОТОРОГО КАРАНТИН И ЗАВЕДЁН (Р6 плана
   * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`), и до исполнения он единственный из
   * десяти сборщиков правила не спрашивал: имя запертого файла уходило в карточку, в список и в ответ
   * каждого действия — всем, кому видна заявка. Перечень модулей здесь ходил мимо него ровно потому,
   * что дыру искали в чужих модулях.
   */
  it('заявки оргтехники: карточка и список', async () => {
    const requestId = await newServiceRequest();
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.serviceRequestFiles).values([
      { requestId, fileId: locked.id, kind: 'act' },
      { requestId, fileId: plain.id, kind: 'act' },
    ]);
    await quarantine(locked.id);
    const card = await get(`/api/v1/service-requests/${requestId}`);
    expectNameHidden(card.raw, locked, plain, 'оргтехника, карточка');
    const list = await get('/api/v1/service-requests?limit=100');
    expectNameHidden(list.raw, locked, plain, 'оргтехника, список');
    // Строка и ссылка остаются: «документ скрыт по обращению» и «документа не было» — разные факты.
    const dto = card.body as { files: { id: string; filename: string; quarantined?: boolean }[] };
    const seen = dto.files.find((f) => f.id === locked.id);
    expect(seen?.filename).toBe('');
    expect(seen?.quarantined).toBe(true);
  });

  it('талоны: экран разбора (оба сборщика) и очередь слепой перепроверки', async () => {
    const requestId = await newWasteRequest('done');
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.requestFiles).values([
      { requestId, fileId: locked.id, kind: 'ticket' },
      { requestId, fileId: plain.id, kind: 'ticket' },
    ]);
    await ctx.db.execute(sql`
      INSERT INTO waste_ticket_files (file_id, request_id, status)
      VALUES (${locked.id}, ${requestId}, 'done'), (${plain.id}, ${requestId}, 'done')`);
    await quarantine(locked.id);

    const screen = await get(`/api/v1/waste-requests/${requestId}/tickets`);
    expectNameHidden(screen.raw, locked, plain, 'талоны, экран разбора');

    // Очередь слепой перепроверки: задание ссылается на страницу, страница — на файл.
    for (const f of [locked, plain]) {
      const page = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO waste_ticket_pages (request_id, file_id, page_no, page_sha256, status)
        VALUES (${requestId}, ${f.id}, 1, ${randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')}, 'done')
        RETURNING id`);
      const ticket = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO waste_tickets (request_id, origin, page_id, seq)
        VALUES (${requestId}, 'ocr', ${page.rows[0]!.id}, 1) RETURNING id`);
      await ctx.db.execute(sql`
        INSERT INTO waste_ticket_blind_checks (ticket_id, baseline_fingerprint, status)
        VALUES (${ticket.rows[0]!.id}, ${'f'.repeat(64)}, 'pending')`);
    }
    const queue = await get('/api/v1/waste-requests/ticket-blind-checks?limit=50');
    expectNameHidden(queue.raw, locked, plain, 'талоны, очередь слепой перепроверки');
  });

  it('заказ техники: карточка', async () => {
    const requestId = await newVehicleRequest();
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.vehicleRequestFiles).values([
      { vehicleRequestId: requestId, fileId: locked.id },
      { vehicleRequestId: requestId, fileId: plain.id },
    ]);
    await quarantine(locked.id);
    const card = await get(`/api/v1/vehicle-requests/${requestId}`);
    expectNameHidden(card.raw, locked, plain, 'заказ техники, карточка');
  });

  it('путевые листы: карточка листа', async () => {
    const waybillId = await newWaybill();
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.waybillFiles).values([
      { waybillId, fileId: locked.id },
      { waybillId, fileId: plain.id },
    ]);
    await quarantine(locked.id);
    const card = await get(`/api/v1/waybills/${waybillId}`);
    expectNameHidden(card.raw, locked, plain, 'путевой лист, карточка');
  });

  it('механизация: карточка заявки', async () => {
    const [request] = await ctx.db
      .insert(ctx.schema.mechRequests)
      .values({
        objectId: ctx.objectId,
        plannedFrom: '2026-09-01',
        plannedTo: '2026-09-10',
        responsibleName: 'Петров Пётр Петрович',
        responsiblePhone: '9990000001',
        status: 'new',
        createdBy: ctx.adminId,
        comment: MARK,
      })
      .returning({ id: ctx.schema.mechRequests.id });
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.mechRequestFiles).values([
      { requestId: request!.id, fileId: locked.id },
      { requestId: request!.id, fileId: plain.id },
    ]);
    await quarantine(locked.id);
    const card = await get(`/api/v1/mech-requests/${request!.id}`);
    expectNameHidden(card.raw, locked, plain, 'механизация, карточка');
  });

  it('обслуживание техники: история ТО', async () => {
    const [record] = await ctx.db
      .insert(ctx.schema.vehicleMaintenance)
      .values({
        vehicleId: ctx.vehicleId,
        performedOn: '2026-09-01',
        createdBy: ctx.adminId,
        comment: MARK,
      })
      .returning({ id: ctx.schema.vehicleMaintenance.id });
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.vehicleMaintenanceFiles).values([
      { maintenanceId: record!.id, fileId: locked.id },
      { maintenanceId: record!.id, fileId: plain.id },
    ]);
    await quarantine(locked.id);
    const history = await get(`/api/v1/vehicle-maintenance/vehicles/${ctx.vehicleId}/history`);
    expectNameHidden(history.raw, locked, plain, 'ТО, история');
  });

  it('чеки автозапчастей: карточка и список', async () => {
    const [receipt] = await ctx.db
      .insert(ctx.schema.autoPartReceipts)
      .values({
        purchasedOn: '2026-09-01',
        documentNumber: `СД-${fileNo}-${randomUUID().slice(0, 6)}`,
        createdBy: ctx.adminId,
      })
      .returning({ id: ctx.schema.autoPartReceipts.id });
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.autoPartReceiptFiles).values([
      { receiptId: receipt!.id, fileId: locked.id },
      { receiptId: receipt!.id, fileId: plain.id },
    ]);
    await quarantine(locked.id);
    const card = await get(`/api/v1/auto-part-receipts/${receipt!.id}`);
    expectNameHidden(card.raw, locked, plain, 'чек автозапчастей, карточка');
  });

  it('журнал показаний: вложения смены', async () => {
    const [report] = await ctx.db
      .insert(ctx.schema.driverDailyReports)
      .values({ personId: ctx.personId, reportDate: '2026-09-02', createdBy: ctx.adminId })
      .returning({ id: ctx.schema.driverDailyReports.id });
    const [item] = await ctx.db
      .insert(ctx.schema.driverDailyReportItems)
      .values({
        reportId: report!.id,
        // Смена ЭСМ-2: строка отчёта обязана ссылаться либо на рейс, либо на лист
        // (`report_items_source_check`), и лист тут короче рейса.
        sourceKind: 'esm2',
        waybillId: await newWaybill(),
        vehicleId: ctx.vehicleId,
        reportDate: '2026-09-02',
        shiftOrder: 1,
      })
      .returning({ id: ctx.schema.driverDailyReportItems.id });
    const [reading] = await ctx.db
      .insert(ctx.schema.vehicleReadings)
      .values({
        itemId: item!.id,
        reportId: report!.id,
        vehicleId: ctx.vehicleId,
        reportDate: '2026-09-02',
        shiftOrder: 1,
        kind: 'values',
        odometerKm: 1000,
        source: 'staff',
        createdBy: ctx.adminId,
      })
      .returning({ id: ctx.schema.vehicleReadings.id });
    const locked = await newFile();
    const plain = await newFile();
    await ctx.db.insert(ctx.schema.vehicleReadingFiles).values([
      { readingId: reading!.id, fileId: locked.id },
      { readingId: reading!.id, fileId: plain.id },
    ]);
    await quarantine(locked.id);
    const journal = await get(
      `/api/v1/vehicle-readings/journal/${ctx.vehicleId}?from=2026-09-01&to=2026-09-30`,
    );
    expectNameHidden(journal.raw, locked, plain, 'журнал показаний');
  });
});
