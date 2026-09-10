import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, type ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * **РАСКЛАДКА СВОБОДНОГО ОБЪЁМА РАБОТ ПО ГРАФАМ** — серверная половина решения Р2 плана
 * `docs/office-equipment-free-estimate-and-executor-scope-plan.md` (ответ В9 заказчика от
 * 09.09.2026; §7, случаи Т1, Т4–Т7, Т20; миграция 0298).
 *
 * ЧТО ДОКАЗЫВАЕТ ФАЙЛ — пять утверждений, и ни одно не проверяется без базы.
 *
 *   Т1. Свободная запись живёт в обычной строке сметы: перечень подрядчика в 2000 символов с
 *       переводами строк доходит до базы и возвращается из неё ЗНАК В ЗНАК. Предел объявлен только
 *       в контрактах (колонка `service_request_items.name` — `text`), поэтому доказывать его надо
 *       сквозным путём «форма → сервер → база → карточка», а не проверкой схемы: схему проверяет
 *       `service-requests-contracts.test.ts`, а вот переводы строк, съеденные по дороге
 *       нормализацией или обрезанием, видны только здесь.
 *   Т4. Раскладка СОГЛАСОВАННОЙ ревизии переиздаёт документ: номер `+1`, подпись снята, итог
 *       пересчитан по строкам, предъявление поставлено заново. И одновременно — инвариант ADR 0133
 *       цел: содержимое согласованной ревизии под ПРЕЖНИМ номером не меняется ничем, включая
 *       обычную правку состава.
 *   Т5. Под висящим предъявлением раскладка отвечает 409 — тем же замком и тем же кодом, что и
 *       обычная правка: запер смету не тот, кто её раскладывает, а чужое действие.
 *   Т6/Т20. Дверь живёт ТОЛЬКО в «В работе»: закрытая заявка (Н4 — строки несут факт и гарантии),
 *       отложенная и «Новая» отвечают 422 со словом «статус».
 *   Т7. Дверь открывает ОДНО право — `serviceRequests.estimateRewrite`. Ни `serviceRequests.estimate`
 *       (сторона исполнителя-подрядчика), ни `serviceRequests.execute` (поимённый исполнитель) её
 *       не открывают: те двое пишут свой черновик, а здесь переиздаётся подписанное.
 *
 * ПОЧЕМУ БАЗА. Предмет — состояние ревизии в колонках заявки (`estimate_revision`,
 * `estimate_pending_revision`, `approved_estimate_revision`, `estimated_total_amount`) и порядок,
 * в котором его меняет транзакция ручки. Право `estimateRewrite` приезжает держателю МИГРАЦИЕЙ
 * 0298 через набор «Оргтехника: ведение» — на моках проверялся бы список из кода, а не то, что
 * миграция и правда положила право в набор и что барьер выдачи пропустил его роли.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`. Файл ведёт заявку по всему циклу и считает деньги
 * по строкам; в общей базе, где параллельно работают соседи, «итог пересчитан» и «строка вернулась
 * знак в знак» — утверждения о чужом мусоре не меньше, чем о своём. Механизм тот же, что у
 * `candidate-intake-flag.db.test.ts`: имя базы своё, заводится и сносится файлом.
 *
 * Запуск (из `apps/api`; базу тест заводит и сносит сам, из адреса берётся только кластер):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run test/service-estimate-breakdown.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_estimate_breakdown_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-breakdown-password-123';
const REQUESTS = '/api/v1/service-requests';

/** День закрытия работ — сегодня по Москве: от него сервер отсчитывает гарантии строк. */
const TODAY = moscowDateKeyOf(new Date());

/**
 * Заголовок входа. Псевдонимом, а не `interface`: заголовки `inject` — тип с индексной подписью, и
 * интерфейс без неё туда не присваивается.
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
  /** Администратор: заводит парк и назначает подрядчика. */
  admin: TestUser;
  /** Заказчик площадки: заводит заявки. */
  customer: TestUser;
  /**
   * «Ведение» модуля (набор `office_equipment_operator`) — ЕДИНСТВЕННЫЙ держатель
   * `serviceRequests.estimateRewrite` после миграции 0298. Он же согласует объём работ: обе работы
   * у набора по построению, и раскладка Т4 идёт ровно по подписанному им документу.
   */
  operator: TestUser;
  /**
   * Оператор подрядчика: пишет объём работ (`serviceRequests.estimate` даёт тип контрагента
   * `service`) и закрывает работы. Он же — отрицательный случай Т7.
   */
  service: TestUser;
  /**
   * Свой исполнитель с каталожным набором `office_equipment_executor`: у него
   * `serviceRequests.execute` и ни одной причины открывать дверь раскладки. Второй отрицательный
   * случай Т7 — и он важнее первого: `execute` стоит в дизъюнкции стража соседней ручки
   * (`PUT /:id/estimate`), и списанный оттуда страж пустил бы его сюда.
   */
  executor: TestUser;
  objectId: string;
  counterpartyId: string;
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
  // S3 здесь не участвует: акт подшивается уже загруженной строкой `files`.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  // Переиздание готовит письмо о предъявлении (Р2). Почта выключена: предмет файла — состояние
  // ревизии, а не почтовый контур, и включённая она сделала бы каждый случай ещё и тестом smtp.
  process.env.MAIL_ENABLED ??= 'false';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query('CREATE EXTENSION IF NOT EXISTS citext');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы по адресу (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
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
    remoteAddress: nextAddress(),
  };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return ctx.app.inject(options);
}

function messageOf(res: LightMyRequestResponse): string {
  try {
    return (res.json() as { message?: string }).message ?? '';
  } catch {
    return res.body;
  }
}

function fieldsOf(res: LightMyRequestResponse): Record<string, string> {
  try {
    return (res.json() as { fields?: Record<string, string> }).fields ?? {};
  } catch {
    return {};
  }
}

async function card(id: string, auth: Auth = ctx.admin.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

async function versionOf(id: string): Promise<number> {
  return (await card(id)).version;
}

/**
 * Десятизначный ИНН по девяти цифрам основы: контрольная сумма считается по весам приказа ФНС, и
 * портал проверяет её на каждом заведении контрагента.
 */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

let unitNo = 0;

/**
 * Своя единица под каждую заявку: по технике разрешена одна открытая заявка, и общая единица
 * заперла бы второй же случай файла.
 */
async function makeEquipment(): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: ctx.typeId,
    name: `RICOH MP C2011 ${RUN}`,
    inventoryNumber: `BRK-${RUN}-${unitNo}`,
    objectId: ctx.objectId,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

interface EstimateLine {
  kind: 'part' | 'service';
  name: string;
  quantity?: number;
  unitPrice: number;
  warrantyMonths?: number | null;
}

/**
 * СВОБОДНАЯ ЗАПИСЬ — обычная строка сметы (Р1): вид `service`, количество 1, цена — общая
 * стоимость заказа. Второй модели у неё нет вовсе, и режим ввода в базе не отмечается ничем: это и
 * есть предмет Т1.
 */
function freeLine(name: string, total: number): EstimateLine {
  return { kind: 'service', name, quantity: 1, unitPrice: total };
}

/** Заявка заказчика на свежей единице, назначенная подрядчику и взятая им в работу. */
async function requestInWork(description: string): Promise<string> {
  const created = await inject('POST', REQUESTS, ctx.customer.auth, {
    officeEquipmentId: await makeEquipment(),
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as { request: ServiceRequestDto }).request.id;

  const assigned = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.operator.auth, {
    userIds: [],
    serviceCounterpartyId: ctx.counterpartyId,
    version: await versionOf(id),
  });
  expect(assigned.statusCode, assigned.body).toBe(200);

  const started = await inject('PATCH', `${REQUESTS}/${id}/start`, ctx.service.auth, {
    version: await versionOf(id),
  });
  expect(started.statusCode, started.body).toBe(200);
  return id;
}

/** Состав объёма работ от лица подрядчика — то, что он и делает своей ручкой. */
async function putEstimate(id: string, items: EstimateLine[]): Promise<LightMyRequestResponse> {
  return inject('PUT', `${REQUESTS}/${id}/estimate`, ctx.service.auth, {
    items,
    version: await versionOf(id),
  });
}

/** Предъявление объёма работ подрядчиком. */
async function submitEstimate(id: string): Promise<void> {
  const res = await inject('PATCH', `${REQUESTS}/${id}/estimate/submit`, ctx.service.auth, {
    version: await versionOf(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Согласование объёма работ «Ведением» — тем же, чем оно ставит подпись в портале. */
async function approveEstimate(id: string): Promise<void> {
  const res = await inject('PATCH', `${REQUESTS}/${id}/estimate/approval`, ctx.operator.auth, {
    approved: true,
    version: await versionOf(id),
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Раскладка по графам: дверь волны. Ответ возвращается сырым — его и разбирают случаи. */
async function breakdown(
  id: string,
  items: EstimateLine[],
  auth: Auth = ctx.operator.auth,
  version?: number,
): Promise<LightMyRequestResponse> {
  return inject('PUT', `${REQUESTS}/${id}/estimate/breakdown`, auth, {
    items,
    version: version ?? (await versionOf(id)),
  });
}

/**
 * Загруженный файл строкой в `files`: настоящая загрузка идёт через presign в S3, которого в тесте
 * нет, а предмет проверки — состояние заявки, а не транспорт.
 */
async function uploadedFile(userId: string, filename: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`brk/${RUN}/${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            'pending', ${userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

/** Акт исполнителя: без закрывающего документа заявку подрядчика в «Решена» не пускают. */
async function attachAct(id: string): Promise<void> {
  const fileId = await uploadedFile(ctx.service.id, `akt-${randomUUID()}.pdf`);
  const res = await inject('POST', `${REQUESTS}/${id}/files`, ctx.service.auth, {
    fileIds: [fileId],
    kind: 'act',
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe.skipIf(!DB_URL)('раскладка объёма работ по графам (Р2)', () => {
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
    await migrate(OWN_DB!);

    prepareEnv(OWN_DB!);
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    // Учётки, контрагент, площадка — прямым SQL: форма учётки и справочник контрагентов предмет
    // своих тестов, здесь они декорации, без которых не собрать цикл заявки.
    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const email = `db-brk-${input.tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${input.tag}, ${passwordHash},
                ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const counterpartyRow = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-BRK ${RUN}`},
              ${innOf(`77${String(Date.now()).slice(-7)}`)})
      RETURNING id`);
    const counterpartyId = counterpartyRow.rows[0]!.id;

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`BRK-${RUN}`}, ${`Тестовая площадка BRK ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const admin2 = await makeUser({ tag: 'admin', role: 'admin' });
    const customer = await makeUser({ tag: 'cust', role: 'shtab' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const executor = await makeUser({ tag: 'exec', role: 'shtab' });
    const service = await makeUser({ tag: 'srv', role: 'operator', counterpartyId });

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectId}), (${operator.id}, ${objectId}),
             (${executor.id}, ${objectId})`);

    // «Ведение» — надстройкой через сервис, а не прямой вставкой: с шага 1a реформы (ADR 0106)
    // выдача пишет `user_role_addons` и `user_grants` одной транзакцией, и половина записи означала
    // бы права, которых сервер не увидит.
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], admin2.id);
    });

    // Набор исполнителя — КАТАЛОЖНЫЙ (миграция 0262), а не собранный тестом: Т7 утверждает про
    // право `serviceRequests.execute` в том виде, в каком оно приезжает держателю в проде.
    const executorGrant = await db.execute<{ id: string }>(
      sql`SELECT id FROM grants WHERE code = 'office_equipment_executor' AND deleted_at IS NULL`,
    );
    const executorGrantId = executorGrant.rows[0]?.id;
    if (!executorGrantId) throw new Error('в базе нет набора «office_equipment_executor»');
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
      VALUES (${executor.id}, ${executorGrantId}, ${admin2.id}, 'manual')`);

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    const app = await buildApp();
    await app.ready();

    const login = async (user: { id: string; email: string }): Promise<TestUser> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: nextAddress(),
        payload: { email: user.email, password: PASSWORD },
      });
      if (res.statusCode !== 200) throw new Error(`вход ${user.email}: ${res.body}`);
      const token = (res.json() as { accessToken: string }).accessToken;
      return { ...user, auth: { authorization: `Bearer ${token}` } };
    };

    ctx = {
      app,
      db,
      closeDb,
      admin: await login(admin2),
      customer: await login(customer),
      operator: await login(operator),
      service: await login(service),
      executor: await login(executor),
      objectId,
      counterpartyId,
      typeId,
    };
  }, 300_000);

  afterAll(async () => {
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

  // ── Т1. Свободная запись доходит до базы и возвращается знак в знак ──

  describe('Т1. свободный объём работ: 2000 символов с переводами строк', () => {
    /**
     * ПЕРЕЧЕНЬ ИЗ ПИСЬМА ПОДРЯДЧИКА — многострочный и длиннее прежнего предела наименования (255).
     * Собирается ровно в 2000 символов: предел объявлен в контрактах
     * (`itemNameSchema`), а колонка — `text`, и граница проверяется по верхней кромке, а не «где-то
     * около». Крайние символы не пробельные намеренно: схема тримит значение ПЕРЕД проверкой
     * длины, и строка, начинающаяся с пробела, доказывала бы 1999.
     */
    const longPerechen = ((): string => {
      const head = 'Ремонт МФУ (RICOH MP C 2011, G479МА30072 (№ 86228)) ЖК ПРИМАВЕРА штаб, 1 шт;';
      const line = 'Узел фотобарабана в сборе MP C2003SP D1882235/D1882264/D1882254, 2 шт;';
      const parts: string[] = [head];
      while (parts.join('\n').length + 1 + line.length <= 2000) parts.push(line);
      const text = parts.join('\n');
      // Добор до ровно 2000 — точками, а не пробелами (см. абзац про trim).
      return text + '.'.repeat(2000 - text.length);
    })();

    it('сохраняется целиком и читается из карточки знак в знак', async () => {
      expect(longPerechen).toHaveLength(2000);
      // Переводы строк — половина утверждения: перечень из письма читают глазами, и склеенный в
      // одну строку он теряет ровно то, ради чего свободный режим и заведён.
      expect(longPerechen.split('\n').length).toBeGreaterThan(5);

      const id = await requestInWork('Свободный объём работ письмом подрядчика');
      const put = await putEstimate(id, [freeLine(longPerechen, 70_455)]);
      expect(put.statusCode, put.body).toBe(200);

      const after = await card(id);
      expect(after.items).toHaveLength(1);
      const [item] = after.items;
      // Знак в знак: ни обрезания, ни нормализации переводов строк, ни схлопывания пробелов.
      expect(item!.name).toBe(longPerechen);
      expect(item!.name).toHaveLength(2000);
      expect(item!.kind).toBe('service');
      expect(Number(item!.quantity)).toBe(1);
      expect(Number(item!.unitPrice)).toBe(70_455);
    });

    it('2001 символ схема не пропускает — и это отказ до базы, а не обрезание', async () => {
      /*
       * ГРАНИЦА ПРОВЕРЯЕТСЯ С ОБЕИХ СТОРОН. Колонка `text` приняла бы и мегабайт: предел живёт
       * только в контрактах, и без этого случая «2000» означало бы лишь «мы столько отправили»,
       * а не «столько разрешено». Отказ обязан быть отказом — молча обрезанное наименование
       * подрядчик увидел бы в акте.
       */
      const id = await requestInWork('Перечень длиннее предела');
      const put = await putEstimate(id, [freeLine('А'.repeat(2001), 1000)]);
      expect(put.statusCode, put.body).toBe(400);
      expect((await card(id)).items).toHaveLength(0);
    });
  });

  // ── Т7. Кто открывает дверь ──

  describe('Т7. дверь раскладки открывает одно право', () => {
    let ready: string;

    beforeAll(async () => {
      ready = await requestInWork('Кому открыта дверь раскладки');
      const put = await putEstimate(ready, [freeLine('Перечень одной строкой', 70_455)]);
      expect(put.statusCode, put.body).toBe(200);
    });

    it('«Ведение» раскладывает ЧЕРНОВИК: состав меняется, номера и подписи — нет', async () => {
      /*
       * ПЕРВАЯ ИЗ ТРЁХ ВЕТОК Р2, и она же — проверка самой двери. Черновик (не предъявлен, не
       * согласован) раскладка меняет ровно так же, как его меняет исполнитель обычной ручкой:
       * ревизия остаётся прежней, предъявления не возникает, итог не проставляется — его и по
       * сегодняшнему правилу ставит только предъявление (Н5). Не проверь мы это, ветка переиздания
       * могла бы срабатывать на всём подряд, а «поднимает номер» читалось бы как «поднимает
       * всегда».
       */
      const before = await card(ready);
      expect(before.estimateRevision).toBe(0);

      const res = await breakdown(ready, [
        { kind: 'service', name: 'Ремонт МФУ', quantity: 1, unitPrice: 40_000 },
        { kind: 'part', name: 'Узел фотобарабана в сборе', quantity: 2, unitPrice: 15_227.5 },
      ]);
      expect(res.statusCode, res.body).toBe(200);
      const after = res.json() as ServiceRequestDto;
      expect(after.items.map((i) => i.name)).toEqual(['Ремонт МФУ', 'Узел фотобарабана в сборе']);
      expect(after.estimateRevision).toBe(before.estimateRevision);
      expect(after.estimatePendingRevision).toBeNull();
      expect(after.approval).toBeNull();
      expect(after.estimatedTotalAmount).toBeNull();

      // Журнал отличает раскладку черновика от переиздания: по составу этого не восстановить, а
      // разбор спора начинается именно с вопроса «под чем стояла подпись».
      const audit = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
        SELECT metadata FROM audit_log
         WHERE entity_id = ${ready} AND action = 'serviceRequest.estimate_breakdown'`);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.metadata).toMatchObject({ revision: 0, reissued: false });
      // Итога у черновика в журнале нет вовсе: записанный нулём, он читался бы как «работы
      // бесплатны».
      expect(audit.rows[0]!.metadata).not.toHaveProperty('total');
    });

    it('держатель serviceRequests.estimate (подрядчик) — 403', async () => {
      /*
       * ПОДРЯДЧИК — АВТОР ОБЪЁМА РАБОТ, и его дверь соседняя (`PUT /:id/estimate`). Списанный
       * оттуда страж («одно из двух прав стороны исполнителя») пустил бы его и сюда — то есть
       * отдал бы автору сметы право переиздавать подписанное собственным же телом запроса.
       */
      const res = await breakdown(
        ready,
        [{ kind: 'service', name: 'Своя раскладка', quantity: 1, unitPrice: 1 }],
        ctx.service.auth,
      );
      expect(res.statusCode, res.body).toBe(403);
      expect(messageOf(res)).toContain('Объём работ раскладывает по графам');
    });

    it('держатель serviceRequests.execute (свой исполнитель) — 403', async () => {
      const res = await breakdown(
        ready,
        [{ kind: 'service', name: 'Своя раскладка', quantity: 1, unitPrice: 1 }],
        ctx.executor.auth,
      );
      expect(res.statusCode, res.body).toBe(403);
    });

    it('заказчик заявки — 403', async () => {
      const res = await breakdown(
        ready,
        [{ kind: 'service', name: 'Своя раскладка', quantity: 1, unitPrice: 1 }],
        ctx.customer.auth,
      );
      expect(res.statusCode, res.body).toBe(403);
    });
  });

  // ── Т4. Переиздание согласованной ревизии ──

  describe('Т4. раскладка согласованной ревизии переиздаёт документ', () => {
    it('номер +1, подпись снята, итог пересчитан, предъявление поставлено заново', async () => {
      const id = await requestInWork('Согласованный объём работ раскладывают по графам');
      const put = await putEstimate(id, [freeLine('Перечень из письма подрядчика', 70_455)]);
      expect(put.statusCode, put.body).toBe(200);
      await submitEstimate(id);
      await approveEstimate(id);

      const signed = await card(id);
      expect(signed.estimateRevision).toBe(1);
      // Снимок согласования указывает на ТЕКУЩУЮ ревизию — именно это равенство и означает
      // «подписано»: колонка `approved_estimate_revision` хранит номер, а не флаг.
      expect(signed.approval?.revision).toBe(1);
      expect(signed.approval?.by).toBe(ctx.operator.id);
      expect(signed.estimatePendingRevision).toBeNull();
      // Итог проставляет предъявление (Н5) — с него и начинается вопрос «пересчитает ли раскладка».
      expect(signed.estimatedTotalAmount).toBe(70_455);

      /*
       * СУММА НАРОЧНО ДРУГАЯ. Раскладка по смыслу сохраняет итог, но равные числа сделали бы
       * утверждение «итог пересчитан по строкам» неотличимым от «прежний итог остался на месте» —
       * а разница между ними и есть находка Н5, ради которой ветка переиздания считает сумму сама.
       */
      const res = await breakdown(id, [
        { kind: 'service', name: 'Ремонт МФУ', quantity: 1, unitPrice: 30_000 },
        { kind: 'part', name: 'Блок проявки в сборе чёрный', quantity: 1, unitPrice: 25_000 },
        { kind: 'part', name: 'Крышка роликов подачи ARDF', quantity: 2, unitPrice: 8_000 },
      ]);
      expect(res.statusCode, res.body).toBe(200);

      const after = await card(id);
      // Номер поднят: подписанное содержимое осталось за прежним номером, а новое едет за новым.
      expect(after.estimateRevision).toBe(2);
      // Подпись снята целиком, всеми тремя полями разом: оставленный «кто подписал» без ревизии
      // читался бы как «кто-то это подписал».
      expect(after.approval).toBeNull();
      // Заявка ждёт новой подписи: предъявление ставит сама ручка — у «Ведения» нет ни `reopen`,
      // ни `submit`, и без этого заявка повисла бы без очереди.
      expect(after.estimatePendingRevision).toBe(2);
      expect(after.estimateSubmittedAt).not.toBeNull();
      // Итог пересчитан по строкам: 30 000 + 25 000 + 2 × 8 000.
      expect(after.estimatedTotalAmount).toBe(71_000);
      expect(after.items.map((i) => i.name)).toEqual([
        'Ремонт МФУ',
        'Блок проявки в сборе чёрный',
        'Крышка роликов подачи ARDF',
      ]);
      // Статус не менялся: раскладка — не переход (`applyTransition` зовут ради истории и версии).
      expect(after.status).toBe('in_work');

      // След в журнале: разбор спора начинается с вопроса «под чем стояла подпись», и по составу
      // «до → после» этого не восстановить.
      const audit = await ctx.db.execute<{ action: string; metadata: Record<string, unknown> }>(sql`
        SELECT action, metadata FROM audit_log
         WHERE entity_id = ${id} AND action = 'serviceRequest.estimate_breakdown'`);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.metadata).toMatchObject({ revision: 2, reissued: true, total: 71_000 });
    });

    it('содержимое согласованной ревизии не меняется обычной правкой — 409', async () => {
      /*
       * ВТОРАЯ ПОЛОВИНА Т4 И ИНВАРИАНТ ADR 0133. Раскладка потому и поднимает номер, что менять
       * подписанное под прежним номером не вправе НИКТО: ни она сама, ни автор объёма работ. Без
       * этого случая первый доказывал бы лишь «ручка делает так», а не «другого пути нет».
       */
      const id = await requestInWork('Согласованное не правится под прежним номером');
      const put = await putEstimate(id, [freeLine('Перечень из письма', 12_000)]);
      expect(put.statusCode, put.body).toBe(200);
      await submitEstimate(id);
      await approveEstimate(id);

      const rewrite = await putEstimate(id, [freeLine('Другой перечень за те же деньги', 12_000)]);
      expect(rewrite.statusCode, rewrite.body).toBe(409);
      expect(messageOf(rewrite)).toContain('согласована');

      const after = await card(id);
      expect(after.estimateRevision).toBe(1);
      expect(after.items).toHaveLength(1);
      expect(after.items[0]!.name).toBe('Перечень из письма');
    });
  });

  // ── Т5. Висящее предъявление ──

  describe('Т5. под висящим предъявлением — 409', () => {
    it('раскладка ждёт ответа согласующего, как и обычная правка', async () => {
      const id = await requestInWork('Предъявленный объём работ раскладывать нельзя');
      const put = await putEstimate(id, [freeLine('Перечень из письма', 5_000)]);
      expect(put.statusCode, put.body).toBe(200);
      await submitEstimate(id);

      const res = await breakdown(id, [
        { kind: 'service', name: 'Ремонт', quantity: 1, unitPrice: 5_000 },
      ]);
      // 409, а не 422: смету запер не тот, кто её раскладывает, а чужое действие — и человеку надо
      // обновить окно, а не исправить данные.
      expect(res.statusCode, res.body).toBe(409);
      expect(messageOf(res)).toContain('предъявлен и ждёт ответа');

      const after = await card(id);
      expect(after.estimateRevision).toBe(1);
      expect(after.estimatePendingRevision).toBe(1);
      expect(after.items[0]!.name).toBe('Перечень из письма');
    });
  });

  // ── Т6 и Т20. Статус заявки ──

  describe('Т6/Т20. дверь живёт только в «В работе»', () => {
    it('«Новая»: объёма работ ещё нет — 422', async () => {
      /*
       * СТАТУС СПРАШИВАЕТСЯ ДО СОСТОЯНИЯ РЕВИЗИИ (находка второго ревью плана), и «Новая» — самый
       * дешёвый способ это показать: ревизии у неё нет вовсе, и ветка по состоянию сметы ответить
       * тут не может ничего.
       */
      const created = await inject('POST', REQUESTS, ctx.customer.auth, {
        officeEquipmentId: await makeEquipment(),
        description: 'Раскладка из «Новой»',
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = (created.json() as { request: ServiceRequestDto }).request.id;
      const assigned = await inject('PUT', `${REQUESTS}/${id}/executors`, ctx.operator.auth, {
        userIds: [],
        serviceCounterpartyId: ctx.counterpartyId,
        version: await versionOf(id),
      });
      expect(assigned.statusCode, assigned.body).toBe(200);

      const res = await breakdown(id, [
        { kind: 'service', name: 'Ремонт', quantity: 1, unitPrice: 1_000 },
      ]);
      expect(res.statusCode, res.body).toBe(422);
      expect(fieldsOf(res)).toHaveProperty('status');
      expect(messageOf(res)).toContain('Новая');
    });

    it('«Отложена»: сперва возобновляют — 422', async () => {
      const id = await requestInWork('Раскладка отложенной заявки');
      const put = await putEstimate(id, [freeLine('Перечень из письма', 3_000)]);
      expect(put.statusCode, put.body).toBe(200);
      const held = await inject('PATCH', `${REQUESTS}/${id}/hold`, ctx.operator.auth, {
        reason: 'ждём запчасть',
        version: await versionOf(id),
      });
      expect(held.statusCode, held.body).toBe(200);
      expect((await card(id)).status).toBe('on_hold');

      const res = await breakdown(id, [
        { kind: 'service', name: 'Ремонт', quantity: 1, unitPrice: 3_000 },
      ]);
      /*
       * ОТДЕЛЬНЫЙ СЛУЧАЙ, А НЕ «ЕЩЁ ОДИН СТАТУС», и вот почему: у отложенной заявки объём работ
       * есть и в состоянии «черновик» — то есть ветка по состоянию ревизии пропустила бы её. Отказ
       * даёт именно status-gate, и без «Отложена» его можно было бы снять, не уронив остальные
       * случаи файла: раскладка поставила бы предъявление, которое НЕКОМУ подписать — кнопки
       * согласования у отложенной заявки нет вовсе.
       */
      expect(res.statusCode, res.body).toBe(422);
      expect(fieldsOf(res)).toHaveProperty('status');
      expect(messageOf(res)).toContain('Отложена');

      const after = await card(id);
      expect(after.items[0]!.name).toBe('Перечень из письма');
      expect(after.estimatePendingRevision).toBeNull();
    });

    it('после закрытия работ — 422 (Н4: строки несут факт и гарантии)', async () => {
      const id = await requestInWork('Раскладка закрытой заявки');
      const put = await putEstimate(id, [
        { kind: 'service', name: 'Чистка узла подачи', quantity: 1, unitPrice: 4_000 },
      ]);
      expect(put.statusCode, put.body).toBe(200);
      await submitEstimate(id);
      await approveEstimate(id);
      await attachAct(id);

      const before = await card(id);
      const completed = await inject('PATCH', `${REQUESTS}/${id}/complete`, ctx.service.auth, {
        completedOn: TODAY,
        items: before.items.map((item) => ({ id: item.id, performed: true })),
        version: before.version,
      });
      expect(completed.statusCode, completed.body).toBe(200);
      expect((await card(id)).status).toBe('done');

      const res = await breakdown(id, [
        { kind: 'service', name: 'Ремонт', quantity: 1, unitPrice: 4_000 },
      ]);
      expect(res.statusCode, res.body).toBe(422);
      expect(fieldsOf(res)).toHaveProperty('status');

      // Факт закрытия цел: именно на него ссылаются гарантийные обращения, и «дверь закрыта» без
      // этой строки означало бы лишь «ответила 422», а не «ничего не тронула».
      const after = await card(id);
      expect(after.items).toHaveLength(1);
      expect(after.items[0]!.name).toBe('Чистка узла подачи');
      expect(after.items[0]!.performed).toBe(true);
    });
  });
});
