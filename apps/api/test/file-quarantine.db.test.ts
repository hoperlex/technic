import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Карантин файла — план `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Р6, п. 4.
 *
 * ЧТО ДОКАЗЫВАЕТСЯ. Карантин — не метка в карточке: после постановки прямая ссылка
 * `GET /files/:id/download` отвечает `404` АВТОРУ ЗАГРУЗКИ, исполнителю и «Ведению», то есть всем,
 * кому файл был открыт минуту назад. Содержимое отдаётся только держателю права
 * `files.quarantineAudit`, и каждое такое открытие появляется в журнале отдельной строкой. Хеш
 * считается сервером при постановке; постановка без причины отбивается; снятие карантина возвращает
 * доступ. И главное рядом с этим — ИНВАРИАНТ: обычный, не карантинный файл той же заявки ведёт себя
 * ровно как прежде, иначе все отказы выше одинаково хорошо объяснялись бы сломанной фикстурой.
 *
 * ЗАЧЕМ БАЗА. Предмет проверки — приоритет запрета в `canAccessFile` относительно ВЕТВЕЙ ВИДИМОСТИ, а
 * они целиком живут в SQL: область заявки, сторона исполнителя и вид документа считаются запросами, а
 * аудитория складывается из права и строки `service_request_executors`, перечитываемых `loadPrincipal`
 * на каждом запросе. Подменить это нечем: «карантин бьёт раньше автора» проверяемо только там, где
 * обе ветки настоящие.
 *
 * ПРАВО РАЗБОРА ДАЁТСЯ РОЛИ БЕЗ ДОСТУПА К МОДУЛЮ — механику. Это не каприз фикстуры, а второе
 * утверждение случая: карантинный файл открывается САМИМ правом, раньше любой ветки видимости, и
 * модуль оргтехники для этого не нужен (`PERMISSION_REQUIRES` объявляет право входным). Обратная
 * сторона того же — механику закрыт обычный файл той же заявки: останься он открыт, «карантин
 * открылся правом» значило бы «механик и так всё видит».
 *
 * ГРАНИЦЫ. Решение о доступе как чистая функция — `file-access.test.ts`; вид документа и аудитории —
 * `service-request-file-access.db.test.ts`; состав каталога полномочий — `grants-catalog.db.test.ts`.
 * Здесь только карантин. Сборка DTO заявки (имя карантинного файла в карточке) живёт в чужом файле
 * этой волны и проверяется своим тестом.
 *
 * Запуск (база общая, поэтому только этот файл; хранилище — своё, см. ниже):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5488/technic_fq_test \
 *   TEST_S3_ENDPOINT=http://localhost:9488 TEST_S3_BUCKET=fq-test \
 *   TEST_S3_ACCESS_KEY_ID=fqtest TEST_S3_SECRET_ACCESS_KEY=fqtestsecret \
 *     pnpm --filter @technic/api test -- file-quarantine.db
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`. Без живого хранилища
 * он НЕ пропускается: хеш тогда не считается, и это ровно то штатное состояние, которое план
 * описывает словами «недосчитанный хеш остаётся пустым и виден в аудите как „посчитать не удалось“, а
 * не как „карантин не состоялся“». Проверяется поэтому обе ветки — по флагу `storeReady`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: база общая и переживает прогоны, а уборка ищет своё по нему. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
/** Префикс ключей объектов: по нему же уборка находит файлы, включая оставленные падением. */
const KEY_PREFIX = `fq/${RUN}/`;

const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000';
const S3_BUCKET = process.env.TEST_S3_BUCKET ?? 'fq-test';
const S3_KEY_ID = process.env.TEST_S3_ACCESS_KEY_ID ?? 'fqtest';
const S3_SECRET = process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'fqtestsecret';

