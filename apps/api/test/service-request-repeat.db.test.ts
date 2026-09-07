import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SERVICE_REQUEST_REPEAT_KIND } from '@technic/contracts';
import type { ServiceRequestDto, ServiceRequestRepeatDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Схема — значением: конфигурации она не читает и до подготовки окружения импортируется свободно.
// Всё остальное (клиент базы, приложение, сам предикат) приезжает `await import` уже после неё.
import { serviceRequests } from '../src/db/schema';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type { Principal } from '../src/auth/principal';
import type * as RepeatService from '../src/services/service-request-repeat';

/**
 * ПРИЗНАК ПОВТОРНОГО ОБРАЩЕНИЯ ПО АППАРАТУ — набор §10.1 плана
 * `docs/office-equipment-repeat-request-plan.md` (правило Р1, этапы Э1 и Э2).
 *
 * ЗАЧЕМ ФАЙЛ. Правило пишется один раз и читается четырьмя способами: меткой строки списка,
 * строкой карточки, отбором «только повторные» и ссылкой «предыдущие». Разъедься они хоть в одном
 * условии — метка обещала бы одно, а ссылка показывала бы другое, и §11 плана считает это провалом
 * приёмки (К3). Здесь проверяется не «функция возвращает число», а то, что число это ОДНО И ТО ЖЕ
 * во всех местах, где его спрашивают, и что оно меняется ровно тогда, когда меняются данные.
 *
 * ЧТО ЗАКРЕПЛЕНО — случаи §10.1 в том же порядке:
 *
 *   1. обе границы окна включены, за границей — ничего; и находка рядом: субмиллисекундная часть
 *      `created_at` до предиката не доезжает, поэтому «на микросекунду раньше» из §10.1 сегодня
 *      не различается, а метка с отбором на этом зазоре расходятся;
 *   2. отменённая предшественница считается, незакрытая — нет («Решена» тоже нет);
 *   3. архив совпадение снимает, восстановление возвращает;
 *   4. соседний аппарат не считается, у заявки без аппарата признака нет вовсе;
 *   5. расходники ни метки не получают, ни предшественницами не бывают;
 *   6. откат приёмки предшественницы гасит метку у соседней, ничего в соседней не тронув;
 *   7. область признака — область читателя, и число совпадает со списком «предыдущих»;
 *   8. нулевое окно: ни поля в ответе, ни пустой выдачи с ошибкой, ни единого запроса в базу;
 *   9. у каждой строки страницы своё окно, а запрос на всю страницу один;
 *  10. отбор «только повторные» ложится на частичный индекс `service_requests_repeat_idx`;
 *  11. время идёт, метка стоит: окно привязано к `created_at` заявки, а не к сегодняшнему дню;
 *  12. отбор помечает ровно то множество, которое помечает метка (остаток п. 12 — ниже).
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Пункт 12 §10.1 спрашивает с режима `repeatFor` (`404` у невидимой `R`,
 * `422` в паре с `repeat=true`, постраничная выдача) — а его в маршруте и query-схеме сегодня нет:
 * реализованы поле ответа и отбор `repeat=true`, ссылка же существует только builder'ом
 * (`serviceRequestRepeatPreviousWhere`), которым и проверяется главное её свойство — «в списке
 * ровно те `P`, которые посчитала метка» (случай 7). Коды ответов ручки закрываются вместе с самой
 * ручкой.
 *
 * ИСХОДЫ И ДАТЫ ЗАЯВОК СТАВЯТСЯ ПРЯМЫМ SQL, и это осознанно — тот же приём и та же причина, что в
 * `equipment-history-blocks.db.test.ts`. Предмет файла — ЧИТАЮЩЕЕ правило: оно смотрит на `status`,
 * `status_changed_at`, `deleted_at`, `kind` и `office_equipment_id`, и больше ни на что. Провести
 * каждую предшественницу настоящим циклом (смета → предъявление → согласование → закрытие →
 * приёмка) значило бы проверять здесь маршруты цикла — предмет соседнего файла
 * (`service-request-warranty-transitions.db.test.ts`), — а главное, ручками НЕВОЗМОЖНО задать
 * прошлое: границы окна считаются долями секунды от `created_at` заявки, и сервер такие даты не
 * принимает ниоткуда. Даты поэтому и ставятся относительно самой заявки, а не абсолютным моментом:
 * `R.created_at ± интервал` не зависит ни от часов машины, ни от длительности прогона.
 *
 * Контрагент проставляется ВМЕСТЕ со статусом: заявка в рабочем или принятом статусе без
 * исполнителя не проходит отложенный триггер `service_requests_executor_present` (миграция 0178).
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test` (образец — `service-request-warranty-transitions`):
 * половина случаев читает ВЕСЬ набор совпадений по аппарату и сверяет счёт с выборкой, а по общей
 * базе идут параллельные прогоны и лежит копия боевого парка — чужая строка сделала бы «×1» и «×2»
 * вопросом расписания. База заводится, мигрируется с нуля и сносится в `afterAll`.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса кластера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev \
 *     pnpm --filter @technic/api exec vitest run --maxWorkers=1 test/service-request-repeat.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_repeat_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-service-repeat-password-123';
const REQUESTS = '/api/v1/service-requests';
const EQUIPMENT = '/api/v1/office-equipment';

/**
 * Окно прогона — ненулевое, потому что нулевое означает «признака нет вовсе» (Р5), и с ним не
 * проверить ни одного правила. Тридцать дней — кандидат замера §8, а не утверждённый порог: ни один
 * случай ниже на самом числе не держится, все считают границы ОТНОСИТЕЛЬНО него.
 */
const WINDOW_DAYS = 30;

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
  repeat: typeof RepeatService;
  /**
   * Читатель без сужения области: администратор видит заявки всех площадок. Он же заводит фикстуры
   * — областью роли они не ограничены, и «оператор с площадки А не может завести заявку на Б» не
   * должно мешать проверять правило, к заведению отношения не имеющее.
   */
  admin: TestUser;
  adminPrincipal: Principal;
  /**
   * Читатель ОДНОЙ площадки: «Оргтехника: ведение» на объекте Б и ничего сверх. Ради него и
   * заведён второй объект — Р8 проверяется только тем, что у двух читателей числа РАЗНЫЕ.
   */
  siteReader: TestUser;
  siteReaderPrincipal: Principal;
  /** Площадка, с которой аппарат уехал: заявки, заведённые на ней, читателю объекта Б не видны. */
  objectA: string;
  /** Площадка читателя `siteReader`. */
  objectB: string;
  typeId: string;
  serviceCounterpartyId: string;
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
  process.env.MAIL_ENABLED ??= 'false';
  // Признак включается ИМЕННО ЗДЕСЬ, а не умолчанием: кодовое умолчание — ноль, то есть «выключен»
  // (Р5), и прогон с ним проверял бы отсутствие метки двенадцатью способами.
  process.env.SERVICE_REQUEST_REPEAT_WINDOW_DAYS = String(WINDOW_DAYS);
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/** Десятизначный ИНН с настоящей контрольной суммой: портал проверяет её при заведении. */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
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
    ...(payload === undefined ? {} : { payload }),
  });
}

