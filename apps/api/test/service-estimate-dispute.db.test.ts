import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceRequestBulkResultDto, ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` уже после того, как выставлено окружение, —
// конфиг проверяет его при импорте и без него падает.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * **СПОР ОБ ОСВОБОЖДЕНИИ ОТ ПОДПИСИ** — серверная половина этапа Э5 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md` (решение Р9; находки Н7, Н9, Н11,
 * Н12, Н14; миграции 0306 и 0307).
 *
 * ЧТО ДОКАЗЫВАЕТ ФАЙЛ.
 *
 *   Д1. МАТРИЦА «СТАТУС × ИСХОД» целиком — шесть сочетаний. Заявка возвращается туда, откуда её
 *       остановили: спор из «Решена» с исходом «оставить» уходит в «Решена», а НЕ в «В работе» —
 *       иначе матрица сбросов стёрла бы факт закрытия, суммы и гарантии (Н12), то есть отменила бы
 *       выполнение, которого никто не отменял. У каждого исхода спор получает исход, автора и время.
 *   Д2. ОКНО ПРИЁМКИ (Н9): «оставить освобождение» ставит порог `auto_close_not_before` моментом
 *       разрешения, «нужна подпись» — НЕ ставит его вовсе, и порог появляется только в момент
 *       подписи. Иначе подпись, поставленная через два дня, закрыла бы заявку в ту же минуту.
 *   Д3. ГАШЕНИЕ ВИДА ЗАМОРОЗКИ на каждом выходе из «Отложена»: `hold_kind` уходит в `NULL` вместе с
 *       `held_from_status` и причиной — у заявки не остаётся следа спора, которого больше нет.
 *   Д4. ВТОРОГО ОТКРЫТОГО СПОРА НЕ БЫВАЕТ: внятный 409, а не `23505` из частичного индекса, и отказ
 *       называет спор, а не статус «Отложена», который заявка приняла из-за этого же спора.
 *   Д5. ПРИ ОТКРЫТОМ СПОРЕ ЗАПЕРТЫ обычный возврат из заморозки (он же массовый, Н11) и приёмка
 *       (Н14): спор закрывают исходом, а не обходят возвратом или приёмкой.
 *   Д6. ПО ПОДПИСАННОМУ ЧЕЛОВЕКОМ ОБЪЁМУ РАБОТ СПОРА НЕТ: такую заявку возвращают в правку, и ручка
 *       отвечает 422 — освобождения по действующей ревизии нет.
 *   Д7. ПОДПИСЬ В «Решена» открыта ТОЛЬКО постспорному ожиданию: до разрешения спора (заявка в
 *       «Отложена») согласование отбивается, после исхода «нужна подпись» — проходит и ставит порог.
 *   Д8. СПОР ВИДЕН В КАРТОЧКЕ полем `dispute` — и открытый, и разрешённый (второй объясняет второе
 *       окно приёмки и подпись в «Решена»). Заявителю он вычитается вместе с остальными деньгами.
 *   Д9. ОБЫЧНАЯ ОТМЕНА ЗАКРЫВАЕТ ОТКРЫТЫЙ СПОР исходом `cancel` — той же транзакцией, и в одиночной
 *       ручке, и в пачке: иначе спор остаётся открытым навсегда и неразрешимым (обе двери к нему
 *       после отмены заперты), а матрица обещает исход КАЖДОМУ спору.
 *  Д10. ТРЕБОВАНИЕ СПОРА ПЕРЕЖИВАЕТ ВОЗВРАТ В ПРАВКУ: после исхода «нужна подпись» повторное
 *       заявление об освобождении отвечает `observed`, автоподписи больше не бывает — иначе исход
 *       спора снимал бы сам подрядчик возвратом и повторным предъявлением.
 *
 * ПОЧЕМУ БАЗА. Предмет — состояния, которых на моках не бывает: частичный уникальный индекс
 * «один открытый спор на заявку», `CHECK` пары «исход ⇔ время разрешения», связка «ожидание равно
 * действующей ревизии», матрица сбросов на настоящих дугах статусов и рубильник освобождения строкой
 * `feature_flags`, которую ручка читает без кэша.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: файл переключает ГЛОБАЛЬНЫЙ рубильник освобождения, и
 * в общей базе он менял бы поведение ручек соседних прогонов посреди их работы (механизм тот же, что
 * у `service-estimate-document-submit`).
 *
 * Запуск (из `apps/api`; базу тест заводит и сносит сам, из адреса берётся только кластер):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5471/postgres \
 *     npx vitest run test/service-estimate-dispute.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_estimate_dispute_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-dispute-password-123';
const REQUESTS = '/api/v1/service-requests';
const BULK = `${REQUESTS}/bulk`;
/** Ящик канала «Ремонт»: он и отправитель писем модуля, и адресат стороны «офис». */
const OFFICE_MAILBOX = `repair-${RUN}@example.invalid`;
/** Дата закрытия работ: московские календарные сутки считает сервер, в будущее ему нельзя. */
const TODAY = new Date().toISOString().slice(0, 10);

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
  admin: TestUser;
  customer: TestUser;
  /** «Ведение» модуля: назначает подрядчика, оспаривает освобождение и разрешает спор. */
  operator: TestUser;
  /** Оператор назначенного контрагента-сервиса: предъявляет объём работ и заявляет освобождение. */
  service: TestUser;
  objectId: string;
  counterpartyId: string;
  typeId: string;
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
  // S3 здесь не участвует: акт подшивается уже загруженной строкой `files`.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  /*
   * ПОЧТА ВКЛЮЧЕНА ЖУРНАЛЬНЫМ ТРАНСПОРТОМ. Предмет файла — не письма, но переходы спора их ставят
   * (вход в «Отложена», возврат, отмена), и выключенный контур прятал бы сбой постановки письма:
   * `applyTransition` требует подготовку письма у КАЖДОЙ дуги, и новая дуга, забывшая про неё, упала
   * бы именно здесь.
   */
  process.env.MAIL_ENABLED = 'true';
  process.env.MAIL_TRANSPORT = 'log';
  process.env.MAIL_ACCOUNT_REPAIR_HOST = 'm.example.invalid';
  process.env.MAIL_ACCOUNT_REPAIR_FROM = `Ремонт <${OFFICE_MAILBOX}>`;
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const ext of ['pgcrypto', 'citext', 'pg_trgm']) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
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
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { ...auth, ...headers },
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

