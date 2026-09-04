import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SERVICE_FILE_KINDS,
  type ServiceFileKind,
  type ServiceRequestDto,
  visibleServiceFileKinds,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Прямая ссылка на документ заявки на обслуживание оргтехники — §7.3 плана
 * `docs/office-equipment-requester-card-plan.md` (ADR 0160, решения Р7/Р8).
 *
 * ЧТО ДОКАЗЫВАЕТСЯ. Заявитель не скачивает счёт, акт и объём работ заявки СВОЕЙ области по прямой
 * ссылке `GET /files/:id/download` — при том, что сама заявка ему видна законно, и вложение с
 * гарантийным талоном из неё открываются. Это главная дыра плана: карточка режет список файлов
 * проекцией DTO, а ссылка ведёт мимо карточки и до Р8 отдавала любой подшитый документ всякому,
 * кому видна заявка.
 *
 * ЗАЧЕМ БАЗА. Предмет проверки — SQL-условие: вид документа ушёл в тот же запрос, где считаются
 * область и сторона (`serviceFileKindWhere` в `routes/files.ts`), и вопрос звучит «есть ли ВИДИМАЯ
 * связь», а не «видима ли первая найденная». Ни аудиторию, ни «видимую связь» на подменах спросить
 * нельзя: аудитория складывается из права и строки `service_request_executors`, перечитываемых
 * `loadPrincipal` на каждом запросе, а «первая найденная связь» существует только там, где у файла
 * есть две строки в `service_request_files` — то есть в базе.
 *
 * ГРАНИЦЫ. Проекция DTO, список файлов карточки, история и подшивка — §7.1 и §7.2, свои файлы;
 * решение о доступе как чистая функция — `file-access.test.ts`; полнота перечня таблиц привязки —
 * `file-linkage.db.test.ts`. Здесь только прямая ссылка и только оргтехника: остальные модули этой
 * веткой не меняются, и проверяют их `mech-files.db.test.ts`, `auto-part-receipts.db.test.ts`,
 * `ticket-audit-scan.db.test.ts` — каждый своим файлом.
 *
 * Запуск (база общая, поэтому только этот файл):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_blank_test \
 *     pnpm --filter @technic/api test -- service-request-file-access.db
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: база общая и переживает прогоны, а уборка ищет своё по нему. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
/** Префикс ключей объектов: по нему же уборка находит файлы, включая оставленные падением. */
const KEY_PREFIX = `srfa/${RUN}/`;

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
  /** Администратор: заводит технику, распределяет заявки и удаляет заявку в архив. */
  admin: TestUser;
  /** Заказчик площадки A — аудитория `requester`, ради которой написан план. */
  customer: TestUser;
  /** «Ведение» площадки A: надстройка `office_equipment_operator` даёт `serviceRequests.finance`. */
  operator: TestUser;
  /** Оператор назначенной сервисной компании: сторона исполнителя, аудитория `finance`. */
  service: TestUser;
  /**
   * Внутренний исполнитель площадки A: `serviceRequests.execute` без `.finance`. Деньги ему
   * открывает НАЗНАЧЕНИЕ, и только на той заявке, где он назначен (§7.3.8).
   */
  executor: TestUser;
  /**
   * Держатель `archive.read` без `.finance` — «Архивариус» §7.3.7. Аудитория у него `requester`:
   * архив открывает удалённую заявку, а не закрытые виды документов.
   */
  archivist: TestUser;
  objectId: string;
  counterpartyId: string;
  typeId: string;
  executorGrantId: string;
  archiveGrantId: string;
  /** Заявка с полным набором из пяти видов документов — общий вход случаев 1–4 и 8. */
  main: { id: string; files: Record<ServiceFileKind, string> };
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
  // Ссылка на скачивание подписывается локально, в хранилище никто не ходит: заглушки нерабочие
  // намеренно — предмет проверки решение о доступе, а не S3.
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