async function card(id: string, auth: Auth = ctx.admin.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

/** Признак из карточки. `undefined` — «признака нет вовсе», и это не то же, что `count: 0` (§6). */
async function repeatOf(
  id: string,
  auth: Auth = ctx.admin.auth,
): Promise<ServiceRequestRepeatDto | undefined> {
  return (await card(id, auth)).repeat;
}

interface ListPage {
  items: ServiceRequestDto[];
  total: number;
}

async function list(query: string, auth: Auth = ctx.admin.auth): Promise<ListPage> {
  const res = await inject('GET', `${REQUESTS}?${query}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ListPage;
}

// ── Фикстуры ──

let unitNo = 0;
/** Своя единица на случай: по единице и виду незакрытая заявка бывает одна (замок §2.1 плана). */
async function makeEquipment(tag: string, objectId?: string): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', EQUIPMENT, ctx.admin.auth, {
    equipmentTypeId: ctx.typeId,
    name: `Kyocera ECOSYS ${tag} ${RUN}`,
    inventoryNumber: `RP-${RUN}-${unitNo}`,
    objectId: objectId ?? ctx.objectB,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

async function createRequest(
  officeEquipmentId: string,
  description: string,
  kind: 'repair' | 'consumable' = 'repair',
): Promise<string> {
  const res = await inject('POST', REQUESTS, ctx.admin.auth, {
    officeEquipmentId,
    kind,
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { request: ServiceRequestDto }).request.id;
}

type FixtureStatus = 'new' | 'in_work' | 'done' | 'accepted' | 'cancelled';

/** Исход заявки — прямым SQL (см. шапку). Контрагент идёт вместе со статусом: триггер 0178. */
async function settle(id: string, status: FixtureStatus): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE service_requests
       SET status = ${sql.raw(`'${status}'::service_request_status`)},
           service_counterparty_id = ${ctx.serviceCounterpartyId}
     WHERE id = ${id}`);
}

/**
 * Момент закрытия предшественницы — ОТНОСИТЕЛЬНО `created_at` заявки, для которой считают признак.
 *
 * Именно так написано условие 4 правила Р1, и проверять его абсолютными датами значило бы проверять
 * заодно часы машины и длительность прогона: между заведением заявки и `UPDATE` проходит время, и
 * «минус тридцать дней от сейчас» уже не равно «минус тридцать дней от `created_at`». Микросекунда
 * в случае 1 — ровно та разница, на которой это ломается.
 */
async function closedAt(prevId: string, requestId: string, offset: string): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE service_requests
       SET status_changed_at =
             (SELECT r.created_at FROM service_requests r WHERE r.id = ${requestId})
             ${sql.raw(offset)}
     WHERE id = ${prevId}`);
}

/** Заявка, заведённая в прошлом: `created_at` ручками не задаётся ниоткуда. */
async function createdAgo(id: string, offset: string): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE service_requests SET created_at = now() ${sql.raw(offset)} WHERE id = ${id}`);
}

