import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  type ServiceRequestDto,
  type ServiceWarrantyRowDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import {
  SERVICE_ACCESS_MANIFEST,
  type ServiceManifestRouteKey,
} from '../src/lib/service-access-manifest';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Отрицательные тесты доступа к заявкам на обслуживание оргтехники — этап Э2 плана
 * `docs/office-equipment-executor-access-audit-plan.md` (§6).
 *
 * ЭТАП НИЧЕГО НЕ ЧИНИТ. Он фиксирует СЕГОДНЯШНЕЕ поведение сервера и делает проверяемым каждое
 * правило §6: кто действует по заявке, на каком основании и чем именно его останавливают.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕТ НИ ОДНОГО `it.fails`. Замысел Э2 был другим: случай, который проходит там, где
 * по инвариантам И1–И4 обязан отказывать, помечался `it.fails` и назывался находкой вместе с
 * этапом, который её закроет; ожидалось, что так помечены Н1.2, Н2, Н3, Н8 (`notify`) и Н9. К
 * первому прогону не воспроизводится НИ ОДНА из пяти — часть закрыта соседними волнами, часть
 * оказалась недостижимой по построению. Что именно случилось с каждой, написано в комментарии к её
 * случаю; здесь важно, что все случаи файла требуют ПРАВИЛЬНОГО поведения и получают его.
 *
 * ЕСЛИ НАХОДКА ВЕРНЁТСЯ, пометка заводится обратно — но заводится с оглядкой. `it.fails` зелёный
 * при ЛЮБОМ падении, в том числе по чужой причине: сломанная фикстура, 422 вместо 200, опечатка в
 * теле. Такой случай молча перестаёт доказывать то, ради чего написан, и в этом файле так и вышло
 * дважды: §6.6 и §6.13 «падали как надо», пока падали на собственной фикстуре — первый не мог
 * назначить исполнителем учётку, у которой сосед по файлу уже отобрал набор, второй не умел
 * переназначать без причины. Обнаружилось это не чтением, а прогоном с фактическим ответом
 * сервера. Пометке поэтому обязателен способ увидеть ОТВЕТ, а не только «упало».
 *
 * ЗАЧЕМ БАЗА. Предмет проверки — область и сторона, а обе они складываются из строк: назначенный
 * контрагент лежит в колонке заявки, поимённое назначение — в `service_request_executors`, право —
 * в наборах учётки, перечитываемых `loadPrincipal` на КАЖДОМ запросе. Инвариант И3 («отзыв
 * прекращает доступ тем же токеном, без перелогина») на моках не виден вовсе: он держится именно
 * тем, что права не кэшируются в JWT. Гонка §6.12 — это две транзакции над одной строкой.
 *
 * ЧЕГО ЗДЕСЬ НЕТ НАМЕРЕННО. Сценарии §6, уже доказанные соседними файлами, не переписываются —
 * на них стоят ссылки в комментариях к своим блокам:
 *
 *   • §6.7 («Новую» нераспределённую сервис не видит) — `service-request-flow.db.test.ts`,
 *     случай «„Новую“ заявку сервис не видит: исполнителя в ней ещё нет»;
 *   • §6.9 в части «сервис не согласует смету, не принимает работу и не отменяет заявку» — там же;
 *   • отказ постороннего держателя набора на ходах исполнителя — там же, блок «поимённый
 *     исполнитель ведёт заявку набором „Оргтехника: ИТ-служба“».
 *
 * Запуск (база общая, поэтому только этот файл и в один поток):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/service-executor-access.db.test.ts --maxWorkers=1
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: база общая и переживает прогоны, а уборка ищет своё по нему. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

/** День закрытия работ — сегодня по Москве: сервер отсчитывает от него гарантии строк. */
const TODAY = moscowDateKeyOf(new Date());

/**
 * Заголовок входа. Псевдонимом, а не `interface`: заголовки `inject` — тип с индексной подписью, и
 * интерфейс без неё туда не присваивается (у псевдонима подпись выводится неявно).
 */
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
  /** Администратор: заводит технику, распределяет заявки обеих площадок и согласует объём работ. */
  admin: TestUser;
  /** Заказчик площадки A: заводит заявки и остаётся стороной `customer`. */
  customer: TestUser;
  /** «Ведение» площадки A: набор `office_equipment_operator` поверх роли штаба (ADR 0086). */
  operator: TestUser;
  /**
   * Внутренний исполнитель площадки A: роль `shtab` плюс прогонный набор с
   * `serviceRequests.execute`. Сквозной области у прогонного набора нет (`GRANT_MODULE_WIDE_SCOPE`
   * знает только системные коды) — то есть это ровно тот субъект, о котором говорит Н1: право
   * исполнять есть, область осталась своей.
   */
  executor: TestUser;
  /** Тот же набор, но не назначенный ни на что: без него отказ назначенному неотличим от отказа всем. */
  strayExecutor: TestUser;
  /**
   * Третья учётка с тем же набором — та, у которой набор ОТБИРАЮТ в §6.4. Отдельная, а не
   * `executor`: отзыв набора действует немедленно и на все последующие случаи файла, и делённая с
   * кем-то учётка сделала бы порядок тестов частью проверки.
   */
  revokedExecutor: TestUser;
  /**
   * Четвёртая — под §6.6, и заведена она по той же причине, по которой заведена третья.
   * Делить её с §6.4 было нельзя: тот отбирает набор первым, а `resolveNamedExecutors` не назначает
   * исполнителем учётку без `serviceRequests.execute` — §6.6 падал бы на СОБСТВЕННОЙ фикстуре
   * («у учётки нет такого полномочия»), и `it.fails` показывал бы это падение зелёным, то есть
   * ровно тем обманом, от которого предостерегает шапка файла: `it.fails` зелён при любом падении,
   * в том числе при падении фикстуры.
   */
  revokedChatExecutor: TestUser;
  /**
   * Пятая учётка с тем же набором — под гонку Р7: набор у неё отбирают, пока запрос на назначение
   * уже стоит в очереди за блокировкой заявки. Отдельная по той же причине, что третья и
   * четвёртая: отзыв необратим, и делённая учётка сделала бы порядок случаев частью проверки.
   */
  raceExecutor: TestUser;
  /**
   * Держатель ФИНАНСОВОЙ АУДИТОРИИ без стороны — ИТ-служба в том виде, в каком она и живёт в
   * каталоге: `serviceRequests.finance` выдан набором на всю компанию, `execute` есть, а
   * `serviceRequests.status` («Ведение») ей не выдают, и поимённо на заявку её не ставили. Ровно
   * этим субъектом и проверяется остаток находки Н2: аудитория открывает деньги, но не бумагу.
   */
  itService: TestUser;
  /** Штаб площадки B: ею проверяется чужая область у внутреннего сотрудника. */
  foreignShtab: TestUser;
  /** Оператор подрядчика A. */
  serviceA: TestUser;
  /** Оператор подрядчика B: ему не назначено ничего — второй подрядчик и есть предмет §6.8. */
  serviceB: TestUser;
  /** Сотрудник отдела A: вторая ось области заказчика, у него заявок нет вовсе. */
  deptUserA: TestUser;
  /** Сотрудник отдела B: заводит заявку своего отдела на площадке B. */
  deptUserB: TestUser;
  objectAId: string;
  objectBId: string;
  departmentAId: string;
  departmentBId: string;
  counterpartyAId: string;
  counterpartyBId: string;
  typeId: string;
  /** Набор прогона с `serviceRequests.execute`: его же и отбирают у `revokedExecutor`. */
  executorGrantId: string;
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
  // S3 в этом файле не участвует: документы подшиваются уже загруженными строками `files`.
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

/** Свой адрес на каждое обращение: и вход, и общий ограничитель считают запросы по адресу. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/**
 * Десятизначный ИНН по девяти цифрам основы. Настоящая контрольная сумма, а не «77…01»: пока идёт
 * прогон, контрагенты лежат в общей базе, а обмен справочниками выгружает её целиком и на
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
  const options: InjectOptions = {
    method,
    url,
    headers: auth,
    // Свой адрес на каждый запрос: общий ограничитель считает обращения с адреса, а один этот файл
    // проходит цикл заявки полтора десятка раз — с общего адреса он упирался бы в 429 на середине,
    // и падение выглядело бы дефектом модуля.
    remoteAddress: nextAddress(),
  };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return ctx.app.inject(options);
}

/** Ответ ручки: под именем он нужен помощникам, которые возвращают его, ничего не утверждая. */
type Injected = LightMyRequestResponse;

/** Сообщение отказа: по нему и видно, ЧТО именно отбило запрос — страж, область или сторона. */
function messageOf(res: Injected): string {
  try {
    return (res.json() as { message?: string }).message ?? '';
  } catch {
    return res.body;
  }
}

/**
 * Машинный код отказа (`code` тела ошибки). Нужен там, где допустимых ответов несколько и один
 * статус их не различает: 404 «файла нет» и 404 «вам не видно» — разные вещи, и `not_found` рядом
 * с 422 состояния означал бы, что проверка приняла за отказ по сценарию отказ по опечатке в id.
 */
function codeOf(res: Injected): string {
  try {
    return (res.json() as { code?: string }).code ?? '';
  } catch {
    return '';
  }
}