/** Свой адрес на каждое обращение: и вход, и общий ограничитель считают запросы по адресу. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/**
 * Десятизначный ИНН по девяти цифрам основы. Настоящая контрольная сумма, а не «77…01»: пока идёт
 * прогон, контрагент лежит в общей базе, а обмен справочниками выгружает её целиком и на
 * выдуманном ИНН падает — падение выглядело бы дефектом чужого модуля.
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

/** Ссылка на файл — единственная ручка, ради которой написан файл. */
function download(fileId: string, auth: Auth): Promise<LightMyRequestResponse> {
  return inject('GET', `/api/v1/files/${fileId}/download`, auth);
}

/**
 * Отказ по прямой ссылке — `404`, а не `403` (Р8): разные коды на «нет такого файла» и «есть, но
 * не тебе» работают оракулом — перебрав идентификаторы, по одному коду ответа читается, сколько у
 * заявки счетов. Проверяется и текст: `404` от стража маршрута или от опечатки в адресе выглядел
 * бы так же, а означал бы, что случай ничего не доказал.
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

/**
 * Уборка своих строк — и ПЕРЕД прогоном тоже, как в `mech-files.db.test.ts`.
 *
 * Опознаётся всё общим для файла префиксом `SRFA`, а не суффиксом одного прогона, и это не
 * небрежность: упавшая `beforeAll` (например, на середине заведения учёток) оставляет мусор, до
 * которого суффиксная уборка следующего прогона не дотянется — он ищет СВОЙ суффикс. База общая, и
 * такой мусор копится молча, пока чужой тест не споткнётся о лишнюю учётку в выборке.
 *
 * Отдельной функцией, а не телом `afterAll`: та зовётся с уже собранным `ctx`, которого при падении
 * подготовки нет вовсе. Порядок задан внешними ключами: задачи и заявки (за ними каскадом связи с
 * файлами), техника, модели, файлы, журнал, учётки, наборы, контрагент и только в конце площадка —
 * её держит `RESTRICT`.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const users = sql`SELECT id FROM users WHERE email LIKE 'db-srfa-%'`;
  const equipment = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE 'SRFA-%'`;
  await db.execute(sql`DELETE FROM jobs WHERE payload->>'objectKey' LIKE 'srfa/%'`);
  await db.execute(sql`
    DELETE FROM service_requests
     WHERE office_equipment_id IN (${equipment}) OR created_by IN (${users})`);
  await db.execute(sql`DELETE FROM office_equipment WHERE inventory_number LIKE 'SRFA-%'`);
  // Модель, заведённую карточкой (миграция 0171: карточка без `model_id` заводит строку сама),
  // удаление техники за собой не уносит. Условие «на неё никто не ссылается» обязательно: имя
  // модели общее с боевым справочником, и метка `SRFA` стоит в нём только у наших.
  await db.execute(sql`
    DELETE FROM office_equipment_models m
     WHERE m.name LIKE '%SRFA-%'
       AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE 'srfa/%'`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE 'db-srfa-%'`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE 'srfa-%'`);
  await db.execute(sql`DELETE FROM counterparties WHERE name LIKE 'Сервис-SRFA %'`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code LIKE 'SRFA-%'`);
}

// ── Подготовка данных ──

async function version(id: string, auth: Auth = ctx.admin.auth): Promise<number> {
  const res = await inject('GET', `/api/v1/service-requests/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as ServiceRequestDto).version;
}

let unitNo = 0;

/**
 * Своя единица под каждую заявку: по технике разрешена одна открытая заявка (Р21), и общая единица
 * заперла бы вторую же заявку файла.
 */
async function makeEquipment(): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: ctx.typeId,
    name: `Kyocera ECOSYS M3145 SRFA-${RUN}`,
    inventoryNumber: `SRFA-${RUN}-${unitNo}`,
    objectId: ctx.objectId,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Заявка заказчика на свежей единице — общий вход всех случаев. */
