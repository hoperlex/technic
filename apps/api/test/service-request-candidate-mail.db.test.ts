import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * ПИСЬМА О СООБЩЕНИИ, ЧТО АППАРАТА НЕТ В СПРАВОЧНИКЕ (план
 * `docs/office-equipment-candidate-plan.md`, §10; этап Э5; общая механика — ADR 0159).
 *
 * ЧТО ИМЕННО ДОКАЗЫВАЕТСЯ. Ценность письма не в том, что оно составилось, а в том, КОМУ оно ушло и
 * КОГДА его не будет. Утверждений здесь ровно столько, сколько у этой пары событий способов
 * сломаться молча:
 *
 *   · заведение пары ставит ДВА письма рядом — службе про заявку и проверяющим про сообщение, — и
 *     они не склеиваются: у писем разные `kind`, и уникальность очереди `(kind, dedupe_key)` их не
 *     схлопывает. Склейка стоила бы одного факта из двух, причём без единого следа;
 *   · адресат считается ПРАВОМ и областью: площадочный проверяющий чужой площадки, отдельский
 *     проверяющий при сообщении без отдела, администратор, отключённая учётка и держатель одного
 *     лишь чтения писем не получают, а централизованный проверяющий без оси — получает;
 *   · рубильник выключен — писем нет вовсе, и письмо СЛУЖБЕ при этом уходит как раньше: два
 *     события включаются порознь;
 *   · обратный адрес разный у двух событий (автор против ящика службы) — приписка в теле обещает
 *     ровно то, что стоит в заголовке;
 *   · источник-актор вычёркивается: сообщивший о технике не получает письма о собственном
 *     сообщении, а решение по своему же сообщению кончается `not_needed`, а не тревогой;
 *   · повтор потерянной попытки (тот же `Idempotency-Key`) второго письма не ставит;
 *   · SQL-ошибка ОЧЕРЕДИ откатывает решение целиком (atomic-outbox, Р13 шаг 7): «письма нет» и
 *     «решения нет» — одно состояние, а не два;
 *   · пустой набор обязательных адресатов даёт `no_recipients` и строгую строку журнала — иначе
 *     «почему никто не пришёл проверять» разбирать было бы нечем.
 *
 * ЗАЧЕМ БАЗА, А НЕ МОКИ. Половина утверждений — про то, чего в коде не видно: эффективное право
 * адресата считается соединением с наборами, область — подзапросами по привязкам учётки, а откат
 * outbox без живой транзакции не воспроизвести вовсе.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: файл считает ПИСЬМА («их ровно два», «второго
 * письма нет»), а список копий `module_mail_recipients` — один на весь портал, и соседний прогон,
 * заведший свою копию на то же событие, делал бы эти утверждения ложными через раз. Образец
 * устройства взят у соседей `office-equipment-candidate-decisions.db.test.ts` и
 * `service-request-candidate-intake.db.test.ts`.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/service-request-candidate-mail.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_candidate_mail_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/u, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/u, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-candidate-mail-password-123';
const REQUESTS = '/api/v1/service-requests';
const CANDIDATES = '/api/v1/office-equipment-candidates';
const EQUIPMENT = '/api/v1/office-equipment';
/** Ящик канала `repair`: он же отправитель писем модуля, он же получатель писем службе. */
const SERVICE_MAILBOX = `repair-${RUN}@example.invalid`;
const COPY_MAILBOX = `copy-${RUN}@example.invalid`;

const PENDING = 'office_equipment_candidate_pending';
const DECIDED = 'office_equipment_candidate_decided';

interface Auth {
  authorization: string;
}

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

/**
 * Действующие лица. Каждый отвечает за своё утверждение о списке адресатов, и «лишних» здесь нет:
 * четверо заведены ровно затем, чтобы письма НЕ получить.
 */