type Auth = { authorization: string };

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: заводит технику и распределяет заявку. */
  admin: TestUser;
  /** Заказчик площадки и АВТОР ЗАГРУЗКИ обоих файлов — главный отказ случая. */
  customer: TestUser;
  /** «Ведение» площадки: надстройка `office_equipment_operator` даёт `serviceRequests.finance`. */
  keeper: TestUser;
  /** Оператор назначенной сервисной компании — сторона исполнителя. */
  service: TestUser;
  /**
   * Держатель `files.quarantineAudit` и НИЧЕГО больше: роль `mechanic`, набор из одного права.
   * Модуля оргтехники у него нет вовсе — в этом и смысл (см. шапку файла).
   */
  auditor: TestUser;
  objectId: string;
  counterpartyId: string;
  typeId: string;
  /** Живо ли хранилище: от него зависит только хеш, но не сам карантин. */
  storeReady: boolean;
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
  // Хранилище здесь НАСТОЯЩЕЕ, в отличие от соседних файлов с заглушками: хеш карантина считается
  // потоком из S3, и подменить этот поток нечем — предмет проверки ровно он.
  process.env.S3_ENDPOINT = S3_ENDPOINT;
  process.env.S3_BUCKET = S3_BUCKET;
  process.env.S3_ACCESS_KEY_ID = S3_KEY_ID;
  process.env.S3_SECRET_ACCESS_KEY = S3_SECRET;
  process.env.S3_FORCE_PATH_STYLE = 'true';
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

/** Свой адрес на каждое обращение: и вход, и общий ограничитель считают запросы по адресу. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/**
 * Десятизначный ИНН по девяти цифрам основы — настоящая контрольная сумма: пока идёт прогон,
 * контрагент лежит в общей базе, а обмен справочниками выгружает её целиком и на выдуманном ИНН
 * падает (падение выглядело бы дефектом чужого модуля).
 */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function inject(
  method: Method,
  url: string,
  auth: Auth,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = { method, url, headers: auth, remoteAddress: nextAddress() };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return ctx.app.inject(options);
}

function download(fileId: string, auth: Auth): Promise<LightMyRequestResponse> {
  return inject('GET', `/api/v1/files/${fileId}/download`, auth);
}

/**
 * Отказ по прямой ссылке — `404` и тем же текстом, что у файла, которого нет вовсе (ADR 0160,
 * решение 6): разные коды на «нет такого» и «есть, но не тебе» работают оракулом. Текст проверяется
 * потому, что `404` от стража маршрута или от опечатки в адресе выглядел бы так же, а означал бы,
 * что случай ничего не доказал.
 */
async function expectHidden(fileId: string, auth: Auth, what: string): Promise<void> {
  const res = await download(fileId, auth);
  expect(res.statusCode, `${what}: ${res.body}`).toBe(404);
  expect((res.json() as { message?: string }).message, what).toBe('Файл не найден');
}

/** Открытый файл: не только код, но и сама пресайн-ссылка — ради неё ручку и зовут. */
async function expectOpen(fileId: string, auth: Auth, what: string): Promise<void> {
  const res = await download(fileId, auth);
  expect(res.statusCode, `${what}: ${res.body}`).toBe(200);
  const body = res.json() as { url?: string };
  expect(typeof body.url, what).toBe('string');
  expect(body.url, what).toContain('http');
}