async function card(id: string, auth: Auth = ctx.admin.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

async function versionOf(id: string): Promise<number> {
  return (await card(id)).version;
}

/** Рубильник волны: значение читается ручкой без кэша, поэтому `UPDATE` действует сразу. */
async function setFlag(key: string, enabled: boolean): Promise<void> {
  const res = await ctx.db.execute(
    sql`UPDATE feature_flags SET is_enabled = ${enabled} WHERE key = ${key}`,
  );
  // Ноль обновлённых строк означал бы, что миграция 0307 не накачена, — и весь файл проверял бы
  // тогда выключенное состояние, считая его включённым.
  expect(res.rowCount, `рубильник ${key} не найден`).toBe(1);
}

function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

let unitNo = 0;

/** Своя единица под каждую заявку: по технике разрешена одна открытая заявка. */
async function makeEquipment(): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: ctx.typeId,
    name: `RICOH MP C2011 ${RUN}`,
    inventoryNumber: `DSP-${RUN}-${unitNo}`,
    objectId: ctx.objectId,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Загруженный файл строкой в `files`: предмет проверки — состояние заявки, а не транспорт. */
async function uploadedFile(userId: string, filename: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`dsp/${RUN}/${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            'active', ${userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

/** Акт от подрядчика: без закрывающей бумаги заявка в «Решена» не уходит вовсе. */
async function attachAct(id: string): Promise<string> {
  const fileId = await uploadedFile(ctx.service.id, `akt-${randomUUID()}.pdf`);
  const res = await inject('POST', `${REQUESTS}/${id}/files`, ctx.service.auth, {
    fileIds: [fileId],
    kind: 'act',
  });
  expect(res.statusCode, res.body).toBe(200);
  return fileId;
}

interface Fixture {
  id: string;
  itemId: string;
}

/**
 * ЗАЯВКА С ПРИМЕНЁННЫМ ОСВОБОЖДЕНИЕМ — общая завязка всех случаев: подрядчик предъявил объём работ
 * строками и сразу пометил «согласование не требуется» (законное сочетание `items` + освобождение,
 * главный сценарий мелкого ремонта на месте). Подпись при этом стоит БЕЗ АВТОРА и с источником
 * `auto` — именно её и оспаривают.
 *
 * `status: 'done'` доводит заявку до «Решена»: акт подшивается подрядчиком, работы закрываются
 * построчным фактом. Это вторая половина матрицы Д1 — и ровно та, где возврат в «В работе» стёр бы
 * факт закрытия.
 */
async function exemptRequest(
  description: string,
  status: 'in_work' | 'done' = 'in_work',
): Promise<Fixture> {
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

  const draft = await inject('PUT', `${REQUESTS}/${id}/estimate`, ctx.service.auth, {
    items: [{ kind: 'service', name: 'Замена ролика захвата', quantity: 1, unitPrice: 2400 }],
    version: await versionOf(id),
  });
  expect(draft.statusCode, draft.body).toBe(200);
  const itemId = (draft.json() as ServiceRequestDto).items[0]!.id;

  const submitted = await inject('PATCH', `${REQUESTS}/${id}/estimate/submit`, ctx.service.auth, {
    mode: 'items',
    exemption: { note: 'Мелкий ремонт на месте, согласование не требуется' },
    version: await versionOf(id),
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  // Завязка обязана быть именно автоподписью: спорят о ней, и подпись человека проверяется Д6.
  expect(await stateOf(id)).toMatchObject({
    approved_estimate_revision: 1,
    estimate_approval_source: 'auto',
    estimate_approved_by: null,
    estimate_pending_revision: null,
  });

  if (status === 'done') {
    await attachAct(id);
    const completed = await inject('PATCH', `${REQUESTS}/${id}/complete`, ctx.service.auth, {
      completedOn: TODAY,
      items: [{ id: itemId, performed: true }],
      version: await versionOf(id),
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect((await card(id)).status).toBe('done');
  }
  return { id, itemId };
}

/** Открыть спор от лица «Ведения». Ответ сырой: отказы разбирают случаи Д4 и Д6. */
async function openDispute(
  id: string,
  options: { auth?: Auth; reason?: string } = {},
): Promise<LightMyRequestResponse> {
  return inject('PATCH', `${REQUESTS}/${id}/estimate/dispute`, options.auth ?? ctx.operator.auth, {
    reason: options.reason ?? 'Счёт вдвое выше прайса, подпись под такой суммой обязательна',
    version: await versionOf(id),
  });
}

/** Разрешить спор исходом. Причина обязательна ровно у отмены — её требует схема союза. */
async function resolveDispute(
  id: string,
  outcome: 'keep' | 'require_signature' | 'cancel',
  options: { auth?: Auth } = {},
): Promise<LightMyRequestResponse> {
  return inject(
    'PATCH',
    `${REQUESTS}/${id}/estimate/dispute/resolution`,
    options.auth ?? ctx.operator.auth,
    {
      outcome,
      ...(outcome === 'cancel'
        ? { reason: 'Ремонт не нужен, аппарат выводится из эксплуатации' }
        : {}),
      comment: 'Разобрали со службой',
      version: await versionOf(id),
    },
  );
}

async function disputeOk(
  id: string,
  outcome: 'keep' | 'require_signature' | 'cancel',
): Promise<void> {
  const opened = await openDispute(id);
  expect(opened.statusCode, opened.body).toBe(200);
  const resolved = await resolveDispute(id, outcome);
  expect(resolved.statusCode, resolved.body).toBe(200);
}

interface RequestState {
  status: string;
  held_from_status: string | null;
  hold_reason: string;
  hold_kind: string | null;
  estimate_revision: number;
  estimate_pending_revision: number | null;
  estimate_pending_source: string | null;
  approved_estimate_revision: number | null;
  estimate_approved_by: string | null;
  estimate_approval_source: string | null;
  /*
   * ВРЕМЕНА — СТРОКАМИ, и это свойство сырого `db.execute`: разборщик типов drizzle работает на
   * построителе запросов, а не на произвольном SQL, и `timestamptz` приезжает сюда текстом. Обёрнутый
   * в `new Date(...)` он сравнивается как обычно; объявленный `Date` — молча падал бы на `getTime`.
   */
  completed_at: string | null;
  final_total_amount: string | null;
  auto_close_not_before: string | null;
  service_counterparty_id: string | null;
}

/** Сырые колонки заявки: вид заморозки и порог окна приёмки в карточку не выходят. */
async function stateOf(id: string): Promise<RequestState> {
  const res = await ctx.db.execute<RequestState>(sql`
    SELECT status::text AS status, held_from_status::text AS held_from_status, hold_reason,
           hold_kind, estimate_revision, estimate_pending_revision, estimate_pending_source,
           approved_estimate_revision, estimate_approved_by, estimate_approval_source,
           completed_at, final_total_amount, auto_close_not_before, service_counterparty_id
      FROM service_requests WHERE id = ${id}`);
  return res.rows[0]!;
}

interface DisputeRow {
  revision: number;
  state: string;
  reason: string;
  opened_by: string | null;
  outcome: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}

async function disputesOf(id: string): Promise<DisputeRow[]> {
  const res = await ctx.db.execute<DisputeRow>(sql`
    SELECT revision, state, reason, opened_by, outcome, resolved_by, resolved_at
      FROM service_request_estimate_disputes
     WHERE request_id = ${id}
     ORDER BY opened_at`);
  return res.rows;
}

/** Заморозка погашена целиком: три поля, а не одно (Д3). */
function expectHoldCleared(state: RequestState): void {
  expect({
    held_from_status: state.held_from_status,
    hold_reason: state.hold_reason,
    hold_kind: state.hold_kind,
  }).toEqual({ held_from_status: null, hold_reason: '', hold_kind: null });
}

describe.skipIf(!DB_URL)('спор об освобождении от подписи (Э5)', () => {
  beforeAll(async () => {
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

    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const email = `db-dsp-${input.tag}-${RUN}@example.invalid`;
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
      VALUES ('service'::counterparty_type, ${`Сервис-DSP ${RUN}`},
              ${innOf(`77${String(Date.now()).slice(-7)}`)})
      RETURNING id`);
    const counterpartyId = counterpartyRow.rows[0]!.id;

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`DSP-${RUN}`}, ${`Тестовая площадка DSP ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const adminUser = await makeUser({ tag: 'admin', role: 'admin' });
    const customer = await makeUser({ tag: 'cust', role: 'shtab' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const service = await makeUser({ tag: 'srv', role: 'operator', counterpartyId });

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectId}), (${operator.id}, ${objectId})`);

    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      // «Ведение» — надстройкой, как оно приезжает держателю в проде: в ней и `assign` (право спора),
      // и `hold` (возврат из заморозки), и `status` (приёмка), и `approveEstimate` (подпись).
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], adminUser.id);
    });

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
      admin: await login(adminUser),
      customer: await login(customer),
      operator: await login(operator),
      service: await login(service),
      objectId,
      counterpartyId,
      typeId,
    };
    // Освобождение применяется только при включённом рубильнике: с выключенным исход заявления —
    // `observed`, автоподписи нет, и оспаривать было бы нечего ни в одном случае файла.
    await setFlag('service_estimate_exemption', true);
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

  // ── Д1, Д2, Д3. Матрица «статус × исход» ──

  describe('Д1. спор из «В работе»', () => {
    it('исход «оставить освобождение» возвращает в «В работе» и открывает окно приёмки заново', async () => {
      const { id } = await exemptRequest('Спор из работы, освобождение остаётся');
      const opened = await openDispute(id);
      expect(opened.statusCode, opened.body).toBe(200);

      // Остановка — обычная заморозка, но со своим видом: по нему заперты возврат и приёмка (Д5).
      expect(await stateOf(id)).toMatchObject({
        status: 'on_hold',
        held_from_status: 'in_work',
        hold_kind: 'estimate_exemption_dispute',
      });
      expect(await disputesOf(id)).toMatchObject([
        {
          revision: 1,
          state: 'open',
          opened_by: ctx.operator.id,
          outcome: null,
          resolved_at: null,
        },
      ]);

      const before = new Date();
      const resolved = await resolveDispute(id, 'keep');
      expect(resolved.statusCode, resolved.body).toBe(200);

      const state = await stateOf(id);
      expect(state.status).toBe('in_work');
      expectHoldCleared(state);
      // Освобождение осталось: автоподпись на месте, ожидания подписи нет.
      expect(state).toMatchObject({
        approved_estimate_revision: 1,
        estimate_approval_source: 'auto',
        estimate_pending_revision: null,
        estimate_pending_source: null,
      });
      /*
       * ПОРОГ ОКНА ПРИЁМКИ — МОМЕНТ РАЗРЕШЕНИЯ (Д2). У спора из «В работе» он ни на что не влияет
       * (закрытие работ будет позже, а отбор берёт позднейшее из двух), но ставится тем же правилом:
       * ветка на статус завела бы второе правило там, где общее верно в обоих случаях.
       */
      expect(new Date(state.auto_close_not_before!).getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000,
      );
      expect(await disputesOf(id)).toMatchObject([
        { state: 'resolved', outcome: 'keep', resolved_by: ctx.operator.id },
      ]);
      expect((await disputesOf(id))[0]!.resolved_at).not.toBeNull();
    });

    it('исход «нужна подпись» снимает автоподпись и открывает ожидание с происхождением спора', async () => {
      const { id } = await exemptRequest('Спор из работы, нужна подпись');
      await disputeOk(id, 'require_signature');

      const state = await stateOf(id);
      expect(state.status).toBe('in_work');
      expectHoldCleared(state);
      expect(state).toMatchObject({
        // Снимок подписи снят целиком: иначе «принято без согласования» осталось бы висеть на
        // заявке, подпись под которой как раз и собирают.
        approved_estimate_revision: null,
        estimate_approved_by: null,
        estimate_approval_source: null,
        // Ожидание — по ДЕЙСТВУЮЩЕЙ ревизии и с происхождением `dispute`: только его пускает к
        // подписи в «Решена» `allowsEstimateApprovalInStatus`.
        estimate_pending_revision: 1,
        estimate_pending_source: 'dispute',
      });
      // Порог приёмки при этом исходе НЕ ставится (Д2): его поставит сама подпись.
      expect(state.auto_close_not_before).toBeNull();
      expect(await disputesOf(id)).toMatchObject([
        { state: 'resolved', outcome: 'require_signature' },
      ]);
    });

    it('исход «отменить заявку» уводит в «Отменена», и причина обязательна', async () => {
      const { id } = await exemptRequest('Спор из работы, отмена');
      const opened = await openDispute(id);
      expect(opened.statusCode, opened.body).toBe(200);

      // Причину отмены требует сам союз схемы: «отменить без причины» не должно собираться.
      const blind = await inject(
        'PATCH',
        `${REQUESTS}/${id}/estimate/dispute/resolution`,
        ctx.operator.auth,
        { outcome: 'cancel', version: await versionOf(id) },
      );
      expect(blind.statusCode, blind.body).toBe(400);
      expect(await stateOf(id)).toMatchObject({ status: 'on_hold' });

      const resolved = await resolveDispute(id, 'cancel');
      expect(resolved.statusCode, resolved.body).toBe(200);
      const state = await stateOf(id);
      expect(state.status).toBe('cancelled');
      expectHoldCleared(state);
      // Порог окна приёмки отменённой не нужен: отбор автозакрытия берёт только «Решена».
      expect(state.auto_close_not_before).toBeNull();
      expect(await disputesOf(id)).toMatchObject([{ state: 'resolved', outcome: 'cancel' }]);
    });
  });

  describe('Д1. спор из «Решена»', () => {
    it('исход «оставить освобождение» возвращает в «Решена», не тронув факт закрытия (Н12)', async () => {
      const { id } = await exemptRequest('Спор из решённой, освобождение остаётся', 'done');
      const closed = await stateOf(id);
      const opened = await openDispute(id);
      expect(opened.statusCode, opened.body).toBe(200);
      expect(await stateOf(id)).toMatchObject({
        status: 'on_hold',
        held_from_status: 'done',
        hold_kind: 'estimate_exemption_dispute',
      });

      const before = new Date();
      const resolved = await resolveDispute(id, 'keep');
      expect(resolved.statusCode, resolved.body).toBe(200);

      const state = await stateOf(id);
      /*
       * «Решена», А НЕ «В работе», И ЭТО ГЛАВНОЕ УТВЕРЖДЕНИЕ ФАЙЛА: дуга `done → in_work` стирает
       * факт закрытия, суммы по акту и даты гарантий (матрица сбросов, Н12), то есть отменила бы
       * выполнение, которого никто не отменял. Поэтому рядом со статусом проверяются и сами суммы.
       */
      expect(state.status).toBe('done');
      expect(state.completed_at).not.toBeNull();
      expect(state.final_total_amount).toBe(closed.final_total_amount);
      expectHoldCleared(state);
      expect(state).toMatchObject({
        approved_estimate_revision: 1,
        estimate_approval_source: 'auto',
        estimate_pending_revision: null,
      });
      // Окно приёмки начинается заново — иначе заявка, простоявшая в споре неделю, закрылась бы
      // автоматически на первом же прогоне после возврата (Н9).
      expect(new Date(state.auto_close_not_before!).getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000,
      );
    });

    it('исход «нужна подпись» оставляет заявку в «Решена» с открытым ожиданием', async () => {
      const { id } = await exemptRequest('Спор из решённой, нужна подпись', 'done');
      await disputeOk(id, 'require_signature');

      const state = await stateOf(id);
      expect(state.status).toBe('done');
      expect(state.completed_at).not.toBeNull();
      expectHoldCleared(state);
      expect(state).toMatchObject({
        approved_estimate_revision: null,
        estimate_approval_source: null,
        estimate_pending_revision: 1,
        estimate_pending_source: 'dispute',
      });
      expect(state.auto_close_not_before).toBeNull();
    });

    it('исход «отменить заявку» не стирает ни факт закрытия, ни документы', async () => {
      const { id } = await exemptRequest('Спор из решённой, отмена', 'done');
      const closed = await stateOf(id);
      await disputeOk(id, 'cancel');

      const state = await stateOf(id);
      expect(state.status).toBe('cancelled');
      expectHoldCleared(state);
      /*
       * ФАКТ И ДОКУМЕНТЫ ОСТАЮТСЯ: отмена их не стирает, и переписывать историю мы не будем. Зато
       * исполнителя и снимок согласования снимает обычная матрица отмены — это её работа, а не
       * ручки спора, и проверяется здесь именно затем, чтобы ручка не начала чинить её «заодно».
       */
      expect(state.completed_at).not.toBeNull();
      expect(state.final_total_amount).toBe(closed.final_total_amount);
      const files = await ctx.db.execute<{ kind: string }>(sql`
        SELECT kind FROM service_request_files WHERE request_id = ${id}`);
      expect(files.rows.map((row) => row.kind)).toContain('act');
      expect(state.service_counterparty_id).toBeNull();
      expect(state.approved_estimate_revision).toBeNull();
    });
  });

  // ── Д4. Второго открытого спора не бывает ──

  describe('Д4. один открытый спор на заявку', () => {
    it('второе открытие — 409 про спор, а не 422 про статус «Отложена»', async () => {
      const { id } = await exemptRequest('Второй спор по одной заявке');
      const first = await openDispute(id);
      expect(first.statusCode, first.body).toBe(200);

      const second = await openDispute(id);
      expect(second.statusCode, second.body).toBe(409);
      /*
       * ОТКАЗ НАЗЫВАЕТ СПОР, А НЕ СТАТУС. Заявка стоит в «Отложена» именно из-за первого спора, и
       * ответь ручка «спор открывают до приёмки», человек читал бы отказ про состояние, в которое
       * заявку привело его же действие.
       */
      expect(messageOf(second)).toContain('уже идёт спор');
      expect(await disputesOf(id)).toHaveLength(1);
    });

    it('после разрешения спор открывается снова — историю споров заявка хранит целиком', async () => {
      const { id } = await exemptRequest('Повторный спор после разрешения');
      await disputeOk(id, 'keep');
      const again = await openDispute(id, { reason: 'Появились новые доводы по той же сумме' });
      expect(again.statusCode, again.body).toBe(200);
      // Двух строк, а не одной: исход «оставить» заявку не изменил, и кто настаивал раньше — весь
      // постфактумный контроль над освобождениями.
      expect(await disputesOf(id)).toMatchObject([
        { state: 'resolved', outcome: 'keep' },
        { state: 'open', outcome: null },
      ]);
    });
  });

  // ── Д5. При открытом споре заперты возврат и приёмка ──

  describe('Д5. спор закрывают исходом, а не обходят', () => {
    it('обычный возврат из заморозки — 422, и отказ называет спор', async () => {
      const { id } = await exemptRequest('Возврат при открытом споре');
      const opened = await openDispute(id);
      expect(opened.statusCode, opened.body).toBe(200);

      const resumed = await inject('PATCH', `${REQUESTS}/${id}/resume`, ctx.operator.auth, {
        comment: 'Поработаем дальше',
        version: await versionOf(id),
      });
      expect(resumed.statusCode, resumed.body).toBe(422);
      expect(messageOf(resumed)).toContain('спором об освобождении');
      expect(await stateOf(id)).toMatchObject({
        status: 'on_hold',
        hold_kind: 'estimate_exemption_dispute',
      });
    });

    it('массовый возврат отбивается той же проверкой и называет причину в отчёте', async () => {
      const { id } = await exemptRequest('Массовый возврат при открытом споре');
      const opened = await openDispute(id);
      expect(opened.statusCode, opened.body).toBe(200);

      const res = await inject(
        'POST',
        BULK,
        ctx.operator.auth,
        { operation: 'resume', rows: [{ id, version: await versionOf(id) }], comment: '' },
        { 'idempotency-key': randomUUID() },
      );
      expect(res.statusCode, res.body).toBe(200);
      const report = res.json() as ServiceRequestBulkResultDto;
      expect([report.done, report.failed]).toEqual([0, 1]);
      /*
       * КОД `blocked` И СВОЙ ТЕКСТ — ради отчёта пачки. Ответь ручка 409, пачка перевела бы отказ в
       * код `version` с текстом «строка изменилась» и потеряла бы причину: оператор обновлял бы
       * список по кругу, не узнав про спор.
       */
      expect(report.rows[0]).toMatchObject({ outcome: 'failed', code: 'blocked' });
      expect(report.rows[0]!.reason).toContain('спором об освобождении');
      expect(await stateOf(id)).toMatchObject({ status: 'on_hold' });
    });

    it('приёмка при открытом споре — 422: спор не закрывают приёмкой (Н14)', async () => {
      const { id } = await exemptRequest('Приёмка при открытом споре', 'done');
      const opened = await openDispute(id);
      expect(opened.statusCode, opened.body).toBe(200);
      /*
       * ЗАЯВКА ПРИ ЭТОМ В «Отложена», И ОТКАЗЫВАЕТ ЕЙ КОРИДОР — замок спора стоит за ним и страхует
       * следующий путь из заморозки, который заведут, не вспомнив про спор. Поэтому случай проверяет
       * обе половины: и отказ ручки, и то, что разрешённый спор приёмку отпирает.
       */
      const accepted = await inject('PATCH', `${REQUESTS}/${id}/accept`, ctx.operator.auth, {
        comment: '',
        version: await versionOf(id),
      });
      expect(accepted.statusCode, accepted.body).toBe(403);
      expect(await stateOf(id)).toMatchObject({ status: 'on_hold' });

      const resolved = await resolveDispute(id, 'keep');
      expect(resolved.statusCode, resolved.body).toBe(200);
      const after = await inject('PATCH', `${REQUESTS}/${id}/accept`, ctx.operator.auth, {
        comment: 'Работу принимаем',
        version: await versionOf(id),
      });
      expect(after.statusCode, after.body).toBe(200);
      expect((await stateOf(id)).status).toBe('accepted');
    });

    it('открытый спор у заявки в «Решена» запирает приёмку — замок живёт в ручке, а не в коридоре', async () => {
      const { id } = await exemptRequest('Приёмка под открытым спором в решённой', 'done');
      /*
       * СОСТОЯНИЕ СОБИРАЕТСЯ SQL НАМЕРЕННО, И ЭТО НЕ ОБХОД РУЧКИ. Ручками его сегодня не собрать:
       * спор держит заявку в «Отложена», а оттуда ведут только возврат (заперт видом заморозки) и
       * отмена. Но база такую пару допускает — `state = 'open'` со статусом «Решена» не запрещён ни
       * одним ограничением, — и появится она у первого же нового пути из заморозки, заведённого без
       * оглядки на спор. Замок приёмки страхует именно это, и проверить его можно только так:
       * спроси случай коридор, он проверял бы `on_hold`, а не новый замок (соседний случай выше это и
       * делает).
       */
      await ctx.db.execute(sql`
        INSERT INTO service_request_estimate_disputes (request_id, revision, opened_by, reason, state)
        VALUES (${id}, 1, ${ctx.operator.id}, 'Счёт не совпадает с прайсом', 'open')`);

      const accepted = await inject('PATCH', `${REQUESTS}/${id}/accept`, ctx.operator.auth, {
        comment: 'Работу принимаем',
        version: await versionOf(id),
      });
      expect(accepted.statusCode, accepted.body).toBe(422);
      expect(messageOf(accepted)).toContain('сначала разрешите спор');
      // Заявка осталась в «Решена»: отказ случился ДО перехода, а не после него.
      expect((await stateOf(id)).status).toBe('done');
    });

    it('спор по принятой заявке не открывают вовсе — приёмка конец разбирательства', async () => {
      const { id } = await exemptRequest('Спор после приёмки', 'done');
      const accepted = await inject('PATCH', `${REQUESTS}/${id}/accept`, ctx.operator.auth, {
        comment: 'Работу принимаем',
        version: await versionOf(id),
      });
      expect(accepted.statusCode, accepted.body).toBe(200);

      const res = await openDispute(id);
      expect(res.statusCode, res.body).toBe(422);
      expect(messageOf(res)).toContain('до приёмки');
      expect(await disputesOf(id)).toHaveLength(0);
    });
  });

  // ── Д6. По подписанному человеком объёму работ спора нет ──

  describe('Д6. спорят об освобождении, а не о подписи', () => {
    it('по подписанному человеком объёму работ — 422, такую заявку возвращают в правку', async () => {
      const created = await inject('POST', REQUESTS, ctx.customer.auth, {
        officeEquipmentId: await makeEquipment(),
        description: 'Объём работ подписан человеком, спорить нечем',
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
      const draft = await inject('PUT', `${REQUESTS}/${id}/estimate`, ctx.service.auth, {
        items: [{ kind: 'service', name: 'Ремонт узла закрепления', quantity: 1, unitPrice: 5400 }],
        version: await versionOf(id),
      });
      expect(draft.statusCode, draft.body).toBe(200);
      // Предъявление БЕЗ заявления об освобождении: подпись собирают обычным порядком.
      const submitted = await inject(
        'PATCH',
        `${REQUESTS}/${id}/estimate/submit`,
        ctx.service.auth,
        { mode: 'items', version: await versionOf(id) },
      );
      expect(submitted.statusCode, submitted.body).toBe(200);
      const approved = await inject(
        'PATCH',
        `${REQUESTS}/${id}/estimate/approval`,
        ctx.operator.auth,
        { approved: true, version: await versionOf(id) },
      );
      expect(approved.statusCode, approved.body).toBe(200);
      expect(await stateOf(id)).toMatchObject({ estimate_approval_source: 'human' });

      const res = await openDispute(id);
      expect(res.statusCode, res.body).toBe(422);
      expect(messageOf(res)).toContain('Освобождение от подписи');
      expect(await stateOf(id)).toMatchObject({ status: 'in_work', hold_kind: null });
      expect(await disputesOf(id)).toHaveLength(0);
    });

    it('после исхода «нужна подпись» и подписи второго спора по той же ревизии нет', async () => {
      const { id } = await exemptRequest('Подпись после спора закрывает дорогу второму', 'done');
      await disputeOk(id, 'require_signature');
      const signed = await inject(
        'PATCH',
        `${REQUESTS}/${id}/estimate/approval`,
        ctx.operator.auth,
        { approved: true, version: await versionOf(id) },
      );
      expect(signed.statusCode, signed.body).toBe(200);

      /*
       * ОСВОБОЖДЕНИЯ БОЛЬШЕ НЕТ, ХОТЯ СТРОКА ЗАЯВЛЕНИЯ ОСТАЛАСЬ НА МЕСТЕ: подпись под этой ревизией
       * теперь человеческая. Без этого слагаемого признака спор открывали бы по кругу — оспаривая
       * подпись, которую сами же и потребовали.
       */
      const res = await openDispute(id);
      expect(res.statusCode, res.body).toBe(422);
      expect(messageOf(res)).toContain('Освобождение от подписи');
    });
  });

  // ── Д7. Подпись в «Решена» ──

  describe('Д7. подпись в «Решена» открыта только постспорному ожиданию', () => {
    it('до разрешения спора согласование отбивается, после исхода «нужна подпись» — проходит', async () => {
      const { id } = await exemptRequest('Подпись в решённой после спора', 'done');
      const opened = await openDispute(id);
      expect(opened.statusCode, opened.body).toBe(200);

      // Заявка в «Отложена»: ожидания подписи ещё нет, и согласовывать нечего.
      const early = await inject(
        'PATCH',
        `${REQUESTS}/${id}/estimate/approval`,
        ctx.operator.auth,
        { approved: true, version: await versionOf(id) },
      );
      expect(early.statusCode, early.body).toBe(422);
      expect(await stateOf(id)).toMatchObject({
        status: 'on_hold',
        estimate_pending_revision: null,
      });

      const resolved = await resolveDispute(id, 'require_signature');
      expect(resolved.statusCode, resolved.body).toBe(200);

      const before = new Date();
      const signed = await inject(
        'PATCH',
        `${REQUESTS}/${id}/estimate/approval`,
        ctx.operator.auth,
        { approved: true, version: await versionOf(id) },
      );
      expect(signed.statusCode, signed.body).toBe(200);

      const state = await stateOf(id);
      // Подпись в «Решена» прошла, факт закрытия на месте, ожидание погашено вместе с происхождением.
      expect(state).toMatchObject({
        status: 'done',
        approved_estimate_revision: 1,
        estimate_approved_by: ctx.operator.id,
        estimate_approval_source: 'human',
        estimate_pending_revision: null,
        estimate_pending_source: null,
      });
      expect(state.completed_at).not.toBeNull();
      /*
       * ПОРОГ ОКНА ПРИЁМКИ СТАВИТ ПОДПИСЬ (Д2, Н9). Отсчёт от разрешения спора закрыл бы заявку
       * автоматически сразу после подписи, поставленной через два дня: окна на возражение не получил
       * бы никто.
       */
      expect(new Date(state.auto_close_not_before!).getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000,
      );
    });
  });
  // ── Д8. Спор виден в карточке ──

  /**
   * СПОР — ПОЛЕ КАРТОЧКИ, А НЕ ДОГАДКА ПО ПРИЧИНЕ ЗАМОРОЗКИ. Портал считает обе двери (открыть спор,
   * разрешить спор) предикатами контрактов, а им нужен готовый признак `disputeOpen`: взять его из
   * `holdReason` — значит читать состояние по свободному тексту, который пишет человек. И
   * РАЗРЕШЁННЫЙ спор обязан остаться: только он объясняет второе окно приёмки и подпись, собранную
   * уже в «Решена».
   */
  describe('Д8. карточка отдаёт спор', () => {
    it('открытый спор виден целиком, разрешённый — вместе с исходом, автором и временем', async () => {
      const { id } = await exemptRequest('Спор в карточке');
      const opened = await openDispute(id, { reason: 'Счёт вдвое выше прайса — нужна подпись' });
      expect(opened.statusCode, opened.body).toBe(200);

      const open = (await card(id)).dispute;
      expect(open).toMatchObject({
        revision: 1,
        state: 'open',
        reason: 'Счёт вдвое выше прайса — нужна подпись',
        openedBy: ctx.operator.id,
        // Исход у открытого спора пуст — это и есть «разбор идёт», а не «решили и не исполнили».
        outcome: null,
        resolvedBy: null,
        resolvedAt: null,
      });
      expect(open!.openedByName).not.toBe('');

      const resolved = await resolveDispute(id, 'keep');
      expect(resolved.statusCode, resolved.body).toBe(200);

      const after = (await card(id)).dispute;
      expect(after).toMatchObject({
        revision: 1,
        state: 'resolved',
        outcome: 'keep',
        resolvedBy: ctx.operator.id,
      });
      expect(after!.resolvedAt).not.toBeNull();
    });

    /**
     * ВТОРОЙ ПРИЗНАК, КОТОРОГО ПОРТАЛУ НЕ ХВАТАЛО, — ИСТОЧНИК ПОДПИСИ. «Освобождение применено»
     * (`ServiceEstimateDisputeFacts.exemptionApplied`) складывается из следа заявления, равенства
     * ревизий и источника `auto`; без источника в карточке портал не может позвать
     * `canOpenServiceEstimateDispute` вовсе, а надпись читала бы автопринятие как подпись живого
     * человека (`serviceEstimateApprovalSourceOf`: пусто = `human`).
     */
    it('карточка называет источник подписи: автопринятие — `auto`, подпись после спора — `human`', async () => {
      const { id } = await exemptRequest('Источник подписи в карточке');
      expect((await card(id)).approval).toMatchObject({ revision: 1, by: null, source: 'auto' });

      await disputeOk(id, 'require_signature');
      const signed = await inject(
        'PATCH',
        `${REQUESTS}/${id}/estimate/approval`,
        ctx.operator.auth,
        { approved: true, version: await versionOf(id) },
      );
      expect(signed.statusCode, signed.body).toBe(200);
      expect((await card(id)).approval).toMatchObject({
        revision: 1,
        by: ctx.operator.id,
        source: 'human',
      });
    });

    it('заявке без спора поле пусто, и это «не спорили», а не «не посчитали»', async () => {
      const { id } = await exemptRequest('Заявка без спора');
      expect((await card(id)).dispute).toBeNull();
    });

    it('заявителю спор вычитается вместе с остальными деньгами заявки (карта аудиторий)', async () => {
      const { id } = await exemptRequest('Спор глазами заявителя');
      const opened = await openDispute(id);
      expect(opened.statusCode, opened.body).toBe(200);
      // «Ведение» спор видит…
      expect((await card(id, ctx.operator.auth)).dispute).toMatchObject({ state: 'open' });
      // …а автор заявки — нет: обсуждение цены без самой цены показывало бы ему спор о деньгах,
      // которых он не видит (Г4).
      expect((await card(id, ctx.customer.auth)).dispute).toBeNull();
    });
  });

  // ── Д9. Отмена поверх открытого спора ──

  /**
   * МАТРИЦА ОБЕЩАЕТ ИСХОД КАЖДОМУ СПОРУ, И ОБЫЧНАЯ ОТМЕНА ЗДЕСЬ — ТА ЖЕ ДВЕРЬ, ЧТО ИСХОД `cancel`.
   * Оставленный открытым спор стал бы неразрешимым навсегда: отмена снимает исполнителя, и
   * `assertEstimateApplies` отвечает потом «заявку ведёт свой сотрудник» (про спор ни слова), а
   * предикат разрешения требует «Отложена». То есть тот же конец достигался бы другой дверью, а
   * записи о том, чем кончился спор, не появлялось бы никогда.
   */
  describe('Д9. обычная отмена закрывает открытый спор исходом', () => {
    it('одиночная ручка статуса: спор уходит в `cancel` с автором и временем', async () => {
      const { id } = await exemptRequest('Отмена поверх открытого спора');
      const opened = await openDispute(id);
      expect(opened.statusCode, opened.body).toBe(200);

      const cancelled = await inject('PATCH', `${REQUESTS}/${id}/status`, ctx.operator.auth, {
        status: 'cancelled',
        reason: 'Аппарат выводится из эксплуатации, ремонт не нужен',
        version: await versionOf(id),
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);

      const state = await stateOf(id);
      expect(state.status).toBe('cancelled');
      // Заморозка погашена целиком — отмена отложенной заявки чистит все три её поля.
      expectHoldCleared(state);

      const [dispute] = await disputesOf(id);
      expect(dispute).toMatchObject({
        state: 'resolved',
        outcome: 'cancel',
        resolved_by: ctx.operator.id,
      });
      expect(dispute!.resolved_at).not.toBeNull();
    });

    it('та же запись появляется у массовой отмены — пачка идёт тем же шагом', async () => {
      const { id } = await exemptRequest('Массовая отмена поверх открытого спора');
      const opened = await openDispute(id);
      expect(opened.statusCode, opened.body).toBe(200);

      const res = await inject(
        'POST',
        BULK,
        ctx.operator.auth,
        {
          operation: 'cancel',
          rows: [{ id, version: await versionOf(id) }],
          reason: 'Заявка закрыта решением службы',
        },
        { 'idempotency-key': randomUUID() },
      );
      expect(res.statusCode, res.body).toBe(200);
      const report = res.json() as ServiceRequestBulkResultDto;
      expect([report.done, report.failed]).toEqual([1, 0]);

      expect((await stateOf(id)).status).toBe('cancelled');
      expect(await disputesOf(id)).toMatchObject([
        { state: 'resolved', outcome: 'cancel', resolved_by: ctx.operator.id },
      ]);
    });

    it('отмена без спора ничего не выдумывает — строк споров у заявки не появляется', async () => {
      const { id } = await exemptRequest('Отмена без всякого спора');
      const cancelled = await inject('PATCH', `${REQUESTS}/${id}/status`, ctx.operator.auth, {
        status: 'cancelled',
        reason: 'Заявка заведена по ошибке',
        version: await versionOf(id),
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(await disputesOf(id)).toHaveLength(0);
    });

    it('разрешённый спор отмена не переписывает: исход остаётся тем, каким его назвали', async () => {
      const { id } = await exemptRequest('Отмена после разрешённого спора');
      await disputeOk(id, 'keep');
      const cancelled = await inject('PATCH', `${REQUESTS}/${id}/status`, ctx.operator.auth, {
        status: 'cancelled',
        reason: 'Аппарат списан',
        version: await versionOf(id),
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      // `keep`, а не `cancel`: закрывается только ОТКРЫТЫЙ спор, и переписывать чужой разбор отмена
      // не вправе.
      expect(await disputesOf(id)).toMatchObject([{ state: 'resolved', outcome: 'keep' }]);
    });
  });

  // ── Д10. Требование спора переживает возврат в правку ──

  /**
   * ИСХОД «НУЖНА ПОДПИСЬ» СНИМАЛСЯ САМИМ ПОДРЯДЧИКОМ — и без всякого разбора: возврат в правку гасит
   * ожидание, то же заявление по новой ревизии снова отвечало `applied`, автоподпись вставала на
   * место, работы закрывались, а автоприёмка через сутки принимала заявку. Ни одной человеческой
   * подписи, и требование спора не помнил никто. Заявка обязана его помнить.
   */
  describe('Д10. после исхода «нужна подпись» освобождение больше не применяется', () => {
    it('возврат в правку и повторное заявление дают `observed`, а не новую автоподпись', async () => {
      const { id, itemId } = await exemptRequest('Требование спора против возврата в правку');
      await disputeOk(id, 'require_signature');
      expect(await stateOf(id)).toMatchObject({
        status: 'in_work',
        estimate_pending_revision: 1,
        estimate_pending_source: 'dispute',
        approved_estimate_revision: null,
      });

      // Ход подрядчика: своё предъявление он вправе отозвать — ожидание спора гаснет вместе с ним.
      const reopened = await inject(
        'PATCH',
        `${REQUESTS}/${id}/estimate/reopen`,
        ctx.service.auth,
        {
          reason: 'Уточняю состав работ',
          version: await versionOf(id),
        },
      );
      expect(reopened.statusCode, reopened.body).toBe(200);
      expect(await stateOf(id)).toMatchObject({ estimate_pending_revision: null });

      const again = await inject('PATCH', `${REQUESTS}/${id}/estimate/submit`, ctx.service.auth, {
        mode: 'items',
        exemption: { note: 'Всё тот же мелкий ремонт на месте' },
        version: await versionOf(id),
      });
      expect(again.statusCode, again.body).toBe(200);

      /*
       * РЕВИЗИЯ 2 ПОДПИСЫВАЕТСЯ ЧЕЛОВЕКОМ, А НЕ САМА СОБОЙ: автоподписи нет, ожидание открыто
       * обычным предъявлением. Именно здесь и была дыра — прежде тут стояли `approved_estimate_revision: 2`
       * и `estimate_approval_source: 'auto'`.
       */
      expect(await stateOf(id)).toMatchObject({
        estimate_revision: 2,
        estimate_pending_revision: 2,
        estimate_pending_source: 'submit',
        approved_estimate_revision: null,
        estimate_approval_source: null,
      });

      // Заявление при этом ЗАПИСАНО — со своим исходом: след остаётся, освобождения не случилось.
      const exemptions = await ctx.db.execute<{ revision: number; outcome: string }>(sql`
        SELECT revision, outcome FROM service_request_estimate_exemptions
         WHERE request_id = ${id} ORDER BY revision`);
      expect(exemptions.rows).toMatchObject([
        { revision: 1, outcome: 'applied' },
        { revision: 2, outcome: 'observed' },
      ]);

      // И дальше всё идёт обычным порядком: подпись ставит человек, и только после неё — работы.
      const signed = await inject(
        'PATCH',
        `${REQUESTS}/${id}/estimate/approval`,
        ctx.operator.auth,
        { approved: true, version: await versionOf(id) },
      );
      expect(signed.statusCode, signed.body).toBe(200);
      expect(await stateOf(id)).toMatchObject({
        approved_estimate_revision: 2,
        estimate_approved_by: ctx.operator.id,
        estimate_approval_source: 'human',
      });
      // Строка `itemId` та же: возврат в правку состава не трогает — предмет проверки в подписи.
      expect(itemId).not.toBe('');
    });

    it('исход «оставить освобождение» ничего не запрещает: там решили обратное', async () => {
      const { id } = await exemptRequest('Исход «оставить» освобождение не отнимает');
      await disputeOk(id, 'keep');
      const reopened = await inject(
        'PATCH',
        `${REQUESTS}/${id}/estimate/reopen`,
        ctx.service.auth,
        {
          reason: 'Добавляю ещё одну работу',
          version: await versionOf(id),
        },
      );
      expect(reopened.statusCode, reopened.body).toBe(200);

      const again = await inject('PATCH', `${REQUESTS}/${id}/estimate/submit`, ctx.service.auth, {
        mode: 'items',
        exemption: { note: 'Мелкий ремонт на месте' },
        version: await versionOf(id),
      });
      expect(again.statusCode, again.body).toBe(200);
      // Автоподпись на месте: «Ведение» разобрало спор в пользу освобождения, и запрещать нечего.
      expect(await stateOf(id)).toMatchObject({
        estimate_revision: 2,
        approved_estimate_revision: 2,
        estimate_approval_source: 'auto',
        estimate_pending_revision: null,
      });
    });
  });
});