type UserTag =
  /** Все права по роли: проверяющий по существу, но из автоматических адресатов исключён (§10). */
  | 'admin'
  /** Автор сообщения: его адрес — обратный у письма проверяющим. */
  | 'author'
  /** Второй автор: на нём проверяется отключённый адресат письма о решении. */
  | 'author2'
  /** Проверяющий площадки сообщения — главный адресат `pending`. */
  | 'reviewerA'
  /** Проверяющий чужой площадки: та же роль, то же право, другая область. */
  | 'reviewerB'
  /** Централизованный проверяющий без оси: очередь всей компании (ветка «роль без оси»). */
  | 'central'
  /** Отдельский проверяющий: у сообщения площадочного автора отдела нет вовсе. */
  | 'deptReviewer'
  /** Автор из того же отдела: на нём проверяется ОТДЕЛЬСКАЯ ось очереди (Р9). */
  | 'deptAuthor'
  /** Отключённая учётка с правом: ящик, за которым никого нет. */
  | 'retired'
  /** Есть роль и область, нет права: письмо считается правом, а не соседством по площадке. */
  | 'plain'
  /** И сообщает, и проверяет: на нём проверяется исключение источника-актора. */
  | 'proposerReviewer';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  users: Record<UserTag, TestUser>;
  typeId: string;
  /** Площадка сообщения, чужая площадка и площадка без единого проверяющего. */
  objectA: string;
  objectB: string;
  objectC: string;
  /** Набор проверяющего: тест снимает и возвращает его, проверяя `no_recipients`. */
  reviewGrantId: string;
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
  // Почта включена и канал службы настроен: без него исход был бы `channel_missing`, и файл
  // проверял бы отсутствие настройки вместо адресатов.
  process.env.MAIL_ENABLED = 'true';
  process.env.MAIL_TRANSPORT = 'log';
  process.env.MAIL_ACCOUNT_REPAIR_HOST = 'm.example.invalid';
  process.env.MAIL_ACCOUNT_REPAIR_FROM = `Ремонт <${SERVICE_MAILBOX}>`;
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
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
  headers?: Record<string, string>,
) {
  return ctx.app.inject({
    method,
    url,
    headers: { ...auth, ...headers },
    remoteAddress: nextAddress(),
    ...(payload === undefined ? {} : { payload }),
  });
}

interface Pair {
  requestId: string;
  candidateId: string;
  displayNumber: string;
  serialNumber: string;
  inventoryNumber: string;
  mail: string;
  candidateMail?: string;
}

/**
 * Пара «кандидат + заявка» — НАСТОЯЩЕЙ РУЧКОЙ, а не прямым SQL (в отличие от соседа про решения).
 * Здесь это и есть предмет проверки: два письма ставятся одной транзакцией заведения, и вставкой
 * строк мимо ручки файл проверял бы собственную подмену.
 */
async function propose(
  who: UserTag,
  tag: string,
  opts: {
    objectId?: string;
    key?: string;
    comment?: string;
    expectStatus?: number;
    /** У заявителя-отдельца площадку называть НЕЛЬЗЯ: подразделением заявки становится отдел. */
    fromDepartment?: boolean;
  } = {},
): Promise<Pair> {
  const serialNumber = `SN-${tag}-${RUN}`;
  const inventoryNumber = `INV-${tag}-${RUN}`;
  const res = await inject(
    'POST',
    REQUESTS,
    ctx.users[who].auth,
    {
      description: 'Не печатает, зажёвывает бумагу',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      /*
       * Площадка заявителя названа явно: у автора их две (площадка сообщения и площадка без
       * проверяющих), а при нескольких привязках сервер выбирать за человека отказывается — и
       * правильно делает, иначе заявка молча уезжала бы в чужую область.
       */
      ...(opts.fromDepartment ? {} : { requesterObjectId: opts.objectId ?? ctx.objectA }),
      equipmentCandidate: {
        equipmentTypeId: ctx.typeId,
        declaredModel: `Kyocera ECOSYS ${tag}`,
        serialNumber,
        inventoryNumber,
        objectId: opts.objectId ?? ctx.objectA,
        location: 'каб. 214',
        comment: opts.comment ?? 'стоит у бухгалтерии, наклейки нет',
      },
    },
    { 'idempotency-key': opts.key ?? randomUUID() },
  );
  /*
   * 201 — обычный ответ, 200 — ПОВТОР потерянной попытки: этим запросом ничего не создано, и
   * сказать «создано» значило бы соврать клиенту, который как раз и выясняет, создавал ли он
   * что-нибудь. Ожидаемый код поэтому называет вызывающий, а не подразумевает помощник.
   */
  expect(res.statusCode, res.body).toBe(opts.expectStatus ?? 201);
  const body = res.json() as {
    request: ServiceRequestDto;
    mail: string;
    candidateMail?: string;
  };
  const row = await ctx.db.execute<{ id: string }>(sql`
    SELECT equipment_candidate_id AS id FROM service_requests WHERE id = ${body.request.id}`);
  return {
    requestId: body.request.id,
    candidateId: row.rows[0]!.id,
    displayNumber: body.request.displayNumber,
    serialNumber,
    inventoryNumber,
    mail: body.mail,
    candidateMail: body.candidateMail,
  };
}