/** Строки журнала по файлу: действие и его метаданные — предмет проверок про аудит. */
async function auditRows(
  fileId: string,
  action: string,
): Promise<{ actorUserId: string | null; metadata: Record<string, unknown> }[]> {
  const res = await ctx.db.execute<{ actor_user_id: string | null; metadata: unknown }>(sql`
    SELECT actor_user_id, metadata FROM audit_log
     WHERE entity_type = 'file' AND entity_id = ${fileId} AND action = ${action}
     ORDER BY created_at`);
  return res.rows.map((r) => ({
    actorUserId: r.actor_user_id,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}

async function fileRow(
  fileId: string,
): Promise<{ quarantinedAt: string | null; contentHash: string | null }> {
  const res = await ctx.db.execute<{ quarantined_at: string | null; content_hash: string | null }>(
    sql`SELECT quarantined_at::text, content_hash FROM files WHERE id = ${fileId}`,
  );
  const row = res.rows[0];
  if (!row) throw new Error(`файла ${fileId} нет в базе`);
  return { quarantinedAt: row.quarantined_at, contentHash: row.content_hash };
}

/**
 * Уборка своих строк — и ПЕРЕД прогоном тоже: упавшая подготовка оставляет мусор, до которого
 * суффиксная уборка следующего прогона не дотянется (он ищет СВОЙ суффикс), а база общая.
 *
 * Порядок задан внешними ключами: заявки (за ними каскадом связи с файлами), техника, модели, файлы,
 * журнал, выдачи и наборы, учётки, контрагент и только в конце площадка — её держит `RESTRICT`.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const users = sql`SELECT id FROM users WHERE email LIKE 'db-fq-%'`;
  const equipment = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE 'FQ-%'`;
  await db.execute(sql`DELETE FROM jobs WHERE payload->>'objectKey' LIKE 'fq/%'`);
  await db.execute(sql`
    DELETE FROM service_requests
     WHERE office_equipment_id IN (${equipment}) OR created_by IN (${users})`);
  await db.execute(sql`DELETE FROM office_equipment WHERE inventory_number LIKE 'FQ-%'`);
  await db.execute(sql`
    DELETE FROM office_equipment_models m
     WHERE m.name LIKE '%FQ-${sql.raw(RUN)}%'
       AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE 'fq/%'`);
  await db.execute(sql`DELETE FROM user_grants WHERE user_id IN (${users})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'db-fq-%'`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE 'fq-%'`);
  await db.execute(sql`DELETE FROM counterparties WHERE name LIKE 'Сервис-FQ %'`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code LIKE 'FQ-%'`);
}

// ── Подготовка данных ──

let unitNo = 0;

/** Своя единица под каждую заявку: по технике разрешена одна открытая заявка. */
async function makeEquipment(): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: ctx.typeId,
    name: `Kyocera ECOSYS M3145 FQ-${RUN}`,
    inventoryNumber: `FQ-${RUN}-${unitNo}`,
    objectId: ctx.objectId,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function createRequest(description: string): Promise<string> {
  const res = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
    officeEquipmentId: await makeEquipment(),
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { request: { id: string } }).request.id;
}

async function requestVersion(id: string): Promise<number> {
  const res = await inject('GET', `/api/v1/service-requests/${id}`, ctx.admin.auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { version: number }).version;
}

/** Назначение сервисной компании: сторона исполнителя нужна, чтобы его отказ что-то значил. */
async function assignService(id: string): Promise<void> {
  const res = await inject('PUT', `/api/v1/service-requests/${id}/executors`, ctx.admin.auth, {
    userIds: [],
    serviceCounterpartyId: ctx.counterpartyId,
    version: await requestVersion(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

/**
 * Файл строкой в `files` И объектом в хранилище: без объекта хеш посчитать нечем, а он — половина
 * карантина. Содержимое своё у каждого файла, чтобы хеши не совпали случайно.
 */
async function uploadedFile(
  userId: string,
  filename: string,
  content: string,
): Promise<{ id: string; objectKey: string; sha256: string }> {
  const objectKey = `${KEY_PREFIX}${randomUUID()}`;
  const bytes = Buffer.from(content, 'utf8');
  if (ctx.storeReady) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { s3 } = await import('../src/lib/s3');
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: objectKey, Body: bytes }));
  }
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES (${S3_BUCKET}, ${objectKey}, ${filename}, 'application/pdf', ${bytes.length},
            'active', ${userId})
    RETURNING id`);
  return {
    id: res.rows[0]!.id,
    objectKey,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Подшивка вложения ручкой портала — тем же путём, каким документы кладут люди. */
async function attach(requestId: string, fileId: string): Promise<void> {
  const res = await inject(
    'POST',
    `/api/v1/service-requests/${requestId}/files`,
    ctx.customer.auth,
    { fileIds: [fileId], kind: 'attachment' },
  );
  expect(res.statusCode, `подшивка вложения: ${res.body}`).toBe(200);
}

function quarantine(fileId: string, auth: Auth, body?: unknown): Promise<LightMyRequestResponse> {
  return inject('POST', `/api/v1/files/${fileId}/quarantine`, auth, body);
}

function release(fileId: string, auth: Auth, body?: unknown): Promise<LightMyRequestResponse> {
  return inject('POST', `/api/v1/files/${fileId}/quarantine/release`, auth, body);
}

describe.skipIf(!DB_URL)('карантин файла (Р6, п. 4)', () => {
  /** Два вложения ОДНОЙ заявки: первое уходит в карантин, второе остаётся мерой «как было». */
  let locked: { id: string; sha256: string };
  let neighbour: { id: string; sha256: string };

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    // Сперва уборка: упавший прогон оставляет учётки и площадку, а имена у них те же.
    await cleanup(db);

    const passwordHash = await hashPassword(PASSWORD);

    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const email = `db-fq-${input.tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${input.tag}, ${passwordHash},
                ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const digits = String(Date.now()).slice(-6);
    const counterpartyRow = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-FQ ${RUN}`}, ${innOf(`78${digits}0`)})
      RETURNING id`);
    const counterpartyId = counterpartyRow.rows[0]!.id;

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`FQ-${RUN}`}, ${`Тестовая площадка FQ ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const admin = await makeUser({ tag: 'admin', role: 'admin' });
    const customer = await makeUser({ tag: 'cust', role: 'shtab' });
    const keeper = await makeUser({ tag: 'keep', role: 'shtab' });
    const auditor = await makeUser({ tag: 'audit', role: 'mechanic' });
    const service = await makeUser({ tag: 'srv', role: 'operator', counterpartyId });

    // Заказчик и «Ведение» — на ОДНОЙ площадке: область обязана совпадать, иначе отказ по карантину
    // неотличим от отказа по области.
    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectId}), (${keeper.id}, ${objectId})`);

    // Надстройка «Ведение» — сервисом, а не прямым SQL: с шага 1a ADR 0106 выдача пишет две таблицы
    // одной транзакцией, и прямая вставка в одну из них оставила бы половину.
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, keeper.id, ['office_equipment_operator'], admin.id);
    });

    /*
     * Набор разбора — СВОИМ кодом, а не поставочным `files_quarantine_audit`: тот совместим с
     * `dispatcher` и `manager` (роли без оси, §«Роли» миграции 0308), а случаю нужна роль БЕЗ
     * доступа к модулю оргтехники — механик. Права набора считаются через гейт совместимости с
     * ролью, поэтому строка `grant_roles` обязательна: без неё держатель не получил бы ни одного
     * права, и все отказы ниже прошли бы «сами собой».
     */
    const grantRow = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, description, is_system, created_by)
      VALUES (${`fq-audit-${RUN}`}, ${`Файлы: разбор карантина ${RUN}`},
              'Набор прогона Р6 п. 4', false, ${admin.id})
      RETURNING id`);
    const grantId = grantRow.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      VALUES (${grantId}, 'files.quarantineAudit')`);
    await db.execute(sql`
      INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'mechanic'::role)`);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by)
      VALUES (${auditor.id}, ${grantId}, ${admin.id})`);

    const app = await buildApp();

    async function login(email: string): Promise<Auth> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    }
    const withAuth = async (u: { id: string; email: string }): Promise<TestUser> => ({
      ...u,
      auth: await login(u.email),
    });

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    // Бакет заводится здесь же: хранилище своё, и пустой контейнер MinIO о нём не знает. Неудача —
    // не падение прогона: без хранилища проверяется ветка «хеш посчитать не удалось».
    let storeReady = false;
    try {
      const { CreateBucketCommand, HeadBucketCommand } = await import('@aws-sdk/client-s3');
      const { s3 } = await import('../src/lib/s3');
      try {
        await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
      }
      storeReady = true;
    } catch {
      storeReady = false;
    }

    ctx = {
      app,
      db,
      closeDb,
      admin: await withAuth(admin),
      customer: await withAuth(customer),
      keeper: await withAuth(keeper),
      service: await withAuth(service),
      auditor: await withAuth(auditor),
      objectId,
      counterpartyId,
      typeId,
      storeReady,
    };

    const requestId = await createRequest('Не забирает бумагу из лотка');
    const first = await uploadedFile(customer.id, 'Паспорт_Иванова.pdf', `карантин ${RUN}`);
    const second = await uploadedFile(customer.id, 'Фото_лотка.pdf', `обычный ${RUN}`);
    await attach(requestId, first.id);
    await attach(requestId, second.id);
    await assignService(requestId);
    locked = { id: first.id, sha256: first.sha256 };
    neighbour = { id: second.id, sha256: second.sha256 };
  }, 180_000);

  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) await cleanup(ctx.db);
    await ctx?.closeDb();
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // 1. Оракул: до карантина файл открыт всем трём, а держателю права разбора — ни один
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('до карантина вложение открыто автору, исполнителю и «Ведению»', async () => {
    await expectOpen(locked.id, ctx.customer.auth, 'автору загрузки');
    await expectOpen(locked.id, ctx.service.auth, 'исполнителю');
    await expectOpen(locked.id, ctx.keeper.auth, '«Ведению»');
    // Держатель права разбора — механик: модуля оргтехники у него нет, и обычный файл ему закрыт.
    // Без этой строки «открылось по праву разбора» ниже объяснялось бы тем, что он и так всё видит.
    await expectHidden(locked.id, ctx.auditor.auth, 'держателю права разбора до карантина');
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // 2. Постановка: право и обязательная причина
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('постановка без причины отбивается, с пустой причиной — тоже', async () => {
    const empty = await quarantine(locked.id, ctx.auditor.auth, {});
    expect(empty.statusCode, empty.body).toBe(400);
    expect((empty.json() as { code?: string }).code).toBe('validation_error');

    const blank = await quarantine(locked.id, ctx.auditor.auth, { reason: '   ' });
    expect(blank.statusCode, blank.body).toBe(400);

    // И ни одна из двух попыток не поставила карантин: отказ формы не должен закрывать доступ
    // «наполовину» — иначе неудачный запрос прятал бы документ без записи о причине.
    expect((await fileRow(locked.id)).quarantinedAt).toBeNull();
    await expectOpen(locked.id, ctx.customer.auth, 'автору после отказанных попыток');
  });

  it('без права разбора карантин не поставить — ни автору файла, ни «Ведению»', async () => {
    for (const [who, auth] of [
      ['автор загрузки', ctx.customer.auth],
      ['«Ведение»', ctx.keeper.auth],
      ['исполнитель', ctx.service.auth],
    ] as const) {
      const res = await quarantine(locked.id, auth, { reason: `проверка ${who}` });
      expect(res.statusCode, `${who}: ${res.body}`).toBe(403);
    }
    expect((await fileRow(locked.id)).quarantinedAt).toBeNull();
  });

  it('держатель права ставит карантин: доступ закрыт, хеш посчитан, причина в журнале', async () => {
    const res = await quarantine(locked.id, ctx.auditor.auth, {
      reason: 'В карточку попал паспорт заявителя — обращение от 11.09.2026',
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      quarantined: boolean;
      quarantinedAt: string | null;
      contentHash: string | null;
    };
    expect(body.quarantined).toBe(true);
    expect(body.quarantinedAt).not.toBeNull();

    const row = await fileRow(locked.id);
    expect(row.quarantinedAt).not.toBeNull();

    /*
     * Хеш — ПОСЛЕ закрытия доступа, и пара «карантин ⇒ хеш есть» в базе не держится намеренно
     * (комментарий колонки `content_hash`). Поэтому проверяются обе ветки: с живым хранилищем хеш
     * равен sha256 содержимого, без него он пуст — но карантин в обоих случаях состоялся, и
     * отличает их журнал полем `hashComputed`, а не доступность файла.
     */
    if (ctx.storeReady) {
      expect(row.contentHash).toBe(locked.sha256);
      expect(body.contentHash).toBe(locked.sha256);
    } else {
      expect(row.contentHash).toBeNull();
    }

    const [record, ...extra] = await auditRows(locked.id, 'file.quarantine');
    expect(extra).toEqual([]);
    expect(record?.actorUserId).toBe(ctx.auditor.id);
    expect(record?.metadata.reason).toBe(
      'В карточку попал паспорт заявителя — обращение от 11.09.2026',
    );
    expect(record?.metadata.hashComputed).toBe(ctx.storeReady);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // 3. Главное утверждение: карантин бьёт раньше любой ветки видимости
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('карантинный файл не отдаётся ни автору, ни исполнителю, ни «Ведению» — 404', async () => {
    await expectHidden(locked.id, ctx.customer.auth, 'автору загрузки');
    await expectHidden(locked.id, ctx.service.auth, 'исполнителю');
    await expectHidden(locked.id, ctx.keeper.auth, '«Ведению»');

    /*
     * И это тот же ответ, что на файл, которого нет вовсе, — байт в байт. Отличайся они, перебор
     * идентификаторов отвечал бы на вопрос «а что там спрятали», не открыв ни одного документа.
     */
    const shape = (res: LightMyRequestResponse): Record<string, unknown> => {
      const body = res.json() as Record<string, unknown>;
      delete body.requestId;
      return { statusCode: res.statusCode, ...body };
    };
    expect(shape(await download(locked.id, ctx.customer.auth))).toEqual(
      shape(await download(randomUUID(), ctx.customer.auth)),
    );
  });

  it('имя карантинного файла не уходит и завершением загрузки', async () => {
    // Вторая ручка, отдающая имя файла (`toFileDto`), обязана ходить по тому же правилу: имя само
    // бывает персональными данными — «Паспорт_Иванова.pdf» остаётся утечкой и без содержимого.
    const res = await inject('POST', `/api/v1/files/${locked.id}/complete`, ctx.customer.auth);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.body).not.toContain('Паспорт_Иванова');
  });

  it('карантинный файл не уничтожается: удаление отбито', async () => {
    // Удаление ставит задачу на физическое снятие объекта из S3 — то есть уносит предмет разбора.
    // Отказ `409` и подшитому файлу, и самому автору: порядок — сперва снять карантин.
    const res = await inject('DELETE', `/api/v1/files/${locked.id}`, ctx.customer.auth);
    expect(res.statusCode, res.body).toBe(409);
    expect((await fileRow(locked.id)).quarantinedAt).not.toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // 4. Право разбора: содержимое отдаётся, и каждый доступ виден в журнале
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('держателю права разбора файл отдаётся, и каждое открытие пишется в журнал', async () => {
    await expectOpen(locked.id, ctx.auditor.auth, 'держателю права разбора');
    const first = await auditRows(locked.id, 'file.quarantine_access');
    expect(first).toHaveLength(1);
    expect(first[0]?.actorUserId).toBe(ctx.auditor.id);
    expect(first[0]?.metadata.filename).toBe('Паспорт_Иванова.pdf');
    if (ctx.storeReady) expect(first[0]?.metadata.contentHash).toBe(locked.sha256);

    // Запись НА КАЖДЫЙ доступ, а не одна на файл: сквозное право уравновешено только тем, что
    // видно, кто и сколько раз смотрел.
    await expectOpen(locked.id, ctx.auditor.auth, 'повторное открытие');
    expect(await auditRows(locked.id, 'file.quarantine_access')).toHaveLength(2);

    // Отказанные обращения в журнал не попадают: иначе лента «кто смотрел» наполнилась бы теми, кто
    // ничего не увидел.
    await expectHidden(locked.id, ctx.customer.auth, 'автору загрузки');
    expect(await auditRows(locked.id, 'file.quarantine_access')).toHaveLength(2);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // 5. Инвариант: обычный файл ведёт себя ровно как прежде
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('обычное вложение той же заявки карантин соседа не тронул', async () => {
    await expectOpen(neighbour.id, ctx.customer.auth, 'автору');
    await expectOpen(neighbour.id, ctx.service.auth, 'исполнителю');
    await expectOpen(neighbour.id, ctx.keeper.auth, '«Ведению»');
    // Держателю права разбора — по-прежнему 404: право открывает карантинное, а не всё подряд.
    await expectHidden(neighbour.id, ctx.auditor.auth, 'держателю права разбора');
    const row = await fileRow(neighbour.id);
    expect(row.quarantinedAt).toBeNull();
    expect(row.contentHash).toBeNull();
  });

  it('не карантинный файл удаляется как прежде, а снятие карантина — отдельное событие', async () => {
    // Ничей файл, не подшитый никуда: его удаляет автор загрузки — ровно как до этой волны.
    const loose = await uploadedFile(ctx.customer.id, 'Черновик.pdf', `черновик ${RUN}`);
    const ok = await inject('DELETE', `/api/v1/files/${loose.id}`, ctx.customer.auth);
    expect(ok.statusCode, ok.body).toBe(200);

    // Снять карантин с файла, который в нём не стоит, нельзя: иначе в журнале появилась бы причина
    // снятия того, чего не было.
    const second = await uploadedFile(ctx.customer.id, 'Второй_черновик.pdf', `второй ${RUN}`);
    const notQuarantined = await release(second.id, ctx.auditor.auth, { reason: 'ошибка' });
    expect(notQuarantined.statusCode, notQuarantined.body).toBe(409);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // 6. Снятие: доступ возвращается, след остаётся
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('снятие карантина требует причины и возвращает доступ', async () => {
    const blank = await release(locked.id, ctx.auditor.auth, {});
    expect(blank.statusCode, blank.body).toBe(400);
    // Отказанное снятие доступ не открыло: иначе ошибка формы открывала бы документ молча.
    await expectHidden(locked.id, ctx.customer.auth, 'автору после отказанного снятия');

    const res = await release(locked.id, ctx.auditor.auth, {
      reason: 'Обращение отозвано: документ относится к заявке, проверено 11.09.2026',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { quarantined: boolean }).quarantined).toBe(false);

    await expectOpen(locked.id, ctx.customer.auth, 'автору после снятия');
    await expectOpen(locked.id, ctx.service.auth, 'исполнителю после снятия');
    await expectOpen(locked.id, ctx.keeper.auth, '«Ведению» после снятия');
    // А держателю права разбора — снова 404: файл вышел из карантина, и право на него больше не
    // распространяется.
    await expectHidden(locked.id, ctx.auditor.auth, 'держателю права после снятия');

    const [record] = await auditRows(locked.id, 'file.quarantine_release');
    expect(record?.actorUserId).toBe(ctx.auditor.id);
    expect(record?.metadata.reason).toBe(
      'Обращение отозвано: документ относится к заявке, проверено 11.09.2026',
    );

    /*
     * Хеш после снятия ОСТАЁТСЯ: он доказывает, какое содержимое было закрыто, и после снятия
     * остаётся единственным следом того, что разбор вообще был. Стёртый хеш превратил бы
     * «доказательство скрывали по обращению» в «ничего не происходило».
     */
    if (ctx.storeReady) expect((await fileRow(locked.id)).contentHash).toBe(locked.sha256);
  });
});
