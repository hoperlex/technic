import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  ServiceChatPageDto,
  ServiceChatSide,
  ServiceRequestChatSummaryDto,
  ServiceRequestDto,
  ServiceRequestHistoryEntryDto,
  ServiceRequestStatus,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Обсуждение заявки на обслуживание оргтехники (ADR 0141,
 * `docs/office-equipment-chat-plan.md` §5 «База») — на живой схеме и через настоящие HTTP-пути.
 *
 * ЗАЧЕМ БАЗА. Всё, ради чего эта переписка устроена именно так, живёт в схеме, а не в коде:
 *
 *   • монотонный `seq` держится блокировкой строки заявки и уникальным индексом
 *     `(request_id, seq)` — на моках «параллельные отправки» неотличимы от последовательных;
 *   • протокол прочтения (§3.4) чинит гонку коммитов, и увидеть её можно ровно одним способом —
 *     двумя соединениями, где одно коммитит ПОСЛЕ того, как другое поставило отметку;
 *   • подсветка считается `EXISTS`-подзапросом и `IS DISTINCT FROM` (§3.5) — обе беды, которые
 *     они закрывают (двойной счёт и молча пропавшая перенесённая реплика), это ответы SQL, а не
 *     ветки TypeScript;
 *   • неизменяемость ленты держат пять триггеров и `xmin` (§3.3) — проверить их нечем, кроме
 *     прямого `UPDATE`/`DELETE` по таблице;
 *   • перенос примечания и его гонка с адаптером (§3.9) — это DO-блок миграции, взятый здесь
 *     дословно из файла `0216`, и его идемпотентность держится на частичном уникальном индексе;
 *   • стоимость счётчика (§3.5) отвечается планировщиком на засеянном объёме, а не рассуждением.
 *
 * ЧТО ГОТОВИТСЯ ПРЯМЫМ SQL И ПОЧЕМУ. Учётки, площадки, отделы, контрагенты, техника и сами заявки
 * — декорации: цикл заявки от заведения до приёмки проверяет `service-request-flow.db.test.ts`, и
 * повторять его здесь значило бы проверять чужой предмет чужими шагами. Предмет этого файла — то,
 * что происходит с лентой, и всё, что её касается, идёт настоящими ручками.
 *
 * Запуск (база своя, пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/oe_chat_test \
 *     pnpm --filter @technic/api test -- service-request-chat --run --no-file-parallelism
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`. Прогонять его в
 * общей базе вместе с другими файлами нельзя: счёт непрочитанного и план запроса считаются по
 * всему, что видно субъекту, и чужие заявки в той же области дали бы ложные падения.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

/**
 * Процедура переноса — ДОСЛОВНО из миграции `0216`, а не переписанная в тесте.
 *
 * Выпуск C копирует этот блок целиком (§3.10), и проверять здесь его пересказ значило бы проверять
 * пересказ: разойдись он с оригиналом на одну строку — тест остался бы зелёным, а миграция выпуска
 * C уронила бы накат. Поэтому блок вырезается из самого файла миграции.
 */
const TRANSFER_SQL = (() => {
  const path = fileURLToPath(new URL('../drizzle/0216_service_request_messages.sql', import.meta.url));
  const text = readFileSync(path, 'utf8');
  // Начало блока ищется с НАЧАЛА СТРОКИ: те же слова стоят в комментарии выше («копируется он
  // целиком, от `DO $migrate$` до конца»), и простой `indexOf` вырезал бы полкомментария.
  const start = text.search(/^DO \$migrate\$/m);
  const end = text.indexOf('$migrate$;', start + 'DO $migrate$'.length);
  if (start < 0 || end < 0) throw new Error('В миграции 0216 не найден DO-блок переноса примечаний');
  return text.slice(start, end + '$migrate$;'.length);
})();

/**
 * Проверка выпуска C (§3.10) — та самая, что стоит перед `DROP COLUMN`: перенесено ли ТЕКУЩЕЕ
 * значение колонки, а не «есть ли у заявки хоть какая-нибудь перенесённая реплика». Равенство
 * `body` рядом с хешем не украшение: `md5` не криптографическая гарантия, и совпадение хешей у
 * разных текстов обязано ловиться, пока колонка ещё цела.
 */
const CUTOVER_CHECK_SQL = `
DO $check$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM service_requests sr
   WHERE btrim(sr.service_comment) <> ''
     AND NOT EXISTS (
       SELECT 1 FROM service_request_messages m
        WHERE m.request_id = sr.id
          AND m.origin = 'import'
          AND m.imported_hash = md5(sr.service_comment)
          AND m.body = sr.service_comment
     );
  IF n > 0 THEN
    RAISE EXCEPTION 'Примечание исполнителя не перенесено у % заявок', n;
  END IF;
END
$check$;`;

interface Auth {
  authorization: string;
}

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: все права разом — и `operator`, и `it`. Им же проверяется п. 7. */
  admin: TestUser;
  /** Автор заявки — штаб площадки. Сторона `customer` и как аудитория, и как участник. */
  author: TestUser;
  /**
   * Коллега автора по площадке: заявка ему видна, в аудиторию «Заявителю» он входит, а участником
   * разговора не является. Единственная учётка, которой доказывается граница §3.1.
   */
  colleague: TestUser;
  /** «Оргтехника: ведение» — надстройка роли даёт `status` и `assign`, то есть сторону `operator`. */
  operator: TestUser;
  /** ИТ-служба: `approveIt` и сквозная область модуля. Сторона `it`, субъект module-wide для п. 16. */
  itSupport: TestUser;
  /** Учётка сервисной компании: сторона `service` через назначенного контрагента. */
  service: TestUser;
  /** Поимённый исполнитель: сторона `service` строкой в `service_request_executors`. */
  exec1: TestUser;
  /** Второй поимённый исполнитель: без него «поимённо одному» неотличимо от «стороне». */
  exec2: TestUser;
  objectId: string;
  /** Своя площадка под отсечку по `users.created_at` (п. 9): на ней ровно одна заявка. */
  freshObjectId: string;
  departmentId: string;
  serviceCounterpartyId: string;
  typeId: string;
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

/** Свой адрес на каждый вход и запрос: общий ограничитель считает обращения с адреса. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url,
    headers: auth,
    remoteAddress: nextAddress(),
    ...(payload ? { payload } : {}),
  });
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── Фикстуры ──

let unitNo = 0;

/**
 * Заявка вместе со своей единицей техники — прямым SQL.
 *
 * По единице разрешена одна открытая заявка (частичный уникальный индекс), поэтому единица у
 * каждой заявки своя; исключение — засев п. 16, где заявки закрытые и индексу не мешают.
 *
 * Одной транзакцией: назначение исполнителя проверяется отложенным триггером на COMMIT
 * (`service_requests_executor_present`), и вставь мы строки порознь — заявка в рабочем статусе
 * без исполнителя не прошла бы.
 */
async function makeRequest(input: {
  tag: string;
  status?: ServiceRequestStatus;
  withService?: boolean;
  executors?: readonly string[];
  objectId?: string;
  /** Тип единицы: им отбирает список, и по нему же кнопка «Отметить все» обязана промахиваться. */
  typeId?: string;
  /** Автор заявки: он же её сторона `customer` — то есть тот, кто в ней вправе писать. */
  createdBy?: string;
  serviceComment?: string;
}): Promise<string> {
  unitNo += 1;
  const objectId = input.objectId ?? ctx.objectId;
  const typeId = input.typeId ?? ctx.typeId;
  const createdBy = input.createdBy ?? ctx.author.id;
  const status = input.status ?? 'in_work';
  const executors = input.executors ?? [];
  const counterparty = input.withService ? ctx.serviceCounterpartyId : null;
  return ctx.db.transaction(async (tx) => {
    const eq = await tx.execute<{ id: string }>(sql`
      INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id, location)
      VALUES (${typeId}, ${`Чат-МФУ ${input.tag} ${RUN}`}, ${`ОЧ-${RUN}-${unitNo}`},
              ${objectId}, 'кабинет 101')
      RETURNING id`);
    const equipmentId = eq.rows[0]!.id;
    const req = await tx.execute<{ id: string }>(sql`
      INSERT INTO service_requests (office_equipment_id, equipment_object_id, equipment_name,
                                    equipment_inventory_number, description, created_by, status,
                                    service_counterparty_id, service_comment)
      VALUES (${equipmentId}, ${objectId}, ${`Чат-МФУ ${input.tag} ${RUN}`},
              ${`ОЧ-${RUN}-${unitNo}`}, ${`обсуждение ${input.tag}`}, ${createdBy},
              ${sql.raw(`'${status}'::service_request_status`)}, ${counterparty},
              ${input.serviceComment ?? ''})
      RETURNING id`);
    const requestId = req.rows[0]!.id;
    for (const userId of executors) {
      await tx.execute(sql`
        INSERT INTO service_request_executors (request_id, user_id, assigned_by)
        VALUES (${requestId}, ${userId}, ${ctx.admin.id})`);
    }
    return requestId;
  });
}

/** Полная заявка со всеми четырьмя сторонами: контрагент-исполнитель и два поимённых. */
function makeFullRequest(tag: string, status: ServiceRequestStatus = 'in_work'): Promise<string> {
  return makeRequest({
    tag,
    status,
    withService: true,
    executors: [ctx.exec1.id, ctx.exec2.id],
  });
}

/**
 * Площадка, заведённая случаем для себя. Нужна там, где предмет проверки — ЧИСЛО по всей области
 * субъекта (бейдж, ответ кнопки «Отметить все»): восемь учёток фикстуры сидят на одной площадке, и
 * заявки соседних случаев легли бы в тот же счёт — ожидаемое «2» стало бы зависеть от порядка
 * прогона, а не от предмета проверки.
 *
 * Код начинается с `OCH-` и кончается меткой прогона: уборка `afterAll` ищет площадки ровно так.
 */
async function makeObject(tag: string): Promise<string> {
  const created = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${`OCH-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 3')
    RETURNING id`);
  return created.rows[0]!.id;
}

/**
 * Учётка, заведённая ПРЯМО СЕЙЧАС, на названных площадках и без единой надстройки: чистый штаб.
 * Стороной разговора такой человек становится только авторством заявки (`customer`), и это ровно
 * тот случай, ради которого кнопка «Отметить все прочитанными» и заведена.
 *
 * Своя учётка на случай — не прихоть: непрочитанным считается лишь написанное после
 * `users.created_at` читателя (п. 9), поэтому заведённый здесь человек не видит ничего, кроме
 * реплик самого случая, — сколько бы ленты ни осталось от соседних.
 *
 * Адрес той же формы, что у фикстурных: уборка `afterAll` уносит их одним `LIKE`.
 */
async function makeNewcomer(tag: string, objectIds: readonly string[]): Promise<TestUser> {
  const { hashPassword } = await import('../src/auth/password');
  const email = `db-chat-${tag}-${RUN}@example.invalid`;
  const created = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                       is_active, email_verified_at)
    VALUES (${email}, 'Тестовый', 'Участник', ${tag}, ${await hashPassword(PASSWORD)},
            'shtab'::role, true, now())
    RETURNING id`);
  const id = created.rows[0]!.id;
  for (const objectId of objectIds) {
    await ctx.db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${id}, ${objectId})`);
  }
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
    remoteAddress: nextAddress(),
  });
  expect(login.statusCode, login.body).toBe(200);
  return { id, email, auth: { authorization: `Bearer ${login.json().accessToken}` } };
}

// ── Обращения к обсуждению ──

interface Addressees {
  sides?: ServiceChatSide[];
  users?: string[];
}

function say(auth: Auth, id: string, body: string, to: Addressees) {
  return inject('POST', `/api/v1/service-requests/${id}/messages`, auth, {
    body,
    addressees: { sides: to.sides ?? [], users: to.users ?? [] },
  });
}

/** Отправка, которая обязана пройти: возвращает номер созданной реплики. */
async function said(auth: Auth, id: string, body: string, to: Addressees): Promise<number> {
  const res = await say(auth, id, body, to);
  expect(res.statusCode, res.body).toBe(200);
  const payload = res.json() as { message: { seq: number }; lastSeq: number };
  expect(payload.lastSeq).toBe(payload.message.seq);
  return payload.message.seq;
}

async function page(
  auth: Auth,
  id: string,
  query = '',
): Promise<ServiceChatPageDto> {
  const res = await inject('GET', `/api/v1/service-requests/${id}/messages${query}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceChatPageDto;
}