interface Letter {
  kind: string;
  to_email: string;
  reply_to: string;
  account: string;
  subject: string;
  dedupe_key: string;
  body_text: string;
}

/** Письма, записанные на сущность кандидата: их адресаты и есть предмет файла. */
async function candidateLetters(candidateId: string): Promise<Letter[]> {
  const res = await ctx.db.execute<Letter>(sql`
    SELECT kind, to_email, reply_to, account, subject, dedupe_key, body_text
      FROM mail_messages
     WHERE entity_type = 'officeEquipmentCandidate' AND entity_id = ${candidateId}
     ORDER BY created_at, to_email`);
  return res.rows;
}

/** Письма самой заявки: рядом с ними и проверяется, что события не подменили друг друга. */
async function requestLetters(requestId: string): Promise<Letter[]> {
  const res = await ctx.db.execute<Letter>(sql`
    SELECT kind, to_email, reply_to, account, subject, dedupe_key, body_text
      FROM mail_messages
     WHERE entity_type = 'serviceRequest' AND entity_id = ${requestId}
     ORDER BY created_at, to_email`);
  return res.rows;
}

const addressesOf = (letters: Letter[], kind: string): string[] =>
  letters
    .filter((l) => l.kind === kind)
    .map((l) => l.to_email)
    .sort();

/** Строки строгого почтового аудита: «письма не было и почему» разбирают именно по ним. */
async function mailAudit(candidateId: string) {
  const res = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM audit_log
     WHERE entity_type = 'officeEquipmentCandidate' AND entity_id = ${candidateId}
       AND action = 'officeEquipmentCandidate.mailPlanned'
     ORDER BY created_at`);
  return res.rows.map((r) => r.metadata as { event: string; outcome: string });
}

async function setEvent(event: string, isEnabled: boolean): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE module_mail_event_settings SET is_enabled = ${isEnabled} WHERE event = ${event}`);
}