async function archive(id: string, archived: boolean): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE service_requests
       SET deleted_at = ${archived ? sql`now()` : sql`NULL`}
     WHERE id = ${id}`);
}

interface Pair {
  equipmentId: string;
  /** Предшественница `P`: принята и закрыта внутри окна. */
  prevId: string;
  /** Заявка `R`, у которой спрашивают признак. */
  id: string;
}

/**
 * Пара «принятая предшественница + заведённая после неё заявка» — общий вход почти всех случаев.
 *
 * Порядок шагов не свободен: пока `P` не закрыта, вторую ремонтную заявку по тому же аппарату не
 * пускает замок «одна открытая» (§2.1) — тот самый, который отвечает на вопрос «уже чиним?» и с
 * признаком повтора не имеет ничего общего.
 */
async function pair(tag: string, objectId?: string): Promise<Pair> {
  const equipmentId = await makeEquipment(tag, objectId);
  const prevId = await createRequest(equipmentId, `Не печатает — первый раз, случай ${tag}`);
  await settle(prevId, 'accepted');
  const id = await createRequest(equipmentId, `Опять не печатает — случай ${tag}`);
  await closedAt(prevId, id, `- interval '1 day'`);
  return { equipmentId, prevId, id };
}

/** Заявка в объёме правила Р1 — то, что builder принимает на вход от списка и от карточки. */
async function subjectOf(id: string): Promise<RepeatService.ServiceRequestRepeatSubject> {
  const [row] = await ctx.db
    .select({
      id: serviceRequests.id,
      officeEquipmentId: serviceRequests.officeEquipmentId,
      kind: serviceRequests.kind,
      createdAt: serviceRequests.createdAt,
    })
    .from(serviceRequests)
    .where(eq(serviceRequests.id, id));
  if (!row) throw new Error(`Заявки ${id} нет в базе`);
  return row;
}

/**
 * «Предыдущие» глазами читателя — то, что покажет ссылка метки (Р10). Пока это builder, а не ручка,
 * и в этом весь смысл сверки: длина выдачи обязана совпасть с `repeat.count`, посчитанным меткой.
 */
async function previousIds(
  p: Principal,
  subject: RepeatService.ServiceRequestRepeatSubject,
): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: serviceRequests.id })
    .from(serviceRequests)
    .where(ctx.repeat.serviceRequestRepeatPreviousWhere(p, subject));
  return rows.map((row) => row.id).sort();
}

describe.skipIf(!DB_URL)('повторное обращение по аппарату: правило и границы (§10.1 плана)', () => {
  beforeAll(async () => {
    /*
     * СВОЯ БАЗА С НУЛЯ. Первые миграции требуют расширений, которых в свежей базе нет вовсе
     * (`pgcrypto` для `gen_random_uuid`, `citext` для адреса учётки, `pg_trgm` для поиска).
     */
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
    const client = new pg.Client({ connectionString: OWN_DB });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    prepareEnv(OWN_DB!);
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const { loadPrincipal } = await import('../src/auth/principal');
    const repeat = await import('../src/services/service-request-repeat');
    const passwordHash = await hashPassword(PASSWORD);

    const object = async (code: string, name: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${code}, ${name}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const objectA = await object(`RP-A-${RUN}`, `Площадка повторов А ${RUN}`);
    const objectB = await object(`RP-B-${RUN}`, `Площадка повторов Б ${RUN}`);

    const counterpartyRow = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-Повтор ${RUN}`},
              ${innOf(`77${String(Date.now()).slice(-6)}0`)})
      RETURNING id`);
    const serviceCounterpartyId = counterpartyRow.rows[0]!.id;

    /*
     * Учётки — прямым SQL: форма учётки предмет своего теста, а здесь она декорация, без которой не
     * разложить двух читателей с разными областями.
     */
    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-rp-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const adminUser = await makeUser('admin', 'admin');
    const siteUser = await makeUser('site', 'shtab');
    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${siteUser.id}, ${objectB})`);

    /*
     * «Оргтехника: ведение» — сервисом, а не прямой вставкой: с шага 1a перехода на назначаемые
     * полномочия (ADR 0106) выдача пишет две таблицы одной транзакцией. Набор нужен ради
     * `serviceRequests.read`: базовая роль площадки заявок на обслуживание не читает вовсе, а
     * сквозной области модуля этот набор не даёт (`GRANT_MODULE_WIDE_SCOPE`) — читатель остаётся
     * ровно при своём объекте, что случаю 7 и требуется.
     */
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, siteUser.id, ['office_equipment_operator'], adminUser.id);
    });

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    const app = await buildApp();
    await app.ready();

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
    const principalOf = async (id: string): Promise<Principal> => {
      const p = await loadPrincipal(id);
      if (!p) throw new Error(`Принципал учётки ${id} не собрался`);
      return p;
    };

    ctx = {
      app,
      db,
      closeDb,
      repeat,
      admin: await withAuth(adminUser),
      adminPrincipal: await principalOf(adminUser.id),
      siteReader: await withAuth(siteUser),
      siteReaderPrincipal: await principalOf(siteUser.id),
      objectA,
      objectB,
      typeId,
      serviceCounterpartyId,
    };
  }, 300_000);

  afterAll(async () => {
    // База своя — уносим её целиком: чужих строк в ней нет по построению, а оставленная помешала бы
    // следующему прогону завести её заново.
    await ctx?.app?.close();
    await ctx?.closeDb?.();
    if (!ADMIN_DB) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  // ── 1 и 11. Окно ──

  describe('окно', () => {
    it('обе границы включены, а за границей ничего (§10.1, случай 1)', async () => {
      /*
       * Ради этого случая правило и написано интервалом по timestamp, а не сравнением календарных
       * дат: сравнение по датам сдвинуло бы обе границы на часовой пояс сервера и растянуло бы окно
       * на неполные сутки в одну сторону — молча и ровно на тех заявках, которые заведены поздно
       * вечером. Четыре положения одной и той же предшественницы, а не четыре пары: разница между
       * «попало» и «не попало» здесь измеряется одним шагом, и любое второе отличие между случаями
       * объясняло бы результат вместо него.
       *
       * ШАГ — МИЛЛИСЕКУНДА, А НЕ МИКРОСЕКУНДА, КАК В §10.1. Это не смягчение проверки, а предел
       * сегодняшней точности признака, и держится он ровно до миллисекунды: субмиллисекундная часть
       * `created_at` до предиката не доезжает. Почему — следующим случаем, там же и цена.
       */
      const { prevId, id } = await pair('window');
      const countAt = async (offset: string): Promise<number> => {
        await closedAt(prevId, id, offset);
        const dto = await repeatOf(id);
        expect(dto?.windowDays).toBe(WINDOW_DAYS);
        return dto!.count;
      };

      // Нижняя граница — ровно `W` дней назад: включена.
      expect(await countAt(`- interval '${WINDOW_DAYS} days'`)).toBe(1);
      // Шаг за неё — и предшественницы нет: «через полгода сломалось другое» повтором не считается.
      expect(await countAt(`- interval '${WINDOW_DAYS} days' - interval '1 millisecond'`)).toBe(0);
      // Верхний край окна — момент заведения заявки (сама точка — в находке ниже).
      expect(await countAt(`- interval '1 millisecond'`)).toBe(1);
      // Заявка, закрытая ПОСЛЕ заведения нашей, предшественницей не бывает по определению: правило
      // отвечает на «чинили и опять сломалось», а не «чинят прямо сейчас» (на это отвечает замок).
      expect(await countAt(`+ interval '1 microsecond'`)).toBe(0);
    });

    it('субмиллисекундная часть `created_at` не разводит метку с отбором (§10.1, случай 1; К3)', async () => {
      /*
       * СЛУЧАЙ-СТОРОЖ НАД ДОРОГОЙ ДАННЫХ, А НЕ НАД САМИМ ПРАВИЛОМ. `timestamptz` хранит
       * микросекунды, `Date` в JavaScript заканчивается миллисекундой. Пока пакетный счёт получал
       * `created_at` строкой из JS, обе границы окна уезжали вниз на этот хвост — а отбор «только
       * повторные» брал ту же дату колонкой, с полной точностью. На заявке ниже расхождение было
       * видно прямо: метка отвечала «повторов нет», и та же заявка стояла в списке повторных.
       *
       * Цена ошибки микроскопическая — чтобы попасть в зазор, предшественницу надо закрыть в ту же
       * миллисекунду, в которую заведена заявка, — но класс её ровно тот, против которого правило
       * и сведено в один builder (К3): числу метки и составу списка расходиться нельзя вовсе.
       * Поэтому проверяется здесь не «правильное число», а СОВПАДЕНИЕ двух ответов; правильное
       * число проверено соседним случаем на границах окна.
       */
      const { equipmentId, prevId, id } = await pair('microsecond');
      await ctx.db.execute(sql`
        UPDATE service_requests
           SET created_at = date_trunc('milliseconds', created_at) + interval '400 microseconds'
         WHERE id = ${id}`);
      await closedAt(prevId, id, `+ interval '0 days'`);

      // Верхняя граница включена: момент закрытия совпал с моментом заведения — повтор есть.
      expect((await repeatOf(id))?.count).toBe(1);
      // И отбор говорит ровно то же: одно правило, один ответ.
      const filtered = await list(`equipmentId=${equipmentId}&repeat=true`);
      expect(filtered.items.map((row) => row.id)).toEqual([id]);
    });

    it('месяцы спустя метка та же: окно привязано к заявке, а не к сегодня (§10.1, случай 11)', async () => {
      /*
       * Прямая проверка против самого соблазнительного упрощения — сравнить `status_changed_at` с
       * `now()`. С ним признак «истекал» бы по ночам: заявка, законно помеченная в день заведения,
       * теряла бы метку сама собой, а история переставала бы объяснять, почему тег вчера был.
       * Здесь пара целиком в прошлом — и метка обязана стоять ровно та же.
       */
      const { prevId, id } = await pair('frozen');
      await createdAgo(id, `- interval '200 days'`);
      await closedAt(prevId, id, `- interval '5 days'`);

      const dto = await repeatOf(id);
      expect(dto?.count).toBe(1);
      // Подсказка «последний раз чинили тогда-то» смотрит туда же, в прошлое, а не на сегодня.
      const at = new Date(dto!.lastAt!).getTime();
      expect(Date.now() - at).toBeGreaterThan(200 * 24 * 3600 * 1000);
    });
  });

  // ── 2, 3, 5. Какая предшественница считается ──

  describe('какая предшественница считается', () => {
    it('отменённая считается наравне с принятой, незакрытая — нет (§10.1, случай 2)', async () => {
      const { prevId, id } = await pair('status');
      expect((await repeatOf(id))?.count).toBe(1);

      // Отменённая входит (Р11, развилка В3): «завели, отменили, завели снова» — это и есть
      // обращение второй раз, а причина отмены («дубль») читается в самой заявке.
      await settle(prevId, 'cancelled');
      expect((await repeatOf(id))?.count).toBe(1);

      /*
       * Дальше нашу `R` приходится закрыть, и это не подгонка под удобство: замок «одна открытая
       * заявка на аппарат и вид» (§2.1) физически не даёт держать открытыми предшественницу и
       * заявку разом — частичный уникальный индекс `service_requests_open_repair_unique` считает
       * ровно такие строки. Правилу же статус самой `R` безразличен: повтором бывает и новая
       * заявка, и давно закрытая.
       */
      await settle(id, 'cancelled');
      expect((await repeatOf(id))?.count).toBe(1);

      // «Решена» терминальной для правила НЕ считается намеренно: работы закрыты, но заявку ещё
      // принимают, и повтором по ней считалась бы заявка, заведённая до того, как первую досмотрели.
      for (const open of ['done', 'in_work', 'new'] as const) {
        await settle(prevId, open);
        expect((await repeatOf(id))?.count, `предшественница в статусе ${open}`).toBe(0);
      }
    });

    it('архив совпадение снимает, восстановление возвращает (§10.1, случай 3)', async () => {
      /*
       * Второй довод против хранимого признака (Р6): архивирование и восстановление ПРЕДШЕСТВЕННИЦЫ
       * мгновенно меняют результат у соседней заявки, к которой никто не прикасался. Архив ставится
       * SQL, а не ручкой, по простой причине: принятую заявку ручка удаления не сносит вовсе, а
       * правило читает саму колонку `deleted_at` — и обязано читать её при любом происхождении.
       */
      const { prevId, id } = await pair('archive');
      expect((await repeatOf(id))?.count).toBe(1);

      await archive(prevId, true);
      expect((await repeatOf(id))?.count).toBe(0);

      await archive(prevId, false);
      expect((await repeatOf(id))?.count).toBe(1);
    });

    it('расходники ни метки не получают, ни предшественницами не бывают (§10.1, случай 5)', async () => {
      /*
       * Р3 целиком: повторная заявка на расходники — норма, а не сигнал. Картридж кончается
       * регулярно, и «Повтор ×5» у принтера, которому пять раз меняли тонер, обесценило бы саму
       * метку. Обе половины правила проверяются порознь, потому что ломаются они порознь: забыв вид
       * у `R`, мы пометили бы заявку на тонер; забыв у `P` — посчитали бы тонер ремонтом.
       */
      const first = await makeEquipment('kind-r');
      const repairPrev = await createRequest(first, 'Замяло бумагу, чинили');
      await settle(repairPrev, 'accepted');
      const consumable = await createRequest(first, 'Закончился тонер', 'consumable');
      await closedAt(repairPrev, consumable, `- interval '1 day'`);
      const consumableDto = await card(consumable);
      expect(Object.hasOwn(consumableDto, 'repeat')).toBe(false);

      const second = await makeEquipment('kind-p');
      const consumablePrev = await createRequest(second, 'Меняли картридж', 'consumable');
      await settle(consumablePrev, 'accepted');
      const repair = await createRequest(second, 'Не печатает');
      await closedAt(consumablePrev, repair, `- interval '1 day'`);
      // Не `undefined`: признак посчитан и честно отвечает «повторов нет» — иначе отбор «только
      // повторные» на этой строке было бы нечем объяснить (§6).
      expect(await repeatOf(repair)).toEqual({ count: 0, windowDays: WINDOW_DAYS, lastAt: null });
    });
  });

  // ── 4. К какой заявке признак применяется ──

  describe('предмет заявки', () => {
    it('соседний аппарат не считается, у заявки без аппарата признака нет (§10.1, случай 4)', async () => {
      const neighbour = await makeEquipment('other-unit');
      const neighbourPrev = await createRequest(neighbour, 'Чинили соседний аппарат');
      await settle(neighbourPrev, 'accepted');

      const own = await makeEquipment('own-unit');
      const id = await createRequest(own, 'Не печатает');
      await closedAt(neighbourPrev, id, `- interval '1 day'`);
      // Условие 1 правила — «тот же аппарат», и никакого «та же модель» или «тот же тип» в нём нет:
      // подменой была бы любая из них (Р4).
      expect(await repeatOf(id)).toEqual({ count: 0, windowDays: WINDOW_DAYS, lastAt: null });

      /*
       * Заявка от площадки без аппарата (розетка, сеть, «поставьте новый») — у неё признака нет
       * ВОВСЕ, а не ноль совпадений: сравнивать не с чем. Разница видна порталу — при отсутствии
       * поля тега нет и места под него не рисуется.
       */
      const res = await inject('POST', REQUESTS, ctx.admin.auth, {
        objectId: ctx.objectB,
        description: 'Поставьте розетку у стола',
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
      });
      expect(res.statusCode, res.body).toBe(201);
      const empty = (res.json() as { request: ServiceRequestDto }).request;
      expect(empty.equipment).toBeNull();
      expect(Object.hasOwn(await card(empty.id), 'repeat')).toBe(false);
    });
  });

  // ── 6. Признак не хранится ──

  describe('признак не хранится', () => {
    it('откат приёмки предшественницы гасит метку у соседней, не тронув соседнюю (§10.1, случай 6)', async () => {
      /*
       * Первый довод Р6 против материализации: терминальность обратима, и откат приёмки ЧУЖОЙ
       * заявки меняет признак у нашей. Храни мы флаг колонкой — его пришлось бы обновлять каскадом
       * при каждом переходе соседней заявки, а промах каскада читался бы как «повтор был, да сплыл».
       *
       * Что здесь считается доказательством: `version` и `updated_at` заявки `R` до и после отката
       * ОДИНАКОВЫ. Никто в неё не писал — а число изменилось.
       *
       * Заявка `R` закрыта заранее, и это не декорация случая, а его условие: пока `R` открыта,
       * отката приёмки `P` по тому же аппарату не бывает вовсе — обе оказались бы незакрытыми, и
       * `service_requests_open_repair_unique` такую пару не принимает. То есть состояние из §10.1
       * достижимо только при закрытой (или снесённой в архив) соседке.
       */
      const { prevId, id } = await pair('rollback');
      await settle(id, 'accepted');
      const before = await card(id);
      expect(before.repeat?.count).toBe(1);

      await settle(prevId, 'done');

      const after = await card(id);
      expect(after.repeat?.count).toBe(0);
      expect(after.version).toBe(before.version);
      expect(after.updatedAt).toBe(before.updatedAt);
    });
  });

  // ── 7. Область признака ──

  describe('область читателя', () => {
    it('у каждого читателя своё число, и оно равно списку «предыдущих» (§10.1, случай 7)', async () => {
      /*
       * ГЛАВНЫЙ ТЕСТ Р8. Число совпадений — свойство ПАРЫ «читатель ↔ заявка», а не заявки: считай
       * мы его по всем строкам, оно само стало бы оракулом (находка Н4) — заявитель узнал бы, что по
       * «его» аппарату есть заявки соседнего отдела, не увидев ни одной из них.
       *
       * Расхождение строится переездом аппарата — единственным способом, каким у заявок ОДНОЙ
       * единицы оказываются разные площадки: снимок площадки заявка берёт при заведении и потом не
       * меняет (перемещение правит карточку парка, а не историю обращений). Поэтому `P1` навсегда
       * остаётся заявкой площадки А, а `P2` и `R` — заявками площадки Б.
       *
       * И второе утверждение того же случая, ради которого метку вообще делают ссылкой: число
       * обязано совпасть с тем, что человек УВИДИТ, перейдя по ней. У обоих читателей.
       */
      const equipmentId = await makeEquipment('scope', ctx.objectA);
      const prevA = await createRequest(equipmentId, 'Чинили, пока стоял на площадке А');
      await settle(prevA, 'accepted');

      const moved = await inject('POST', `${EQUIPMENT}/${equipmentId}/move`, ctx.admin.auth, {
        objectId: ctx.objectB,
        movedOn: new Date().toISOString().slice(0, 10),
        reason: 'Переезд отдела на другую площадку',
      });
      expect(moved.statusCode, moved.body).toBe(201);

      const prevB = await createRequest(equipmentId, 'Чинили уже на площадке Б');
      await settle(prevB, 'accepted');
      const id = await createRequest(equipmentId, 'Опять не печатает');
      // Позже закрыта та, которой узкий читатель НЕ видит: иначе «последний раз чинили тогда-то»
      // совпало бы у обоих случайно, и подсказка проверялась бы совпадением, а не правилом.
      await closedAt(prevA, id, `- interval '2 days'`);
      await closedAt(prevB, id, `- interval '5 days'`);

      const wide = await repeatOf(id);
      const narrow = await repeatOf(id, ctx.siteReader.auth);
      expect(wide?.count).toBe(2);
      expect(narrow?.count).toBe(1);

      const subject = await subjectOf(id);
      const widePrevious = await previousIds(ctx.adminPrincipal, subject);
      const narrowPrevious = await previousIds(ctx.siteReaderPrincipal, subject);
      expect(widePrevious).toEqual([prevA, prevB].sort());
      // Ровно та заявка, которую этот читатель и так видит списком, — и ни одной сверх.
      expect(narrowPrevious).toEqual([prevB]);
      // Само обещание метки (К3): сколько сказано, столько человек и увидит, перейдя по ссылке.
      expect(widePrevious.length).toBe(wide?.count);
      expect(narrowPrevious.length).toBe(narrow?.count);
      // Текущая заявка в «предыдущие» не входит — вычитать её из счётчика поэтому не приходится.
      expect(widePrevious).not.toContain(id);

      /*
       * Подсказка «последний раз чинили тогда-то» тоже считается в области читателя: возьми она
       * максимум по всем совпадениям, узкий читатель прочёл бы дату заявки, которой не видит.
       * Здесь обе даты разные, и совпасть они не могут случайно.
       */
      expect(wide?.lastAt).not.toBe(narrow?.lastAt);
    });
  });

  // ── 8. Выключенный признак ──

  describe('нулевое окно', () => {
    it('поля в ответе нет, отбор пуст и не ошибочен, в базу за признаком не ходят (§10.1, случай 8)', async () => {
      /*
       * Ноль — не «окно нулевой длины», а рубильник признака целиком (Р5), и он же безопасное
       * состояние первого выката (Э4). Проверяются все три его обещания разом, потому что порознь
       * каждое выглядит выполненным: поле можно не показать, продолжая считать; отбор можно
       * «выключить» ошибкой 422 — и список сломается у человека, который ничего сегодня не нажимал,
       * а всего лишь помнит фильтр с прошлого сеанса (ADR 0139).
       *
       * Окно подменяется в самой настройке, а не переменной окружения: конфиг читается при импорте,
       * и второе приложение в том же процессе завести нечем. Значение возвращается в `finally` —
       * следующие случаи считают по включённому признаку.
       */
      const { equipmentId, id } = await pair('disabled');
      expect((await repeatOf(id))?.count).toBe(1);

      const { config } = await import('../src/config');
      const saved = config.serviceRequests.repeatWindowDays;
      (config.serviceRequests as { repeatWindowDays: number }).repeatWindowDays = 0;
      try {
        expect(Object.hasOwn(await card(id), 'repeat')).toBe(false);

        const filtered = await list(`equipmentId=${equipmentId}&repeat=true`);
        expect(filtered.items).toEqual([]);
        expect(filtered.total).toBe(0);

        /*
         * «Не ходим в базу вовсе» — утверждение о ЦЕНЕ выключенного признака, и проверить его можно
         * только счётчиком обращений: пустая карта возвращается и в том случае, когда запрос всё же
         * ушёл, а совпадений не нашлось.
         */
        const spy = vi.spyOn(ctx.db, 'execute');
        try {
          const map = await ctx.repeat.serviceRequestRepeatByRequest(ctx.adminPrincipal, [
            await subjectOf(id),
          ]);
          expect(map.size).toBe(0);
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      } finally {
        (config.serviceRequests as { repeatWindowDays: number }).repeatWindowDays = saved;
      }
    });
  });

  // ── 9. Страница ──

  describe('страница списка', () => {
    it('у каждой строки своё окно, и запрос на всю страницу один (§10.1, случай 9)', async () => {
      /*
       * ПРЯМОЙ ТЕСТ ПРОТИВ НАИВНОЙ ГРУППИРОВКИ ПО АППАРАТУ (Р6). Условие 4 правила сравнивает
       * закрытие предшественницы с `created_at` ТЕКУЩЕЙ заявки, а у строк страницы эти даты разные.
       * Сгруппировав по аппарату, сервер посчитал бы одно число на единицу техники и приписал бы
       * свежий счёт заявке, заведённой полгода назад, — метка «Повтор» появилась бы в архиве, где
       * повторяться было нечему.
       *
       * Обе заявки лежат на ОДНОМ аппарате и приходят одной страницей: порознь ошибка группировки
       * не воспроизводится вовсе.
       */
      const equipmentId = await makeEquipment('page');
      const old = await createRequest(equipmentId, 'Полгода назад чинили и закрыли');
      await settle(old, 'cancelled');
      await createdAgo(old, `- interval '200 days'`);
      await closedAt(old, old, `+ interval '0 days'`);

      const prevId = await createRequest(equipmentId, 'Чинили на прошлой неделе');
      await settle(prevId, 'accepted');
      const fresh = await createRequest(equipmentId, 'Опять не печатает');
      await closedAt(prevId, fresh, `- interval '1 day'`);

      const page = await list(`equipmentId=${equipmentId}&pageSize=50`);
      const byId = new Map(page.items.map((row) => [row.id, row.repeat]));
      expect(byId.size).toBe(3);
      expect(byId.get(fresh)?.count).toBe(1);
      // У старой заявки в её собственном окне не закрывалось ничего — и метки у неё нет.
      expect(byId.get(old)?.count).toBe(0);
      // Предшественница сама повтором не стала: до неё в её окне тоже пусто.
      expect(byId.get(prevId)?.count).toBe(0);

      /*
       * Цена страницы (К5): один дополнительный запрос независимо от числа строк. Считается на
       * builder'е, а не на ручке, — иначе счётчик поймал бы заодно вложения, исполнителей, чат и
       * прочие блоки карточки, и «один» пришлось бы объяснять арифметикой.
       */
      const subjects = await Promise.all([old, prevId, fresh].map(subjectOf));
      const spy = vi.spyOn(ctx.db, 'execute');
      try {
        const map = await ctx.repeat.serviceRequestRepeatByRequest(ctx.adminPrincipal, subjects);
        expect(map.size).toBe(3);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── 10 и 12. Отбор «только повторные» ──

  describe('отбор «только повторные»', () => {
    it('отбирает ровно то множество, которое помечает метка (§10.1, случай 12)', async () => {
      /*
       * Одно правило — четыре потребителя (Р4), и разъехаться им нельзя ни на строку: метка,
       * обещавшая «Повтор», и отбор, этой заявки не показавший, — это не «мелкое расхождение», а
       * два разных ответа сервера на один вопрос. Множества сверяются целиком, а не по счётчику:
       * совпадение размеров бывает и у разных наборов.
       */
      const equipmentId = await makeEquipment('filter');
      const old = await createRequest(equipmentId, 'Давняя заявка');
      await settle(old, 'cancelled');
      await createdAgo(old, `- interval '200 days'`);
      await closedAt(old, old, `+ interval '0 days'`);

      const prevId = await createRequest(equipmentId, 'Чинили на прошлой неделе');
      await settle(prevId, 'accepted');
      const fresh = await createRequest(equipmentId, 'Опять не печатает');
      await closedAt(prevId, fresh, `- interval '1 day'`);

      const all = await list(`equipmentId=${equipmentId}&pageSize=50`);
      const marked = all.items
        .filter((row) => (row.repeat?.count ?? 0) > 0)
        .map((row) => row.id)
        .sort();
      const filtered = await list(`equipmentId=${equipmentId}&repeat=true&pageSize=50`);
      expect(filtered.items.map((row) => row.id).sort()).toEqual(marked);
      expect(marked).toEqual([fresh]);
      // Счётчик страницы зовёт тот же `listWhere`: разойдись он с выдачей, список показывал бы
      // «показано 1 из 3».
      expect(filtered.total).toBe(1);
    });

    it('ложится на частичный индекс `service_requests_repeat_idx` (§10.1, случай 10)', async () => {
      /*
       * Отбор — единственный потребитель правила, у которого условие попадает в `WHERE` самой
       * выборки, и ради него индекс Р7 (миграция 0276) и заводился: без него `EXISTS` брал бы все
       * заявки аппарата и отбрасывал бы лишнее уже после чтения.
       *
       * ЧТО ИМЕННО ПРОВЕРЯЕТСЯ: что весь предикат ложится в `Index Cond`, а не остаётся фильтром
       * после чтения. Одного упоминания индекса в плане мало — он попадает туда и тогда, когда по
       * нему прочитаны все терминальные ремонты подряд, а аппарат и окно проверены уже строками.
       * Снаружи остаётся только `id <> id` — шестое условие Р1, ключом ему быть незачем.
       *
       * ВЫКЛЮЧЕННЫЕ ПЕРЕКЛЮЧАТЕЛИ ПЛАНИРОВЩИКА — не подгонка ответа, а единственный способ задать
       * вопрос на тестовых данных. В таблице десяток строк, и планировщик прав, выбирая по ним
       * последовательное чтение и хеш-соединение: на такой таблице ЛЮБОЙ индекс дороже. Запреты
       * спрашивают другое — «существует ли вообще индексный путь к этому условию и покрывает ли он
       * его целиком», а это свойство самого индекса, а не объёма данных. `SET LOCAL` внутри
       * транзакции: соединение возвращается в пул чистым.
       */
      const equipmentId = await makeEquipment('explain');
      const prevId = await createRequest(equipmentId, 'Чинили');
      await settle(prevId, 'accepted');
      const id = await createRequest(equipmentId, 'Опять не печатает');
      await closedAt(prevId, id, `- interval '1 day'`);
      await ctx.db.execute(sql`ANALYZE service_requests`);

      const where = ctx.repeat.serviceRequestRepeatWhere(ctx.adminPrincipal);
      const plan = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        await tx.execute(sql`SET LOCAL enable_hashjoin = off`);
        await tx.execute(sql`SET LOCAL enable_mergejoin = off`);
        await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
        await tx.execute(sql`SET LOCAL enable_material = off`);
        const res = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`EXPLAIN SELECT ${serviceRequests.id} FROM ${serviceRequests} WHERE ${where}`,
        );
        return res.rows.map((row) => row['QUERY PLAN']).join('\n');
      });
      expect(plan).toContain('Index Scan using service_requests_repeat_idx');
      const cond =
        plan
          .slice(plan.indexOf('service_requests_repeat_idx'))
          .split('\n')
          .find((line) => line.includes('Index Cond:')) ?? '';
      expect(cond).toContain('office_equipment_id =');
      expect(cond).toContain(`kind = '${SERVICE_REQUEST_REPEAT_KIND}'`);
      expect(cond).toContain('status_changed_at >=');
      expect(cond).toContain('status_changed_at <=');
    });
  });
});