async function createRequest(description: string): Promise<string> {
  const res = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
    officeEquipmentId: await makeEquipment(),
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { request: ServiceRequestDto }).request.id;
}

/**
 * Состав исполнителей: назначает администратор — коридор назначения не предмет этого файла.
 *
 * `reason` — не украшение: первое назначение причины не требует, а переназначение и снятие требуют
 * (у прежнего исполнителя отбирают работу), и без неё запрос упирался бы в 422 формы.
 */
async function assign(
  id: string,
  input: { userIds?: string[]; serviceCounterpartyId?: string | null; reason?: string },
): Promise<void> {
  const res = await inject('PUT', `/api/v1/service-requests/${id}/executors`, ctx.admin.auth, {
    userIds: input.userIds ?? [],
    serviceCounterpartyId: input.serviceCounterpartyId ?? null,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    version: await version(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

/**
 * «Принять в работу» — статус, в котором принимаются ВСЕ пять видов документов
 * (`SERVICE_FILE_KIND_POLICY`): в нём и собираются заявки этого файла, чтобы вид документа
 * закрывался аудиторией, а не подходящестью статуса.
 */
async function start(id: string, user: TestUser): Promise<void> {
  const res = await inject('PATCH', `/api/v1/service-requests/${id}/start`, user.auth, {
    version: await version(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

/**
 * Загруженный файл строкой в `files`. Настоящая загрузка идёт через presign в S3, которого в тесте
 * нет, а предмет проверки — доступ к документу, а не транспорт. Статус `active`: ссылка отдаётся
 * только по завершённой загрузке, и подшивка ручкой всё равно доводит строку до него сама.
 */
async function uploadedFile(userId: string, filename: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`${KEY_PREFIX}${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            'active', ${userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

/** Подшивка документа ручкой портала — тем же путём, каким документы кладут люди. */
async function attach(id: string, kind: ServiceFileKind, user: TestUser): Promise<string> {
  const fileId = await uploadedFile(user.id, `${kind}-${randomUUID()}.pdf`);
  const res = await inject('POST', `/api/v1/service-requests/${id}/files`, user.auth, {
    fileIds: [fileId],
    kind,
  });
  expect(res.statusCode, `подшивка «${kind}»: ${res.body}`).toBe(200);
  return fileId;
}

/**
 * Связь файла с заявкой строкой таблицы — в обход ручки подшивки, и это не срез угла.
 *
 * Ручка кладёт только файл, загруженный САМИМ обращающимся и не привязанный никуда
 * (`assertFilesAttachable`), а случаи §7.3.5 и §7.3.6 состоят ровно в обратном: чужой файл,
 * подшитый закрытым видом, и один файл в двух заявках. Собрать такое состояние ручкой нечем, а
 * проверяется по нему не подшивка, а чтение — то, как `canAccessFile` разбирает УЖЕ сложившиеся
 * строки.
 */
async function link(
  requestId: string,
  fileId: string,
  kind: ServiceFileKind,
  byUserId: string,
): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO service_request_files (request_id, file_id, kind, attached_by)
    VALUES (${requestId}::uuid, ${fileId}::uuid, ${kind}, ${byUserId}::uuid)`);
}

/** Заявка «В работе» с полным набором из пяти видов документов. */
async function requestWithAllKinds(
  description: string,
): Promise<{ id: string; files: Record<ServiceFileKind, string> }> {
  const id = await createRequest(description);
  // Вложение кладёт САМ заказчик, и в «Новой»: §7.3.3 спрашивает про «своё вложение», а своим оно
  // бывает только у того, кто его и загрузил.
  const attachment = await attach(id, 'attachment', ctx.customer);
  await assign(id, { serviceCounterpartyId: ctx.counterpartyId });
  await start(id, ctx.service);
  const estimate = await attach(id, 'estimate', ctx.service);
  const act = await attach(id, 'act', ctx.service);
  const invoice = await attach(id, 'invoice', ctx.service);
  const warrantyCard = await attach(id, 'warranty_card', ctx.service);
  return { id, files: { attachment, estimate, act, invoice, warranty_card: warrantyCard } };
}

describe.skipIf(!DB_URL)('прямая ссылка на документ заявки оргтехники (§7.3)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    // Сперва уборка: упавший прогон оставляет учётки и площадку, а имена у них те же.
    await cleanup(db);

    const passwordHash = await hashPassword(PASSWORD);

    // Учётки, контрагент и площадка заводятся SQL: форма учётки и справочник контрагентов —
    // предмет своих тестов, здесь они декорации, без которых не разложить аудитории.
    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const email = `db-srfa-${input.tag}-${RUN}@example.invalid`;
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
      VALUES ('service'::counterparty_type, ${`Сервис-SRFA ${RUN}`}, ${innOf(`79${digits}0`)})
      RETURNING id`);
    const counterpartyId = counterpartyRow.rows[0]!.id;

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`SRFA-${RUN}`}, ${`Тестовая площадка SRFA ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const admin = await makeUser({ tag: 'admin', role: 'admin' });
    const customer = await makeUser({ tag: 'cust', role: 'shtab' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const executor = await makeUser({ tag: 'exec', role: 'shtab' });
    const archivist = await makeUser({ tag: 'arch', role: 'shtab' });
    const service = await makeUser({ tag: 'srv', role: 'operator', counterpartyId });

    // Все внутренние — на ОДНОЙ площадке: область должна совпадать у всех, иначе отказ по виду
    // документа неотличим от отказа по области, и случай не доказывал бы ничего.
    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectId}), (${operator.id}, ${objectId}),
             (${executor.id}, ${objectId}), (${archivist.id}, ${objectId})`);

    // Надстройка «Ведение» — сервисом, а не прямым SQL: с шага 1a перехода на назначаемые
    // полномочия (ADR 0106) выдача пишет две таблицы одной транзакцией, и прямая вставка в одну из
    // них оставила бы половину — оператор молча остался бы без прав.
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], admin.id);
    });

    /**
     * Наборы прогона — СВОИМИ кодами, а не системными. Причина та же, что в
     * `service-executor-access.db.test.ts`: у системных наборов модуля сквозная область
     * (`GRANT_MODULE_WIDE_SCOPE`), и держатель видел бы заявки всей компании — область перестала бы
     * быть одинаковой у всех участников, а именно на этом равенстве держится смысл каждого отказа.
     *
     * Роль в `grant_roles` обязательна: права набора считаются через гейт совместимости с ролью, и
     * без строки `shtab` учётки не получили бы ни одного права.
     */
    async function makeGrant(code: string, name: string, permissions: string[]): Promise<string> {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO grants (code, name, description, is_system, created_by)
        VALUES (${code}, ${name}, 'Набор прогона §7.3', false, ${admin.id})
        RETURNING id`);
      const grantId = row.rows[0]!.id;
      // Перечень разворачивается в отдельные параметры (`sql.join`), а не уходит массивом: drizzle
      // подставляет массив кортежем `($1, $2, $3)`, и `unnest` такого не принимает.
      await db.execute(sql`
        INSERT INTO grant_permissions (grant_id, permission)
        SELECT ${grantId}, permission
        FROM unnest(ARRAY[${sql.join(
          permissions.map((permission) => sql`${permission}`),
          sql`, `,
        )}]::text[]) AS permission`);
      await db.execute(sql`
        INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'shtab'::role)`);
      return grantId;
    }

    // Внутренний исполнитель: читает, исполняет, подшивает — и НЕ держит `serviceRequests.finance`.
    // Деньги ему открывает назначение, и ровно этим он отличается от «Ведения» (§7.3.8).
    const executorGrantId = await makeGrant(`srfa-exec-${RUN}`, `Оргтехника: исполнитель ${RUN}`, [
      'serviceRequests.read',
      'serviceRequests.execute',
      'serviceRequests.files',
    ]);
    // «Архивариус»: удалённые записи и ничего сверх. `archive.read` входных прав не требует
    // (`PERMISSION_REQUIRES`), чтение модуля добавлено потому, что без него он не дошёл бы до
    // ветки заявок вовсе.
    const archiveGrantId = await makeGrant(`srfa-arch-${RUN}`, `Архивариус ${RUN}`, [
      'serviceRequests.read',
      'archive.read',
    ]);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by)
      VALUES (${executor.id}, ${executorGrantId}, ${admin.id}),
             (${archivist.id}, ${archiveGrantId}, ${admin.id})`);

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

    ctx = {
      app,
      db,
      closeDb,
      admin: await withAuth(admin),
      customer: await withAuth(customer),
      operator: await withAuth(operator),
      service: await withAuth(service),
      executor: await withAuth(executor),
      archivist: await withAuth(archivist),
      objectId,
      counterpartyId,
      typeId,
      executorGrantId,
      archiveGrantId,
      main: { id: '', files: {} as Record<ServiceFileKind, string> },
    };
    ctx.main = await requestWithAllKinds('Не забирает бумагу из лотка');
  }, 120_000);

  /** База общая и живёт между прогонами, поэтому файл уносит ровно то, что завёл сам. */
  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) await cleanup(ctx.db);
    await ctx?.closeDb();
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // §7.3.1–§7.3.3. Заказчик своей заявки: деньги закрыты, своё открыто
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('§7.3.1 счёт заявки своей области заказчику — 404', async () => {
    await expectHidden(ctx.main.files.invoice, ctx.customer.auth, 'счёт заказчику');

    /*
     * И это тот же самый ответ, что на файл, которого нет вовсе, — байт в байт. В этом весь смысл
     * `404` вместо `403` (Р8): отличайся они, перебор идентификаторов отвечал бы на вопрос «а
     * сколько у моей заявки счетов», не открыв ни одного документа. Утверждение проверяемо только
     * сравнением с настоящим «нет такого файла», и потому оно стоит здесь, а не в комментарии.
     */
    const missing = await download(randomUUID(), ctx.customer.auth);
    const hidden = await download(ctx.main.files.invoice, ctx.customer.auth);
    // Всё, кроме идентификатора обращения: он свой у каждого запроса и различает не ответы, а их.
    const shape = (res: LightMyRequestResponse): Record<string, unknown> => {
      const body = res.json() as Record<string, unknown>;
      delete body.requestId;
      return { statusCode: res.statusCode, ...body };
    };
    expect(shape(hidden)).toEqual(shape(missing));
  });

  it('§7.3.2 акт и объём работ заказчику — 404', async () => {
    await expectHidden(ctx.main.files.act, ctx.customer.auth, 'акт заказчику');
    await expectHidden(ctx.main.files.estimate, ctx.customer.auth, 'объём работ заказчику');
  });

  it('§7.3.3 своё вложение и гарантийный талон заказчику — 200 и ссылка', async () => {
    /*
     * Этот случай — оракул трёх предыдущих. Заявка у заказчика ОДНА И ТА ЖЕ, право `.read` одно и
     * то же, область одна и та же: разница между 404 выше и 200 здесь может быть только в виде
     * документа. Не будь его, три отказа выше одинаково хорошо объяснялись бы сломанной фикстурой.
     */
    await expectOpen(ctx.main.files.attachment, ctx.customer.auth, 'своё вложение заказчику');
    await expectOpen(
      ctx.main.files.warranty_card,
      ctx.customer.auth,
      'гарантийный талон заказчику',
    );
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // §7.3.4. Аудитория `finance`: ничего не потеряно
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('§7.3.4 «Ведению» и сервисной компании открыты все пять видов', async () => {
    // Перечень берётся из контрактов, а не переписывается: новый вид документа обязан появиться
    // здесь сам и потребовать решения, а не молча остаться непроверенным.
    expect(visibleServiceFileKinds('finance')).toEqual([...SERVICE_FILE_KINDS]);
    for (const kind of SERVICE_FILE_KINDS) {
      await expectOpen(ctx.main.files[kind], ctx.operator.auth, `«Ведению» вид «${kind}»`);
      await expectOpen(ctx.main.files[kind], ctx.service.auth, `сервису вид «${kind}»`);
    }
    // Обратная половина того же утверждения: заявителю из пяти видов открыты ровно два, и перечень
    // у прямой ссылки тот же, которым режется список файлов карточки (Р7).
    expect(visibleServiceFileKinds('requester')).toEqual(['attachment', 'warranty_card']);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // §7.3.5. Ветка авторства не обходит вид документа
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('§7.3.5 свой же файл, подшитый счётом, заказчику больше не открывается', async () => {
    const fileId = await uploadedFile(ctx.customer.id, `svoy-schet-${randomUUID()}.pdf`);
    /*
     * До подшивки файл открыт — и это половина случая: ветка авторства (`decideFileAccess`)
     * работает на файле, НЕ привязанном никуда, и без этой строки 404 ниже объяснялся бы тем, что
     * автор не открывает свой файл вообще. Такой отказ ничего не говорил бы о виде документа.
     */
    await expectOpen(fileId, ctx.customer.auth, 'свой непривязанный файл');

    await link(ctx.main.id, fileId, 'invoice', ctx.admin.id);
    await expectHidden(fileId, ctx.customer.auth, 'свой файл, подшитый счётом');
    // А «Ведение» его открывает: файл цел и подшит правильно — закрыт он именно заказчику.
    await expectOpen(fileId, ctx.operator.auth, 'тот же счёт «Ведению»');
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // §7.3.6. Решает ВИДИМАЯ связь, а не первая найденная
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('§7.3.6 файл в двух заявках: доступ решает видимая связь, а не первая найденная', async () => {
    const second = await createRequest('Вторая заявка той же площадки');

    /*
     * Две пары связей, различающиеся ТОЛЬКО порядком вставки. `LIMIT 1` без сортировки берёт любую
     * строку, и разбор вида документа ПОСЛЕ выборки давал бы верный ответ ровно в половине случаев
     * — в той, где первой легла видимая связь. Одна пара такую ошибку не поймала бы: она прошла бы
     * или упала целиком, в зависимости от того, как легли строки.
     */
    const hiddenFirst = await uploadedFile(ctx.customer.id, `pervyy-schet-${randomUUID()}.pdf`);
    await link(ctx.main.id, hiddenFirst, 'invoice', ctx.admin.id);
    await link(second, hiddenFirst, 'attachment', ctx.customer.id);

    const visibleFirst = await uploadedFile(
      ctx.customer.id,
      `pervoe-vlozhenie-${randomUUID()}.pdf`,
    );
    await link(second, visibleFirst, 'attachment', ctx.customer.id);
    await link(ctx.main.id, visibleFirst, 'invoice', ctx.admin.id);

    await expectOpen(hiddenFirst, ctx.customer.auth, 'счёт в одной заявке, вложение в другой');
    await expectOpen(visibleFirst, ctx.customer.auth, 'вложение в одной заявке, счёт в другой');

    // И обратный полюс: две связи, обе закрытых, — «где-нибудь да видно» не работает.
    const bothHidden = await uploadedFile(ctx.customer.id, `dva-zakrytykh-${randomUUID()}.pdf`);
    await link(ctx.main.id, bothHidden, 'invoice', ctx.admin.id);
    await link(second, bothHidden, 'act', ctx.admin.id);
    await expectHidden(bothHidden, ctx.customer.auth, 'счёт и акт в двух заявках');
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // §7.3.7. Архив приоткрыт праву, а не всем
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('§7.3.7 архивная заявка: заказчику закрыта целиком, «Архивариусу» — по видам', async () => {
    const archived = await requestWithAllKinds('Заявка, удалённая в архив');
    // До архива вложение заказчику открыто — иначе отказ ниже нечем было бы отличить от отказа по
    // виду документа.
    await expectOpen(archived.files.attachment, ctx.customer.auth, 'вложение живой заявки');

    const deleted = await inject(
      'DELETE',
      `/api/v1/service-requests/${archived.id}`,
      ctx.admin.auth,
    );
    expect(deleted.statusCode, deleted.body).toBe(200);

    // Заказчику закрыто ВСЁ, включая собственное вложение: архив открывает право, которого у него
    // нет, и «моё вложение» после удаления заявки перестаёт быть аргументом.
    await expectHidden(archived.files.attachment, ctx.customer.auth, 'вложение архивной заявки');
    await expectHidden(archived.files.invoice, ctx.customer.auth, 'счёт архивной заявки');

    // Держателю `archive.read` без `.finance` — ровно перечень его аудитории: вкладка «Архив»
    // показывает вложение, и оно обязано скачиваться; счёт остаётся закрытым и в архиве.
    await expectOpen(
      archived.files.attachment,
      ctx.archivist.auth,
      'вложение архивной заявки «Архивариусу»',
    );
    await expectOpen(
      archived.files.warranty_card,
      ctx.archivist.auth,
      'гарантийный талон архивной заявки «Архивариусу»',
    );
    await expectHidden(
      archived.files.invoice,
      ctx.archivist.auth,
      'счёт архивной заявки «Архивариусу»',
    );
    await expectHidden(archived.files.act, ctx.archivist.auth, 'акт архивной заявки «Архивариусу»');
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // §7.3.8. Назначение открывает деньги одной заявки — и ровно на срок назначения
  // ────────────────────────────────────────────────────────────────────────────────────────────

  it('§7.3.8 назначенный исполнитель открывает счёт своей заявки и только её', async () => {
    const own = await createRequest('Заявка внутреннего исполнителя');
    await assign(own, { userIds: [ctx.executor.id] });
    await start(own, ctx.executor);
    const ownInvoice = await attach(own, 'invoice', ctx.executor);

    // Своя заявка: назначение — единственный источник аудитории `finance`, права `.finance` у
    // учётки нет вовсе.
    await expectOpen(ownInvoice, ctx.executor.auth, 'счёт своей заявки исполнителю');

    /*
     * Соседняя заявка ТОЙ ЖЕ площадки, назначенная подрядчику: счёт закрыт, а вложение открыто.
     * Пара обязательна — без вложения отказ по счёту объяснялся бы невидимостью самой заявки, и
     * случай перестал бы говорить про аудиторию.
     */
    await expectHidden(ctx.main.files.invoice, ctx.executor.auth, 'счёт чужой заявки исполнителю');
    await expectOpen(
      ctx.main.files.attachment,
      ctx.executor.auth,
      'вложение чужой заявки исполнителю',
    );

    /*
     * Снятие назначения закрывает и первый счёт — тем же токеном, без перелогина: аудитория
     * считается на каждом запросе, а не запекается во вход.
     *
     * Снимается исполнитель ПЕРЕДАЧЕЙ подрядчику, а не пустым составом: взятую в работу заявку
     * нельзя оставить вовсе без исполнителя (422 «Назначьте хотя бы одного»), и «сняли» на практике
     * означает «отдали другому». Для проверки важно единственное — что поимённой строки у этой
     * учётки больше нет.
     */
    await assign(own, {
      userIds: [],
      serviceCounterpartyId: ctx.counterpartyId,
      reason: 'ремонт передан подрядчику',
    });
    await expectHidden(ownInvoice, ctx.executor.auth, 'счёт после снятия назначения');
    // Сама заявка при этом ему по-прежнему видна — она на его площадке: 404 выше означает «деньги
    // закрыты», а не «заявка пропала из области».
    const stillReadable = await inject('GET', `/api/v1/service-requests/${own}`, ctx.executor.auth);
    expect(stillReadable.statusCode, stillReadable.body).toBe(200);
  });
});