describe.skipIf(!DB_URL)('письма о сообщении, что техники нет в справочнике', () => {
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
    const passwordHash = await hashPassword(PASSWORD);

    const object = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`CM-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const objectA = await object('A');
    const objectB = await object('B');
    const objectC = await object('C');
    const departmentRow = await db.execute<{ id: string }>(sql`
      INSERT INTO departments (code, name) VALUES (${`CM-D-${RUN}`}, ${`Отдел ${RUN}`})
      RETURNING id`);
    const departmentId = departmentRow.rows[0]!.id;

    async function makeUser(
      tag: string,
      role: string,
      isActive = true,
    ): Promise<{ id: string; email: string }> {
      const email = `db-cm-${tag}-${RUN}@example.invalid`;
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, ${isActive}, now())
        RETURNING id`);
      return { id: row.rows[0]!.id, email };
    }

    const raw = {
      admin: await makeUser('admin', 'admin'),
      author: await makeUser('author', 'shtab'),
      author2: await makeUser('author2', 'shtab'),
      reviewerA: await makeUser('reviewera', 'shtab'),
      reviewerB: await makeUser('reviewerb', 'shtab'),
      central: await makeUser('central', 'dispatcher'),
      deptReviewer: await makeUser('dept', 'department'),
      deptAuthor: await makeUser('deptauthor', 'department'),
      // Отключённая учётка входа не даёт, и логинить её незачем: она проверяется отсутствием в
      // списке адресатов, а не своими действиями.
      retired: await makeUser('retired', 'shtab', false),
      plain: await makeUser('plain', 'shtab'),
      proposerReviewer: await makeUser('both', 'shtab'),
    };

    const attachObject = (userId: string, objectId: string) =>
      db.execute(sql`
        INSERT INTO user_construction_objects (user_id, construction_object_id)
        VALUES (${userId}, ${objectId})`);
    for (const id of [
      raw.author.id,
      raw.author2.id,
      raw.reviewerA.id,
      raw.retired.id,
      raw.plain.id,
      raw.proposerReviewer.id,
    ]) {
      await attachObject(id, objectA);
    }
    // Площадка без единого проверяющего: она есть только у авторов — на ней и проверяется
    // `no_recipients`.
    await attachObject(raw.author.id, objectC);
    await attachObject(raw.reviewerB.id, objectB);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id)
      VALUES (${raw.deptReviewer.id}, ${departmentId}), (${raw.deptAuthor.id}, ${departmentId})`);
    /*
     * Площадка отдела (ADR 0062): без неё отдельский заявитель не может сообщить о технике на A —
     * сервер отобьёт чужую площадку раньше всякой почты.
     */
    await db.execute(sql`
      INSERT INTO department_construction_objects (department_id, construction_object_id)
      VALUES (${departmentId}, ${objectA})`);

    /*
     * НАБОРЫ СОБИРАЮТСЯ ТЕСТОМ, а не берутся системными: составы профилей едут ВЫПУСКОМ B (§14,
     * M4), а выпуск A обязан работать до него. Строки `grant_roles` обязательны — права набора
     * считаются соединением с ролью (`grantPermissionsExpr`), и набор без них не даёт ничего.
     */
    const makeGrant = async (
      code: string,
      permissions: string[],
      roles: string[],
      holders: string[],
    ): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO grants (code, name, description, is_system, created_by)
        VALUES (${code}, ${`Набор прогона ${code}`}, 'Письма по сообщениям о технике (Э5)', false,
                ${raw.admin.id})
        RETURNING id`);
      const grantId = row.rows[0]!.id;
      for (const permission of permissions) {
        await db.execute(sql`
          INSERT INTO grant_permissions (grant_id, permission) VALUES (${grantId}, ${permission})`);
      }
      for (const role of roles) {
        await db.execute(sql`
          INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, ${sql.raw(`'${role}'::role`)})`);
      }
      for (const holder of holders) {
        await db.execute(sql`
          INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
          VALUES (${holder}, ${grantId}, ${raw.admin.id}, 'manual')`);
      }
      return grantId;
    };

    await makeGrant(
      `cm-propose-${RUN}`,
      ['officeEquipment.propose'],
      ['shtab', 'department'],
      [raw.author.id, raw.author2.id, raw.proposerReviewer.id, raw.deptAuthor.id],
    );
    const reviewGrantId = await makeGrant(
      `cm-review-${RUN}`,
      [
        'officeEquipment.read',
        'officeEquipment.write',
        'officeEquipment.review',
        'serviceRequests.read',
      ],
      ['shtab', 'dispatcher', 'department'],
      [
        raw.reviewerA.id,
        raw.reviewerB.id,
        raw.central.id,
        raw.deptReviewer.id,
        raw.retired.id,
        raw.proposerReviewer.id,
      ],
    );

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id ?? '';
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    /*
     * Оба события заводятся ВЫКЛЮЧЕННЫМИ (миграция M3), и это состояние выпуска A. Файл их
     * включает — иначе он проверял бы один-единственный исход `event_off`, — а отдельный случай
     * рубильника выключает своё событие обратно.
     */
    await db.execute(sql`
      UPDATE module_mail_event_settings SET is_enabled = true
       WHERE event IN (${PENDING}, ${DECIDED})`);

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
    const users = {} as Record<UserTag, TestUser>;
    for (const [tag, user] of Object.entries(raw) as [UserTag, { id: string; email: string }][]) {
      users[tag] =
        tag === 'retired'
          ? { ...user, auth: { authorization: 'Bearer нет-входа-у-отключённой' } }
          : { ...user, auth: await login(user.email) };
    }

    ctx = { app, db, closeDb, users, typeId, objectA, objectB, objectC, reviewGrantId };
  }, 180_000);

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

  // ── 1. Два письма рядом ──

  describe('заведение пары', () => {
    it('ставит письмо службе и письмо проверяющим — двумя видами, не подавляя друг друга', async () => {
      const pair = await propose('author', 'P1');
      // Исходы разные полями: `mail` отвечает за письмо службы, `candidateMail` — за сообщение.
      expect(pair.mail).toBe('queued');
      expect(pair.candidateMail).toBe('queued');

      const forRequest = await requestLetters(pair.requestId);
      expect(forRequest).toHaveLength(1);
      expect(forRequest[0]!.kind).toBe('service_request_waiting_it');
      expect(forRequest[0]!.to_email).toBe(SERVICE_MAILBOX);

      const forCandidate = await candidateLetters(pair.candidateId);
      expect(forCandidate.every((l) => l.kind === PENDING)).toBe(true);
      // Ключи писем не пересекаются даже частью: вид у них разный, и `(kind, dedupe_key)` не
      // склеит два факта — служба получила своё, проверяющие своё.
      const keys = new Set(
        [...forRequest, ...forCandidate].map((l) => `${l.kind}:${l.dedupe_key}`),
      );
      expect(keys.size).toBe(forRequest.length + forCandidate.length);
      expect(forCandidate[0]!.dedupe_key.startsWith(`${PENDING}:${pair.candidateId}:`)).toBe(true);
      expect(forCandidate[0]!.account).toBe('repair');
    });

    it('адресат считается правом и областью, а не соседством по площадке', async () => {
      const pair = await propose('author', 'P2');
      const letters = await candidateLetters(pair.candidateId);
      const to = addressesOf(letters, PENDING);
      /*
       * Проверяющий площадки сообщения и централизованный без оси — вдвоём. Остальные не получают
       * ничего, и каждый по своей причине: чужая площадка, отдел у площадочного сообщения пуст,
       * администратор исключён из автоматических адресатов, учётка отключена, права нет вовсе.
       */
      expect(to).toEqual(
        [
          ctx.users.central.email,
          ctx.users.reviewerA.email,
          // Держатель обоих прав — законный адресат: сообщение завёл не он, и вычёркивать его
          // здесь было бы нечем.
          ctx.users.proposerReviewer.email,
        ].sort(),
      );
      for (const tag of ['reviewerB', 'deptReviewer', 'admin', 'retired', 'plain'] as UserTag[]) {
        expect(to, `письмо ушло лишнему адресату: ${tag}`).not.toContain(ctx.users[tag].email);
      }
    });

    it('у сообщения от отдела адресатом становится и отдельский проверяющий', async () => {
      const pair = await propose('deptAuthor', 'P7', { fromDepartment: true });
      const to = addressesOf(await candidateLetters(pair.candidateId), PENDING);
      /*
       * ОСЬ У РОЛИ ОДНА, а оснований очереди два: отдельский проверяющий ловит сообщение отделом
       * автора, площадочный — площадкой сообщения, и оба они его адресаты. Ровно это и означает
       * зеркало предиката Р9: «кто из проверяющих видит это сообщение» обязано совпасть с «какие
       * сообщения видит этот проверяющий».
       */
      expect(to).toContain(ctx.users.deptReviewer.email);
      expect(to).toContain(ctx.users.reviewerA.email);
      expect(to).toContain(ctx.users.central.email);
      // Чужая площадка чужой и остаётся: отдел автора его очереди не открывает.
      expect(to).not.toContain(ctx.users.reviewerB.email);
    });

    it('обратный адрес письма проверяющим — автор сообщения, а тело называет место и комментарий', async () => {
      const pair = await propose('author', 'P3', { comment: 'наклейки нет, стоит у окна' });
      const letters = await candidateLetters(pair.candidateId);
      const letter = letters.find((l) => l.to_email === ctx.users.reviewerA.email)!;
      // Вопрос проверяющего — «точно ли этот аппарат там стоит», и задать его надо тому, кто видел.
      expect(letter.reply_to).toBe(ctx.users.author.email);
      expect(letter.subject).toContain(pair.displayNumber);
      expect(letter.body_text).toContain(pair.inventoryNumber);
      expect(letter.body_text).toContain('каб. 214');
      expect(letter.body_text).toContain('наклейки нет, стоит у окна');
    });

    it('повтор потерянной попытки второго письма не ставит', async () => {
      const key = randomUUID();
      const first = await propose('author', 'P4', { key });
      const before = await candidateLetters(first.candidateId);
      const again = await propose('author', 'P4', { key, expectStatus: 200 });
      expect(again.requestId).toBe(first.requestId);
      // Повтор ничего не создавал — и письма о том, чего не случилось, быть не должно.
      expect(again.candidateMail).toBeUndefined();
      expect(await candidateLetters(first.candidateId)).toHaveLength(before.length);
    });
  });

  // ── 2. Рубильник и копии ──

  describe('настройка события', () => {
    it('выключенное событие писем не ставит, а письмо службе уходит как раньше', async () => {
      await setEvent(PENDING, false);
      try {
        const pair = await propose('author', 'P5');
        expect(pair.candidateMail).toBe('event_off');
        expect(await candidateLetters(pair.candidateId)).toHaveLength(0);
        // Два события включаются порознь: письмо службе рубильником сообщения не гасится.
        expect(pair.mail).toBe('queued');
        expect(await requestLetters(pair.requestId)).toHaveLength(1);
        expect((await mailAudit(pair.candidateId))[0]).toMatchObject({
          event: PENDING,
          outcome: 'event_off',
        });
      } finally {
        await setEvent(PENDING, true);
      }
    });

    it('копия получает урезанное тело и обратный адрес службы', async () => {
      const added = await inject('POST', '/api/v1/admin/mail/recipients', ctx.users.admin.auth, {
        event: PENDING,
        toEmail: COPY_MAILBOX,
        replyToMode: 'portal',
      });
      expect(added.statusCode, added.body).toBe(201);
      const recipientId = (added.json() as { id: string }).id;
      try {
        const pair = await propose('author', 'P6', { comment: 'секретная подробность прогона' });
        const letters = await candidateLetters(pair.candidateId);
        expect(addressesOf(letters, PENDING)).toContain(COPY_MAILBOX);
        const copy = letters.find((l) => l.to_email === COPY_MAILBOX)!;
        // У строки настройки нет проверяемого субъекта: наблюдение человека ей не раскрывается.
        expect(copy.body_text).not.toContain('секретная подробность прогона');
        expect(copy.body_text).not.toContain('каб. 214');
        expect(copy.body_text).not.toContain(ctx.users.author.email);
        // Обозначение техники копии остаётся: ради него её и заводят.
        expect(copy.body_text).toContain(pair.inventoryNumber);
        // Режим строки — `portal`, но по событиям заявок он не применяется: ответ идёт в службу.
        expect(copy.reply_to).toBe(SERVICE_MAILBOX);
      } finally {
        const removed = await inject(
          'DELETE',
          `/api/v1/admin/mail/recipients/${recipientId}`,
          ctx.users.admin.auth,
        );
        expect(removed.statusCode).toBe(204);
      }
    });
  });

  // ── 3. Решения ──

  describe('письмо о решении', () => {
    it('отказ приходит автору дословно и с ответом в службу', async () => {
      const pair = await propose('author', 'D1');
      const res = await inject(
        'POST',
        `${CANDIDATES}/${pair.candidateId}/reject`,
        ctx.users.reviewerA.auth,
        {
          expectedVersion: 1,
          reason: 'Аппарата в 214-м нет: там стоит другой, уже заведённый',
        },
      );
      expect(res.statusCode, res.body).toBe(200);
      const dto = res.json() as { mail: string; mailTargets: { author: string } };
      expect(dto.mail).toBe('queued');
      expect(dto.mailTargets.author).toBe('queued');

      const decided = (await candidateLetters(pair.candidateId)).filter((l) => l.kind === DECIDED);
      expect(decided).toHaveLength(1);
      expect(decided[0]!.to_email).toBe(ctx.users.author.email);
      // Ответ на письмо о решении уходит в службу: переписка по справочнику рабочая, и попадать
      // она обязана тем, кто его ведёт, а не в личный ящик дежурного проверяющего.
      expect(decided[0]!.reply_to).toBe(SERVICE_MAILBOX);
      expect(decided[0]!.body_text).toContain('Аппарата в 214-м нет');
      // Якорь ключа — «кандидат + решение», и двоеточий в нём нет: адресат обязан остаться третьим
      // полем ключа, иначе письмо не найти там, где его ищут.
      expect(decided[0]!.dedupe_key).toBe(
        `${DECIDED}:${pair.candidateId}-rejected:${ctx.users.author.id}`,
      );
    });

    it('подтверждение называет заведённую карточку, а объединение чужую — нет', async () => {
      const confirmed = await propose('author', 'D2');
      const okConfirm = await inject(
        'POST',
        `${CANDIDATES}/${confirmed.candidateId}/confirm`,
        ctx.users.reviewerA.auth,
        {
          expectedVersion: 1,
          equipment: {
            equipmentTypeId: ctx.typeId,
            name: `Kyocera ECOSYS D2 ${RUN}`,
            serialNumber: confirmed.serialNumber,
            inventoryNumber: confirmed.inventoryNumber,
            objectId: ctx.objectA,
            location: 'каб. 214 (проверено)',
          },
        },
      );
      expect(okConfirm.statusCode, okConfirm.body).toBe(200);
      const confirmLetter = (await candidateLetters(confirmed.candidateId)).find(
        (l) => l.kind === DECIDED,
      )!;
      expect(confirmLetter.body_text).toContain(`Kyocera ECOSYS D2 ${RUN}`);

      // Цель объединения — уже заведённая карточка, и реквизитов её письмо не называет (Р10):
      // она может числиться за чужим подразделением, а письмо — не то место, где это раскрывают.
      const card = await inject('POST', EQUIPMENT, ctx.users.admin.auth, {
        equipmentTypeId: ctx.typeId,
        name: `МФУ соседа ${RUN}`,
        objectId: ctx.objectA,
        location: 'каб. 101',
        serialNumber: `SN-CARD-${RUN}`,
      });
      expect(card.statusCode, card.body).toBe(201);
      const merged = await propose('author', 'D3');
      const okMerge = await inject(
        'POST',
        `${CANDIDATES}/${merged.candidateId}/merge`,
        ctx.users.reviewerA.auth,
        { expectedVersion: 1, officeEquipmentId: (card.json() as { id: string }).id },
      );
      expect(okMerge.statusCode, okMerge.body).toBe(200);
      const mergeLetter = (await candidateLetters(merged.candidateId)).find(
        (l) => l.kind === DECIDED,
      )!;
      expect(mergeLetter.body_text).toContain('Аппарат уже был в справочнике');
      expect(mergeLetter.body_text).not.toContain(`МФУ соседа ${RUN}`);
    });

    it('решение по собственному сообщению письма не ставит: исход not_needed', async () => {
      const pair = await propose('proposerReviewer', 'D4');
      // Заодно исключение источника-актора на первом письме: сообщивший о технике проверяющий не
      // получает письма о собственном сообщении, а его коллеги получают.
      const pendingTo = addressesOf(await candidateLetters(pair.candidateId), PENDING);
      expect(pendingTo).not.toContain(ctx.users.proposerReviewer.email);
      expect(pendingTo).toContain(ctx.users.reviewerA.email);

      const res = await inject(
        'POST',
        `${CANDIDATES}/${pair.candidateId}/reject`,
        ctx.users.proposerReviewer.auth,
        { expectedVersion: 1, reason: 'Ошибся: аппарат стоит в соседнем кабинете и уже заведён' },
      );
      expect(res.statusCode, res.body).toBe(200);
      // «Письма нет, и это правильно»: адресат узнал о решении своим же нажатием кнопки, и
      // `no_recipients` звал бы заводить ящик там, где он ни при чём.
      expect((res.json() as { mail: string }).mail).toBe('not_needed');
      expect((await candidateLetters(pair.candidateId)).filter((l) => l.kind === DECIDED)).toEqual(
        [],
      );
    });
  });

  // ── 4. Молчание, о котором надо знать ──

  describe('пустой набор адресатов', () => {
    it('сообщение с площадки без проверяющих даёт no_recipients и строгую запись журнала', async () => {
      // Централизованный проверяющий видит очередь всей компании, поэтому «проверяющих нет» без
      // снятия его набора недостижимо вовсе — на площадке C нет ни одного площадочного.
      await ctx.db.execute(sql`
        DELETE FROM user_grants
         WHERE user_id = ${ctx.users.central.id} AND grant_id = ${ctx.reviewGrantId}`);
      try {
        const pair = await propose('author', 'N1', { objectId: ctx.objectC });
        expect(pair.candidateMail).toBe('no_recipients');
        expect(await candidateLetters(pair.candidateId)).toHaveLength(0);
        // Строк очереди при этом исходе не возникает вовсе, и «письма не было» не остаётся больше
        // нигде, кроме этой записи.
        expect((await mailAudit(pair.candidateId))[0]).toMatchObject({
          event: PENDING,
          outcome: 'no_recipients',
        });
      } finally {
        await ctx.db.execute(sql`
          INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
          VALUES (${ctx.users.central.id}, ${ctx.reviewGrantId}, ${ctx.users.admin.id}, 'manual')`);
      }
    });

    it('решение по сообщению отключённого автора отвечает no_recipients', async () => {
      const pair = await propose('author2', 'N2');
      await ctx.db.execute(
        sql`UPDATE users SET is_active = false WHERE id = ${ctx.users.author2.id}`,
      );
      try {
        const res = await inject(
          'POST',
          `${CANDIDATES}/${pair.candidateId}/reject`,
          ctx.users.reviewerA.auth,
          { expectedVersion: 1, reason: 'Сообщение недостоверно: такого аппарата на площадке нет' },
        );
        expect(res.statusCode, res.body).toBe(200);
        // Ящик, за которым никого нет, — не адресат: молчаливая отправка туда хуже честного
        // «человек о решении не узнает».
        expect((res.json() as { mail: string }).mail).toBe('no_recipients');
        expect(
          (await candidateLetters(pair.candidateId)).filter((l) => l.kind === DECIDED),
        ).toEqual([]);
      } finally {
        await ctx.db.execute(
          sql`UPDATE users SET is_active = true WHERE id = ${ctx.users.author2.id}`,
        );
      }
    });
  });

  // ── 5. Атомарность outbox ──

  describe('atomic-outbox', () => {
    it('SQL-ошибка очереди откатывает решение целиком', async () => {
      const pair = await propose('author', 'A1');
      /*
       * Сбой наводится триггером на `mail_messages` и ПРИЦЕЛЕН по сущности нашего сообщения:
       * глухой запрет всей таблице сорвал бы соседние случаи файла. Отказ ОЧЕРЕДИ — это отказ
       * общего хранилища, и прятать его под мягким «сбой почты» нельзя: решение обязано
       * откатиться целиком, а не остаться принятым втихую.
       */
      const fn = `zz_outbox_boom_${RUN.replace(/-/gu, '')}`;
      await ctx.db.execute(
        sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN RAISE EXCEPTION 'db-тест: очередь писем недоступна'; END $fn$`),
      );
      await ctx.db.execute(
        sql.raw(`CREATE TRIGGER ${fn} BEFORE INSERT ON mail_messages
        FOR EACH ROW WHEN (NEW.entity_id = '${pair.candidateId}') EXECUTE FUNCTION ${fn}()`),
      );
      try {
        const res = await inject(
          'POST',
          `${CANDIDATES}/${pair.candidateId}/reject`,
          ctx.users.reviewerA.auth,
          { expectedVersion: 1, reason: 'Проверка отката: этой строки в базе остаться не должно' },
        );
        expect(res.statusCode, res.body).toBe(500);
      } finally {
        await ctx.db.execute(sql.raw(`DROP TRIGGER ${fn} ON mail_messages`));
        await ctx.db.execute(sql.raw(`DROP FUNCTION ${fn}()`));
      }

      const row = await ctx.db.execute<{ status: string; content_version: number }>(sql`
        SELECT status, content_version FROM office_equipment_candidates WHERE id = ${pair.candidateId}`);
      expect(row.rows[0]!.status).toBe('pending');
      expect(row.rows[0]!.content_version).toBe(1);
      // И после снятия сбоя то же решение проходит: замок был на очереди, а не на данных.
      const again = await inject(
        'POST',
        `${CANDIDATES}/${pair.candidateId}/reject`,
        ctx.users.reviewerA.auth,
        { expectedVersion: 1, reason: 'Сообщение недостоверно: аппарат в кабинете не найден' },
      );
      expect(again.statusCode, again.body).toBe(200);
      expect(
        (await candidateLetters(pair.candidateId)).filter((l) => l.kind === DECIDED),
      ).toHaveLength(1);
    });
  });
});