async function card(id: string, auth: Auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `/api/v1/service-requests/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

async function versionOf(id: string, auth: Auth = ctx.admin.auth): Promise<number> {
  return (await card(id, auth)).version;
}

/** Идентификаторы заявок, видимых субъекту: страница заведомо больше, чем данных у теста. */
async function listIds(auth: Auth): Promise<string[]> {
  const res = await inject('GET', '/api/v1/service-requests?pageSize=200', auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as ServiceRequestDto[]).map((row) => row.id);
}

// ── Подготовка данных ──

/**
 * Наименование модели с суффиксом прогона: с миграции `0171` карточка без `model_id` заводит строку
 * справочника моделей сама, а база общая — без метки уборка не отличила бы свою модель от боевой.
 */
const modelName = (base: string): string => `${base} ${RUN}`;

let unitNo = 0;

/**
 * Своя единица под каждую заявку: по технике разрешена одна открытая заявка (Р21), и общая единица
 * заперла бы второй же случай файла. Заводится администратором — справочник ведёт «Ведение», но
 * оно у нас площадочное, а техника нужна на обеих площадках.
 */
async function makeEquipment(
  objectId: string,
  departmentId: string | null = null,
): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: ctx.typeId,
    name: modelName('Kyocera ECOSYS M3145'),
    inventoryNumber: `SEA-${RUN}-${unitNo}`,
    objectId,
    departmentId,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Заявка заказчика на свежей единице — общий вход всех случаев файла. */
async function createRequest(
  auth: Auth,
  objectId: string,
  description: string,
  extra: Record<string, unknown> = {},
): Promise<ServiceRequestDto> {
  const res = await inject('POST', '/api/v1/service-requests', auth, {
    officeEquipmentId: await makeEquipment(objectId),
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  // Заведение отвечает заявкой и исходом письма службе: сама заявка лежит в `request`.
  return (res.json() as { request: ServiceRequestDto }).request;
}

/**
 * Состав исполнителей: назначает администратор — он видит обе площадки.
 *
 * ПРИЧИНА ШЛЁТСЯ ВСЕГДА. Первому назначению она не нужна, переназначению обязательна: у прежнего
 * исполнителя отбирают работу, и без причины сервер отвечает 422 («Укажите причину
 * переназначения»). Решать здесь, какое назначение первое, значило бы завести второе мнение о том,
 * о чём у сервера уже есть своё (`serviceIsFirstAssignment`), — и разъехалось бы оно молча.
 * Лишняя причина в истории первого назначения не мешает никому, а забытая превращает отказ по
 * смыслу сценария в отказ по незаполненной форме: случай доказывал бы валидацию вместо стороны.
 */
async function assign(
  id: string,
  input: { userIds?: string[]; serviceCounterpartyId?: string | null; reason?: string },
  auth: Auth = ctx.admin.auth,
): Promise<ServiceRequestDto> {
  const res = await inject('PUT', `/api/v1/service-requests/${id}/executors`, auth, {
    userIds: input.userIds ?? [],
    serviceCounterpartyId: input.serviceCounterpartyId ?? null,
    reason: input.reason ?? 'состав меняет прогон отрицательных тестов',
    version: await versionOf(id),
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { request: ServiceRequestDto }).request;
}

/** Объём работ из одной строки: предмет проверки — кто его ведёт, а не что в нём. */
const ESTIMATE_ITEMS = [
  { kind: 'service', name: 'Чистка узла подачи', quantity: 1, unitPrice: 1000, warrantyMonths: 3 },
];

/**
 * Заявка, доведённая исполнителем до «В работе» с СОГЛАСОВАННЫМ объёмом работ, — состояние, из
 * которого закрывают работы. Без него `complete` упирается в равенство ревизий и отвечает 409, то
 * есть отказом не про доступ.
 */
async function driveToApproved(id: string, executorAuth: Auth): Promise<void> {
  const started = await inject('PATCH', `/api/v1/service-requests/${id}/start`, executorAuth, {
    version: await versionOf(id),
  });
  expect(started.statusCode, started.body).toBe(200);
  const put = await inject('PUT', `/api/v1/service-requests/${id}/estimate`, executorAuth, {
    items: ESTIMATE_ITEMS,
    version: (started.json() as ServiceRequestDto).version,
  });
  expect(put.statusCode, put.body).toBe(200);
  const submitted = await inject(
    'PATCH',
    `/api/v1/service-requests/${id}/estimate/submit`,
    executorAuth,
    { version: (put.json() as ServiceRequestDto).version },
  );
  expect(submitted.statusCode, submitted.body).toBe(200);
  const approved = await inject(
    'PATCH',
    `/api/v1/service-requests/${id}/estimate/approval`,
    ctx.admin.auth,
    { approved: true, version: await versionOf(id) },
  );
  expect(approved.statusCode, approved.body).toBe(200);
}

/** Заявка площадки A, назначенная поимённо и готовая к закрытию работ. */
async function namedRequestReady(user: TestUser, description: string): Promise<ServiceRequestDto> {
  const dto = await createRequest(ctx.customer.auth, ctx.objectAId, description);
  await assign(dto.id, { userIds: [user.id] });
  await driveToApproved(dto.id, user.auth);
  return card(dto.id, ctx.admin.auth);
}

/** Закрытие работ по всей смете — ход, которым и проверяется сторона исполнителя. */
async function completeWork(id: string, auth: Auth): Promise<Injected> {
  const before = await card(id, ctx.admin.auth);
  return inject('PATCH', `/api/v1/service-requests/${id}/complete`, auth, {
    completedOn: TODAY,
    items: before.items.map((item) => ({ id: item.id, performed: true })),
    version: before.version,
  });
}

/**
 * Загруженный файл строкой в `files`. Настоящая загрузка идёт через presign в S3, которого в тесте
 * нет, а предмет проверки — правила подшивки, а не транспорт.
 */
async function uploadedFile(userId: string, filename: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`sea/${RUN}/${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            'pending', ${userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

/** Подшивка документа: возвращает и ответ, и id файла — снимать его будут по нему же. */
async function attach(
  id: string,
  kind: string,
  user: TestUser,
): Promise<{ fileId: string; res: Injected }> {
  const fileId = await uploadedFile(user.id, `${kind}-${randomUUID()}.pdf`);
  const res = await inject('POST', `/api/v1/service-requests/${id}/files`, user.auth, {
    fileIds: [fileId],
    kind,
  });
  return { fileId, res };
}

/**
 * Ждёт, пока `n` запросов приложения упрутся в блокировку строки, которую держит сторонний
 * `client` (§6.13). Отвечает `true`, если дождались, и `false` по истечении срока — падать здесь
 * нельзя: «никто не ждёт» это не поломка прогона, а осмысленный ответ («ручка блокировку не
 * берёт»), и распорядиться им должен сам случай, вместе с ответами сервера.
 *
 * Ожидающие считаются по `pg_stat_activity`: собственных соединений у прогона немного, а заявка в
 * нём одна на случай — блокировки чужих строк в это окно не попадают. Шаг короткий: окно
 * измеряется миллисекундами, и редкий опрос сам стал бы задержкой.
 */
async function waitForBlocked(client: pg.Client, n: number, timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // Снимок `pg_stat_activity` берётся ОДИН РАЗ НА ТРАНЗАКЦИЮ, а спрашивают его здесь изнутри
    // открытой: без сброса каждый опрос возвращал бы одно и то же состояние, снятое до того, как
    // ручки успели встать в очередь, — и ожидание всегда истекало бы впустую.
    await client.query('SELECT pg_stat_clear_snapshot()');
    const res = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`,
    );
    if (Number(res.rows[0]?.n ?? 0) >= n) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Отзыв прогонного набора у учётки — тем же, чем его отзывает форма учётки: строкой `user_grants`.
 * Идемпотентно, чтобы случаи §6.4 и §6.6 не зависели от порядка друг друга.
 */
async function revokeExecutorGrant(userId: string): Promise<void> {
  await ctx.db.execute(sql`
    DELETE FROM user_grants WHERE user_id = ${userId}::uuid AND grant_id = ${ctx.executorGrantId}::uuid`);
}

describe.skipIf(!DB_URL)('заявки на обслуживание: область и сторона исполнителя (Э2)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const passwordHash = await hashPassword(PASSWORD);

    // Учётки, контрагенты, площадки и отделы заводятся SQL: форма учётки и справочник контрагентов —
    // предмет своих тестов, здесь они декорации, без которых не разложить стороны.
    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const email = `db-sea-${input.tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${input.tag}, ${passwordHash},
                ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const counterparty = async (name: string, inn: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO counterparties (type, name, inn)
        VALUES ('service'::counterparty_type, ${name}, ${inn})
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const digits = String(Date.now()).slice(-6);
    const counterpartyAId = await counterparty(`Сервис-SEA-A ${RUN}`, innOf(`78${digits}0`));
    const counterpartyBId = await counterparty(`Сервис-SEA-B ${RUN}`, innOf(`78${digits}1`));

    const makeObject = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`SEA-${tag}-${RUN}`}, ${`Тестовая площадка SEA ${tag} ${RUN}`},
                'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const objectAId = await makeObject('A');
    const objectBId = await makeObject('B');

    const makeDepartment = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO departments (code, name)
        VALUES (${`SEA-${tag}-${RUN}`}, ${`Тестовый отдел SEA ${tag} ${RUN}`})
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const departmentAId = await makeDepartment('DA');
    const departmentBId = await makeDepartment('DB');

    const admin = await makeUser({ tag: 'admin', role: 'admin' });
    const customer = await makeUser({ tag: 'cust', role: 'shtab' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const executor = await makeUser({ tag: 'exec', role: 'shtab' });
    const strayExecutor = await makeUser({ tag: 'stray', role: 'shtab' });
    const revokedExecutor = await makeUser({ tag: 'revoked', role: 'shtab' });
    const revokedChatExecutor = await makeUser({ tag: 'revchat', role: 'shtab' });
    const raceExecutor = await makeUser({ tag: 'race', role: 'shtab' });
    const itService = await makeUser({ tag: 'itsvc', role: 'shtab' });
    const foreignShtab = await makeUser({ tag: 'fshtab', role: 'shtab' });
    const serviceA = await makeUser({
      tag: 'srva',
      role: 'operator',
      counterpartyId: counterpartyAId,
    });
    const serviceB = await makeUser({
      tag: 'srvb',
      role: 'operator',
      counterpartyId: counterpartyBId,
    });
    const deptUserA = await makeUser({ tag: 'depta', role: 'department' });
    const deptUserB = await makeUser({ tag: 'deptb', role: 'department' });

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectAId}), (${operator.id}, ${objectAId}),
             (${executor.id}, ${objectAId}), (${strayExecutor.id}, ${objectAId}),
             (${revokedExecutor.id}, ${objectAId}), (${revokedChatExecutor.id}, ${objectAId}),
             (${raceExecutor.id}, ${objectAId}),
             (${itService.id}, ${objectAId}), (${foreignShtab.id}, ${objectBId})`);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id)
      VALUES (${deptUserA.id}, ${departmentAId}), (${deptUserB.id}, ${departmentBId})`);

    // Надстройка «Ведение» заводится сервисом, а не прямым SQL: с шага 1a перехода на назначаемые
    // полномочия (ADR 0106) выдача пишет две таблицы одной транзакцией, и прямая вставка в одну из
    // них оставила бы половину — оператор молча остался бы без прав.
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], admin.id);
    });

    /**
     * Набор внутреннего исполнителя — СВОИМ кодом на прогон, а не системным
     * `office_equipment_it_approver`. Причин две, и обе по делу. Первая: у системного набора
     * сквозная область модуля (`GRANT_MODULE_WIDE_SCOPE`), и субъект с ним видел бы все заявки
     * компании — то есть ровно то, что делает находку Н1 ненаблюдаемой. Вторая: подмешать `execute`
     * в поставочный набор значило бы править каталог прав ради теста.
     *
     * Состав — тот, который Э8 и заведёт под именем `office_equipment_executor`: чтение, исполнение,
     * документы. Роль в `grant_roles` обязательна: права набора считаются через гейт совместимости
     * с ролью, и без строки `shtab` учётки не получили бы ни одного права.
     */
    const grantRow = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, description, is_system, created_by)
      VALUES (${`oe-exec-${RUN}`}, ${`Оргтехника: исполнитель ${RUN}`},
              'Набор внутреннего исполнителя заявок оргтехники (аудит §6)', false, ${admin.id})
      RETURNING id`);
    const executorGrantId = grantRow.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      SELECT ${executorGrantId}, permission
      FROM unnest(ARRAY['serviceRequests.read', 'serviceRequests.execute',
                        'serviceRequests.files']) AS permission`);
    await db.execute(sql`
      INSERT INTO grant_roles (grant_id, role) VALUES (${executorGrantId}, 'shtab'::role)`);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by)
      VALUES (${executor.id}, ${executorGrantId}, ${admin.id}),
             (${strayExecutor.id}, ${executorGrantId}, ${admin.id}),
             (${revokedExecutor.id}, ${executorGrantId}, ${admin.id}),
             (${revokedChatExecutor.id}, ${executorGrantId}, ${admin.id}),
             (${raceExecutor.id}, ${executorGrantId}, ${admin.id})`);

    /**
     * Набор ИТ-службы — состав `office_equipment_it_approver` в той части, что делает находку Н2
     * наблюдаемой: чтение, исполнение, документы и **финансовая аудитория**. Своим кодом на прогон
     * и без сквозной области (`GRANT_MODULE_WIDE_SCOPE` знает только системные коды): область здесь
     * ни при чём — заявку субъект видит по своей площадке, — а предмет проверки в том, что
     * `serviceRequests.finance` сам по себе бумагу не открывает.
     *
     * `serviceRequests.status` в набор НЕ входит, и это половина случая: «Ведению» акт разрешён
     * самой таблицей Р3, и включи мы право сюда — проверка доказывала бы обратное тому, ради чего
     * написана.
     */
    const financeGrantRow = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, description, is_system, created_by)
      VALUES (${`oe-fin-${RUN}`}, ${`Оргтехника: ИТ-служба ${RUN}`},
              'Набор с финансовой аудиторией без стороны исполнителя (аудит §6.11)', false,
              ${admin.id})
      RETURNING id`);
    const financeGrantId = financeGrantRow.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      SELECT ${financeGrantId}, permission
      FROM unnest(ARRAY['serviceRequests.read', 'serviceRequests.execute',
                        'serviceRequests.files', 'serviceRequests.finance']) AS permission`);
    await db.execute(sql`
      INSERT INTO grant_roles (grant_id, role) VALUES (${financeGrantId}, 'shtab'::role)`);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by)
      VALUES (${itService.id}, ${financeGrantId}, ${admin.id})`);

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
      executor: await withAuth(executor),
      strayExecutor: await withAuth(strayExecutor),
      revokedExecutor: await withAuth(revokedExecutor),
      revokedChatExecutor: await withAuth(revokedChatExecutor),
      raceExecutor: await withAuth(raceExecutor),
      itService: await withAuth(itService),
      foreignShtab: await withAuth(foreignShtab),
      serviceA: await withAuth(serviceA),
      serviceB: await withAuth(serviceB),
      deptUserA: await withAuth(deptUserA),
      deptUserB: await withAuth(deptUserB),
      objectAId,
      objectBId,
      departmentAId,
      departmentBId,
      counterpartyAId,
      counterpartyBId,
      typeId,
      executorGrantId,
    };
  }, 60_000);

  /**
   * Уборка: база общая и живёт между прогонами, поэтому файл уносит ровно то, что завёл сам.
   * Опознаётся всё суффиксом прогона, порядок задан внешними ключами: события журнала остатка
   * держат заявку и автора `RESTRICT`ом, заявки держат технику, автора и контрагента, техника —
   * площадку и отдел.
   */
  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      const equipment = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE ${`SEA-${RUN}-%`}`;
      const users = sql`SELECT id FROM users WHERE email LIKE ${`db-sea-%-${RUN}@example.invalid`}`;
      const consumables = sql`SELECT id FROM office_equipment_consumables WHERE code LIKE ${`ДSEA${RUN.toUpperCase()}%`}`;
      // Строки журнала остатка неизменяемы триггером: круг размыкает только временное гашение —
      // одной транзакцией и обратно `ENABLE ALWAYS`, как в `service-request-flow.db.test.ts`.
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
        await tx.execute(sql`
          ALTER TABLE office_equipment_consumable_stock_entries
            DISABLE TRIGGER office_equipment_consumable_stock_immutable`);
        await tx.execute(sql`
          DELETE FROM office_equipment_consumable_stock_entries WHERE consumable_id IN (${consumables})`);
        await tx.execute(sql`
          ALTER TABLE office_equipment_consumable_stock_entries
            ENABLE ALWAYS TRIGGER office_equipment_consumable_stock_immutable`);
      });
      await ctx.db.execute(
        sql`DELETE FROM service_requests WHERE office_equipment_id IN (${equipment})`,
      );
      await ctx.db.execute(
        sql`DELETE FROM office_equipment_consumables WHERE id IN (${consumables})`,
      );
      await ctx.db.execute(
        sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`SEA-${RUN}-%`}`,
      );
      // Модели, заведённые карточками этого файла: карточка без `model_id` заводит строку
      // справочника сама, а её удаление модель за собой не уносит.
      await ctx.db.execute(sql`
        DELETE FROM office_equipment_models m
         WHERE m.name LIKE ${`% ${RUN}`}
           AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
      await ctx.db.execute(
        sql`DELETE FROM jobs WHERE payload->>'objectKey' LIKE ${`sea/${RUN}/%`}`,
      );
      await ctx.db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`sea/${RUN}/%`}`);
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-sea-%-${RUN}@example.invalid`}`,
      );
      // Оба прогонных набора — исполнительский и с финансовой аудиторией: по общему префиксу и
      // суффиксу прогона, чтобы третий набор не пришлось вспоминать отдельной строкой.
      await ctx.db.execute(sql`DELETE FROM grants WHERE code LIKE ${`oe-%-${RUN}`}`);
      await ctx.db.execute(
        sql`DELETE FROM counterparties WHERE name LIKE ${`Сервис-SEA-% ${RUN}`}`,
      );
      // Отделы раньше площадок: у отдела бывает своя площадка (ADR 0062), и ссылка на неё —
      // `RESTRICT`. У отделов этого файла её нет, но порядок не должен зависеть от этого.
      await ctx.db.execute(sql`DELETE FROM departments WHERE code LIKE ${`SEA-D%-${RUN}`}`);
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${`SEA-%-${RUN}`}`);
    }
    await ctx?.closeDb();
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // §6.1–§6.6. Внутренний сотрудник: право без назначения и назначение без права
  // ────────────────────────────────────────────────────────────────────────────────────────────

  describe('внутренний исполнитель (§6.1–§6.6)', () => {
    /** Ручки чтения карточки: у всех трёх одна и та же пара «архив → 404, чужая область → 403». */
    const READ_ROUTES = ['', '/history', '/messages'] as const;

    it('§6.1 не назначен и заявка вне области — все двери закрыты', async () => {
      const foreign = await createRequest(
        ctx.foreignShtab.auth,
        ctx.objectBId,
        'Площадка B: не захватывает бумагу',
      );

      for (const suffix of READ_ROUTES) {
        const res = await inject(
          'GET',
          `/api/v1/service-requests/${foreign.id}${suffix}`,
          ctx.executor.auth,
        );
        expect(res.statusCode, `${suffix}: ${res.body}`).toBe(403);
        // Отказ приходит от ОБЛАСТИ, а не от стража: право чтения у субъекта есть, и подмена
        // причины (403 «недостаточно прав») означала бы, что доказан не тот рубеж.
        expect(messageOf(res)).toContain('работает только со своими объектами');
      }

      // Ходы исполнителя — той же областью, ДО разбора состояния и назначения.
      const start = await inject(
        'PATCH',
        `/api/v1/service-requests/${foreign.id}/start`,
        ctx.executor.auth,
        { version: foreign.version },
      );
      expect(start.statusCode, start.body).toBe(403);
      const estimate = await inject(
        'PUT',
        `/api/v1/service-requests/${foreign.id}/estimate`,
        ctx.executor.auth,
        { items: ESTIMATE_ITEMS, version: foreign.version },
      );
      expect(estimate.statusCode, estimate.body).toBe(403);
      const complete = await inject(
        'PATCH',
        `/api/v1/service-requests/${foreign.id}/complete`,
        ctx.executor.auth,
        { completedOn: TODAY, items: [], version: foreign.version },
      );
      expect(complete.statusCode, complete.body).toBe(403);

      // И в списке её нет: карточка и витрина обязаны отвечать одинаково (К3).
      expect(await listIds(ctx.executor.auth)).not.toContain(foreign.id);
    });

    it('§6.2 назначенный поимённо читает заявку и закрывает работы', async () => {
      const request = await namedRequestReady(ctx.executor, 'Назначенный исполнитель ведёт заявку');

      for (const suffix of READ_ROUTES) {
        const res = await inject(
          'GET',
          `/api/v1/service-requests/${request.id}${suffix}`,
          ctx.executor.auth,
        );
        expect(res.statusCode, `${suffix}: ${res.body}`).toBe(200);
      }

      const completed = await completeWork(request.id, ctx.executor.auth);
      expect(completed.statusCode, completed.body).toBe(200);
      expect((completed.json() as ServiceRequestDto).status).toBe('done');
    });

    it('§6.3 переназначение прекращает ходы ТЕМ ЖЕ токеном, без перелогина (И3)', async () => {
      const request = await namedRequestReady(ctx.executor, 'Переназначение снимает исполнителя');

      // Состав меняет распределяющий: прежнего исполнителя в списке больше нет.
      const after = await assign(request.id, { userIds: [ctx.strayExecutor.id] });
      expect(after.executors.map((e) => e.userId)).toEqual([ctx.strayExecutor.id]);

      // Токен у снятого исполнителя ТОТ ЖЕ — он не перезаходил и вкладку не обновлял. Права и
      // назначение перечитываются на каждом запросе (`loadPrincipal` + `executorAssignment`),
      // поэтому следующий же ход обязан упереться в сторону.
      const completed = await completeWork(request.id, ctx.executor.auth);
      expect(completed.statusCode, completed.body).toBe(403);
      expect(messageOf(completed)).toContain('не может перевести заявку');

      const comment = await inject(
        'PATCH',
        `/api/v1/service-requests/${request.id}/service-comment`,
        ctx.executor.auth,
        { serviceComment: 'я тут больше ни при чём', version: await versionOf(request.id) },
      );
      expect(comment.statusCode, comment.body).toBe(403);
      expect(messageOf(comment)).toContain('не пишет примечание исполнителя');

      /*
       * А ЧТЕНИЕ ОСТАЛОСЬ — и это не дыра, а вторая половина И3: базовая видимость заказчика,
       * если она есть у роли независимо от назначения, снятием исполнителя не отбирается. Наш
       * исполнитель — штаб площадки A, заявка стоит на его площадке, и увидел бы он её и не
       * будучи назначенным. Ждать здесь 403 значило бы требовать, чтобы назначение ОТБИРАЛО
       * область, которой оно не давало.
       */
      const readable = await inject(
        'GET',
        `/api/v1/service-requests/${request.id}`,
        ctx.executor.auth,
      );
      expect(readable.statusCode, readable.body).toBe(200);
    });

    it('§6.4 отзыв набора прекращает ходы тем же токеном, чтение остаётся по области', async () => {
      const request = await namedRequestReady(
        ctx.revokedExecutor,
        'Отзыв права при живом назначении',
      );
      // Назначение остаётся: отбирают ПРАВО, а не строку исполнителя, — ровно случай И1
      // «одного назначения мало никогда».
      expect(request.executors.map((e) => e.userId)).toEqual([ctx.revokedExecutor.id]);

      await revokeExecutorGrant(ctx.revokedExecutor.id);

      const completed = await completeWork(request.id, ctx.revokedExecutor.auth);
      expect(completed.statusCode, completed.body).toBe(403);
      /*
       * Отбивает СТРАЖ МАРШРУТА, и проверяется именно рубеж, а не буква сообщения. У
       * `PATCH /:id/complete` страж — «одно из прав» (`serviceRequests.estimate` либо
       * `serviceRequests.execute`), и своей подсказкой он и отвечает: `serviceRequests.execute` у
       * субъекта больше нет, а `serviceRequests.estimate` роль штаба не даёт и не давала.
       *
       * Двух других текстов быть не должно, и они здесь не для красоты: дойди запрос до следующих
       * рубежей, отказ пришёл бы от стороны («не может перевести заявку») или от области
       * («работает только со своими объектами») — то есть случай доказывал бы не отзыв права, а
       * снятое назначение (§6.3) или чужую площадку (§6.1), и подмену эту по одному коду 403 не
       * видно.
       */
      expect(messageOf(completed)).toContain('Объём работ ведёт исполнитель');
      expect(messageOf(completed)).not.toContain('не может перевести заявку');
      expect(messageOf(completed)).not.toContain('работает только со своими объектами');

      const estimate = await inject(
        'PUT',
        `/api/v1/service-requests/${request.id}/estimate`,
        ctx.revokedExecutor.auth,
        { items: ESTIMATE_ITEMS, version: await versionOf(request.id) },
      );
      expect(estimate.statusCode, estimate.body).toBe(403);

      // Чтение осталось: оно приходит ролью и площадкой, а не отобранным набором.
      const readable = await inject(
        'GET',
        `/api/v1/service-requests/${request.id}`,
        ctx.revokedExecutor.auth,
      );
      expect(readable.statusCode, readable.body).toBe(200);
    });

    /**
     * Н1.2 ЗАКРЫТА: третья ось видимости приехала в дерево, пока писался этот файл.
     *
     * Находка была про то, что назначение заявку не открывает: видимость знала две оси — заказчика
     * и назначенного подрядчика, — а область спрашивала у объектной роли только её площадки. Значит
     * исполнителя, назначенного на соседний объект, назначить было МОЖНО
     * (`resolveNamedExecutors` проверяет у кандидата одно право), письмо-задание ему уходило, в
     * карточке он числился исполнителем — и получал 403 на собственную заявку.
     *
     * Сегодня `assertServiceRequestVisible` ([access.ts](../src/lib/access.ts)) спрашивает ось «я
     * назначен поимённо» ПЕРВОЙ, и та же ось стоит в отборе списка. Это решение Р1, этап Э4 —
     * выполненный не этим этапом, а параллельной волной. Случай поэтому обычный зелёный: он
     * требует правильного поведения и получает его. Пару ему составляет следующий — назначение
     * обязано открыть ОДНУ строку, а не снять область целиком.
     */
    it('§6.5 назначение открывает заявку вне области — третья ось Р1', async () => {
      const foreign = await createRequest(
        ctx.foreignShtab.auth,
        ctx.objectBId,
        'Площадка B: назначен сисадмин соседней площадки',
      );
      const assigned = await assign(foreign.id, { userIds: [ctx.executor.id] });
      // Назначение прошло — и это половина находки: «мёртвого» исполнителя сервер принимает.
      expect(assigned.executors.map((e) => e.userId)).toEqual([ctx.executor.id]);

      const res = await inject('GET', `/api/v1/service-requests/${foreign.id}`, ctx.executor.auth);
      expect(res.statusCode, res.body).toBe(200);
      expect(await listIds(ctx.executor.auth)).toContain(foreign.id);
    });

    it('§6.5 назначение открывает ТОЛЬКО назначенную заявку, а не всю чужую площадку', async () => {
      // Половина сценария, которая верна и сегодня, и после Э4, — поэтому она отдельным зелёным
      // случаем: третья ось Р1 обязана открыть ОДНУ строку, а не снять область целиком.
      const mine = await createRequest(
        ctx.foreignShtab.auth,
        ctx.objectBId,
        'Площадка B: моя назначенная',
      );
      const neighbour = await createRequest(
        ctx.foreignShtab.auth,
        ctx.objectBId,
        'Площадка B: соседняя, меня в ней нет',
      );
      await assign(mine.id, { userIds: [ctx.executor.id] });

      const res = await inject(
        'GET',
        `/api/v1/service-requests/${neighbour.id}`,
        ctx.executor.auth,
      );
      expect(res.statusCode, res.body).toBe(403);
      expect(await listIds(ctx.executor.auth)).not.toContain(neighbour.id);
    });

    /**
     * Н9 ЗАКРЫТА той же волной Р1/Э4, что и Н1.2.
     *
     * Находка была про то, что `matchesServiceChatSide('service')` спрашивал один
     * `facts.isNamedExecutor` и о праве не знал. Строка назначения историческая — по ней написана
     * переписка и разосланы задания, снимать её при отзыве набора нельзя, — и человек продолжал
     * быть стороной `service` в заявке, доступной ему по базовой области: писал от имени
     * исполнителя и попадал в адресаты «Исполнителю» вместе с будущей почтой.
     *
     * Сегодня ветка `service` — дизъюнкция «назначенный контрагент ∨ (поимённый И
     * `serviceRequests.execute`)», и находка названа в комментарии к ней по имени. Случай поэтому
     * обычный зелёный и доказывает вторую половину И3: право читается из БД на каждом запросе, и
     * отзыв гасит сторону СЛЕДУЮЩИМ ЖЕ запросом — тем же токеном, без перелогина.
     */
    it('§6.6 отзыв execute гасит сторону service в чате', async () => {
      const request = await namedRequestReady(
        ctx.revokedChatExecutor,
        'Отзыв права и сторона чата',
      );
      const before = await card(request.id, ctx.revokedChatExecutor.auth);
      expect(before.chat.participantSides).toContain('service');

      await revokeExecutorGrant(ctx.revokedChatExecutor.id);

      const after = await card(request.id, ctx.revokedChatExecutor.auth);
      // Стороны `customer`/`it` он не получал ни откуда: автор заявки — заказчик, `approveIt` в
      // набор не входил. Значит после отзыва участие обязано исчезнуть целиком.
      expect(after.chat.participantSides).not.toContain('service');
      expect(after.chat.canWrite).toBe(false);

      const posted = await inject(
        'POST',
        `/api/v1/service-requests/${request.id}/messages`,
        ctx.revokedChatExecutor.auth,
        {
          body: 'пишу как исполнитель, хотя права уже нет',
          addressees: { sides: ['all'], users: [] },
        },
      );
      expect(posted.statusCode, posted.body).toBe(403);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // §6.8–§6.10. Представитель сервисной компании
  // ────────────────────────────────────────────────────────────────────────────────────────────

  describe('представитель сервисной компании (§6.8–§6.10)', () => {
    /*
     * §6.7 («Новую» нераспределённую сервис не видит) и §6.9 в части «сервис не согласует смету, не
     * принимает работу и не отменяет заявку» доказаны в `service-request-flow.db.test.ts` —
     * случаями «„Новую“ заявку сервис не видит: исполнителя в ней ещё нет» и «сервис не согласует
     * смету, не принимает работу и не отменяет заявку — 403». Повтор их здесь означал бы два места,
     * которые придётся править парой.
     */

    /**
     * Тело пробы на каждую ручку модуля, у которой есть `:id`.
     *
     * ЗАЧЕМ ТЕЛА ВООБЩЕ. Проверка схемы в Fastify стоит ДО `preHandler`: с пустым телом ручка
     * ответила бы 400 разбора, и перебор доказывал бы валидацию вместо области. Тела нарочно
     * бессмысленные (нулевая версия, пустые списки) — до состояния заявки запрос дойти не должен.
     *
     * `satisfies` вместо аннотации: опечатка в ключе или ручка соседнего модуля упрутся в
     * компилятор, а полнота перечня проверяется первым же случаем перебора.
     */
    const PROBE_BODY = {
      'GET /api/v1/service-requests/:id': null,
      'GET /api/v1/service-requests/:id/history': null,
      'GET /api/v1/service-requests/:id/messages': null,
      'POST /api/v1/service-requests/:id/messages': {
        body: 'проба доступа',
        addressees: { sides: ['all'], users: [] },
      },
      'POST /api/v1/service-requests/:id/messages/read': { throughSeq: 1 },
      'PATCH /api/v1/service-requests/:id': { description: 'Проба доступа', version: 0 },
      'PATCH /api/v1/service-requests/:id/urgency': {
        isUrgent: false,
        urgencyReason: '',
        version: 0,
      },
      'DELETE /api/v1/service-requests/:id': null,
      'PUT /api/v1/service-requests/:id/executors': {
        userIds: [],
        serviceCounterpartyId: null,
        version: 0,
      },
      'PATCH /api/v1/service-requests/:id/decline': { reason: 'проба доступа', version: 0 },
      'PATCH /api/v1/service-requests/:id/start': { version: 0 },
      'PUT /api/v1/service-requests/:id/estimate': { items: [], version: 0 },
      'PATCH /api/v1/service-requests/:id/estimate/submit': { version: 0 },
      'PATCH /api/v1/service-requests/:id/estimate/approval': { approved: true, version: 0 },
      'PATCH /api/v1/service-requests/:id/estimate/reopen': { reason: 'проба доступа', version: 0 },
      'PUT /api/v1/service-requests/:id/consumables': {
        items: [{ consumableId: '00000000-0000-4000-8000-000000000001', requestedQuantity: 1 }],
        version: 0,
      },
      'PATCH /api/v1/service-requests/:id/consumables/issued': {
        items: [{ id: '00000000-0000-4000-8000-000000000001', issuedQuantity: 1 }],
        version: 0,
      },
      'PATCH /api/v1/service-requests/:id/complete': {
        completedOn: TODAY,
        items: [],
        version: 0,
      },
      'PATCH /api/v1/service-requests/:id/accept': { version: 0 },
      'PATCH /api/v1/service-requests/:id/rework': { reason: 'проба доступа', version: 0 },
      'PATCH /api/v1/service-requests/:id/status': {
        status: 'cancelled',
        reason: 'проба доступа',
        version: 0,
      },
      'PATCH /api/v1/service-requests/:id/hold': { reason: 'проба доступа', version: 0 },
      'PATCH /api/v1/service-requests/:id/resume': { version: 0 },
      'POST /api/v1/service-requests/:id/notify': {
        idempotencyKey: '00000000-0000-4000-8000-000000000002',
      },
      'PATCH /api/v1/service-requests/:id/service-comment': {
        serviceComment: 'проба доступа',
        version: 0,
      },
      'POST /api/v1/service-requests/:id/files': {
        fileIds: ['00000000-0000-4000-8000-000000000003'],
        kind: 'attachment',
      },
      'DELETE /api/v1/service-requests/:id/files/:fileId': null,
      'POST /api/v1/service-requests/:id/restore': null,
    } as const satisfies Partial<Record<ServiceManifestRouteKey, unknown>>;

    it('§6.8 заявка другого подрядчика — 403 на каждой строке манифеста области', async () => {
      const request = await createRequest(
        ctx.customer.auth,
        ctx.objectAId,
        'Заявка подрядчика A: подрядчик B к ней не подходит',
      );
      await assign(request.id, { serviceCounterpartyId: ctx.counterpartyAId });

      /*
       * Перечень ручек берётся ИЗ МАНИФЕСТА, а не выписывается здесь: новая ручка модуля обязана
       * попасть в перебор сама, а не ждать, пока о ней вспомнят. Строки `scope: 'none'` отсеиваются
       * СВОИМ ПОЛЕМ — «у этой двери области нет» записано решением в манифесте, и повторять список
       * исключений тут значило бы завести второе мнение о том же.
       */
      const probes = Object.entries(SERVICE_ACCESS_MANIFEST)
        .filter(([key, row]) => row.scope === 'visibility' && key.includes('/:id'))
        .map(([key]) => key as keyof typeof PROBE_BODY);
      expect(probes.length).toBeGreaterThan(20);

      const refusals: string[] = [];
      for (const key of probes) {
        // Тело обязано быть у каждой строки перебора: забытое означало бы 400 разбора вместо
        // отказа по области — то есть зелёный случай, ничего не доказывающий.
        expect(PROBE_BODY, `нет тела пробы для ${key}`).toHaveProperty(key);
        const [method, path] = key.split(' ') as [Method, string];
        const url = path
          .replace(':id', request.id)
          .replace(':fileId', '00000000-0000-4000-8000-000000000004');
        const res = await inject(method, url, ctx.serviceB.auth, PROBE_BODY[key] ?? undefined);
        if (res.statusCode !== 403) refusals.push(`${key} → ${res.statusCode} ${res.body}`);
      }
      expect(refusals, refusals.join('\n')).toEqual([]);

      // И в списке чужая заявка не показывается: витрина отвечает так же, как карточка.
      expect(await listIds(ctx.serviceB.auth)).not.toContain(request.id);
    });

    it('§6.9 объём работ согласуют две стороны, и подрядчик в них не входит', async () => {
      /*
       * Единственная дверь модуля с двумя сторонами сразу (комментарий манифеста к
       * `PATCH /:id/estimate/approval`): «Ведение» правом `approveEstimate` ЛИБО поимённый
       * исполнитель (ответ В2, ADR 0145). Манифест называет одну сторону и требует от Э2 проверить
       * обе — иначе строка доказывала бы половину правила.
       */
      const dto = await createRequest(ctx.customer.auth, ctx.objectAId, 'Две двери согласования');
      await assign(dto.id, { userIds: [ctx.executor.id] });
      /*
       * ВЕРСИЯ ПЕРЕЧИТЫВАЕТСЯ ПЕРЕД КАЖДЫМ ХОДОМ. Ревизию заявки поднимает не только сам ход:
       * назначение состава — тоже запись, и версия, взятая из ответа на заведение, устаревает уже
       * на нём. Сверка `version` отвечает на это 409, и случай доказывал бы оптимистичную
       * блокировку вместо двух дверей согласования — причём доказывал бы её зелёным первым
       * запросом и красным вторым, то есть в самом неудобном для чтения виде.
       */
      const started = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/start`,
        ctx.executor.auth,
        { version: await versionOf(dto.id) },
      );
      expect(started.statusCode, started.body).toBe(200);
      const put = await inject(
        'PUT',
        `/api/v1/service-requests/${dto.id}/estimate`,
        ctx.executor.auth,
        { items: ESTIMATE_ITEMS, version: await versionOf(dto.id) },
      );
      expect(put.statusCode, put.body).toBe(200);
      const submitted = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/estimate/submit`,
        ctx.executor.auth,
        { version: await versionOf(dto.id) },
      );
      expect(submitted.statusCode, submitted.body).toBe(200);

      // Оператор чужого подрядчика — мимо области.
      const foreignService = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/estimate/approval`,
        ctx.serviceB.auth,
        { approved: true, version: await versionOf(dto.id) },
      );
      expect(foreignService.statusCode, foreignService.body).toBe(403);

      // Дверь первая: «Ведение» своим правом.
      const byOperator = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/estimate/approval`,
        ctx.operator.auth,
        { approved: true, version: await versionOf(dto.id) },
      );
      expect(byOperator.statusCode, byOperator.body).toBe(200);

      // Дверь вторая: поимённый исполнитель без `approveEstimate` — на новой ревизии.
      const reopened = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/estimate/reopen`,
        ctx.executor.auth,
        { reason: 'пересчитываем состав', version: await versionOf(dto.id) },
      );
      expect(reopened.statusCode, reopened.body).toBe(200);
      const resubmitted = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/estimate/submit`,
        ctx.executor.auth,
        { version: await versionOf(dto.id) },
      );
      expect(resubmitted.statusCode, resubmitted.body).toBe(200);
      const byExecutor = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/estimate/approval`,
        ctx.executor.auth,
        { approved: true, version: await versionOf(dto.id) },
      );
      expect(byExecutor.statusCode, byExecutor.body).toBe(200);
    });

    it('§6.10 снятие компании с заявки закрывает и чтение, и документы, и рассылку', async () => {
      const request = await createRequest(
        ctx.customer.auth,
        ctx.objectAId,
        'Подрядчика сняли с заявки',
      );
      await assign(request.id, { serviceCounterpartyId: ctx.counterpartyAId });
      expect((await card(request.id, ctx.serviceA.auth)).id).toBe(request.id);

      /*
       * Снимаем компанию так, как это делает жизнь. Пустого состава сервер не принимает вовсе
       * («Назначьте хотя бы одного исполнителя — сотрудника или сервисную компанию»), и это не
       * придирка формы: заявку не бросают, её ПЕРЕДАЮТ — иначе она осталась бы ничьей и по ней
       * никто не отвечал бы. Передаём своему сотруднику; контрагент в строке обнуляется тем же
       * ходом, и предмет случая — что у прежнего подрядчика после передачи закрылось всё, — от
       * того, кому именно передали, не зависит.
       */
      const handed = await assign(request.id, {
        userIds: [ctx.executor.id],
        reason: 'заявку передали своему сотруднику',
      });
      expect(handed.service).toBeNull();
      expect(handed.executors.map((e) => e.userId)).toEqual([ctx.executor.id]);

      const read = await inject('GET', `/api/v1/service-requests/${request.id}`, ctx.serviceA.auth);
      expect(read.statusCode, read.body).toBe(403);
      expect(messageOf(read)).toContain('Сервисная компания работает только с назначенными');

      const { res: attached } = await attach(request.id, 'act', ctx.serviceA);
      expect(attached.statusCode, attached.body).toBe(403);

      const notified = await inject(
        'POST',
        `/api/v1/service-requests/${request.id}/notify`,
        ctx.serviceA.auth,
        { idempotencyKey: randomUUID() },
      );
      expect(notified.statusCode, notified.body).toBe(403);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // §6.11–§6.13. Бумаги и гонки
  // ────────────────────────────────────────────────────────────────────────────────────────────

  describe('бумаги и гонки (§6.11–§6.13)', () => {
    /**
     * Н2 В ЭТОЙ ЧАСТИ ЗАКРЫТА — И ЗАКРЫЛ ЕЁ НЕ ЭТОТ ПЛАН.
     *
     * Находка описывала подшивку без стороны: `POST /:id/files` спрашивал право
     * `serviceRequests.files`, область и таблицу «вид × статус», а виды `act`, `invoice`,
     * `warranty_card` разрешены уже в «В работе» — и наличие любого из них снимает планку
     * закрывающего документа. Заказчик клал основание платежа, подрядчик закрывал по нему работу.
     *
     * Пока шёл аудит, в дерево приехал план карточки заявителя: `canAttachServiceFile(kind, status,
     * audience)` и `SERVICE_FILE_KIND_POLICY` в контрактах, право `serviceRequests.finance` в
     * матрице. У `act` теперь `attachedBy: ['finance']`, а заказчик без `finance` — аудитория
     * `requester`, и сервер отвечает ему 403 ещё до разбора статуса. Это записано и в самом Р3:
     * функция делится между двумя планами, аудитория приехала первой.
     *
     * Случай поэтому ОБЫЧНЫЙ ЗЕЛЁНЫЙ, а не помеченный `it.fails`: правильное поведение достигнуто,
     * и пометка на нём требовала бы возврата дыры. ОСТАТОК находки — держатель `finance`, не
     * являющийся ни стороной исполнителя, ни «Ведением», — закрыт Э5 (Р3) и проверяется соседним
     * случаем: он про ВТОРОЙ слой, сторону, и субъект в нём другой (`ctx.itService`).
     */
    it('§6.11 заказчик не подшивает акт: аудитория «заявитель» его не кладёт', async () => {
      const request = await namedRequestReady(ctx.executor, 'Акт от заказчика');
      const { res } = await attach(request.id, 'act', ctx.customer);
      expect(res.statusCode, res.body).toBe(403);
      // Отбивает ПОТОЛОК АУДИТОРИИ, а не статус: «в другом статусе получится» заявителю не
      // обещают — он не положит акт никогда. Ответ 422 «неподходящий статус» означал бы, что
      // закрыт не тот рубеж и находка Н2 всё ещё жива.
      expect(messageOf(res)).toContain('прикладывает исполнитель, а не заявитель');
    });

    /**
     * ОСТАТОК НАХОДКИ Н2 — И ЗАКРЫВАЕТ ЕГО Э5 (Р3).
     *
     * Аудитория отвечает на вопрос «видны ли этому читателю деньги заявки», и `finance` бывает
     * сквозным: ИТ-служба получает его набором на всю компанию. Пока подшивку решала одна
     * аудитория, держатель `finance` без всякого отношения к работе клал акт или счёт — а именно
     * наличие любого из них снимает планку `serviceRequestNeedsClosingDocument`, и внешний
     * подрядчик закрывал работу под чужой бумагой.
     *
     * ДО Э5 сервер отвечал на оба запроса `200` и подшивал документ. Теперь отвечает `403`, и
     * отбивает его ВТОРОЙ слой — сторона: текст отказа называет того, чья это бумага, а не
     * «исполнитель, а не заявитель» (это первый слой, аудиторный, — им отбивают заказчика в
     * соседнем случае). Разные тексты здесь и есть доказательство того, что закрыт нужный рубеж.
     */
    it('§6.11 финансовая аудитория без стороны не подшивает ни акт, ни счёт', async () => {
      const request = await namedRequestReady(ctx.executor, 'Акт от ИТ-службы без назначения');
      // Заявка ему ВИДНА (та же площадка) и деньги её открыты — иначе отказ означал бы область, а
      // не сторону, и находка осталась бы недоказанной.
      const seen = await card(request.id, ctx.itService.auth);
      expect(seen.audience).toBe('finance');

      for (const kind of ['act', 'invoice'] as const) {
        const { res } = await attach(request.id, kind, ctx.itService);
        expect(res.statusCode, `${kind}: ${res.body}`).toBe(403);
        expect(messageOf(res), kind).toContain('прикладывает назначенный исполнитель');
      }
      // Ни одна бумага не подшита: планка закрывающего документа не снята, и «Решена» по-прежнему
      // требует акта от того, кто работу делал.
      const after = await card(request.id, ctx.admin.auth);
      expect(after.files.map((f) => f.kind)).toEqual([]);
    });

    /**
     * Вторая половина того же правила: вложение стороны не спрашивает вовсе. Без этого случая
     * первый доказывал бы «ИТ-службе закрыли документы», а закрыт ей ровно закрывающий документ.
     */
    it('§6.11 вложение той же учётке открыто: у него стороны нет', async () => {
      const request = await namedRequestReady(ctx.executor, 'Фотография от ИТ-службы');
      const { res } = await attach(request.id, 'attachment', ctx.itService);
      expect(res.statusCode, res.body).toBe(200);
    });

    it('§6.11 вложение заказчику по-прежнему открыто — это не дыра, а половина заявки', async () => {
      const request = await namedRequestReady(ctx.executor, 'Фотография поломки от заказчика');
      const { res } = await attach(request.id, 'attachment', ctx.customer);
      expect(res.statusCode, res.body).toBe(200);
    });

    it('§6.12 переназначение и закрытие работ одновременно — ровно один успех', async () => {
      const request = await namedRequestReady(ctx.executor, 'Гонка переназначения и закрытия');
      const before = await card(request.id, ctx.admin.auth);

      /*
       * Обе ручки берут ОДНУ И ТУ ЖЕ версию — то самое окно, в котором сегодня страхует только
       * оптимистичная сверка: признаки назначения `executorAssignment` считает ДО транзакции
       * (Н3), и единственное, что мешает снятому исполнителю закрыть заявку, — `WHERE version = ?`.
       * Проверяется поэтому не «кто победил», а что победитель один: одновременный успех обоих
       * означал бы закрытие работ по снятому назначению.
       */
      const [reassigned, completed] = await Promise.all([
        inject('PUT', `/api/v1/service-requests/${request.id}/executors`, ctx.admin.auth, {
          userIds: [ctx.strayExecutor.id],
          serviceCounterpartyId: null,
          // Причина обязательна: переназначение отбирает работу у прежнего исполнителя. Без неё
          // запрос упирался бы в 422 формы ВСЕГДА — то есть гонки не было бы вовсе, побеждало бы
          // закрытие работ, и случай доказывал бы валидацию тела вместо одновременности.
          reason: 'заявку передают другому исполнителю',
          version: before.version,
        }),
        inject('PATCH', `/api/v1/service-requests/${request.id}/complete`, ctx.executor.auth, {
          completedOn: TODAY,
          items: before.items.map((item) => ({ id: item.id, performed: true })),
          version: before.version,
        }),
      ]);

      const codes = [reassigned.statusCode, completed.statusCode];
      expect(
        codes.filter((code) => code === 200),
        `${reassigned.body}\n${completed.body}`,
      ).toHaveLength(1);

      /*
       * ПРОИГРАВШИЙ ОБЯЗАН ПОЛУЧИТЬ ОТКАЗ, И ОТКАЗ ПО СМЫСЛУ СЦЕНАРИЯ. Кодов законных три, и они не
       * взаимозаменяемы — каждый называет свой рубеж, на котором опоздавшего остановили:
       *
       *   • 409 `version_conflict` — сверка ревизии: победитель поднял версию первым;
       *   • 403 — сторона или статус: работы уже закрыты, и в «Решена» состав не меняют (либо
       *     наоборот — исполнителя сняли, и закрывать работы ему больше нечего);
       *   • 422 — состояние записи: переназначение упирается в предъявленный объём работ.
       *
       * Проверяется поэтому не один код из перечня, а пара «код + смысл». Голый перечень статусов
       * пропустил бы 404 «заявка не найдена» и 422 «укажите причину» — оба выглядят отказом и оба
       * означали бы, что проигравшая сторона проиграла НЕ ГОНКЕ, а опечатке в запросе. Отдельной
       * строкой поэтому отсекается `not_found`: он в перечень статусов не входит, но именно им
       * ответил бы сервер на разъехавшуюся фикстуру, и в паре с широким перечнем такую подмену
       * было бы уже не видно.
       */
      const loser = reassigned.statusCode === 200 ? completed : reassigned;
      expect([403, 409, 422], loser.body).toContain(loser.statusCode);
      expect(codeOf(loser), loser.body).not.toBe('not_found');
      expect(messageOf(loser), loser.body).not.toContain('Укажите причину');
      expect(messageOf(loser).length, loser.body).toBeGreaterThan(0);

      const after = await card(request.id, ctx.admin.auth);
      if (reassigned.statusCode === 200) {
        /*
         * Переназначение победило — значит работы НЕ закрыты снятым исполнителем, и это главное.
         * Статус при этом «Новая», а не «В работе»: переназначение ИЗ «В работе» возвращает заявку
         * в «Новую», чтобы новый исполнитель нажал «Принять в работу» сам (Р5). Проверяются оба
         * факта, и первым — отсутствие «Решена»: разъедься дуга Р5 с этим ожиданием, случай обязан
         * сказать «статус не тот», а не промолчать о том, что заявку всё-таки закрыли.
         */
        expect(after.status).not.toBe('done');
        expect(after.status).toBe('new');
        expect(after.executors.map((e) => e.userId)).toEqual([ctx.strayExecutor.id]);
      } else {
        // Победило закрытие — состав остался прежним: снять исполнителя опоздавший запрос не смог.
        expect(after.status).toBe('done');
        expect(after.executors.map((e) => e.userId)).toEqual([ctx.executor.id]);
      }
    });

    /**
     * ПОСЛЕДОВАТЕЛЬНАЯ ПОЛОВИНА Н3 ЗАКРЫТА — И ТОЖЕ НЕ ЭТИМ ПЛАНОМ.
     *
     * Находка про то, что у подшивки нет ни стороны, ни версии в теле, и `lockRequest` она не
     * берёт. Отсюда следовало, что снятый исполнитель кладёт закрывающий документ в окне между
     * отзывом назначения и обновлением своей вкладки.
     *
     * Сегодня не кладёт, и по той же причине, что в §6.11: аудитория считается по свежему
     * `executorAssignment` на каждом запросе (`serviceRequestAudienceOf`), снятый исполнитель
     * `finance` не имеет — ни своим набором, ни назначением, которого больше нет, — и `act` ему
     * закрыт потолком аудитории.
     *
     * ЧТО ЭТИМ НЕ ДОКАЗАНО. Н3 говорит про ОКНО, а не про порядок ходов: аудитория по-прежнему
     * считается вне транзакции и без блокировки строки, и запрос, вышедший одновременно с отзывом
     * назначения, застаёт прежний ответ. Гонку эту случай не воспроизводит — её закрывает Р4, и
     * доказательство ей нужно своё. Здесь проверено ровно то, что видно последовательным ходом:
     * ПОСЛЕ снятия дверь заперта.
     */
    it('§6.13 снятый исполнитель не подшивает акт: аудитория пересчитана по строке', async () => {
      const request = await namedRequestReady(ctx.executor, 'Акт от снятого исполнителя');
      await assign(request.id, {
        userIds: [ctx.strayExecutor.id],
        reason: 'заявку ведёт другой сотрудник',
      });

      const { res } = await attach(request.id, 'act', ctx.executor);
      expect(res.statusCode, res.body).toBe(403);
      // Тот же рубеж, что и у заказчика: снятие назначения отобрало `finance`, а с ним и право
      // класть закрывающий документ. Токен при этом ТОТ ЖЕ — субъект не перезаходил (И3).
      expect(messageOf(res)).toContain('прикладывает исполнитель, а не заявитель');
    });

    /**
     * §6.13, ГОНКА — то, чего последовательный случай выше не доказывает и доказать не может (Р4).
     *
     * До Э5 `POST /:id/files` не брала блокировку строки и считала признаки назначения ДО
     * транзакции: версии в теле у подшивки нет, страховать окно между чтением и `COMMIT` было
     * нечем, и снятый исполнитель успевал положить закрывающий документ — а именно он снимает
     * планку `serviceRequestNeedsClosingDocument`.
     *
     * ПОЧЕМУ ОКНО ОТКРЫВАЕТСЯ РУКАМИ, А НЕ `Promise.all`. Два одновременных запроса дают гонку,
     * исход которой решает планировщик: в половине прогонов подшивка успевает ПЕРВОЙ и отвечает
     * `200` совершенно законно — на тот момент субъект ещё исполнитель. Случай, зелёный по такой
     * причине, не доказывает ничего. Поэтому очередь выстраивается явно: сторонняя транзакция
     * держит строку заявки `FOR UPDATE`, обе ручки упираются в неё и встают в очередь ожидания
     * известным порядком — сперва переназначение, следом подшивка. Ждать друг друга их заставляет
     * та самая блокировка, ради которой этап и делался: до неё подшивка не ждала ничего.
     *
     * Проверяется поэтому пара «ровно один успех + чего нет в карточке»: переназначение проходит,
     * подшивка отвечает `403`, и акта в заявке не появляется. До Э5 успехов было ДВА, и в заявке
     * лежал акт снятого исполнителя.
     */
    it('§6.13 подшивка в окне переназначения: снятый исполнитель не кладёт акт', async () => {
      const request = await namedRequestReady(ctx.executor, 'Акт в окне переназначения');
      const version = await versionOf(request.id);
      const fileId = await uploadedFile(ctx.executor.id, `act-race-${randomUUID()}.pdf`);

      // Своё соединение, мимо пула приложения: пул нужен самим ручкам, и занятая им строка
      // заперла бы прогон, а не заявку.
      const holder = new pg.Client({ connectionString: DB_URL });
      await holder.connect();
      let reassigned: Injected;
      let attached: Injected;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM service_requests WHERE id = $1 FOR UPDATE', [
          request.id,
        ]);

        /*
         * `Promise.resolve` вокруг `inject` — не украшение. `app.inject` возвращает не промис, а
         * цепочку light-my-request: запрос уходит в приложение, только когда у неё позовут `then`,
         * то есть на `await`. Оставь мы `const p = inject(...)`, обе ручки стартовали бы уже ПОСЛЕ
         * `COMMIT`, никакой очереди у блокировки не возникло бы, и случай доказывал бы
         * последовательный ход — тот самый, что уже проверен соседом. `Promise.resolve` зовёт
         * `then` сразу и отправляет запрос сейчас.
         */
        const reassigning = Promise.resolve(
          inject('PUT', `/api/v1/service-requests/${request.id}/executors`, ctx.admin.auth, {
            userIds: [ctx.strayExecutor.id],
            serviceCounterpartyId: null,
            reason: 'заявку передают другому исполнителю',
            version,
          }),
        );
        // Очередь ожидания у строки — FIFO, и порядок в ней задаётся тем, кто первым УПЁРСЯ в
        // блокировку, а не тем, кого первым отправили: между `inject` и `FOR UPDATE` у ручки стоит
        // разбор запроса, чтение заявки и подготовка письма. Поэтому следующий запрос уходит
        // только после того, как предыдущий встал в очередь, — иначе порядок решал бы планировщик.
        const queuedFirst = await waitForBlocked(holder, 1);
        const attaching = Promise.resolve(
          inject('POST', `/api/v1/service-requests/${request.id}/files`, ctx.executor.auth, {
            fileIds: [fileId],
            kind: 'act',
          }),
        );
        // Ждать подшивку вторым ожиданием обязательно: не встань она в очередь до `COMMIT`, она
        // прошла бы по прежнему назначению — то есть по тому самому окну, которое проверяется.
        // Не дождались — значит блокировки у ручки нет, и это и есть находка Н3.
        const queued = await waitForBlocked(holder, 2);
        await holder.query('COMMIT');
        [reassigned, attached] = await Promise.all([reassigning, attaching]);
        // Оба ожидания проверяются, и по отдельности: не встань в очередь ПЕРВОЙ переназначение —
        // порядок в очереди решил бы планировщик, и случай проверял бы не то, что заявлено.
        expect(queuedFirst, 'переназначение не встало в очередь первым').toBe(true);
        expect(
          queued,
          `подшивка не встала в очередь за блокировкой строки заявки (ответы: ${reassigned.statusCode} и ${attached.statusCode})`,
        ).toBe(true);
      } finally {
        await holder.end();
      }

      expect(reassigned.statusCode, reassigned.body).toBe(200);
      expect(attached.statusCode, attached.body).toBe(403);
      // Отказ пересчитан ПОСЛЕ снятия: субъект перестал быть исполнителем, вместе со стороной у
      // него пропала и финансовая аудитория, и первым отвечает аудиторный слой. Токен тот же —
      // вкладка снятого исполнителя даже не успела обновиться (И3).
      expect(messageOf(attached)).toContain('прикладывает исполнитель, а не заявитель');

      const after = await card(request.id, ctx.admin.auth);
      expect(after.executors.map((e) => e.userId)).toEqual([ctx.strayExecutor.id]);
      // Главное: акта в заявке нет вовсе. Останься он — «Решена» прошла бы по бумаге того, кто
      // заявке уже никто (К5).
      expect(after.files.map((f) => f.kind)).toEqual([]);
      // Срок случая свой: он дважды ждёт очереди у блокировки, и пятисекундного умолчания vitest
      // на два ожидания подряд не хватает даже при мгновенном ответе сервера.
    }, 20_000);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // §6.14–§6.17. Прямые запросы и косвенные пути
  // ────────────────────────────────────────────────────────────────────────────────────────────

  describe('прямые запросы и косвенные пути (§6.14–§6.17)', () => {
    it('§6.14 файл чужой заявки по прямой ссылке — 404, и это не «нет файла»', async () => {
      const request = await namedRequestReady(ctx.executor, 'Документ чужой площадки');
      const { fileId, res } = await attach(request.id, 'act', ctx.executor);
      expect(res.statusCode, res.body).toBe(200);

      const denied = await inject('GET', `/api/v1/files/${fileId}/download`, ctx.foreignShtab.auth);
      /*
       * ОЖИДАЕТСЯ АНТИОРАКУЛЬНЫЙ 404. Прежняя оговорка «403 до плана карточки заявителя» больше не
       * действует: план карточки свою волну выкатил, и `canAccessFile` отвечает на недоступный
       * файл «не найден» — тем же ответом, что и на несуществующий. Это не потеря доказательства,
       * а его усиление: 403 подтверждал бы стороннему человеку, что файл с таким id есть, — то
       * есть отвечал бы на вопрос, которого ему задавать не положено (И4 разрешает обе формы
       * отказа, 403 и 404, и выбор между ними — предмет плана карточки, а не этого).
       *
       * Файл при этом настоящий и только что подшит своим исполнителем — строкой выше видно, что
       * подшивка прошла. Значит 404 здесь означает ровно «вам не видно», а не «нечего показывать»:
       * исчезни файл на самом деле, красным стал бы предыдущий шаг.
       */
      expect(denied.statusCode, denied.body).toBe(404);
    });

    it('§6.15 история ремонтов чужой единицы закрыта справочником, а не журналом', async () => {
      const request = await namedRequestReady(ctx.executor, 'История ремонтов чужой единицы');
      const equipmentId = (await card(request.id, ctx.admin.auth)).equipment!.id;

      // Штаб соседней площадки не доходит до истории вовсе: его отбивает область справочника.
      const foreign = await inject(
        'GET',
        `/api/v1/office-equipment/${equipmentId}`,
        ctx.foreignShtab.auth,
      );
      expect(foreign.statusCode, foreign.body).toBe(403);

      /*
       * А сервисную компанию отбивает ПРАВО справочника, которого у неё нет. Именно на этом внешнем
       * факте и держатся две неполные копии правила области (Н4: `loadServiceHistory` и
       * `office-equipment-history.ts` знают одну ось заказчика). Случай фиксирует допущение вслух:
       * открой кому-нибудь `officeEquipment.read` — и история единицы отдаст заявки всех
       * подрядчиков, не оставив следа в логе.
       */
      const service = await inject(
        'GET',
        `/api/v1/office-equipment/${equipmentId}`,
        ctx.serviceA.auth,
      );
      expect(service.statusCode, service.body).toBe(403);

      // Держатель области видит свою же историю — иначе случай доказывал бы неработающую ручку.
      const own = await inject('GET', `/api/v1/office-equipment/${equipmentId}`, ctx.operator.auth);
      expect(own.statusCode, own.body).toBe(200);
      const history = (own.json() as { serviceHistory?: unknown[] }).serviceHistory ?? [];
      expect(history.length).toBeGreaterThan(0);
    });

    it('§6.16 журнал остатка расходников не обещает чужую заявку', async () => {
      const consumable = await inject(
        'POST',
        '/api/v1/office-equipment-consumables',
        ctx.admin.auth,
        {
          code: `ДSEA${RUN.toUpperCase()}1`,
          name: `Тонер доступа ${RUN} (шт)`,
          quantity: 5,
          color: null,
          comment: '',
        },
      );
      expect(consumable.statusCode, consumable.body).toBe(201);
      const consumableId = (consumable.json() as { id: string }).id;

      const request = await createRequest(ctx.customer.auth, ctx.objectAId, 'Нужны картриджи', {
        kind: 'consumable',
        consumables: [{ consumableId, requestedQuantity: 2 }],
      });
      await assign(request.id, { userIds: [ctx.executor.id] });
      const started = await inject(
        'PATCH',
        `/api/v1/service-requests/${request.id}/start`,
        ctx.executor.auth,
        { version: await versionOf(request.id) },
      );
      expect(started.statusCode, started.body).toBe(200);
      const lineId = (started.json() as ServiceRequestDto).consumables[0]!.id;
      const issued = await inject(
        'PATCH',
        `/api/v1/service-requests/${request.id}/consumables/issued`,
        ctx.executor.auth,
        { items: [{ id: lineId, issuedQuantity: 2 }], version: await versionOf(request.id) },
      );
      expect(issued.statusCode, issued.body).toBe(200);

      /*
       * Остаток на складе один на компанию, и сам журнал не прячется ни от кого, у кого открыт
       * справочник, — прячется ССЫЛКА: `requestAccessible` считается теми же двумя осями, что и
       * список заявок. Проверяется именно признак: штаб соседней площадки видит движение склада,
       * но заявку за ним открыть не может, и портал не должен предлагать ему переход в 403.
       */
      const entries = async (auth: Auth) => {
        const res = await inject(
          'GET',
          `/api/v1/office-equipment-consumables/${consumableId}/stock-entries?pageSize=50`,
          auth,
        );
        expect(res.statusCode, res.body).toBe(200);
        return (
          res.json() as { items: { serviceRequestId: string | null; requestAccessible: boolean }[] }
        ).items.filter((row) => row.serviceRequestId === request.id);
      };

      const foreign = await entries(ctx.foreignShtab.auth);
      expect(foreign.length).toBeGreaterThan(0);
      expect(foreign.every((row) => row.requestAccessible === false)).toBe(true);
      // …и она же открыта тому, чья это заявка: признак обязан различать, а не просто молчать.
      const own = await entries(ctx.operator.auth);
      expect(own.every((row) => row.requestAccessible === true)).toBe(true);
    });

    it('§6.17 «отметить все прочитанными» гасит только видимые заявки', async () => {
      const mine = await namedRequestReady(ctx.executor, 'Своя заявка с перепиской');
      const foreign = await createRequest(
        ctx.foreignShtab.auth,
        ctx.objectBId,
        'Чужая площадка с перепиской',
      );

      for (const id of [mine.id, foreign.id]) {
        const posted = await inject(
          'POST',
          `/api/v1/service-requests/${id}/messages`,
          ctx.admin.auth,
          {
            body: `реплика прогона ${RUN}`,
            addressees: { sides: ['all'], users: [] },
          },
        );
        expect(posted.statusCode, posted.body).toBe(200);
      }

      const readAll = await inject(
        'POST',
        '/api/v1/service-requests/messages/read-all',
        ctx.executor.auth,
        {},
      );
      expect(readAll.statusCode, readAll.body).toBe(200);

      /*
       * Проверяется не число в ответе, а СОСТАВ погашенного: `count` считает строки курсора, и
       * совпасть он мог бы случайно. Курсоры читаются прямо из таблицы — ручки «покажи мои
       * отметки» у портала нет, а предмет проверки как раз в том, что отметка не поставилась там,
       * где заявка не видна.
       */
      const cursors = await ctx.db.execute<{ request_id: string }>(sql`
        SELECT request_id FROM service_request_message_reads WHERE user_id = ${ctx.executor.id}::uuid`);
      const marked = cursors.rows.map((row) => row.request_id);
      expect(marked).toContain(mine.id);
      expect(marked).not.toContain(foreign.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // §6.18. Повтор служебного письма
  // ────────────────────────────────────────────────────────────────────────────────────────────

  describe('повтор письма службе (§6.18)', () => {
    /**
     * Заявка, у которой есть что повторять: событие письма привязано к входу в статус, и
     * повторяются ровно два — «Новая» (службу зовут разобрать заявку) и «Отменена» (чтобы не
     * выезжали зря).
     *
     * И ВОТ ЧТО ВЫЯСНИЛОСЬ ПРИ ПРОГОНЕ, а по чтению плана видно не было. Отмена САМА снимает
     * сторону: `serviceResetOnTransition` на дуге в `cancelled` ставит `executor: true`, а он и
     * обнуляет `service_counterparty_id`, и удаляет строки `service_request_executors` — «заявка
     * снова ничья». Значит ни у одной повторяемой заявки стороны исполнителя нет: у отменённой её
     * сняли переходом, у нераспределённой «Новой» её не было (иначе `serviceMailRepeatable`
     * ответил бы «нечего повторять»).
     *
     * Помощник поэтому назначает подрядчика ДО отмены и возвращает уже осиротевшую строку, а факт
     * сиротства проверяет вслух: на нём держатся оба случая ниже, и молчаливым он был бы
     * допущением, которое однажды перестанет быть верным.
     */
    async function cancelledAfterService(description: string): Promise<ServiceRequestDto> {
      const dto = await createRequest(ctx.customer.auth, ctx.objectAId, description);
      await assign(dto.id, { serviceCounterpartyId: ctx.counterpartyAId });
      const cancelled = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/status`,
        ctx.operator.auth,
        {
          status: 'cancelled',
          reason: 'заявка снята заказчиком',
          version: await versionOf(dto.id),
        },
      );
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      const row = await card(dto.id, ctx.admin.auth);
      expect(row.service, 'отмена обязана снять подрядчика').toBeNull();
      expect(row.executors, 'отмена обязана очистить поимённый состав').toEqual([]);
      return row;
    }

    it('§6.18 повтор доступен «Ведению» и администратору, держателю execute — нет', async () => {
      const repeatable = await cancelledAfterService('Повтор письма: своя сторона');

      /*
       * Поимённый исполнитель отбивается СТРАЖЕМ, и до стороны запрос не доходит:
       * `POST /:id/notify` закрыт правом `serviceRequests.status`, которого нет ни в наборе
       * исполнителя, ни у роли штаба. Спрашивается это на ЖИВОЙ заявке, где субъект и правда
       * назван исполнителем: на повторяемой назвать его нельзя — отмена состав сбросила бы, — и
       * случай доказывал бы пустой состав вместо стороны.
       */
      const own = await namedRequestReady(ctx.executor, 'Повтор письма: назначенный исполнитель');
      const byExecutor = await inject(
        'POST',
        `/api/v1/service-requests/${own.id}/notify`,
        ctx.executor.auth,
        { idempotencyKey: randomUUID() },
      );
      expect(byExecutor.statusCode, byExecutor.body).toBe(403);
      expect(messageOf(byExecutor)).toContain('Недостаточно прав для смены статуса');

      // «Ведение» повторяет: набор у него выдан, заявка в его области, событие повторяемо.
      const byOperator = await inject(
        'POST',
        `/api/v1/service-requests/${repeatable.id}/notify`,
        ctx.operator.auth,
        { idempotencyKey: randomUUID() },
      );
      expect(byOperator.statusCode, byOperator.body).toBe(200);

      /*
       * Администратор — вторая половина стороны (Р9), и проверяется она отдельно: кодов наборов у
       * него нет вовсе, и держись дверь на одном коде — разбирать застрявшее стало бы некому.
       * Ключ идемпотентности свой: тот же ключ вернул бы прежний исход, ничего не спросив.
       */
      const byAdmin = await inject(
        'POST',
        `/api/v1/service-requests/${repeatable.id}/notify`,
        ctx.admin.auth,
        { idempotencyKey: randomUUID() },
      );
      expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    });

    /**
     * Н8 (`notify`) ЗАКРЫТА СТОРОНОЙ (Р9), и случай переписан вместе с кодом.
     *
     * Находка была про дверь без стороны: право `serviceRequests.status` есть и у типа контрагента
     * `service`, то есть подрядчик мог бы сам инициировать повтор СЛУЖЕБНОЙ рассылки. Прежде его
     * спасала одна область — повторяемых событий два, и в обоих исполнителя уже нет по построению,
     * — и прежняя редакция случая сверяла именно текст отказа ОБЛАСТИ. Это доказывало совпадение
     * построения, а не запрет: появись третье повторяемое событие, сохраняющее подрядчика, дверь
     * открылась бы молча.
     *
     * Теперь спрашивается сторона, и случай сверяет её отказ на заявке, которая подрядчику ВИДНА:
     * область пройдена, назначение есть, право есть — и всё равно 403. Отказ области при этом
     * никуда не делся и проверяется тут же, второй половиной: по чужой заявке до стороны дело
     * по-прежнему не доходит, и порядок «сперва область, потом сторона» виден по текстам.
     */
    it('§6.18 подрядчик не повторяет письмо и по СВОЕЙ заявке: его отбивает сторона', async () => {
      const own = await createRequest(
        ctx.customer.auth,
        ctx.objectAId,
        'Повтор письма: заявка самого подрядчика',
      );
      await assign(own.id, { serviceCounterpartyId: ctx.counterpartyAId });
      // Заявка ему видна — иначе доказывать было бы нечего: отказ пришёл бы от области.
      expect((await card(own.id, ctx.serviceA.auth)).id).toBe(own.id);

      const bySide = await inject(
        'POST',
        `/api/v1/service-requests/${own.id}/notify`,
        ctx.serviceA.auth,
        { idempotencyKey: randomUUID() },
      );
      expect(bySide.statusCode, bySide.body).toBe(403);
      expect(messageOf(bySide)).toContain('не повторяет письмо службе — это шаг ведущего заявку');
      /*
       * Отказ обязан быть про СТОРОНУ, а не про состояние: у «Новой» с назначенным подрядчиком
       * повторять и правда нечего (`serviceMailRepeatable`), и ответь сервер 422 — дверь осталась
       * бы открытой, а случай зелёным. Порядок проверок здесь и проверяется.
       */
      expect(bySide.statusCode).not.toBe(422);
      expect(messageOf(bySide)).not.toContain('Нечего повторять');

      // Чужая заявка — по-прежнему область: сторона до неё не доходит, и это не дубль первой
      // половины, а порядок рубежей.
      const foreign = await cancelledAfterService('Повтор письма: чужая заявка подрядчика');
      const byScope = await inject(
        'POST',
        `/api/v1/service-requests/${foreign.id}/notify`,
        ctx.serviceA.auth,
        { idempotencyKey: randomUUID() },
      );
      expect(byScope.statusCode, byScope.body).toBe(403);
      expect(messageOf(byScope)).toContain('Сервисная компания работает только с назначенными');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Р7. Назначают только тех, кто сможет работать
  // ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ. Назначение — единственное место модуля, где доступ ВЫДАЮТ: строка
   * `service_request_executors` открывает заявку сама (третья ось, Р1). Значит и спрос с неё
   * особый: поставленный исполнителем обязан суметь работать, а «он был пригоден, когда я открывал
   * окно» доказательством не является — набор отбирают ровно между открытием списка и нажатием
   * кнопки.
   *
   * ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ: проверки «видит ли кандидат заявку сейчас». Она отменила бы ровно ту
   * ось, ради которой всё делалось, — назначение как раз и открывает заявку сисадмину соседней
   * площадки (§6.5). Пригодность спрашивается о САМОЙ УЧЁТКЕ, а не о её сегодняшней области.
   */
  describe('пригодность кандидата (Р7)', () => {
    /** Назначение без утверждения об исходе: помощник `assign` требует 200, а здесь ждут отказа. */
    async function assignRaw(
      id: string,
      userIds: string[],
      auth: Auth = ctx.admin.auth,
    ): Promise<Injected> {
      return inject('PUT', `/api/v1/service-requests/${id}/executors`, auth, {
        userIds,
        serviceCounterpartyId: null,
        reason: 'проба пригодности кандидата',
        version: await versionOf(id),
      });
    }

    it('исполнителем не становится тот, у кого нет полномочия исполнителя', async () => {
      const request = await createRequest(
        ctx.customer.auth,
        ctx.objectAId,
        'Пригодность: заказчика исполнителем не ставят',
      );
      // Заказчик заявку видит и даже завёл её — и всё равно не кандидат: пара «назначение +
      // `execute`» (И1) требует обеих половин, а одного назначения мало никогда.
      const res = await assignRaw(request.id, [ctx.customer.id]);
      expect(res.statusCode, res.body).toBe(422);
      expect(messageOf(res)).toContain('у учётки нет такого полномочия');
      expect((await card(request.id, ctx.admin.auth)).executors).toEqual([]);
    });

    it('подрядчика назначают компанией, а не поимённой строкой', async () => {
      const request = await createRequest(
        ctx.customer.auth,
        ctx.objectAId,
        'Пригодность: подрядчика поимённо не ставят',
      );
      /*
       * Отказ называет ПРИЧИНУ, а не «нет полномочия»: `serviceRequests.execute` в наборе типа
       * контрагента `service` нет и не появится, и общий текст предложил бы выдать полномочие там,
       * где выдавать его нельзя ни при каком составе набора.
       */
      const res = await assignRaw(request.id, [ctx.serviceA.id]);
      expect(res.statusCode, res.body).toBe(422);
      expect(messageOf(res)).toContain('назначают компанией целиком, а не поимённо');

      /*
       * Та же учётка, но компания УЖЕ на заявке — и отказ другой: предикат спрашивают о ПАРЕ
       * «кандидат ↔ заявка», а не об учётке вообще. Сторона у такого кандидата есть и без строки —
       * её даёт договор, — а поимённую запись отказ подрядчика (он снимает компанию целиком) потом
       * не убрал бы.
       */
      await assign(request.id, { serviceCounterpartyId: ctx.counterpartyAId });
      const assigned = await inject(
        'PUT',
        `/api/v1/service-requests/${request.id}/executors`,
        ctx.admin.auth,
        {
          userIds: [ctx.serviceA.id],
          serviceCounterpartyId: ctx.counterpartyAId,
          reason: 'проба пригодности кандидата',
          version: await versionOf(request.id),
        },
      );
      expect(assigned.statusCode, assigned.body).toBe(422);
      expect(messageOf(assigned)).toContain('уже назначенной на заявку');
    });

    /**
     * ГОНКА: право отобрали между открытием окна и нажатием кнопки.
     *
     * Кандидат пригоден в момент, когда окно спросило список, — и перестаёт быть пригодным, пока
     * запрос на назначение стоит в очереди за блокировкой заявки. Проверенный ДО транзакции, он
     * записался бы исполнителем, которому уже нечем работать: письмо-задание ушло бы, строка
     * осталась бы, а первый же его ход упёрся бы в стража маршрута.
     *
     * Приём тот же, что у §6.13: своё соединение держит строку `FOR UPDATE`, запрос встаёт в
     * очередь, набор отбирается СОСЕДНЕЙ таблицей (блокировка заявки её и не держит), и только
     * потом `COMMIT`. Отзыв поэтому гарантированно попадает в окно между открытием списка и
     * проверкой состава.
     */
    it('право, отобранное в окне назначения, отбивается под блокировкой заявки', async () => {
      const request = await createRequest(
        ctx.customer.auth,
        ctx.objectAId,
        'Пригодность: право отобрали в окне назначения',
      );
      // Список кандидатов, открытый ДО отзыва, — то самое «доказательство», которому верить
      // нельзя: сервер отвечает про сейчас, а нажимают потом.
      const before = await inject(
        'GET',
        `/api/v1/service-requests/executor-candidates?requestId=${request.id}`,
        ctx.admin.auth,
      );
      expect(before.statusCode, before.body).toBe(200);
      expect((before.json().items as { id: string }[]).map((row) => row.id)).toContain(
        ctx.raceExecutor.id,
      );

      const version = await versionOf(request.id);
      const holder = new pg.Client({ connectionString: DB_URL });
      await holder.connect();
      let assigned: Injected;
      let queued: boolean;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM service_requests WHERE id = $1 FOR UPDATE', [
          request.id,
        ]);
        // `Promise.resolve` — по той же причине, что в §6.13: цепочка light-my-request отправляет
        // запрос только когда у неё позовут `then`, и без этого он ушёл бы уже после `COMMIT`.
        const assigning = Promise.resolve(
          inject('PUT', `/api/v1/service-requests/${request.id}/executors`, ctx.admin.auth, {
            userIds: [ctx.raceExecutor.id],
            serviceCounterpartyId: null,
            reason: 'назначение в окне отзыва набора',
            version,
          }),
        );
        queued = await waitForBlocked(holder, 1);
        // Набор отбирают, пока запрос стоит в очереди. Не дождались очереди — значит проверка
        // прошла до блокировки, и отзыв в окно не попал: об этом скажет утверждение ниже.
        await revokeExecutorGrant(ctx.raceExecutor.id);
        await holder.query('COMMIT');
        assigned = await assigning;
      } finally {
        await holder.end();
      }

      expect(queued, 'назначение не встало в очередь за блокировкой заявки').toBe(true);
      expect(assigned.statusCode, assigned.body).toBe(422);
      expect(messageOf(assigned)).toContain('у учётки нет такого полномочия');
      // Главное: строки в заявке нет. Появись она — человек числился бы исполнителем, не имея ни
      // одного его хода (К5).
      expect((await card(request.id, ctx.admin.auth)).executors).toEqual([]);
    }, 20_000);

    it('список кандидатов спрашивает заявку и её область', async () => {
      const own = await createRequest(
        ctx.customer.auth,
        ctx.objectAId,
        'Кандидаты: заявка своей площадки',
      );
      const foreign = await createRequest(
        ctx.foreignShtab.auth,
        ctx.objectBId,
        'Кандидаты: заявка чужой площадки',
      );

      // Заявки в запросе нет вовсе — 400 разбора: ручка отвечает про ЗАЯВКУ, и «кого вообще можно
      // назначить» она больше не отвечает никому.
      const nameless = await inject(
        'GET',
        '/api/v1/service-requests/executor-candidates',
        ctx.operator.auth,
      );
      expect(nameless.statusCode, nameless.body).toBe(400);

      // Область спрашивается у СПРАШИВАЮЩЕГО: «Ведение» площадки A о заявке площадки B узнаёт
      // ровно столько же, сколько о ней же в карточке.
      const outside = await inject(
        'GET',
        `/api/v1/service-requests/executor-candidates?requestId=${foreign.id}`,
        ctx.operator.auth,
      );
      expect(outside.statusCode, outside.body).toBe(403);
      expect(messageOf(outside)).toContain('работает только со своими объектами');

      const res = await inject(
        'GET',
        `/api/v1/service-requests/executor-candidates?requestId=${own.id}`,
        ctx.operator.auth,
      );
      expect(res.statusCode, res.body).toBe(200);
      const ids = (res.json().items as { id: string }[]).map((row) => row.id);
      // Держатели набора — кандидаты оба, и назначение тут ни при чём: список отвечает «кого можно
      // поставить», а не «кто уже стоит».
      expect(ids).toContain(ctx.executor.id);
      expect(ids).toContain(ctx.strayExecutor.id);
      // Заказчик и подрядчик — не кандидаты: у первого нет полномочия исполнителя, второго
      // назначают компанией.
      expect(ids).not.toContain(ctx.customer.id);
      expect(ids).not.toContain(ctx.serviceA.id);
      /*
       * А вот эти двое — доказательство того, ради чего список и переписан: набор у них отобрали
       * (§6.4 и случай гонки выше), и предлагать их окну нельзя — назначение им же и откажет.
       * Порядок случаев здесь важен и назван вслух: оба отзыва необратимы и сделаны раньше.
       */
      expect(ids).not.toContain(ctx.revokedExecutor.id);
      expect(ids).not.toContain(ctx.raceExecutor.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // К3. Витрина ⊆ карточка
  // ────────────────────────────────────────────────────────────────────────────────────────────

  describe('витрины ⊆ карточка (К3)', () => {
    it('ни один список, счётчик и реестр гарантий не показывает недоступную строку', async () => {
      /*
       * Свойство проверяется ПЕРЕБОРОМ, а не рассуждением: витрин у модуля четыре, отбираются они
       * тремя разными выражениями (`listWhere`, `visibility`, область справочника гарантий), и
       * доказать «они совпадают» можно только спросив у каждой, а потом сверив ответ с карточкой.
       *
       * Администратора в переборе нет намеренно: он видит всю общую базу, включая заявки соседних
       * тестов, и перебор превратился бы в проверку чужих данных. Все остальные учётки файла —
       * свежие и с областью, ограниченной фикстурами прогона.
       */
      const subjects: [string, TestUser][] = [
        ['заказчик площадки A', ctx.customer],
        ['«Ведение» площадки A', ctx.operator],
        ['внутренний исполнитель', ctx.executor],
        ['держатель набора без назначений', ctx.strayExecutor],
        ['штаб площадки B', ctx.foreignShtab],
        ['отдел A', ctx.deptUserA],
        ['отдел B', ctx.deptUserB],
        ['подрядчик A', ctx.serviceA],
        ['подрядчик B', ctx.serviceB],
      ];

      for (const [name, user] of subjects) {
        const ids = await listIds(user.auth);
        for (const id of ids) {
          const res = await inject('GET', `/api/v1/service-requests/${id}`, user.auth);
          expect(res.statusCode, `${name}: карточка ${id} — ${res.body}`).toBe(200);
        }

        // Счётчики отбираются той же `visibility`, что и список: строк они не отдают, поэтому
        // сверяется потолок — очередь и бейдж не бывают шире самого списка.
        const waiting = await inject('GET', '/api/v1/service-requests/waiting-count', user.auth);
        expect(waiting.statusCode, waiting.body).toBe(200);
        expect(waiting.json().count, `${name}: «ждут меня» шире списка`).toBeLessThanOrEqual(
          ids.length,
        );
        const unread = await inject('GET', '/api/v1/service-requests/unread-count', user.auth);
        expect(unread.statusCode, unread.body).toBe(200);
        expect(unread.json().count, `${name}: непрочитанное шире списка`).toBeLessThanOrEqual(
          ids.length,
        );

        // Реестр гарантий сужается дважды — областью заявок и правом справочника (комментарий
        // манифеста к `GET /warranties`), и строка ремонта несёт ссылку на заявку-источник.
        const warranties = await inject('GET', '/api/v1/service-requests/warranties', user.auth);
        expect(warranties.statusCode, warranties.body).toBe(200);
        const rows = (warranties.json() as { items: ServiceWarrantyRowDto[] }).items;
        for (const row of rows.filter((r) => r.requestId !== null)) {
          const res = await inject('GET', `/api/v1/service-requests/${row.requestId}`, user.auth);
          expect(res.statusCode, `${name}: гарантия ведёт в ${res.statusCode}`).toBe(200);
        }
      }
    }, 60_000);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // К6. Отказ по области и стороне виден в журнале
  // ────────────────────────────────────────────────────────────────────────────────────────────

  describe('журнал отказов (Р6, К6)', () => {
    /*
     * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ. До Э6 отказ по области или стороне не оставлял следа нигде:
     * `errorHandler` для статусов < 500 молчит, а `writeAudit` зовётся только на успехе (Н6).
     * Попытка подрядчика открыть чужую заявку по прямой ссылке была невидима. Теперь стражи
     * бросают `ServiceAccessDenied` с причиной и адресом заявки, а локальный `onError`-хук плагина
     * пишет `serviceRequest.access_denied`.
     *
     * ПОЧЕМУ СТРОКУ ВИДНО СРАЗУ ПОСЛЕ ОТВЕТА, без ожиданий и опросов: `onError` в Fastify
     * выполняется после обработчика ошибок, а ответ уходит клиенту только когда хук завершился.
     * Не будь это так, случай пришлось бы писать с ретраями — и он молча зеленел бы на медленной
     * базе, ничего не доказывая.
     *
     * ПОРОГ ПРОВЕРЯЕТСЯ НАРАВНЕ С ЗАПИСЬЮ. Журнал ценен ровно постольку, поскольку в нём лежат
     * попытки прямого запроса, а не весь поток отказов портала: три случая ниже требуют строку,
     * четвёртый и пятый требуют её ОТСУТСТВИЯ там, где событие не заведено.
     */

    /** Строка журнала как она есть: колонки и разобранные `metadata`. */
    interface DenialRow {
      entity_type: string;
      entity_id: string;
      actor_user_id: string;
      metadata: Record<string, unknown>;
    }

    /** Все отказы, записанные по этой сущности. Заявки случаев свежие — чужого сюда не попадает. */
    async function denials(entityId: string): Promise<DenialRow[]> {
      return (
        await ctx.db.execute<DenialRow>(sql`
          SELECT entity_type, entity_id, actor_user_id, metadata
            FROM audit_log
           WHERE action = 'serviceRequest.access_denied' AND entity_id = ${entityId}
           ORDER BY created_at`)
      ).rows;
    }

    it('К6 подрядчик, постучавшийся в чужую заявку, оставляет строку с причиной scope', async () => {
      const request = await createRequest(
        ctx.customer.auth,
        ctx.objectAId,
        'Заявка подрядчика A: прямую ссылку пробует подрядчик B',
      );
      await assign(request.id, { serviceCounterpartyId: ctx.counterpartyAId });

      const res = await inject('GET', `/api/v1/service-requests/${request.id}`, ctx.serviceB.auth);
      /*
       * ОТВЕТ ОБЯЗАН ОСТАТЬСЯ ПРЕЖНИМ ДО БУКВЫ — и код, и текст. Наблюдаемость не имеет права
       * стоить ни одного изменённого сообщения: `ServiceAccessDenied` наследует `AppError` ровно
       * ради этого, и случай сторожит именно это свойство, а не только появление строки.
       */
      expect(res.statusCode, res.body).toBe(403);
      expect(codeOf(res)).toBe('forbidden');
      expect(messageOf(res)).toBe('Сервисная компания работает только с назначенными ей заявками');

      const rows = await denials(request.id);
      expect(rows, JSON.stringify(rows)).toHaveLength(1);
      expect(rows[0]!.entity_type).toBe('serviceRequest');
      expect(rows[0]!.actor_user_id).toBe(ctx.serviceB.id);
      /*
       * Сверяется ВЕСЬ состав `metadata`, а не отдельные ключи: забытое поле — это вопрос, на
       * который журнал спустя месяцы не ответит («кем он тогда стучался»), и заметить пропажу
       * выборочной проверкой нельзя. Ключ маршрута — тот же, которым ручки названы в манифесте
       * области: строка журнала читается вместе со строкой ожидания.
       */
      expect(rows[0]!.metadata).toEqual({
        route: 'GET /api/v1/service-requests/:id',
        reason: 'scope',
        role: 'operator',
        counterpartyId: ctx.counterpartyBId,
      });
    });

    it('К6 снятый исполнитель, сделавший ход, оставляет строку с причиной side', async () => {
      const request = await namedRequestReady(ctx.executor, 'Ход снятого исполнителя в журнале');
      await assign(request.id, { userIds: [ctx.strayExecutor.id] });

      /*
       * До хода журнал по заявке ПУСТ, хотя за ней уже десяток успешных запросов: заведение,
       * назначение, взятие в работу, объём работ, предъявление, согласование, чтения карточки.
       * Это и есть вторая половина порога — успех не пишет ничего.
       */
      expect(await denials(request.id)).toEqual([]);

      const completed = await completeWork(request.id, ctx.executor.auth);
      expect(completed.statusCode, completed.body).toBe(403);
      expect(messageOf(completed)).toContain('не может перевести заявку');

      const rows = await denials(request.id);
      expect(rows, JSON.stringify(rows)).toHaveLength(1);
      expect(rows[0]!.actor_user_id).toBe(ctx.executor.id);
      expect(rows[0]!.metadata).toEqual({
        route: 'PATCH /api/v1/service-requests/:id/complete',
        reason: 'side',
        role: 'shtab',
        counterpartyId: null,
      });
    });

    /**
     * Отказ СТОРОНЫ у двери, где своего хода нет вовсе (Р9). Механизм тот же, что у случая выше, и
     * второго заводить не пришлось: `assertServiceOperatorSide` бросает тот же типизированный
     * отказ, а пишет его тот же хук плагина. Случай сторожит именно это — что новая дверь не
     * завела себе отдельную запись в журнал и не осталась вовсе без неё.
     */
    it('К6 подрядчик, повторяющий письмо по своей заявке, оставляет строку с причиной side', async () => {
      const request = await createRequest(
        ctx.customer.auth,
        ctx.objectAId,
        'Повтор письма подрядчиком в журнале',
      );
      await assign(request.id, { serviceCounterpartyId: ctx.counterpartyAId });
      // Заявка ему видна: до стороны дело доходит только после области, и без этой строки в
      // журнале лежала бы причина `scope`, а случай выглядел бы зелёным.
      expect(await denials(request.id)).toEqual([]);

      const res = await inject(
        'POST',
        `/api/v1/service-requests/${request.id}/notify`,
        ctx.serviceA.auth,
        { idempotencyKey: randomUUID() },
      );
      expect(res.statusCode, res.body).toBe(403);

      const rows = await denials(request.id);
      expect(rows, JSON.stringify(rows)).toHaveLength(1);
      expect(rows[0]!.actor_user_id).toBe(ctx.serviceA.id);
      expect(rows[0]!.metadata).toEqual({
        route: 'POST /api/v1/service-requests/:id/notify',
        reason: 'side',
        role: 'operator',
        counterpartyId: ctx.counterpartyAId,
      });
    });

    /** Сколько отказов записано по учётке: порог проверяется там, где `entityId` не бывает вовсе. */
    async function denialCount(actorUserId: string): Promise<number> {
      const rows = (
        await ctx.db.execute<{ n: string }>(sql`
          SELECT count(*) AS n
            FROM audit_log
           WHERE action = 'serviceRequest.access_denied'
             AND actor_user_id = ${actorUserId}::uuid`)
      ).rows;
      return Number(rows[0]!.n);
    }

    it('К6 отказ стража маршрута в журнал не идёт: право — не чужая заявка', async () => {
      const request = await namedRequestReady(ctx.executor, 'Отказ правом журнала не трогает');

      /*
       * Заказчику ручка закрытия работ закрыта САМИМ МАРШРУТОМ: `canEstimate` требует одно из двух
       * прав, и ни одного из них у него нет. Отказ приходит из `preHandler`, где ещё неизвестно, к
       * какой записи стучались, — и «нет права» не то же самое, что «чужая заявка»: правом отбивает
       * и обычную свою. Проверяется текст, а не только код: дойди запрос до области или стороны,
       * случай доказывал бы не тот рубеж.
       */
      const denied = await inject(
        'PATCH',
        `/api/v1/service-requests/${request.id}/complete`,
        ctx.customer.auth,
        { completedOn: TODAY, items: [], version: request.version },
      );
      expect(denied.statusCode, denied.body).toBe(403);
      expect(messageOf(denied)).toContain('Объём работ ведёт исполнитель');

      expect(await denials(request.id)).toEqual([]);

      /*
       * ЗАВЕДЕНИЕ — тоже мимо журнала, и по другой причине. Область там спрашивается по ПРЕДМЕТУ
       * будущей заявки, строки ещё нет, и отказ приходит без её адреса. Порог держится составом
       * самого отказа, а не перечнем ручек: `entityId` не назван — записи нет. Проверяется счётом
       * по учётке, потому что искать нечего — у такой строки и `entity_id` был бы пуст.
       */
      const before = await denialCount(ctx.foreignShtab.id);
      const created = await inject('POST', '/api/v1/service-requests', ctx.foreignShtab.auth, {
        officeEquipmentId: await makeEquipment(ctx.objectAId),
        description: 'Штаб площадки B заводит заявку по технике площадки A',
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
      });
      expect(created.statusCode, created.body).toBe(403);
      expect(messageOf(created)).toContain('работает только со своими объектами');
      expect(await denialCount(ctx.foreignShtab.id)).toBe(before);
    });

    it('К6 хук не протёк на соседей: отказ по области в чужом модуле строки не пишет', async () => {
      /*
       * ИНКАПСУЛЯЦИЯ FASTIFY — свойство, а не соглашение: хук, объявленный внутри плагина заявок,
       * в контекст маршрута соседнего плагина не попадает. Проверяется она отказом ПО ОБЛАСТИ у
       * соседа — справочник оргтехники отбивает штаб чужой площадки тем же по смыслу правилом и
       * тем же текстом, что и заявки. Не будь хук локальным, событие модуля заявок нашлось бы у
       * записи, которая заявкой не является вовсе.
       */
      const equipmentId = await makeEquipment(ctx.objectAId);
      const res = await inject(
        'GET',
        `/api/v1/office-equipment/${equipmentId}`,
        ctx.foreignShtab.auth,
      );
      expect(res.statusCode, res.body).toBe(403);
      expect(messageOf(res)).toContain('работает только со своими объектами');
      expect(await denials(equipmentId)).toEqual([]);

      /*
       * И то же свойство СРАЗУ ПО ВСЕМУ ПРОГОНУ, а не по одной пробе. За файлом остаётся хвост из
       * сотен запросов к соседям — справочник техники, расходники, склад, файлы, — и ни один их
       * отказ не имеет права оказаться в этом событии. Отбор по учёткам прогона: база общая, и
       * чужие строки в неё пишут соседние прогоны.
       */
      const strangers = (
        await ctx.db.execute<{ route: string | null }>(sql`
          SELECT metadata->>'route' AS route
            FROM audit_log
           WHERE action = 'serviceRequest.access_denied'
             AND actor_user_id IN (
                   SELECT id FROM users WHERE email LIKE ${`db-sea-%-${RUN}@example.invalid`})
             AND coalesce(metadata->>'route', '') NOT LIKE '% /api/v1/service-requests%'`)
      ).rows;
      expect(strangers, JSON.stringify(strangers)).toEqual([]);
    });
  });
});