function markRead(auth: Auth, id: string, throughSeq: number) {
  return inject('POST', `/api/v1/service-requests/${id}/messages/read`, auth, { throughSeq });
}

/**
 * «Отметить все прочитанными»: телом приходит ТОТ ЖЕ отбор, что и списку, а ответом — число заявок,
 * у которых курсор действительно сдвинулся. Возвращается именно оно: портал показывает его человеку
 * («Отмечено прочитанными заявок: N»), и ноль в нём означает «непрочитанного не было».
 */
async function readAll(auth: Auth, filter: Record<string, string> = {}): Promise<number> {
  const res = await inject('POST', '/api/v1/service-requests/messages/read-all', auth, filter);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { count: number }).count;
}

/** Блок `chat` карточки: то, из чего портал рисует обе метки. */
async function chatOf(auth: Auth, id: string): Promise<ServiceRequestChatSummaryDto> {
  const res = await inject('GET', `/api/v1/service-requests/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as ServiceRequestDto).chat;
}

/** Число для бейджа раздела: заявки области, где есть непрочитанное, адресованное мне. */
async function unreadCount(auth: Auth): Promise<number> {
  const res = await inject('GET', '/api/v1/service-requests/unread-count', auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { count: number }).count;
}

async function historyOf(auth: Auth, id: string): Promise<ServiceRequestHistoryEntryDto[]> {
  const res = await inject('GET', `/api/v1/service-requests/${id}/history`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestHistoryEntryDto[];
}

/** Строки ленты прямо из базы — там, где предмет проверки сама таблица, а не ответ ручки. */
async function rowsOf(requestId: string) {
  return (
    await ctx.db.execute<{
      id: string;
      seq: number;
      author_id: string | null;
      origin: string;
      body: string;
      imported_hash: string | null;
      created_at: Date;
    }>(sql`
      SELECT id, seq, author_id, origin, body, imported_hash, created_at
        FROM service_request_messages WHERE request_id = ${requestId} ORDER BY seq`)
  ).rows;
}

/**
 * Отказ прямого SQL: текст ошибки — часть проверки, поэтому возвращается он, а не флаг. Драйвер
 * заворачивает отказ базы в свой («Failed query: …»), а сообщение триггера лежит в `cause`, —
 * поэтому склеиваются оба.
 */
async function refused(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const outer = String((error as Error).message);
    const inner = String(((error as { cause?: Error }).cause as Error | undefined)?.message ?? '');
    return `${outer} ${inner}`;
  }
  throw new Error('ожидался отказ, но запрос прошёл');
}

describe.skipIf(!DB_URL)('обсуждение заявки на обслуживание: лента, курсор и подсветка', () => {
  /**
   * Умолчания vitest (5 с на случай, 10 с на хук) этому файлу не годятся: здесь есть случаи с
   * настоящим ожиданием блокировки, засев пятидесяти тысяч реплик и уборка того же объёма каскадом.
   * Поднято здесь, а не в конфиге пакета: длинные пороги нужны этому файлу, а не всем остальным.
   */
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const email = `db-chat-${input.tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Участник', ${input.tag}, ${passwordHash},
                ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    // ИНН с настоящей контрольной суммой: обмен справочниками выгружает базу целиком и на
    // выдуманном номере падает — падение выглядело бы дефектом чужого модуля.
    const innOf = (base9: string): string => {
      const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
      const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
      return `${base9}${(sum % 11) % 10}`;
    };
    const cp = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-Чат ${RUN}`},
              ${innOf(`77${String(Date.now()).slice(-6)}0`)})
      RETURNING id`);
    const serviceCounterpartyId = cp.rows[0]!.id;

    const object = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`OCH-${RUN}`}, ${`Площадка обсуждения ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = object.rows[0]!.id;
    const freshObject = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`OCH-N-${RUN}`}, ${`Площадка новичка ${RUN}`}, 'г Москва, ул Тестовая, д 2')
      RETURNING id`);
    const freshObjectId = freshObject.rows[0]!.id;
    const department = await db.execute<{ id: string }>(sql`
      INSERT INTO departments (code, name)
      VALUES (${`OCH-D-${RUN}`}, ${`Отдел обсуждения ${RUN}`})
      RETURNING id`);
    const departmentId = department.rows[0]!.id;

    const admin = await makeUser({ tag: 'admin', role: 'admin' });
    const author = await makeUser({ tag: 'author', role: 'shtab' });
    const colleague = await makeUser({ tag: 'colleague', role: 'shtab' });
    const operator = await makeUser({ tag: 'operator', role: 'shtab' });
    const itSupport = await makeUser({ tag: 'it', role: 'department' });
    const service = await makeUser({
      tag: 'service',
      role: 'operator',
      counterpartyId: serviceCounterpartyId,
    });
    const exec1 = await makeUser({ tag: 'exec1', role: 'shtab' });
    const exec2 = await makeUser({ tag: 'exec2', role: 'shtab' });

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${author.id}, ${objectId}), (${colleague.id}, ${objectId}),
             (${operator.id}, ${objectId}), (${exec1.id}, ${objectId}),
             (${exec2.id}, ${objectId})`);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id) VALUES (${itSupport.id}, ${departmentId})`);

    // Надстройки — сервисом, а не прямым SQL: с шага 1a перехода на назначаемые полномочия выдача
    // пишет две таблицы одной транзакцией, и половина оставила бы учётку без прав (ADR 0106).
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], admin.id);
      await replaceUserAddons(tx, itSupport.id, ['office_equipment_it_approver'], admin.id);
    });

    /**
     * Набор поимённого исполнителя — свой на прогон: `execute` и ничего сверх того. Ни `status`,
     * ни `assign`, ни `approveIt` в нём нет намеренно — иначе обе учётки попали бы заодно в
     * стороны `operator` и `it`, и «реплика поимённо одному» перестала бы отличаться от
     * «реплики стороне».
     */
    const grantCode = `oe-chat-exec-${RUN}`;
    const grant = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, description, is_system, created_by)
      VALUES (${grantCode}, ${`Оргтехника: исполнитель ${RUN}`},
              'Поимённый исполнитель заявок оргтехники (db-тест обсуждения)', false, ${admin.id})
      RETURNING id`);
    const grantId = grant.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      SELECT ${grantId}, permission
        FROM unnest(ARRAY['serviceRequests.read', 'serviceRequests.execute',
                          'serviceRequests.files']) AS permission`);
    await db.execute(sql`INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'shtab'::role)`);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by)
      VALUES (${exec1.id}, ${grantId}, ${admin.id}), (${exec2.id}, ${grantId}, ${admin.id})`);

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
      author: await withAuth(author),
      colleague: await withAuth(colleague),
      operator: await withAuth(operator),
      itSupport: await withAuth(itSupport),
      service: await withAuth(service),
      exec1: await withAuth(exec1),
      exec2: await withAuth(exec2),
      objectId,
      freshObjectId,
      departmentId,
      serviceCounterpartyId,
      typeId,
    };
  }, 300_000);

  /**
   * Уборка: база живёт между прогонами, поэтому файл уносит ровно то, что завёл сам. Порядок задан
   * внешними ключами — реплики ссылаются на автора `RESTRICT`ом и уходят только каскадом от
   * заявки, заявки держат технику, технику держит площадка.
   */
  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      const equipment = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE ${`ОЧ-${RUN}-%`}`;
      const users = sql`SELECT id FROM users WHERE email LIKE ${`db-chat-%-${RUN}@example.invalid`}`;
      await ctx.db.execute(sql`DELETE FROM service_requests WHERE office_equipment_id IN (${equipment})`);
      await ctx.db.execute(sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`ОЧ-${RUN}-%`}`);
      // Модели заводит триггер-зеркало карточки: удаление карточки их за собой не уносит.
      await ctx.db.execute(sql`
        DELETE FROM office_equipment_models m
         WHERE m.name LIKE ${`Чат-МФУ % ${RUN}`}
           AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
      await ctx.db.execute(sql`DELETE FROM users WHERE email LIKE ${`db-chat-%-${RUN}@example.invalid`}`);
      await ctx.db.execute(sql`DELETE FROM grants WHERE code = ${`oe-chat-exec-${RUN}`}`);
      await ctx.db.execute(sql`DELETE FROM counterparties WHERE name = ${`Сервис-Чат ${RUN}`}`);
      await ctx.db.execute(sql`DELETE FROM departments WHERE code = ${`OCH-D-${RUN}`}`);
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${`OCH-%${RUN}`}`);
    }
    await ctx?.closeDb();
  });

  // ── п. 1. Кто пишет ──

  describe('п. 1. пишут стороны цикла и автор', () => {
    it('все четыре стороны отправляют реплику, и номера идут подряд', async () => {
      const id = await makeFullRequest('четыре стороны');
      // Автор — сторона `customer`: участником её делает именно авторство, а не область.
      expect(await said(ctx.author.auth, id, 'бумага снова зажевалась', { sides: ['all'] })).toBe(1);
      // «Ведение» — `status` и `assign` разом, и ни одного из них по отдельности не хватило бы.
      expect(await said(ctx.operator.auth, id, 'передаю в сервис', { sides: ['service'] })).toBe(2);
      // ИТ-служба — `approveIt`.
      expect(await said(ctx.itSupport.auth, id, 'менять узел не будем', { sides: ['operator'] })).toBe(3);
      // Сервисная компания — оператор НАЗНАЧЕННОГО контрагента.
      expect(await said(ctx.service.auth, id, 'ждём ролик подачи', { sides: ['customer'] })).toBe(4);
      // Поимённый исполнитель — сторона `service` строкой назначения, а не правом.
      expect(await said(ctx.exec1.auth, id, 'заеду завтра', { sides: ['all'] })).toBe(5);

      const feed = await page(ctx.author.auth, id);
      expect(feed.items.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(feed.lastSeq).toBe(5);
      expect(feed.hasMore).toBe(false);
    });

    it('наблюдатель читает, но не пишет: 403 с названной причиной', async () => {
      const id = await makeFullRequest('наблюдатель');
      await said(ctx.author.auth, id, 'вопрос по срокам', { sides: ['all'] });

      // Заявку он видит и ленту читает — адресат это пометка, а не ограничение видимости.
      const feed = await page(ctx.colleague.auth, id);
      expect(feed.items).toHaveLength(1);

      const res = await say(ctx.colleague.auth, id, 'а я что думаю', { sides: ['all'] });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().message).toBe('В обсуждении заявки пишут её стороны и автор');
      // Он не участник — значит и блёклой точки на чужую переписку у него не бывает.
      const summary = await chatOf(ctx.colleague.auth, id);
      expect(summary.participantSides).toEqual([]);
      expect(summary.canWrite).toBe(false);
      expect(summary.unreadOthers).toBe(false);
    });

    it('в «Принята» и «Отменена» лента замораживается: 409 chat_frozen всем сторонам', async () => {
      for (const status of ['accepted', 'cancelled'] as const) {
        const id = await makeFullRequest(`заморозка ${status}`, status);
        for (const who of [ctx.author, ctx.operator, ctx.itSupport, ctx.service, ctx.exec1]) {
          const res = await say(who.auth, id, 'ещё одно слово', { sides: ['all'] });
          expect(res.statusCode, `${status}: ${res.body}`).toBe(409);
          expect(res.json().code).toBe('chat_frozen');
          expect(res.json().message).toContain('закрыта: обсуждение только читается');
        }
        // Читается она при этом всеми: заморожена лента, а не заявка.
        expect((await page(ctx.author.auth, id)).items).toEqual([]);
        expect((await chatOf(ctx.operator.auth, id)).canWrite).toBe(false);
      }
    });
  });

  // ── п. 2. Проверка адресатов ──

  describe('п. 2. адресат проверяется сервером', () => {
    it('поимённо — только назначенному исполнителю этой заявки: 422', async () => {
      const id = await makeFullRequest('чужой адресат');
      const stranger = await say(ctx.operator.auth, id, 'посмотрите, пожалуйста', {
        users: [ctx.colleague.id],
      });
      expect(stranger.statusCode, stranger.body).toBe(422);
      expect(stranger.json().message).toBe(
        'Поимённо адресовать реплику можно только исполнителю этой заявки',
      );
      // Назначенному — проходит: правило про назначение, а не про «знакомый uuid».
      expect(await said(ctx.operator.auth, id, 'посмотрите, пожалуйста', { users: [ctx.exec1.id] })).toBe(1);
    });

    /**
     * Пустой список и «Всем участникам вместе со стороной» ловит схема тела ДО обработчика, и код
     * тут 400 `validation_error` с пометкой поля, а не 422. Ожидание пишется по фактическому коду:
     * портал показывает такой отказ прямо в форме, и придумай тест 422 — он проверял бы ручку,
     * которой нет.
     */
    it('пустой список адресатов и «all» со стороной — 400 от схемы, с пометкой поля', async () => {
      const id = await makeFullRequest('схема адресатов');

      const empty = await say(ctx.operator.auth, id, 'кому-нибудь', {});
      expect(empty.statusCode, empty.body).toBe(400);
      expect(empty.json().code).toBe('validation_error');
      expect(Object.keys(empty.json().fields).join(' ')).toContain('addressees');

      const both = await say(ctx.operator.auth, id, 'всем и ещё вот этому', {
        sides: ['all', 'it'],
      });
      expect(both.statusCode, both.body).toBe(400);
      expect(both.json().code).toBe('validation_error');

      const withUser = await say(ctx.operator.auth, id, 'всем и лично', {
        sides: ['all'],
        users: [ctx.exec1.id],
      });
      expect(withUser.statusCode, withUser.body).toBe(400);

      // Ни одна из трёх попыток ленты не завела.
      expect(await rowsOf(id)).toHaveLength(0);
    });
  });

  // ── п. 3. Курсор прочтения ──

  describe('п. 3. курсор, а не отметка времени', () => {
    /**
     * ГОНКА БЛОКЕРА 3, воспроизведённая двумя соединениями.
     *
     * Отправка начинается раньше, чем читатель открыл окно, а коммитится позже, чем он подтвердил
     * прочтение. При отметке временем (`read_at = now()`) такая реплика родилась бы прочитанной:
     * её `created_at` МЕНЬШЕ `read_at`, и тест это равенство проверяет прямо — иначе доказательство
     * свелось бы к «ну и хорошо, что непрочитано».
     */
    it('реплика, закоммиченная после отметки чтения, остаётся непрочитанной', async () => {
      const id = await makeFullRequest('гонка курсора');
      await said(ctx.operator.auth, id, 'первое сообщение', { sides: ['all'] });
      await said(ctx.operator.auth, id, 'второе сообщение', { sides: ['all'] });

      const sender = new pg.Client({ connectionString: DB_URL! });
      await sender.connect();
      let messageAt: Date;
      try {
        // Отправитель начал первым: взял строку заявки, выдал номер, вставил реплику — и замер.
        await sender.query('BEGIN');
        await sender.query('SELECT id FROM service_requests WHERE id = $1 FOR UPDATE', [id]);
        const inserted = await sender.query<{ id: string; created_at: Date }>(
          `INSERT INTO service_request_messages
             (request_id, seq, author_id, origin, body, created_at)
           SELECT $1::uuid,
                  COALESCE((SELECT max(seq) FROM service_request_messages WHERE request_id = $1::uuid), 0) + 1,
                  $2::uuid, 'chat', 'третье — начато раньше, закоммичено позже', now()
           RETURNING id, created_at`,
          [id, ctx.operator.id],
        );
        messageAt = inserted.rows[0]!.created_at;
        await sender.query(
          `INSERT INTO service_request_message_addressees (message_id, side) VALUES ($1, 'all')`,
          [inserted.rows[0]!.id],
        );

        // Читатель тем временем видит только две реплики и честно подтверждает прочтение обеих.
        const feed = await page(ctx.author.auth, id);
        expect(feed.lastSeq).toBe(2);
        // Отметку НЕ ЖДЁМ: её вставка в курсор берёт `FOR KEY SHARE` на ту же строку заявки и
        // упирается в `FOR UPDATE` отправителя — ровно так это выглядит и в проде. Важно, что
        // номер (`lastSeq`) она успела прочитать ДО коммита: он спрашивается обычным `SELECT`,
        // который незакоммиченной реплики не видит.
        const reading = markRead(ctx.author.auth, id, 2);
        await pause(200);
        await sender.query('COMMIT');

        const read = await reading;
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json()).toEqual({ readThroughSeq: 2, lastSeq: 2 });
      } finally {
        await sender.end();
      }

      const readAt = (
        await ctx.db.execute<{ read_at: Date }>(sql`
          SELECT read_at FROM service_request_message_reads
           WHERE request_id = ${id} AND user_id = ${ctx.author.id}`)
      ).rows[0]!.read_at;
      // Вот она, ловушка отметки временем: реплика «старше» подтверждения прочтения.
      expect(new Date(messageAt).getTime()).toBeLessThan(new Date(readAt).getTime());

      // И тем не менее она непрочитана: курсор остался на 2, а у реплики номер 3.
      const summary = await chatOf(ctx.author.auth, id);
      expect(summary.lastSeq).toBe(3);
      expect(summary.readThroughSeq).toBe(2);
      expect(summary.unreadMine).toBe(1);
    });

    it('повторная отметка меньшим номером курсор не откатывает', async () => {
      const id = await makeFullRequest('курсор назад');
      for (let i = 1; i <= 5; i += 1) await said(ctx.operator.auth, id, `реплика ${i}`, { sides: ['all'] });

      expect((await markRead(ctx.author.auth, id, 5)).json()).toEqual({ readThroughSeq: 5, lastSeq: 5 });
      // Вторая вкладка догрузила старую страницу и прислала свой, устаревший номер.
      expect((await markRead(ctx.author.auth, id, 1)).json()).toEqual({ readThroughSeq: 5, lastSeq: 5 });
      expect((await chatOf(ctx.author.auth, id)).unreadMine).toBe(0);
      // Ноль законен и означает «не прочитано ничего» — но и он курсора не двигает назад.
      expect((await markRead(ctx.author.auth, id, 0)).json().readThroughSeq).toBe(5);
    });

    it('номер больше последней реплики — 422, и следующая реплика приходит непрочитанной', async () => {
      const id = await makeFullRequest('курсор в будущее');
      await said(ctx.operator.auth, id, 'единственная реплика', { sides: ['all'] });

      const res = await markRead(ctx.author.auth, id, 1_000_000);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().message).toBe(
        'Отметка прочтения 1000000 больше последней реплики обсуждения (1)',
      );
      // Курсор не сдвинулся ни на шаг: молчаливое обрезание скрыло бы ошибку клиента.
      expect((await chatOf(ctx.author.auth, id)).readThroughSeq).toBe(0);

      await markRead(ctx.author.auth, id, 1);
      await said(ctx.operator.auth, id, 'а вот и новое', { sides: ['all'] });
      const after = await chatOf(ctx.author.auth, id);
      expect(after.readThroughSeq).toBe(1);
      expect(after.unreadMine).toBe(1);
    });
  });

  // ── п. 4. Номер реплики ──

  it('п. 4. параллельные отправки получают подряд идущие номера, без столкновений', async () => {
    const id = await makeFullRequest('параллельные отправки');
    const senders = [
      ctx.author,
      ctx.operator,
      ctx.itSupport,
      ctx.service,
      ctx.exec1,
      ctx.exec2,
      ctx.admin,
      ctx.operator,
    ];
    const replies = await Promise.all(
      senders.map((who, i) => say(who.auth, id, `одновременная реплика ${i + 1}`, { sides: ['all'] })),
    );
    for (const res of replies) expect(res.statusCode, res.body).toBe(200);

    const seqs = replies
      .map((res) => (res.json() as { message: { seq: number } }).message.seq)
      .sort((a, b) => a - b);
    // Ни дыр, ни повторов: номер выдаётся под блокировкой строки заявки, а уникальный индекс
    // `(request_id, seq)` — страховка, которая ни разу не должна была понадобиться.
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await rowsOf(id)).toHaveLength(8);
    const dup = await ctx.db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c FROM (
        SELECT seq FROM service_request_messages WHERE request_id = ${id}
         GROUP BY seq HAVING count(*) > 1) t`);
    expect(Number(dup.rows[0]!.c)).toBe(0);
  });

  // ── п. 5. Отправка не правит заявку ──

  it('п. 5. отправка не меняет ни version, ни updated_at, ни updated_by заявки', async () => {
    const id = await makeFullRequest('версия заявки');
    const shot = async () =>
      (
        await ctx.db.execute<{ version: number; updated_at: Date; updated_by: string | null }>(sql`
          SELECT version, updated_at, updated_by FROM service_requests WHERE id = ${id}`)
      ).rows[0]!;
    const before = await shot();

    await said(ctx.operator.auth, id, 'ждём запчасть до пятницы', { sides: ['customer'] });
    await said(ctx.author.auth, id, 'принято', { sides: ['operator'] });
    await markRead(ctx.author.auth, id, 2);

    const after = await shot();
    // Реплика — не правка заявки: поднимай она версию, всякая открытая форма получала бы конфликт
    // оптимистической блокировки на каждое чужое сообщение.
    expect(after.version).toBe(before.version);
    expect(new Date(after.updated_at).toISOString()).toBe(new Date(before.updated_at).toISOString());
    expect(after.updated_by).toBe(before.updated_by);
  });

  // ── п. 6 и п. 7. Счёт непрочитанного ──

  describe('п. 6. счёт непрочитанного', () => {
    it('своё сообщение себя не подсвечивает', async () => {
      const id = await makeFullRequest('своё сообщение');
      await said(ctx.operator.auth, id, 'записал для истории', { sides: ['all'] });
      const mine = await chatOf(ctx.operator.auth, id);
      expect(mine.total).toBe(1);
      expect(mine.unreadMine).toBe(0);
      expect(mine.unreadOthers).toBe(false);
    });

    it('«Ведение» видит яркое адресованное себе и блёклую точку на чужое', async () => {
      const id = await makeFullRequest('яркое и блёклое');
      await said(ctx.author.auth, id, 'когда приедут?', { sides: ['operator'] });

      const bright = await chatOf(ctx.operator.auth, id);
      expect(bright.unreadMine).toBe(1);
      expect(bright.unreadOthers).toBe(false);
      expect(bright.participantSides).toEqual(['operator']);

      // Чужая переписка: адресована ИТ-службе, «Ведению» — нет.
      await said(ctx.author.auth, id, 'а что скажет ИТ?', { sides: ['it'] });
      const dim = await chatOf(ctx.operator.auth, id);
      expect(dim.unreadMine).toBe(1);
      expect(dim.unreadOthers).toBe(true);

      // Наблюдателю блёклая точка не положена: вмешаться ему нечем.
      expect((await chatOf(ctx.colleague.auth, id)).unreadOthers).toBe(false);
      // А вот яркая — положена: адресат «Заявителю» бьёт по всей стороне заказчика.
      await said(ctx.operator.auth, id, 'выезд в четверг', { sides: ['customer'] });
      expect((await chatOf(ctx.colleague.auth, id)).unreadMine).toBe(1);
    });

    it('реплика поимённо одному исполнителю не подсвечивается второму', async () => {
      const id = await makeFullRequest('поимённо');
      await said(ctx.operator.auth, id, 'возьмите на себя', { users: [ctx.exec1.id] });

      const named = await chatOf(ctx.exec1.auth, id);
      expect(named.unreadMine).toBe(1);
      const other = await chatOf(ctx.exec2.auth, id);
      expect(other.unreadMine).toBe(0);
      // Второй исполнитель — участник разговора, поэтому чужое непрочитанное он видит точкой.
      expect(other.participantSides).toEqual(['service']);
      expect(other.unreadOthers).toBe(true);
    });
  });

  it('п. 7. реплика двум сторонам одного человека даёт unreadMine = 1, а не 2', async () => {
    const id = await makeFullRequest('две стороны одного');
    // Администратор — и `operator` (status + assign), и `it` (approveIt): соединение с таблицей
    // адресатов размножило бы такую реплику на две строки, и `count(*)` показал бы «2 новых».
    expect((await chatOf(ctx.admin.auth, id)).participantSides).toEqual(['operator', 'it']);
    await said(ctx.author.auth, id, 'вопрос и к ведению, и к ИТ', { sides: ['operator', 'it'] });

    const summary = await chatOf(ctx.admin.auth, id);
    expect(summary.total).toBe(1);
    expect(summary.unreadMine).toBe(1);
    // Та же проверка на стороне бейджа: заявка одна, а не две.
    const both = await ctx.db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c FROM service_request_message_addressees a
        JOIN service_request_messages m ON m.id = a.message_id
       WHERE m.request_id = ${id}`);
    expect(Number(both.rows[0]!.c)).toBe(2);
  });

  // ── п. 8. Перенесённая реплика без автора ──

  /**
   * `author_id IS NULL` — только у перенесённых (§3.9), и `NULL <> :me` даёт не «истину», а
   * `UNKNOWN`. С `<>` вместо `IS DISTINCT FROM` такая реплика не попала бы в непрочитанные НИ У
   * КОГО, то есть перенесённое примечание молча исчезло бы из подсветки у всех сразу — и заметили
   * бы это через месяц, по жалобе «мы ничего не получали».
   *
   * Мутация проверена руками: замена `IS DISTINCT FROM` на `<>` в `unreadSql`
   * (`apps/api/src/services/service-request-chat.ts`) роняет ровно этот случай — `unreadMine`
   * становится 0, а `unread-count` перестаёт считать заявку.
   */
  it('п. 8. перенесённая реплика без автора считается непрочитанной', async () => {
    const id = await makeFullRequest('перенесённая без автора');
    await ctx.db.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO service_request_messages
          (request_id, seq, author_id, origin, imported_hash, body, created_at)
        VALUES (${id}, 1, NULL, 'import', md5('ждём запчасть, автор неизвестен'),
                'ждём запчасть, автор неизвестен', now())
        RETURNING id`);
      await tx.execute(sql`
        INSERT INTO service_request_message_addressees (message_id, side)
        VALUES (${inserted.rows[0]!.id}, 'all')`);
    });

    // Непрочитанная у всех сразу — и у сторон, и у наблюдателя: адресат у неё «Всем участникам».
    for (const who of [ctx.author, ctx.operator, ctx.itSupport, ctx.service, ctx.colleague]) {
      const summary = await chatOf(who.auth, id);
      expect(summary.total, who.email).toBe(1);
      expect(summary.unreadMine, who.email).toBe(1);
    }
    // И в ленте она приходит без имени: выдумывать его нечем.
    const feed = await page(ctx.author.auth, id);
    expect(feed.items[0]!.authorId).toBeNull();
    expect(feed.items[0]!.authorName).toBe('');
    expect(feed.items[0]!.origin).toBe('import');
  });

  // ── п. 9. Отсечка по дате заведения учётки ──

  it('п. 9. учётка, заведённая сегодня, годовой ленты непрочитанной не получает', async () => {
    // Своя площадка и одна заявка на ней: тогда бейдж новичка отвечает ровно про эту переписку.
    const id = await makeRequest({
      tag: 'новичок',
      withService: true,
      objectId: ctx.freshObjectId,
    });
    for (let i = 1; i <= 4; i += 1) {
      await said(ctx.admin.auth, id, `старое сообщение ${i}`, { sides: ['all'] });
    }

    // Учётка заводится ПОСЛЕ этих четырёх реплик — в этом весь случай.
    const newbie = (await makeNewcomer('newbie', [ctx.freshObjectId])).auth;

    // Заявку он видит, ленту читает — но непрочитанного у него нет: всё это написано до него.
    const before = await chatOf(newbie, id);
    expect(before.total).toBe(4);
    expect(before.unreadMine).toBe(0);
    expect(await unreadCount(newbie)).toBe(0);

    // Написанное после его заведения — непрочитано, как у всех.
    await said(ctx.admin.auth, id, 'а это уже при новом сотруднике', { sides: ['all'] });
    expect((await chatOf(newbie, id)).unreadMine).toBe(1);
    expect(await unreadCount(newbie)).toBe(1);
  });

  // ── п. 10 и п. 11. Перенос «Примечания исполнителя» ──

  describe('п. 10. перенос примечания идемпотентен по хешу', () => {
    /** Перенос — тем самым DO-блоком миграции `0216`, что скопирует выпуск C. */
    const runTransfer = () => ctx.db.execute(sql.raw(TRANSFER_SQL));

    /** Ленты вне разбираемых заявок быть не должно: DO-блок идёт по всей таблице. */
    const clearComments = () =>
      ctx.db.execute(sql`UPDATE service_requests SET service_comment = '' WHERE btrim(service_comment) <> ''`);

    it('повторный прогон дублей не даёт, изменённый текст даёт вторую реплику следующим номером', async () => {
      await clearComments();
      const id = await makeFullRequest('перенос примечания');
      // У заявки уже есть переписка: «`seq` перенесённых равен единице» верно только для пустой
      // ленты, а повторный прогон выпуска C встречает как раз непустую.
      await said(ctx.operator.auth, id, 'первая реплика ленты', { sides: ['all'] });
      await said(ctx.author.auth, id, 'вторая реплика ленты', { sides: ['all'] });
      await ctx.db.execute(sql`
        UPDATE service_requests SET service_comment = 'ждём ролик подачи' WHERE id = ${id}`);

      await runTransfer();
      let rows = await rowsOf(id);
      expect(rows).toHaveLength(3);
      const moved = rows[2]!;
      expect(moved.seq).toBe(3);
      expect(moved.origin).toBe('import');
      // Автора у примечания взять неоткуда: `updated_by` — общее поле заявки.
      expect(moved.author_id).toBeNull();
      expect(moved.body).toBe('ждём ролик подачи');
      const hash = (
        await ctx.db.execute<{ h: string }>(sql`SELECT md5('ждём ролик подачи') AS h`)
      ).rows[0]!.h;
      expect(moved.imported_hash).toBe(hash);
      // Время — приблизительное, от самой заявки, а не «перенесено сегодня».
      const at = (
        await ctx.db.execute<{ at: Date }>(sql`
          SELECT COALESCE(updated_at, created_at) AS at FROM service_requests WHERE id = ${id}`)
      ).rows[0]!.at;
      expect(new Date(moved.created_at).toISOString()).toBe(new Date(at).toISOString());
      // Адресат у неё один — «Всем участникам»: кому оно предназначалось, поле не знало никогда.
      const sides = await ctx.db.execute<{ side: string }>(sql`
        SELECT side FROM service_request_message_addressees WHERE message_id = ${moved.id}`);
      expect(sides.rows.map((r) => r.side)).toEqual(['all']);

      // Повторный прогон — тем же кодом, и ничего не добавляет.
      await runTransfer();
      await runTransfer();
      expect(await rowsOf(id)).toHaveLength(3);

      // Переписанное в окне выката примечание — другой хеш, значит новая реплика. Номер у неё
      // следующий по ленте, а не единица.
      await ctx.db.execute(sql`
        UPDATE service_requests SET service_comment = 'ролик пришёл, ставим в четверг' WHERE id = ${id}`);
      await runTransfer();
      rows = await rowsOf(id);
      expect(rows).toHaveLength(4);
      expect(rows[3]!.seq).toBe(4);
      expect(rows[3]!.body).toBe('ролик пришёл, ставим в четверг');
      await clearComments();
    });

    it('адаптер пишет реплику с автором и точным временем, а повторный перенос дубля не создаёт', async () => {
      await clearComments();
      const id = await makeRequest({ tag: 'адаптер', withService: true });
      const versionOf = async () =>
        Number(
          (
            await ctx.db.execute<{ version: number }>(sql`
              SELECT version FROM service_requests WHERE id = ${id}`)
          ).rows[0]!.version,
        );

      const before = new Date();
      const patched = await inject('PATCH', `/api/v1/service-requests/${id}/service-comment`, ctx.service.auth, {
        serviceComment: 'написано старым бандлом в окне выката',
        version: await versionOf(),
      });
      expect(patched.statusCode, patched.body).toBe(200);

      let rows = await rowsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.origin).toBe('import');
      // У адаптера принципал под рукой: пустой автор там означал бы выдуманную анонимность.
      expect(rows[0]!.author_id).toBe(ctx.service.id);
      expect(new Date(rows[0]!.created_at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(new Date(rows[0]!.created_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);

      // Повторный прогон переноса встречает тот же хеш и молча проходит мимо.
      await runTransfer();
      rows = await rowsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.author_id).toBe(ctx.service.id);

      // Пустое значение — старый способ «стереть примечание»: колонку чистит, ленту не трогает.
      const cleared = await inject('PATCH', `/api/v1/service-requests/${id}/service-comment`, ctx.service.auth, {
        serviceComment: '',
        version: await versionOf(),
      });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(await rowsOf(id)).toHaveLength(1);
      await clearComments();
    });
  });

  /**
   * п. 11. ГОНКА ПЕРЕНОСА С АДАПТЕРОМ.
   *
   * Процедура отбирает заявки с непустым примечанием ОДНОЙ выборкой, а блокировку берёт в цикле —
   * между тем и другим ту же строку успевает вставить адаптер выпуска A. Окно это открывается
   * ровно тогда, когда цикл застревает на предыдущей заявке, — поэтому барьером здесь служит
   * ЧУЖАЯ строка, идущая раньше в `ORDER BY sr.id`: пока перенос ждёт её, адаптер спокойно пишет
   * в целевую.
   *
   * Без перепроверки хеша под блокировкой и вставки адресата только по `RETURNING` процедура
   * попыталась бы дописать адресата к ЧУЖОЙ, ранее созданной реплике и упала бы об `xmin`-триггер,
   * уронив миграцию на ровном месте.
   */
  it('п. 11. перенос, ждавший блокировки, не спорит с адаптером: в ленте ровно одна реплика', async () => {
    await ctx.db.execute(sql`UPDATE service_requests SET service_comment = '' WHERE btrim(service_comment) <> ''`);
    const TEXT = 'запчасть выехала, ждём в среду';
    const a = await makeRequest({ tag: 'гонка A', withService: true, serviceComment: 'барьер' });
    const b = await makeRequest({ tag: 'гонка B', withService: true, serviceComment: 'барьер' });
    // Порядок цикла — по идентификатору: барьером становится та заявка, что идёт первой.
    const [barrier, target] = a < b ? [a, b] : [b, a];
    await ctx.db.execute(sql`UPDATE service_requests SET service_comment = ${TEXT} WHERE id = ${target}`);

    const holder = new pg.Client({ connectionString: DB_URL! });
    const migration = new pg.Client({ connectionString: DB_URL! });
    await holder.connect();
    await migration.connect();
    let transfer: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM service_requests WHERE id = $1 FOR UPDATE', [barrier]);

      const pid = (await migration.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      transfer = migration.query(TRANSFER_SQL);

      // Ждём, пока процедура упрётся в барьер: без этого «параллельность» была бы догадкой —
      // перенос мог бы успеть целиком до того, как адаптер сделает первый запрос.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const waiting = await ctx.db.execute<{ c: number }>(sql`
          SELECT count(*)::int AS c FROM pg_stat_activity
           WHERE pid = ${pid} AND wait_event_type = 'Lock'`);
        if (Number(waiting.rows[0]!.c) > 0) break;
        if (Date.now() > deadline) throw new Error('перенос не встал в очередь за барьерной заявкой');
        await pause(25);
      }

      // Пока перенос ждёт, адаптер пишет ровно тот же текст в целевую заявку.
      const version = Number(
        (
          await ctx.db.execute<{ version: number }>(sql`
            SELECT version FROM service_requests WHERE id = ${target}`)
        ).rows[0]!.version,
      );
      const patched = await inject(
        'PATCH',
        `/api/v1/service-requests/${target}/service-comment`,
        ctx.service.auth,
        { serviceComment: TEXT, version },
      );
      expect(patched.statusCode, patched.body).toBe(200);
      expect(await rowsOf(target)).toHaveLength(1);
    } finally {
      await holder.query('COMMIT').catch(() => undefined);
      await holder.end();
      // Соединение переноса закрывается в любом исходе: упади проверка выше — незавершённый
      // запрос остался бы висеть незакрытым обещанием и утащил бы за собой весь файл.
      await transfer?.catch(() => undefined);
      await migration.end();
    }

    // Перенос снялся с барьера и дошёл до целевой заявки — где реплика уже есть. Отказ его,
    // если он был, поднимается здесь: `catch` выше только не давал ему стать необработанным.
    await transfer;

    const rows = await rowsOf(target);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.author_id).toBe(ctx.service.id);
    expect(rows[0]!.body).toBe(TEXT);
    // Барьерную заявку перенос всё-таки забрал: ждал он, а не пропускал.
    expect(await rowsOf(barrier)).toHaveLength(1);
    await ctx.db.execute(sql`UPDATE service_requests SET service_comment = '' WHERE btrim(service_comment) <> ''`);
  });

  // ── п. 12. Миграция выпуска C ──

  describe('п. 12. миграция выпуска C: перенос, проверка, DROP — одной транзакцией', () => {
    /**
     * Все три шага выполняются на отдельном соединении и ОТКАТЫВАЮТСЯ: колонку `service_comment`
     * этот файл сносить не вправе — она нужна остальным тестам и коду выпуска A. Откат не ослабляет
     * проверку: и «прошло», и «упало» видны внутри транзакции, а видимость `DROP COLUMN` проверяется
     * там же, до отката.
     */
    async function cutover(): Promise<{ ok: boolean; error: string; droppedInside: boolean }> {
      const client = new pg.Client({ connectionString: DB_URL! });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(TRANSFER_SQL);
        await client.query(CUTOVER_CHECK_SQL);
        await client.query('ALTER TABLE service_requests DROP COLUMN service_comment');
        const gone = await client.query<{ c: string }>(
          `SELECT count(*) AS c FROM information_schema.columns
            WHERE table_name = 'service_requests' AND column_name = 'service_comment'`,
        );
        return { ok: true, error: '', droppedInside: Number(gone.rows[0]!.c) === 0 };
      } catch (error) {
        return { ok: false, error: String((error as Error).message), droppedInside: false };
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    }

    it('перенос забирает написанное адаптером в окне выката B, и колонка снимается', async () => {
      await ctx.db.execute(sql`UPDATE service_requests SET service_comment = '' WHERE btrim(service_comment) <> ''`);
      const byAdapter = await makeRequest({ tag: 'выкат B адаптер', withService: true });
      const version = Number(
        (
          await ctx.db.execute<{ version: number }>(sql`
            SELECT version FROM service_requests WHERE id = ${byAdapter}`)
        ).rows[0]!.version,
      );
      const patched = await inject(
        'PATCH',
        `/api/v1/service-requests/${byAdapter}/service-comment`,
        ctx.service.auth,
        { serviceComment: 'написано в окне выката B', version },
      );
      expect(patched.statusCode, patched.body).toBe(200);
      // И заявка, до которой адаптер не дошёл: её примечание заберёт сам перенос выпуска C.
      const onlyColumn = await makeRequest({
        tag: 'выкат B колонка',
        withService: true,
        serviceComment: 'осталось только в колонке',
      });

      const result = await cutover();
      expect(result.error).toBe('');
      expect(result.ok).toBe(true);
      expect(result.droppedInside).toBe(true);

      // Транзакция откачена целиком: и колонка на месте, и перенос второй заявки не сохранился.
      const column = await ctx.db.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c FROM information_schema.columns
         WHERE table_name = 'service_requests' AND column_name = 'service_comment'`);
      expect(Number(column.rows[0]!.c)).toBe(1);
      expect(await rowsOf(onlyColumn)).toHaveLength(0);
      expect(await rowsOf(byAdapter)).toHaveLength(1);
      await ctx.db.execute(sql`UPDATE service_requests SET service_comment = '' WHERE btrim(service_comment) <> ''`);
    });

    it('перенесена прежняя редакция, а текущая нет — проверка падает, DROP не выполняется', async () => {
      await ctx.db.execute(sql`UPDATE service_requests SET service_comment = '' WHERE btrim(service_comment) <> ''`);
      const id = await makeRequest({ tag: 'разошедшийся текст', withService: true });
      // Реплика с хешем ТЕКУЩЕГО значения, но другим телом. Перенос такую пропустит — хеш совпал, —
      // а проверка обязана поймать: `md5` не криптографическая гарантия, и расхождение текста
      // должно ловиться, пока колонка ещё цела.
      await ctx.db.transaction(async (tx) => {
        const inserted = await tx.execute<{ id: string }>(sql`
          INSERT INTO service_request_messages
            (request_id, seq, author_id, origin, imported_hash, body, created_at)
          VALUES (${id}, 1, NULL, 'import', md5('новая редакция примечания'),
                  'прежняя редакция примечания', now())
          RETURNING id`);
        await tx.execute(sql`
          INSERT INTO service_request_message_addressees (message_id, side)
          VALUES (${inserted.rows[0]!.id}, 'all')`);
      });
      await ctx.db.execute(sql`
        UPDATE service_requests SET service_comment = 'новая редакция примечания' WHERE id = ${id}`);

      const result = await cutover();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Примечание исполнителя не перенесено у 1 заявок');
      expect(result.droppedInside).toBe(false);

      // Транзакция откатилась целиком: колонка на месте, половины сделанного не осталось.
      const column = await ctx.db.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c FROM information_schema.columns
         WHERE table_name = 'service_requests' AND column_name = 'service_comment'`);
      expect(Number(column.rows[0]!.c)).toBe(1);
      expect(await rowsOf(id)).toHaveLength(1);
      await ctx.db.execute(sql`UPDATE service_requests SET service_comment = '' WHERE btrim(service_comment) <> ''`);
    });
  });

  // ── п. 13. Неизменяемость ленты ──

  describe('п. 13. лента только растёт', () => {
    it('правка реплики и адресата отбивается', async () => {
      const id = await makeFullRequest('правка');
      await said(ctx.operator.auth, id, 'первоначальный текст', { sides: ['customer'] });
      const [row] = await rowsOf(id);

      expect(
        await refused(() =>
          ctx.db.execute(sql`UPDATE service_request_messages SET body = 'подменённый' WHERE id = ${row!.id}`),
        ),
      ).toContain('Реплика обсуждения неизменяема');
      expect(
        await refused(() =>
          ctx.db.execute(sql`
            UPDATE service_request_message_addressees SET side = 'service' WHERE message_id = ${row!.id}`),
        ),
      ).toContain('Реплика обсуждения неизменяема');

      expect((await rowsOf(id))[0]!.body).toBe('первоначальный текст');
    });

    it('самостоятельное удаление реплики и адресата отбивается, каскад от заявки — проходит', async () => {
      const id = await makeFullRequest('удаление');
      await said(ctx.operator.auth, id, 'на это ссылаются в споре', { sides: ['all'] });
      const [row] = await rowsOf(id);

      expect(
        await refused(() =>
          ctx.db.execute(sql`DELETE FROM service_request_messages WHERE id = ${row!.id}`),
        ),
      ).toContain('нельзя удалить отдельно от заявки');
      expect(
        await refused(() =>
          ctx.db.execute(sql`DELETE FROM service_request_message_addressees WHERE message_id = ${row!.id}`),
        ),
      ).toContain('нельзя удалить отдельно от самой реплики');

      // Единственная законная дверь — удаление самой заявки насовсем.
      await ctx.db.execute(sql`DELETE FROM service_requests WHERE id = ${id}`);
      expect(await rowsOf(id)).toHaveLength(0);
      const orphans = await ctx.db.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c FROM service_request_message_addressees WHERE message_id = ${row!.id}`);
      expect(Number(orphans.rows[0]!.c)).toBe(0);
    });

    it('адресата дописывают только вместе с репликой: чужой, ранее созданной — отказ', async () => {
      const id = await makeFullRequest('переадресация');
      await said(ctx.operator.auth, id, 'адресовано заявителю', { sides: ['customer'] });
      const [row] = await rowsOf(id);

      // Отдельной транзакцией — то есть задним числом.
      expect(
        await refused(() =>
          ctx.db.execute(sql`
            INSERT INTO service_request_message_addressees (message_id, side)
            VALUES (${row!.id}, 'service')`),
        ),
      ).toContain('только вместе с самой репликой');

      // Отказом встречается и вложенная транзакция, ДАЖЕ когда реплика с адресатом созданы внутри
      // ОДНОГО savepoint'а: `pg_current_xact_id()` отдаёт идентификатор верхней транзакции, а
      // строка из подтранзакции несёт в `xmin` её собственный. Проверка тут строже задуманного, и
      // это требование к серверному коду (§3.3): реплику вставляет `db.transaction`, а вложенная
      // `tx.transaction` — она разворачивается в savepoint — не годится.
      const nested = await refused(() =>
        ctx.db.transaction(async (tx) =>
          tx.transaction(async (inner) => {
            const inserted = await inner.execute<{ id: string }>(sql`
              INSERT INTO service_request_messages (request_id, seq, author_id, origin, body, created_at)
              VALUES (${id}, 2, ${ctx.operator.id}, 'chat', 'реплика из savepoint', now())
              RETURNING id`);
            await inner.execute(sql`
              INSERT INTO service_request_message_addressees (message_id, side)
              VALUES (${inserted.rows[0]!.id}, 'all')`);
          }),
        ),
      );
      expect(nested).toContain('только вместе с самой репликой');

      // А вместе с репликой, одной верхнеуровневой транзакцией, — проходит.
      await ctx.db.transaction(async (tx) => {
        const inserted = await tx.execute<{ id: string }>(sql`
          INSERT INTO service_request_messages (request_id, seq, author_id, origin, body, created_at)
          VALUES (${id}, 2, ${ctx.operator.id}, 'chat', 'реплика вместе с адресатами', now())
          RETURNING id`);
        await tx.execute(sql`
          INSERT INTO service_request_message_addressees (message_id, side)
          VALUES (${inserted.rows[0]!.id}, 'service'), (${inserted.rows[0]!.id}, 'it')`);
      });
      expect(await rowsOf(id)).toHaveLength(2);
    });

    it('реплика без единого адресата не доживает до конца транзакции', async () => {
      const id = await makeFullRequest('без адресата');
      const message = await refused(() =>
        ctx.db.transaction(async (tx) => {
          await tx.execute(sql`
            INSERT INTO service_request_messages (request_id, seq, author_id, origin, body, created_at)
            VALUES (${id}, 1, ${ctx.operator.id}, 'chat', 'кому это?', now())`);
        }),
      );
      expect(message).toContain('нет ни одного адресата');
      expect(await rowsOf(id)).toHaveLength(0);
    });
  });

  // ── п. 14 и п. 15. История заявки ──

  it('п. 14. реплика попадает в историю заявки строкой с текстом и адресатом', async () => {
    const id = await makeFullRequest('история');
    await said(ctx.service.auth, id, 'ждём запчасть', { sides: ['customer'] });
    await said(ctx.operator.auth, id, 'посмотрите вы', { users: [ctx.exec1.id] });

    const history = await historyOf(ctx.operator.auth, id);
    const chat = history.filter((entry) => entry.kind === 'chatMessage');
    expect(chat).toHaveLength(2);
    expect(chat[0]!.comment).toBe('сообщение заявителю: «ждём запчасть»');
    expect(chat[0]!.actorId).toBe(ctx.service.id);
    expect(chat[1]!.comment).toContain('лично Тестовый Участник exec1');
    expect(chat[1]!.comment).toContain('«посмотрите вы»');
  });

  it('п. 15. история заявки с 500 репликами не длиннее 200 строк и показывает последние', async () => {
    const id = await makeFullRequest('длинная переписка');
    // Двумя запросами в одной верхнеуровневой транзакции: адресата принимает только та транзакция,
    // что создала реплику, а вставить пятьсот реплик ручкой значило бы гонять HTTP пятьсот раз.
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO service_request_messages (request_id, seq, author_id, origin, body, created_at)
        SELECT ${id}::uuid, g.i, ${ctx.operator.id}::uuid, 'chat', 'реплика №' || g.i,
               now() - ((500 - g.i) || ' seconds')::interval
          FROM generate_series(1, 500) AS g(i)`);
      await tx.execute(sql`
        INSERT INTO service_request_message_addressees (message_id, side)
        SELECT id, 'all' FROM service_request_messages WHERE request_id = ${id}`);
    });

    const history = await historyOf(ctx.operator.auth, id);
    // `HISTORY_LIMIT` = 200: третий источник живёт по правилам первых двух, иначе длинная переписка
    // вернула бы историю к неограниченной выдаче. Двести — это ВЕСЬ список, а не «двести реплик
    // плюс остальное»: свои двести берёт каждый источник, и только потом общий список режется тем
    // же числом. Одну строку из двухсот занимает здесь заведение заявки, поэтому реплик 199.
    expect(history).toHaveLength(200);
    expect(history.filter((e) => e.kind === 'created')).toHaveLength(1);
    const bodies = history.filter((e) => e.kind === 'chatMessage').map((e) => e.comment);
    expect(bodies).toHaveLength(199);
    // Берутся ПОСЛЕДНИЕ: история отвечает на вопрос «что происходило недавно».
    expect(bodies.at(-1)).toContain('«реплика №500»');
    expect(bodies.some((c) => c.includes('«реплика №302»'))).toBe(true);
    expect(bodies.some((c) => c.includes('«реплика №300»'))).toBe(false);
    expect(bodies.some((c) => c.includes('«реплика №1»'))).toBe(false);

    // Сама лента при этом страничная и отдаёт последние 50 — без второго запроса за `count(*)`.
    const feed = await page(ctx.operator.auth, id);
    expect(feed.items).toHaveLength(50);
    expect(feed.hasMore).toBe(true);
    expect(feed.lastSeq).toBe(500);
    expect(feed.items[0]!.seq).toBe(451);
  });

  // ── п. 16. Стоимость счётчика ──

  describe('п. 16. план запроса счётчика на засеянном объёме', () => {
    /**
     * SQL берётся У САМОГО СЕРВЕРА, а не переписывается в тесте. Счётчик собирается из ответов
     * `audienceMatches` по каждой стороне (`addressedToMeSql`), и повтори мы его здесь руками —
     * измеряли бы план запроса, которого в проде нет. Поэтому `db.execute` на время обращения к
     * ручке подменяется перехватчиком, а `EXPLAIN` идёт по перехваченному объекту.
     */
    async function explainUnreadCount(auth: Auth): Promise<{
      plan: Record<string, unknown>;
      ms: number;
      sharedRead: number;
      blocks: number;
    }> {
      const captured: SQL[] = [];
      const holder = ctx.db as unknown as { execute?: unknown };
      const original = ctx.db.execute.bind(ctx.db);
      holder.execute = (query: SQL) => {
        captured.push(query);
        return original(query);
      };
      try {
        expect((await inject('GET', '/api/v1/service-requests/unread-count', auth)).statusCode).toBe(200);
      } finally {
        delete holder.execute;
      }
      const query = captured.at(-1);
      if (!query) throw new Error('ручка счётчика не обратилась к базе — перехват не сработал');

      // Замер повторяется, и берётся ЛУЧШИЙ: первое исполнение греет кэш, а машина под тестами
      // делит процессор с самим сервером — по худшему замеру порог пришлось бы задирать втрое, и
      // он перестал бы ловить потерянный индекс.
      let best:
        | { plan: Record<string, unknown>; ms: number; sharedRead: number; blocks: number }
        | undefined;
      for (let i = 0; i < 5; i += 1) {
        const rows = await original(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
        const raw = (rows.rows[0] as Record<string, unknown>)['QUERY PLAN'];
        const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
          Plan: Record<string, unknown>;
          'Execution Time': number;
        }[];
        const ms = Number(parsed[0]!['Execution Time']);
        const plan = parsed[0]!.Plan;
        // Счётчики буферов в JSON НАКОПИТЕЛЬНЫЕ: узел уже включает своих детей и свои подпланы, и
        // сумма по дереву посчитала бы каждую страницу столько раз, сколько над ней ярусов.
        // Поэтому берётся корень — он и есть итог по запросу.
        const sharedRead = Number(plan['Shared Read Blocks'] ?? 0);
        // Тронутые страницы целиком: на прогретом кэше `shared read` равен нулю у любого плана —
        // и хорошего, и негодного, — а вот число ПРОЧИТАННЫХ страниц растёт вместе с лишней
        // работой и потому ловит потерянный индекс.
        const blocks = sharedRead + Number(plan['Shared Hit Blocks'] ?? 0);
        if (!best || ms < best.ms) best = { plan, ms, sharedRead, blocks };
      }
      return best!;
    }

    function nodes(node: Record<string, unknown>): Record<string, unknown>[] {
      return [
        node,
        ...(((node.Plans as Record<string, unknown>[] | undefined) ?? []).flatMap(nodes)),
      ];
    }

    /**
     * Критерий 1 §3.5 — НЕ «без seq scan». У субъекта со сквозной областью один последовательный
     * проход по большей части таблицы бывает дешевле индексного, и запрет гнал бы планировщик в
     * худший план. Запрещено другое: ПОВТОРНЫЙ полный проход — тот, что исполняется заново на
     * каждую заявку (внутренняя сторона nested loop, `Actual Loops` больше единицы).
     */
    function repeatedSeqScans(plan: Record<string, unknown>): string[] {
      return nodes(plan)
        .filter(
          (n) =>
            String(n['Node Type']) === 'Seq Scan' && Number(n['Actual Loops'] ?? 1) > 1,
        )
        .map((n) => `${String(n['Relation Name'])} × ${String(n['Actual Loops'])}`);
    }

    /** Засев: закрытые заявки на одной единице — открытая по единице разрешена только одна. */
    async function seed(marker: string, requests: number): Promise<void> {
      unitNo += 1;
      const equipment = (
        await ctx.db.execute<{ id: string }>(sql`
          INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id)
          VALUES (${ctx.typeId}, ${`Чат-МФУ ${marker} ${RUN}`}, ${`ОЧ-${RUN}-${unitNo}`}, ${ctx.objectId})
          RETURNING id`)
      ).rows[0]!.id;
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO service_requests (office_equipment_id, equipment_object_id, equipment_name,
                                        description, created_by, status)
          SELECT ${equipment}::uuid, ${ctx.objectId}::uuid, ${`Чат-МФУ ${marker} ${RUN}`},
                 ${marker}, ${ctx.author.id}::uuid, 'cancelled'::service_request_status
            FROM generate_series(1, ${requests})`);
        await tx.execute(sql`
          INSERT INTO service_request_messages (request_id, seq, author_id, origin, body, created_at)
          SELECT r.id, g.i, ${ctx.author.id}::uuid, 'chat', 'нагрузочная реплика ' || g.i, now()
            FROM service_requests r CROSS JOIN generate_series(1, 10) AS g(i)
           WHERE r.description = ${marker}`);
        await tx.execute(sql`
          INSERT INTO service_request_message_addressees (message_id, side)
          SELECT m.id, 'it' FROM service_request_messages m
            JOIN service_requests r ON r.id = m.request_id
           WHERE r.description = ${marker}`);
      });
      await ctx.db.execute(sql`ANALYZE service_requests`);
      await ctx.db.execute(sql`ANALYZE service_request_messages`);
      await ctx.db.execute(sql`ANALYZE service_request_message_addressees`);
      await ctx.db.execute(sql`ANALYZE service_request_message_reads`);
    }

    /*
     * ПОРОГИ — ИЗМЕРЕННЫЕ, А НЕ ВЫДУМАННЫЕ.
     *
     * Объём тот, что назван в §3.5: 1 000 и 5 000 заявок по 10 реплик, все реплики адресованы
     * стороне `it`, читатель — субъект со СКВОЗНОЙ областью модуля (ИТ-служба): предикат области
     * у него не сужает ничего, и он задаёт верхнюю границу стоимости. Курсора прочтения у него
     * нет ни по одной заявке, то есть непрочитано всё — худший случай и по числу совпадений.
     *
     * Снято на dev-postgres (PostgreSQL 16, localhost:5433), лучшее из пяти исполнений, четыре
     * прогона подряд:
     *
     *   1 000 заявок:  7,3 / 7,4 / 7,7 / 8,0 мс,  10 208–10 487 страниц, shared read 0
     *   5 000 заявок: 44,3 / 45,7 / 46,2 мс,      71 410 страниц,        shared read 0
     *   рост по времени: 5,79 / 5,93 / 6,06 (линейный — 5, квадратичный был бы 25)
     *
     * Пороги взяты впятеро-вшестеро от измеренного: разброс машины они переживают, а потерянный
     * индекс — нет, он превращает эти миллисекунды в секунды и удесятеряет страницы.
     *
     * `sharedRead` на прогретом кэше равен нулю у ЛЮБОГО плана, и порог здесь сторожит не сегодня,
     * а завтра: план, который начнёт ходить на диск на каждую заявку, упрётся в него первым.
     */
    const LIMITS = {
      ms1k: 50,
      ms5k: 250,
      sharedRead: 5_000,
      blocks1k: 30_000,
      blocks5k: 200_000,
      growth: 12,
    };
    let first: { ms: number; blocks: number } | undefined;

    it('1 000 заявок × 10 реплик: без повторных проходов и в пределах порога', async () => {
      await seed(`нагрузка ${RUN} п1`, 1000);
      const measured = await explainUnreadCount(ctx.itSupport.auth);
      const shot = `замер: ${measured.ms} мс, ${measured.blocks} страниц, read ${measured.sharedRead}`;

      expect(repeatedSeqScans(measured.plan), shot).toEqual([]);
      expect(measured.ms, shot).toBeLessThan(LIMITS.ms1k);
      expect(measured.sharedRead, shot).toBeLessThan(LIMITS.sharedRead);
      expect(measured.blocks, shot).toBeLessThan(LIMITS.blocks1k);
      first = measured;
    }, 300_000);

    it('5 000 заявок: рост от 1 000 близок к линейному', async () => {
      await seed(`нагрузка ${RUN} п2`, 4000);
      const measured = await explainUnreadCount(ctx.itSupport.auth);
      const growth = measured.ms / Math.max(first!.ms, 0.01);
      const blocksGrowth = measured.blocks / Math.max(first!.blocks, 1);
      const shot =
        `замер: ${measured.ms} мс, ${measured.blocks} страниц, read ${measured.sharedRead}; ` +
        `рост ${growth.toFixed(2)}× по времени и ${blocksGrowth.toFixed(2)}× по страницам`;

      expect(repeatedSeqScans(measured.plan), shot).toEqual([]);
      expect(measured.ms, shot).toBeLessThan(LIMITS.ms5k);
      expect(measured.sharedRead, shot).toBeLessThan(LIMITS.sharedRead);
      expect(measured.blocks, shot).toBeLessThan(LIMITS.blocks5k);
      // Линейный рост — впятеро; квадратичный дал бы двадцать пять. Порог посередине и ближе к
      // линейному: он ловит потерянный индекс, а не разброс машины.
      expect(growth, shot).toBeLessThan(LIMITS.growth);
      expect(blocksGrowth, shot).toBeLessThan(LIMITS.growth);

      // Ответ при этом правильный: ИТ-служба видит все засеянные заявки непрочитанными.
      expect(await unreadCount(ctx.itSupport.auth)).toBeGreaterThanOrEqual(5000);
    }, 300_000);
  });

  // ── п. 17. «Отметить все прочитанными» ──

  /**
   * Кнопка тулбара списка (§3.4) и её ответ. Ручка `POST /messages/read-all` серверными тестами не
   * проверялась вовсе — и ровно в ней ревью нашло дефект: `ON CONFLICT … DO UPDATE` без предиката
   * обновляет КАЖДУЮ совпавшую строку, и `rowCount` считал заодно заявки, где курсор уже стоял на
   * `lastSeq` и не двигался ни на шаг. Портал показывает это число словами «Отмечено прочитанными
   * заявок: N» и нулём отличает «непрочитанного не было» от «ручка не сработала» — а второе нажатие
   * подряд снова отвечало «1».
   *
   * СВОЙ УГОЛ ПОРТАЛА: две учётки, заведённые здесь, и своя площадка на каждый случай. Ответ ручки —
   * число по всей области субъекта, и на общей площадке фикстуры ожидаемое «2» зависело бы от того,
   * что оставили после себя полтора десятка соседних случаев, а не от предмета проверки.
   */
  describe('п. 17. «Отметить все прочитанными» гасит отбор и считает только сдвиги', () => {
    /** Тот, кто нажимает кнопку: автор всех заявок угла, то есть сторона `customer`. */
    let reader: TestUser;
    /** Сосед по площадке: его курсоры чужая кнопка трогать не должна. */
    let mate: TestUser;
    /** Второй тип техники: им проверяется, что отбор списка кнопка понимает целиком, а не наполовину. */
    let printerTypeId: string;

    beforeAll(async () => {
      reader = await makeNewcomer('reader', []);
      mate = await makeNewcomer('mate', []);
      const type = await ctx.db.execute<{ id: string }>(
        sql`SELECT id FROM office_equipment_types WHERE code = 'printer'`,
      );
      printerTypeId = type.rows[0]!.id;
    });

    /** Площадка случая: она в области у обеих учёток угла — и ни у кого больше. */
    async function ownObject(tag: string): Promise<string> {
      const objectId = await makeObject(tag);
      await ctx.db.execute(sql`
        INSERT INTO user_construction_objects (user_id, construction_object_id)
        VALUES (${reader.id}, ${objectId}), (${mate.id}, ${objectId})`);
      return objectId;
    }

    /** Заявка угла: заводит её сам читатель — иначе он наблюдатель, и писать в неё некому. */
    const ask = (tag: string, objectId: string, typeId?: string): Promise<string> =>
      makeRequest({ tag, status: 'new', objectId, typeId, createdBy: reader.id });

    it('повторное нажатие подряд даёт 0: в счёт идут только сдвинувшиеся курсоры', async () => {
      const objectId = await ownObject('RA');
      const talky = await ask('кнопка две реплики', objectId);
      const quiet = await ask('кнопка одна реплика', objectId);
      await said(ctx.admin.auth, talky, 'первое', { sides: ['customer'] });
      await said(ctx.admin.auth, talky, 'второе', { sides: ['customer'] });
      await said(ctx.admin.auth, quiet, 'единственное', { sides: ['customer'] });

      // Обе заявки видит первое нажатие: курсора у читателя не было ни по одной — это вставки.
      expect(await readAll(reader.auth, { objectId })).toBe(2);
      // ВОТ ОН, ДЕФЕКТ РЕВЮ. Без предиката у `DO UPDATE` обе строки обновились бы снова, и ручка
      // ответила бы «2» на нажатие, которое ничего не изменило: ноль не наступал бы никогда.
      expect(await readAll(reader.auth, { objectId })).toBe(0);

      const first = await chatOf(reader.auth, talky);
      expect(first.unreadMine).toBe(0);
      expect(first.readThroughSeq).toBe(2);
      expect((await chatOf(reader.auth, quiet)).readThroughSeq).toBe(1);

      // Пришло новое в одну заявку — и в счёт идёт ровно она: вторая стоит на `lastSeq`.
      await said(ctx.admin.auth, quiet, 'а вот и второе', { sides: ['customer'] });
      expect(await readAll(reader.auth, { objectId })).toBe(1);
      expect((await chatOf(reader.auth, quiet)).readThroughSeq).toBe(2);
    });

    it('гасит только заявки отбора: соседняя площадка и другой тип техники остаются', async () => {
      const objectId = await ownObject('RB');
      const aside = await ownObject('RC');
      const inScope = await ask('кнопка в отборе', objectId);
      const otherObject = await ask('кнопка чужая площадка', aside);
      const otherType = await ask('кнопка чужой тип', objectId, printerTypeId);
      for (const id of [inScope, otherObject, otherType]) {
        await said(ctx.admin.auth, id, 'посмотрите, пожалуйста', { sides: ['customer'] });
      }

      // Отбор — площадка И тип: за вторую половину отвечает соединение с `office_equipment` внутри
      // ручки, и без него кнопка гасила бы то, чего человек на экране не видит.
      expect(await readAll(reader.auth, { objectId, equipmentTypeId: ctx.typeId })).toBe(1);
      expect((await chatOf(reader.auth, inScope)).unreadMine).toBe(0);

      for (const id of [otherObject, otherType]) {
        const summary = await chatOf(reader.auth, id);
        expect(summary.unreadMine).toBe(1);
        // Курсора нет вовсе: кнопка не поставила его даже на ноль.
        expect(summary.readThroughSeq).toBe(0);
      }

      // Другой отбор — и гаснет ровно заявка соседней площадки, а третья по-прежнему ждёт.
      expect(await readAll(reader.auth, { objectId: aside })).toBe(1);
      expect((await chatOf(reader.auth, otherObject)).unreadMine).toBe(0);
      expect((await chatOf(reader.auth, otherType)).unreadMine).toBe(1);
    });

    it('чужие курсоры не двигаются: у соседа по площадке непрочитанное остаётся', async () => {
      const objectId = await ownObject('RD');
      const id = await ask('кнопка и сосед', objectId);
      await said(ctx.admin.auth, id, 'вопрос заявителю', { sides: ['customer'] });
      await said(ctx.admin.auth, id, 'и ещё один', { sides: ['customer'] });
      // Адресат «Заявителю» бьёт по всей стороне заказчика: непрочитано у обоих.
      expect((await chatOf(reader.auth, id)).unreadMine).toBe(2);
      expect((await chatOf(mate.auth, id)).unreadMine).toBe(2);

      expect(await readAll(reader.auth, { objectId })).toBe(1);
      expect((await chatOf(reader.auth, id)).unreadMine).toBe(0);

      const untouched = await chatOf(mate.auth, id);
      expect(untouched.unreadMine).toBe(2);
      expect(untouched.readThroughSeq).toBe(0);
      // И его собственное нажатие — настоящий сдвиг, а не «уже прочитано»: курсоры у людей свои.
      expect(await readAll(mate.auth, { objectId })).toBe(1);
      expect((await chatOf(mate.auth, id)).unreadMine).toBe(0);

      const cursors = await ctx.db.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c FROM service_request_message_reads WHERE request_id = ${id}`);
      expect(Number(cursors.rows[0]!.c)).toBe(2);
    });

    it('заявка, дочитанная окном до последней реплики, в счёт не идёт', async () => {
      const objectId = await ownObject('RE');
      const seen = await ask('кнопка дочитанная', objectId);
      const fresh = await ask('кнопка непрочитанная', objectId);
      await said(ctx.admin.auth, seen, 'это прочитают окном', { sides: ['customer'] });
      await said(ctx.admin.auth, fresh, 'а это нет', { sides: ['customer'] });

      // Курсор двигает окно заявки — обычной ручкой `messages/read`, а не кнопкой списка.
      const readAt = async (): Promise<string> =>
        new Date(
          (
            await ctx.db.execute<{ read_at: Date }>(sql`
              SELECT read_at FROM service_request_message_reads
               WHERE request_id = ${seen} AND user_id = ${reader.id}`)
          ).rows[0]!.read_at,
        ).toISOString();
      expect((await markRead(reader.auth, seen, 1)).json()).toEqual({ readThroughSeq: 1, lastSeq: 1 });
      const before = await readAt();

      // Кнопка находит в отборе обе заявки, а двигает одну: вторая уже стоит на `lastSeq`.
      expect(await readAll(reader.auth, { objectId })).toBe(1);
      expect((await chatOf(reader.auth, fresh)).readThroughSeq).toBe(1);
      // Неподвижную строку нажатие не трогает вовсе. `read_at` разбирает жалобы «я это не читал»,
      // и переписывать его нажатием, которое ничего не прочло, значило бы стирать свидетельство.
      expect(await readAt()).toBe(before);
    });
  });

  // ── п. 18. Бейдж раздела ──

  /**
   * `GET /unread-count` — число на пункте меню. До ревью оно тоже не сверялось ни разу: п. 16 гоняет
   * ту же ручку `EXPLAIN`'ом, то есть измеряет её стоимость, а не ответ.
   *
   * Свой человек на своей площадке — по той же причине, что в п. 17: счёт идёт по ВСЕЙ области
   * субъекта, и на общей площадке фикстуры ответ зависел бы от соседних случаев.
   */
  describe('п. 18. счётчик бейджа считает заявки, а не реплики', () => {
    let reader: TestUser;
    let objectId: string;

    beforeAll(async () => {
      objectId = await makeObject('UC');
      reader = await makeNewcomer('badge', [objectId]);
    });

    const ask = (tag: string): Promise<string> =>
      makeRequest({ tag, status: 'new', objectId, createdBy: reader.id });

    it('две непрочитанные реплики одной заявки — это единица, а не двойка', async () => {
      const first = await ask('бейдж две реплики');
      await said(ctx.admin.auth, first, 'первое', { sides: ['customer'] });
      await said(ctx.admin.auth, first, 'второе', { sides: ['customer'] });

      // Бейдж ведёт в список, и «1» обязано означать одну строку, к которой надо подойти: реплики
      // считает яркая метка в самой строке, и путать их местами нельзя.
      expect((await chatOf(reader.auth, first)).unreadMine).toBe(2);
      expect(await unreadCount(reader.auth)).toBe(1);

      const second = await ask('бейдж вторая заявка');
      await said(ctx.admin.auth, second, 'и здесь тоже', { sides: ['customer'] });
      expect(await unreadCount(reader.auth)).toBe(2);
    });

    it('заявка вне области видимости в счёт не идёт', async () => {
      const before = await unreadCount(reader.auth);
      // Заявка фикстурной площадки: читателю она не видна, а реплика в ней — самая настоящая, и
      // тому, кто площадку ведёт, она приходит непрочитанной.
      const alien = await makeFullRequest('бейдж чужая площадка');
      await said(ctx.admin.auth, alien, 'всем участникам', { sides: ['all'] });
      expect((await chatOf(ctx.author.auth, alien)).unreadMine).toBe(1);

      // Бейдж ведёт в список, отобранный той же `visibility`: разойдись они, он звал бы в пустоту.
      expect(await unreadCount(reader.auth)).toBe(before);
    });

    it('своё сообщение себя не подсвечивает', async () => {
      const before = await unreadCount(reader.auth);
      const id = await ask('бейдж своё сообщение');
      await said(reader.auth, id, 'записал для ведения', { sides: ['operator'] });
      // Реплика настоящая — «Ведению» она приходит яркой; себя автор ею не зажигает.
      expect((await chatOf(ctx.admin.auth, id)).unreadMine).toBe(1);
      expect((await chatOf(reader.auth, id)).unreadMine).toBe(0);
      expect(await unreadCount(reader.auth)).toBe(before);
    });

    it('после «Отметить все прочитанными» бейдж гаснет, а новая реплика зажигает его снова', async () => {
      expect(await unreadCount(reader.auth)).toBeGreaterThan(0);
      // Без отбора — то есть по всей области: ровно так кнопку нажимают в списке без фильтров.
      expect(await readAll(reader.auth)).toBeGreaterThan(0);
      expect(await unreadCount(reader.auth)).toBe(0);

      const id = await ask('бейдж после кнопки');
      await said(ctx.admin.auth, id, 'а это уже после', { sides: ['customer'] });
      expect(await unreadCount(reader.auth)).toBe(1);
    });
  });
});
