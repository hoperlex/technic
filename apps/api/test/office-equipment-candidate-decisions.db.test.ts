import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficeEquipmentCandidateDto, ServiceRequestDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * ТРИ РЕШЕНИЯ ПРОВЕРЯЮЩЕГО ПО СООБЩЕНИЮ О ТЕХНИКЕ (план
 * `docs/office-equipment-candidate-plan.md`, Р11, Р13–Р16, §11; этап Э4).
 *
 * ЧТО ИМЕННО ДОКАЗЫВАЕТСЯ. Решение — самое ответственное действие модуля: оно заводит запись в
 * ПАРКЕ и переписывает предмет чужой заявки. Утверждений здесь ровно столько, сколько у него
 * способов сломаться, и все они про совместность, а не про формат ответа:
 *
 *   · три исхода доводятся до конца и оставляют след в обеих строках — в кандидате и в заявке;
 *   · невозможных состояний база не принимает (`…_result_check`, `…_reason_check`): подтверждения
 *     без карточки и отказа без причины не бывает, и это не договорённость кода;
 *   · два проверяющих, нажавших решения одновременно, не перетирают друг друга — второй получает
 *     409 со СВЕЖИМ состоянием, а не молча ложится поверх (Р11);
 *   · решение и приёмка встречаются на одной паре строк и берут их в одном порядке «заявка →
 *     кандидат»: гонка кончается ответом, а не дедлоком (Р13);
 *   · пока сообщение `pending`, заявку не принимают, а после ЛЮБОГО решения — принимают: отказ
 *     намеренно не создаёт тупика в «Решена» (Р16);
 *   · объединение с неактивной карточкой отбивается — иначе оно обошло бы серверный замок Ф2;
 *   · занятый номер при подтверждении отвечает 409 С ГОТОВЫМ СЛЕДУЮЩИМ ШАГОМ (Р10, рубеж 3);
 *   · аудит решения СТРОГИЙ: искусственный сбой записи журнала откатывает решение целиком (§11);
 *   · решение видно в ИСТОРИИ ЗАЯВКИ, и все три исхода читаются там разными словами (Р6): без
 *     третьей строки журнала лента заявки о решении не узнала бы вовсе — она читает свою пару
 *     `entity_type = 'serviceRequest'`, а решение записано на кандидата.
 *
 * ЗАЧЕМ БАЗА, А НЕ МОКИ. Половина утверждений здесь — про то, чего в коде не видно: `CHECK`,
 * условная запись с `ROW_COUNT = 1`, порядок блокировок и атомарность строгого аудита. Подменив
 * базу, файл проверял бы собственную подмену; гонку двух решений и гонку с приёмкой без живых
 * транзакций не воспроизвести вовсе.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: часть утверждений считает строки парка и журнала
 * («второй карточки не появилось», «строк аудита ровно две»), и чужой прогон в тех же таблицах
 * сделал бы их ложными. База заводится, мигрируется с нуля и сносится в `afterAll` — образец
 * устройства взят у соседа `office-equipment-candidate-access.db.test.ts`.
 *
 * ПАРЫ «КАНДИДАТ + ЗАЯВКА» ЗАВОДЯТСЯ ПРЯМЫМ SQL, а не ручкой заведения заявки: ручка — предмет
 * своего файла (`service-request-candidate-intake.db.test.ts`), и повесив на неё фикстуры, этот
 * прогон краснел бы от любой её правки, ничего не сообщая про решения. Прямой вставке при этом
 * доступны состояния, до которых иначе надо гнать заявку по всему циклу, — заявка в «Решена»
 * нужна каждому случаю про замок приёмки.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/office-equipment-candidate-decisions.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_oe_candidate_decisions_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-candidate-decisions-password-123';
const CANDIDATES = '/api/v1/office-equipment-candidates';
const REQUESTS = '/api/v1/service-requests';
const EQUIPMENT = '/api/v1/office-equipment';

/** Отказ замка приёмки дословно: по тексту видно, что 422 пришёл от Р16, а не от коридора статусов. */
const ACCEPT_LOCK = 'Сначала дождитесь решения по технике';

interface Auth {
  authorization: string;
}

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

/**
 * Действующие лица. Их трое, и каждый отвечает за свою сторону утверждений: проверяющий принимает
 * решения и он же принимает работу по заявке (в жизни это одно «Ведение»), автор — тот, чьё
 * сообщение разбирают, чужой проверяющий — граница области.
 */
type UserTag = 'admin' | 'reviewer' | 'author' | 'foreign';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  users: Record<UserTag, TestUser>;
  typeId: string;
  objectA: string;
  objectB: string;
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
) {
  return ctx.app.inject({
    method,
    url,
    headers: auth,
    remoteAddress: nextAddress(),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Пара «кандидат + заявка», заведённая прямым SQL: всё, что различает случаи, — в параметрах. */
interface Pair {
  candidateId: string;
  requestId: string;
  num: number;
  serialNumber: string;
  inventoryNumber: string;
}

async function makePair(opts: {
  tag: string;
  objectId?: string;
  requestStatus?: 'new' | 'in_work' | 'done';
  authorId?: string;
}): Promise<Pair> {
  const serialNumber = `SN-${opts.tag}-${RUN}`;
  const inventoryNumber = `INV-${opts.tag}-${RUN}`;
  const objectId = opts.objectId ?? ctx.objectA;
  const authorId = opts.authorId ?? ctx.users.author.id;
  const candidate = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO office_equipment_candidates (
      equipment_type_id, declared_model, serial_number, inventory_number,
      object_id, location, comment, created_by, idempotency_key, idempotency_fingerprint)
    VALUES (
      ${ctx.typeId}, ${`Kyocera ${opts.tag}`}, ${serialNumber}, ${inventoryNumber},
      ${objectId}, ${`каб. ${opts.tag}`}, '', ${authorId},
      ${randomUUID()}, ${`fingerprint-${opts.tag}-${RUN}`})
    RETURNING id`);
  const candidateId = candidate.rows[0]!.id;
  /*
   * Заявка и её исполнитель — ОДНОЙ транзакцией: инвариант «в рабочем статусе исполнитель есть»
   * держит отложенный constraint-триггер (миграция 0178), и заведённая отдельным запросом заявка в
   * «Решена» отбивается им ещё до того, как файл дойдёт до своего утверждения.
   */
  const status = opts.requestStatus ?? 'new';
  const request = await ctx.db.transaction(async (tx) => {
    const row = await tx.execute<{ id: string; num: number }>(sql`
      INSERT INTO service_requests (
        equipment_candidate_id, equipment_object_id, status,
        equipment_name, equipment_serial_number, equipment_inventory_number, equipment_location,
        description, responsible_name, created_by)
      VALUES (
        ${candidateId}, ${objectId}, ${sql.raw(`'${status}'::service_request_status`)},
        ${`Kyocera ${opts.tag}`}, ${serialNumber}, ${inventoryNumber}, ${`каб. ${opts.tag}`},
        'Не печатает, зажёвывает бумагу', 'Иванов Иван Иванович', ${authorId})
      RETURNING id, num`);
    if (status !== 'new') {
      await tx.execute(sql`
        INSERT INTO service_request_executors (request_id, user_id, assigned_by)
        VALUES (${row.rows[0]!.id}, ${authorId}, ${ctx.users.admin.id})`);
    }
    return row.rows[0]!;
  });
  return {
    candidateId,
    requestId: request.id,
    num: request.num,
    serialNumber,
    inventoryNumber,
  };
}

/**
 * Заявка БЕЗ кандидата — отрицательный контроль к блоку `equipmentCandidate` в DTO. Заводится
 * прямым SQL по той же причине, что и пары: ручка заведения — предмет своего файла.
 *
 * Предмет у неё «без аппарата» (Р8): `office_equipment_id` пуст, площадка названа. Ветвь
 * `service_requests_subject_check` для такой строки требует ровно одного заказчика — площадку либо
 * отдел, — и отдела здесь нет, поэтому XOR сходится на объекте.
 */
async function makePlainRequest(tag: string): Promise<{ id: string }> {
  const row = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO service_requests (
      equipment_object_id, status, equipment_name, equipment_serial_number,
      equipment_inventory_number, equipment_location,
      description, responsible_name, created_by)
    VALUES (
      ${ctx.objectA}, 'new'::service_request_status, '', '', '', '',
      ${`Обычная заявка ${tag}`}, 'Иванов Иван Иванович', ${ctx.users.author.id})
    RETURNING id`);
  return { id: row.rows[0]!.id };
}

/** Форма подтверждения — полная форма карточки парка (Р13), а не «завести как есть». */
function confirmBody(pair: Pair, extra: Record<string, unknown> = {}) {
  const { expectedVersion, ...equipment } = extra as { expectedVersion?: number };
  return {
    expectedVersion: expectedVersion ?? 1,
    equipment: {
      equipmentTypeId: ctx.typeId,
      // Именем, а не ссылкой на модель: так работает совместимость выпуска A, и модель по имени
      // заводит триггер зеркала — заодно проверяется, что снимок заявки берёт имя ИЗ БАЗЫ.
      name: `Kyocera ECOSYS ${pair.serialNumber}`,
      serialNumber: pair.serialNumber,
      inventoryNumber: pair.inventoryNumber,
      objectId: ctx.objectA,
      location: 'каб. 214 (проверено)',
      ...equipment,
    },
  };
}

function decide(action: 'confirm' | 'merge' | 'reject', who: UserTag, id: string, body: unknown) {
  return inject('POST', `${CANDIDATES}/${id}/${action}`, ctx.users[who].auth, body);
}

async function candidateRow(id: string) {
  const res = await ctx.db.execute<{
    status: string;
    content_version: number;
    decision_reason: string;
    result_equipment_id: string | null;
    decided_by: string | null;
    updated_by: string | null;
  }>(sql`SELECT * FROM office_equipment_candidates WHERE id = ${id}`);
  return res.rows[0]!;
}

async function requestRow(id: string) {
  const res = await ctx.db.execute<{
    office_equipment_id: string | null;
    equipment_candidate_id: string | null;
    equipment_object_id: string | null;
    equipment_department_id: string | null;
    equipment_name: string;
    equipment_serial_number: string;
    equipment_inventory_number: string;
    equipment_location: string;
    status: string;
  }>(sql`SELECT * FROM service_requests WHERE id = ${id}`);
  return res.rows[0]!;
}

/** Событие истории заявки — ровно те поля, на которых стоят утверждения раздела 9. */
interface HistoryEntry {
  kind: string;
  comment: string;
  actorName: string | null;
}

/**
 * Лента истории заявки глазами названного читателя. Читатель — параметр, потому что в разделе 9
 * их двое: решение принимает проверяющий, а читает след в первую очередь автор сообщения, которому
 * причина отказа и адресована (В5).
 */
async function history(requestId: string, who: UserTag): Promise<HistoryEntry[]> {
  const res = await inject('GET', `${REQUESTS}/${requestId}/history`, ctx.users[who].auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as HistoryEntry[];
}

/** Карточка заявки глазами названного читателя — ответ ручки, а не строка базы. */
async function requestDto(requestId: string, who: UserTag): Promise<ServiceRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${requestId}`, ctx.users[who].auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

/**
 * Страница списка заявок с отбором. Возвращается целиком (`total` вместе с `items`): у отбора по
 * состоянию предмета есть ТРЕТИЙ читатель — счётчик страницы, — и расхождение счёта с выдачей
 * («показано 3 из 5») ловится только сравнением этих двух чисел.
 */
async function listRequests(
  who: UserTag,
  query: string,
): Promise<{ items: ServiceRequestDto[]; total: number }> {
  const res = await inject('GET', `${REQUESTS}?pageSize=200&${query}`, ctx.users[who].auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: ServiceRequestDto[]; total: number };
}

/** Строки журнала по одной сущности: их число — часть утверждения о строгом аудите. */
async function auditRows(entityId: string) {
  const res = await ctx.db.execute<{ action: string; metadata: Record<string, unknown> }>(sql`
    SELECT action, metadata FROM audit_log WHERE entity_id = ${entityId} ORDER BY created_at`);
  return res.rows;
}

/**
 * Отказ БАЗЫ, а не сервера: код и имя ограничения. Drizzle заворачивает ошибку драйвера, и
 * `SQLSTATE` лежит в причине — сравнивай тест верхний уровень, он проходил бы на любой ошибке,
 * включая опечатку в имени колонки.
 */
async function refusalOf(run: Promise<unknown>): Promise<{ code: string; constraint: string }> {
  let accepted = false;
  let caught: unknown;
  try {
    await run;
    accepted = true;
  } catch (e) {
    caught = e;
  }
  if (accepted) throw new Error('база приняла строку, которую обязана была отбить');
  const cause = (caught as { cause?: { code?: string; constraint?: string } }).cause ?? caught;
  const e = cause as { code?: string; constraint?: string };
  return { code: e.code ?? 'unknown', constraint: e.constraint ?? '—' };
}

describe.skipIf(!DB_URL)(
  'решения по сообщению о технике: три исхода, гонки и строгий аудит',
  () => {
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
        VALUES (${`CD-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
        return row.rows[0]!.id;
      };
      const objectA = await object('A');
      const objectB = await object('B');

      const typeRow = await db.execute<{ id: string }>(
        sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
      );
      const typeId = typeRow.rows[0]?.id ?? '';
      if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

      async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
        const email = `db-oecd-${tag}-${RUN}@example.invalid`;
        const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Проверяющий', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
        return { id: res.rows[0]!.id, email };
      }

      const raw = {
        admin: await makeUser('admin', 'admin'),
        reviewer: await makeUser('reviewer', 'shtab'),
        author: await makeUser('author', 'shtab'),
        foreign: await makeUser('foreign', 'shtab'),
      } satisfies Record<UserTag, { id: string; email: string }>;

      await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${raw.reviewer.id}, ${objectA}), (${raw.author.id}, ${objectA}),
             (${raw.foreign.id}, ${objectB})`);

      /**
       * Наборы прогона — СВОИМИ кодами, а не системными: поставочный состав «Ведения» живёт своей
       * жизнью, и подмешивать в него права ради теста нельзя. Здесь набор называет ровно то, на чём
       * стоят утверждения файла: `review` — решать, `write` — заводить карточку (его требует
       * `PERMISSION_REQUIRES`, Р8), `serviceRequests.status` — принимать работу той же учёткой, что
       * и решает (в жизни это одно «Ведение», и замок приёмки проверяется именно на нём).
       */
      const makeGrant = async (
        code: string,
        permissions: string[],
        roles: string[],
        holderIds: string[],
      ): Promise<void> => {
        const row = await db.execute<{ id: string }>(sql`
        INSERT INTO grants (code, name, description, is_system, created_by)
        VALUES (${code}, ${`Набор прогона ${code}`}, 'Решения по кандидатам (план Э4)', false,
                ${raw.admin.id})
        RETURNING id`);
        const grantId = row.rows[0]!.id;
        await db.execute(sql`
        INSERT INTO grant_permissions (grant_id, permission)
        SELECT ${grantId}, permission FROM unnest(${sql.raw(
          `ARRAY[${permissions.map((p) => `'${p}'`).join(',')}]`,
        )}) AS permission`);
        for (const role of roles) {
          await db.execute(sql`
          INSERT INTO grant_roles (grant_id, role)
          VALUES (${grantId}, ${sql.raw(`'${role}'::role`)})`);
        }
        for (const holderId of holderIds) {
          await db.execute(sql`
          INSERT INTO user_grants (user_id, grant_id, granted_by)
          VALUES (${holderId}, ${grantId}, ${raw.admin.id})`);
        }
      };

      await makeGrant(
        `oecd-review-${RUN}`,
        [
          'officeEquipment.read',
          'officeEquipment.write',
          'officeEquipment.review',
          'serviceRequests.read',
          'serviceRequests.status',
        ],
        ['shtab'],
        [raw.reviewer.id, raw.foreign.id],
      );
      // Автор сообщения решений не принимает: у него только чтение заявок — им и проверяется, что
      // страж закрывает три ручки правом, а не областью.
      await makeGrant(`oecd-read-${RUN}`, ['serviceRequests.read'], ['shtab'], [raw.author.id]);

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
        users[tag] = { ...user, auth: await login(user.email) };
      }

      ctx = { app, db, closeDb, users, typeId, objectA, objectB };
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

    /** Карточка парка: заводит её администратор — у него есть и `write`, и вся область. */
    async function makeCard(
      tag: string,
      extra: Record<string, unknown> = {},
    ): Promise<{ id: string; serialNumber: string }> {
      const serialNumber = `CARD-${tag}-${RUN}`;
      const res = await inject('POST', EQUIPMENT, ctx.users.admin.auth, {
        equipmentTypeId: ctx.typeId,
        name: `МФУ ${tag} ${RUN}`,
        objectId: ctx.objectA,
        location: 'кабинет 101',
        serialNumber,
        ...extra,
      });
      expect(res.statusCode, res.body).toBe(201);
      return { id: (res.json() as { id: string }).id, serialNumber };
    }

    // ── 1. Подтверждение: карточка, ссылка и снимки ──

    describe('подтверждение', () => {
      it('заводит карточку, переписывает снимки заявки и пишет две строки журнала', async () => {
        const pair = await makePair({ tag: 'C1' });
        const res = await decide('confirm', 'reviewer', pair.candidateId, confirmBody(pair));
        expect(res.statusCode, res.body).toBe(200);
        const dto = res.json() as OfficeEquipmentCandidateDto;
        expect(dto.status).toBe('confirmed');
        // Версия растёт той же записью, что и статус: форма, оставшаяся открытой, повторно не пройдёт.
        expect(dto.contentVersion).toBe(2);
        expect(dto.decidedByName).toContain('Тестовый');
        expect(dto.resultEquipment?.title).toContain(pair.serialNumber);
        expect(dto.decisionReason).toBe('');

        const card = dto.resultEquipment!.id;
        const request = await requestRow(pair.requestId);
        expect(request.office_equipment_id).toBe(card);
        // Ссылка на сообщение ОСТАЁТСЯ: по ней заявка помнит, что предмет пришёл проверкой (Р4).
        expect(request.equipment_candidate_id).toBe(pair.candidateId);
        // Снимок переписан реквизитами карточки — единственный раз в жизни заявки (Р6).
        expect(request.equipment_name).toBe(`Kyocera ECOSYS ${pair.serialNumber}`);
        expect(request.equipment_location).toBe('каб. 214 (проверено)');
        // А колонки ОБЛАСТИ не тронуты: решение по справочнику не меняет круг тех, кто видит заявку.
        expect(request.equipment_object_id).toBe(ctx.objectA);
        expect(request.equipment_department_id).toBeNull();
        expect(request.status).toBe('new');

        /*
         * Строки строгого аудита на сообщении: решение и ИТОГ ПЛАНИРОВАНИЯ ПИСЬМА (§10, Э5) — оно
         * ставится той же транзакцией и след оставляет на каждом исходе, здесь `event_off`:
         * почта в этом прогоне выключена вовсе. Сравнение идёт по МНОЖЕСТВУ, а не по порядку:
         * обе строки пишутся в одной транзакции, у них одинаковый `created_at` (это время
         * транзакции), и порядок выдачи по нему не определён.
         */
        const decision = await auditRows(pair.candidateId);
        expect(decision.map((r) => r.action).sort()).toEqual([
          'officeEquipmentCandidate.confirm',
          'officeEquipmentCandidate.mailPlanned',
        ]);
        const confirmRow = decision.find((r) => r.action === 'officeEquipmentCandidate.confirm')!;
        expect(confirmRow.metadata.officeEquipmentId).toBe(card);
        const created = await auditRows(card);
        expect(created.map((r) => r.action)).toEqual(['officeEquipment.create']);
        // Происхождение карточки читается из журнала парка: «откуда она взялась» спрашивают там.
        expect(created[0]!.metadata.candidateId).toBe(pair.candidateId);
      });

      it('повторное подтверждение той же формой — 409 со свежим состоянием', async () => {
        const pair = await makePair({ tag: 'C2' });
        const first = await decide('confirm', 'reviewer', pair.candidateId, confirmBody(pair));
        expect(first.statusCode, first.body).toBe(200);

        const second = await decide('confirm', 'reviewer', pair.candidateId, confirmBody(pair));
        expect(second.statusCode, second.body).toBe(409);
        const details = (second.json() as { details: { candidate: OfficeEquipmentCandidateDto } })
          .details;
        // Свежее состояние целиком, а не один номер версии: окну надо показать, ЧТО изменилось.
        expect(details.candidate.status).toBe('confirmed');
        expect(details.candidate.contentVersion).toBe(2);
        // Второй карточки не появилось — транзакция откатилась до вставки.
        const cards = await ctx.db.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c FROM office_equipment WHERE serial_number = ${pair.serialNumber}`);
        expect(cards.rows[0]!.c).toBe(1);
      });

      it('в чужую область карточку не заводят — 403 по месту заведения, а не по площадке сообщения', async () => {
        const pair = await makePair({ tag: 'C3' });
        const res = await decide(
          'confirm',
          'reviewer',
          pair.candidateId,
          confirmBody(pair, { objectId: ctx.objectB }),
        );
        expect(res.statusCode, res.body).toBe(403);
        expect((await candidateRow(pair.candidateId)).status).toBe('pending');
      });

      it('занятый номер — 409 с готовым следующим шагом и идентификатором цели (рубеж 3)', async () => {
        const pair = await makePair({ tag: 'C4' });
        const card = await makeCard('BUSY');
        const res = await decide(
          'confirm',
          'reviewer',
          pair.candidateId,
          confirmBody(pair, { serialNumber: card.serialNumber }),
        );
        expect(res.statusCode, res.body).toBe(409);
        const body = res.json() as {
          message: string;
          details?: { officeEquipmentId?: string };
        };
        // Отказ НЕ глухой: он называет, что делать дальше, и отдаёт цель для кнопки объединения.
        expect(body.message).toContain('Объедините сообщение с ней');
        expect(body.details?.officeEquipmentId).toBe(card.id);
        expect((await candidateRow(pair.candidateId)).status).toBe('pending');
      });

      it('занятый номер чужой площадки не раскрывает её реквизитов', async () => {
        const pair = await makePair({ tag: 'C6' });
        const card = await makeCard('BUSY-FOREIGN', { objectId: ctx.objectB });
        const res = await decide(
          'confirm',
          'reviewer',
          pair.candidateId,
          confirmBody(pair, { serialNumber: card.serialNumber }),
        );
        expect(res.statusCode, res.body).toBe(409);
        const body = res.json() as { message: string; details?: { officeEquipmentId?: string } };
        expect(body.message).toContain('в другом подразделении');
        // Ни наименования, ни идентификатора: объединить её этот проверяющий всё равно не может.
        expect(body.message).not.toContain('МФУ BUSY-FOREIGN');
        expect(body.details?.officeEquipmentId).toBeUndefined();
      });

      it('занятый номер неактивной карточки зовёт сначала вернуть её в работу', async () => {
        const pair = await makePair({ tag: 'C5' });
        const card = await makeCard('BUSY-OFF', { isActive: false });
        const res = await decide(
          'confirm',
          'reviewer',
          pair.candidateId,
          confirmBody(pair, { serialNumber: card.serialNumber }),
        );
        expect(res.statusCode, res.body).toBe(409);
        const body = res.json() as { message: string; details?: { officeEquipmentId?: string } };
        expect(body.message).toContain('снята с эксплуатации');
        // Идентификатора нет намеренно: объединение неактивную цель всё равно отобьёт (Ф2).
        expect(body.details?.officeEquipmentId).toBeUndefined();
      });
    });

    // ── 2. Объединение ──

    describe('объединение', () => {
      it('связывает заявку с существующей карточкой и второй не заводит', async () => {
        const pair = await makePair({ tag: 'M1' });
        const card = await makeCard('M1');
        const res = await decide('merge', 'reviewer', pair.candidateId, {
          expectedVersion: 1,
          officeEquipmentId: card.id,
        });
        expect(res.statusCode, res.body).toBe(200);
        const dto = res.json() as OfficeEquipmentCandidateDto;
        expect(dto.status).toBe('duplicate');
        expect(dto.resultEquipment?.id).toBe(card.id);

        const request = await requestRow(pair.requestId);
        expect(request.office_equipment_id).toBe(card.id);
        expect(request.equipment_serial_number).toBe(card.serialNumber);
        // Сообщение картотеку не пополнило: в парке по-прежнему одна карточка с этим номером.
        const cards = await ctx.db.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c FROM office_equipment WHERE serial_number = ${card.serialNumber}`);
        expect(cards.rows[0]!.c).toBe(1);
        // Журнал парка второй строки не получает: карточка появилась в нём тогда, когда её завели.
        expect((await auditRows(card.id)).map((r) => r.action)).toEqual(['officeEquipment.create']);
      });

      it('неактивную карточку не принимает — иначе объединение обошло бы замок Ф2', async () => {
        const pair = await makePair({ tag: 'M2' });
        const card = await makeCard('M2', { isActive: false });
        const res = await decide('merge', 'reviewer', pair.candidateId, {
          expectedVersion: 1,
          officeEquipmentId: card.id,
        });
        expect(res.statusCode, res.body).toBe(422);
        expect((res.json() as { fields?: Record<string, string> }).fields).toHaveProperty(
          'officeEquipmentId',
        );
        const candidate = await candidateRow(pair.candidateId);
        expect(candidate.status).toBe('pending');
        expect(candidate.result_equipment_id).toBeNull();
      });

      it('карточку с чужой незакрытой заявкой не берёт — назван номер занявшей место', async () => {
        const pair = await makePair({ tag: 'M4' });
        const card = await makeCard('M4');
        // Открытая заявка по той же карточке: «одна открытая заявка на единицу» держится частичным
        // индексом (Р21 ADR 0085), и объединение упёрлось бы в него пятисоткой вместо ответа словами.
        const busy = await ctx.db.execute<{ num: number }>(sql`
        INSERT INTO service_requests (
          office_equipment_id, equipment_object_id, equipment_name,
          description, responsible_name, created_by)
        VALUES (
          ${card.id}, ${ctx.objectA}, 'МФУ занято', 'Не печатает', 'Иванов Иван Иванович',
          ${ctx.users.author.id})
        RETURNING num`);
        const res = await decide('merge', 'reviewer', pair.candidateId, {
          expectedVersion: 1,
          officeEquipmentId: card.id,
        });
        expect(res.statusCode, res.body).toBe(409);
        expect((res.json() as { message: string }).message).toContain(`СО-${busy.rows[0]!.num}`);
        expect((await candidateRow(pair.candidateId)).status).toBe('pending');
      });

      it('несуществующая цель — 422 полем, а не пятисоткой внешнего ключа', async () => {
        const pair = await makePair({ tag: 'M3' });
        const res = await decide('merge', 'reviewer', pair.candidateId, {
          expectedVersion: 1,
          officeEquipmentId: '00000000-0000-4000-8000-000000000000',
        });
        expect(res.statusCode, res.body).toBe(422);
      });
    });

    // ── 3. Отказ ──

    describe('отказ', () => {
      it('закрывает сообщение причиной и НЕ трогает заявку', async () => {
        const pair = await makePair({ tag: 'R1' });
        const res = await decide('reject', 'reviewer', pair.candidateId, {
          expectedVersion: 1,
          reason: 'В кабинете 214 такого аппарата нет',
        });
        expect(res.statusCode, res.body).toBe(200);
        const dto = res.json() as OfficeEquipmentCandidateDto;
        expect(dto.status).toBe('rejected');
        expect(dto.decisionReason).toBe('В кабинете 214 такого аппарата нет');
        expect(dto.resultEquipment).toBeNull();

        // Заявка осталась ровно такой, какой была: описание и снимки — работа человека (Р16).
        const request = await requestRow(pair.requestId);
        expect(request.office_equipment_id).toBeNull();
        expect(request.equipment_serial_number).toBe(pair.serialNumber);
        expect(request.status).toBe('new');
      });

      it('без причины не принимается', async () => {
        const pair = await makePair({ tag: 'R2' });
        const res = await decide('reject', 'reviewer', pair.candidateId, {
          expectedVersion: 1,
          reason: '',
        });
        expect(res.statusCode, res.body).toBe(400);
        expect((await candidateRow(pair.candidateId)).status).toBe('pending');
      });
    });

    // ── 4. Право и область: три ручки закрыты одним правом ──

    describe('право и область', () => {
      it('автору сообщения решения не открыты — 403 от стража', async () => {
        const pair = await makePair({ tag: 'P1' });
        const res = await decide('reject', 'author', pair.candidateId, {
          expectedVersion: 1,
          reason: 'передумал',
        });
        // 403, а не 404: решения закрыты ПРАВОМ, и о существовании ручки автор знать может.
        expect(res.statusCode, res.body).toBe(403);
      });

      it('чужую очередь не решают — 404, а не 403', async () => {
        const pair = await makePair({ tag: 'P2' });
        const res = await decide('reject', 'foreign', pair.candidateId, {
          expectedVersion: 1,
          reason: 'не моё',
        });
        expect(res.statusCode, res.body).toBe(404);
        expect((await candidateRow(pair.candidateId)).status).toBe('pending');
      });
    });

    // ── 5. Инварианты базы: невозможных состояний не бывает ──

    describe('инварианты решения в самой базе', () => {
      it('подтверждения без карточки-результата база не принимает', async () => {
        const pair = await makePair({ tag: 'I1' });
        const refusal = await refusalOf(
          ctx.db.execute(sql`
          UPDATE office_equipment_candidates
             SET status = 'confirmed', decided_by = ${ctx.users.reviewer.id}, decided_at = now()
           WHERE id = ${pair.candidateId}`),
        );
        expect(refusal.code).toBe('23514');
        expect(refusal.constraint).toBe('office_equipment_candidates_result_check');
      });

      it('отказа без причины база не принимает', async () => {
        const pair = await makePair({ tag: 'I2' });
        const refusal = await refusalOf(
          ctx.db.execute(sql`
          UPDATE office_equipment_candidates
             SET status = 'rejected', decided_by = ${ctx.users.reviewer.id}, decided_at = now()
           WHERE id = ${pair.candidateId}`),
        );
        expect(refusal.code).toBe('23514');
        expect(refusal.constraint).toBe('office_equipment_candidates_reason_check');
      });

      it('решения без пары «кто и когда» база не принимает', async () => {
        const pair = await makePair({ tag: 'I3' });
        const refusal = await refusalOf(
          ctx.db.execute(sql`
          UPDATE office_equipment_candidates
             SET status = 'rejected', decision_reason = 'аппарата нет'
           WHERE id = ${pair.candidateId}`),
        );
        expect(refusal.code).toBe('23514');
        expect(refusal.constraint).toBe('office_equipment_candidates_decision_check');
      });
    });

    // ── 6. Гонки ──

    describe('гонка двух проверяющих', () => {
      it('одновременные «подтвердить» и «отклонить»: один проходит, второй получает свежее состояние', async () => {
        const pair = await makePair({ tag: 'G1' });
        const [confirmed, rejected] = await Promise.all([
          decide('confirm', 'reviewer', pair.candidateId, confirmBody(pair)),
          decide('reject', 'reviewer', pair.candidateId, {
            expectedVersion: 1,
            reason: 'аппарата в названном месте нет',
          }),
        ]);
        const codes = [confirmed.statusCode, rejected.statusCode].sort((a, b) => a - b);
        expect(codes, `${confirmed.body} | ${rejected.body}`).toEqual([200, 409]);

        // В базе один исход, а не смесь: подтверждённого кандидата с причиной отказа не бывает.
        const row = await candidateRow(pair.candidateId);
        expect(row.content_version).toBe(2);
        if (row.status === 'confirmed') {
          expect(row.decision_reason).toBe('');
          expect(row.result_equipment_id).not.toBeNull();
        } else {
          expect(row.status).toBe('rejected');
          expect(row.result_equipment_id).toBeNull();
        }
        // Проигравший получил свежую версию — по ней портал перерисует форму, а не повторит нажатие.
        const loser = confirmed.statusCode === 409 ? confirmed : rejected;
        const details = (loser.json() as { details: { candidate: OfficeEquipmentCandidateDto } })
          .details;
        expect(details.candidate.contentVersion).toBe(2);
        expect(details.candidate.status).toBe(row.status);
      });

      it('гонка решения с приёмкой заявки проходит без дедлока', async () => {
        const pair = await makePair({ tag: 'G2', requestStatus: 'done' });
        const [decided, accepted] = await Promise.all([
          decide('reject', 'reviewer', pair.candidateId, {
            expectedVersion: 1,
            reason: 'аппарата в названном месте нет',
          }),
          inject('PATCH', `${REQUESTS}/${pair.requestId}/accept`, ctx.users.reviewer.auth, {
            version: 0,
          }),
        ]);
        // Ни одна из сторон не получила пятисотки: `40P01` (deadlock detected) приезжает именно ею.
        expect(decided.statusCode, decided.body).toBe(200);
        expect([200, 422], accepted.body).toContain(accepted.statusCode);
        const request = await requestRow(pair.requestId);
        // Исход допустим только тот, который разрешает замок: приёмка либо не состоялась (решение
        // ещё не закоммичено), либо состоялась после решения.
        expect(request.status).toBe(accepted.statusCode === 200 ? 'accepted' : 'done');
        expect((await candidateRow(pair.candidateId)).status).toBe('rejected');
      });
    });

    // ── 7. Замок приёмки (Р16) ──

    describe('замок приёмки', () => {
      it('пока сообщение на проверке, заявку не принимают', async () => {
        const pair = await makePair({ tag: 'A1', requestStatus: 'done' });
        const locked = await inject(
          'PATCH',
          `${REQUESTS}/${pair.requestId}/accept`,
          ctx.users.reviewer.auth,
          { version: 0 },
        );
        expect(locked.statusCode, locked.body).toBe(422);
        expect((locked.json() as { message: string }).message).toContain(ACCEPT_LOCK);
        expect((await requestRow(pair.requestId)).status).toBe('done');

        // Подтверждение снимает замок, и переход СВОЕГО хода не делает: заявка так и стоит в «Решена».
        const confirmed = await decide('confirm', 'reviewer', pair.candidateId, confirmBody(pair));
        expect(confirmed.statusCode, confirmed.body).toBe(200);
        expect((await requestRow(pair.requestId)).status).toBe('done');

        const accepted = await inject(
          'PATCH',
          `${REQUESTS}/${pair.requestId}/accept`,
          ctx.users.reviewer.auth,
          { version: 0 },
        );
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect((await requestRow(pair.requestId)).status).toBe('accepted');
      });

      it('после ОТКАЗА заявка не остаётся в тупике: её принимают обычным ходом', async () => {
        const pair = await makePair({ tag: 'A2', requestStatus: 'done' });
        const rejected = await decide('reject', 'reviewer', pair.candidateId, {
          expectedVersion: 1,
          reason: 'аппарата в названном месте нет',
        });
        expect(rejected.statusCode, rejected.body).toBe(200);
        const accepted = await inject(
          'PATCH',
          `${REQUESTS}/${pair.requestId}/accept`,
          ctx.users.reviewer.auth,
          { version: 0 },
        );
        expect(accepted.statusCode, accepted.body).toBe(200);
      });

      it('заявки без сообщения замок не касается', async () => {
        const card = await makeCard('FREE');
        const row = await ctx.db.transaction(async (tx) => {
          const inserted = await tx.execute<{ id: string }>(sql`
          INSERT INTO service_requests (
            office_equipment_id, equipment_object_id, status,
            equipment_name, description, responsible_name, created_by)
          VALUES (
            ${card.id}, ${ctx.objectA}, 'done'::service_request_status,
            'МФУ без сообщения', 'Не печатает', 'Иванов Иван Иванович',
            ${ctx.users.author.id})
          RETURNING id`);
          await tx.execute(sql`
          INSERT INTO service_request_executors (request_id, user_id, assigned_by)
          VALUES (${inserted.rows[0]!.id}, ${ctx.users.author.id}, ${ctx.users.admin.id})`);
          return inserted.rows[0]!;
        });
        const accepted = await inject(
          'PATCH',
          `${REQUESTS}/${row.id}/accept`,
          ctx.users.reviewer.auth,
          { version: 0 },
        );
        expect(accepted.statusCode, accepted.body).toBe(200);
      });
    });

    // ── 8. Строгий аудит (§11) ──

    describe('строгий аудит решения', () => {
      it('искусственный сбой записи журнала откатывает решение целиком', async () => {
        const pair = await makePair({ tag: 'AU1' });
        /*
         * Сбой наводится триггером на `audit_log` и ПРИЦЕЛЕН по идентификатору нашего сообщения:
         * глухой запрет всей таблице сорвал бы соседние случаи того же файла. Строку решения пишет
         * `writeAuditTx` — она и попадает под условие; общий `writeAudit` писал бы своим соединением
         * и пережил бы откат, то есть рассказывал бы в журнале о решении, которого нет.
         */
        const fn = `zz_audit_boom_${RUN.replace(/-/gu, '')}`;
        await ctx.db.execute(
          sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$
          BEGIN RAISE EXCEPTION 'db-тест: запись журнала не удалась'; END $fn$`),
        );
        await ctx.db.execute(
          sql.raw(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log
          FOR EACH ROW WHEN (NEW.entity_id = '${pair.candidateId}') EXECUTE FUNCTION ${fn}()`),
        );
        try {
          const res = await decide('confirm', 'reviewer', pair.candidateId, confirmBody(pair));
          // Отказ виден сразу — проверяющий повторит решение; молча пройти он не может.
          expect(res.statusCode, res.body).toBe(500);
        } finally {
          await ctx.db.execute(sql.raw(`DROP TRIGGER ${fn} ON audit_log`));
          await ctx.db.execute(sql.raw(`DROP FUNCTION ${fn}()`));
        }

        // Откатилось ВСЁ: сообщение ждёт проверки, карточки в парке нет, заявка без предмета.
        const candidate = await candidateRow(pair.candidateId);
        expect(candidate.status).toBe('pending');
        expect(candidate.content_version).toBe(1);
        const cards = await ctx.db.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c FROM office_equipment WHERE serial_number = ${pair.serialNumber}`);
        expect(cards.rows[0]!.c, 'карточка пережила откат решения').toBe(0);
        expect((await requestRow(pair.requestId)).office_equipment_id).toBeNull();

        // И после снятия сбоя то же решение проходит: замок был на журнале, а не на данных.
        const again = await decide('confirm', 'reviewer', pair.candidateId, confirmBody(pair));
        expect(again.statusCode, again.body).toBe(200);
      });
    });

    // ── 9. След решения в истории ЗАЯВКИ (Р6, Р16) ──

    /**
     * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ И ПОЧЕМУ ЭТО НЕ САМО СОБОЙ. Решение пишется строгим аудитом на СВОИ
     * сущности — кандидата и карточку парка, — а лента заявки читает журнал по паре
     * `entity_type = 'serviceRequest'` из закрытого перечня действий. Без третьей строки решение,
     * переписывающее предмет чужой заявки, в истории этой заявки не появилось бы вовсе: заявитель
     * увидел бы, что у заявки вдруг завёлся аппарат, и не нашёл бы, откуда; при отказе не увидел
     * бы ничего и продолжал бы ждать уже принятого решения.
     *
     * ТРИ ИСХОДА — ТРИ РАЗНЫЕ СТРОКИ, и проверяются они именно СЛОВАМИ, а не видом события: вид у
     * всех трёх один (`equipmentCandidateDecided`), и разводит их фраза. Утверждение по виду
     * зеленело бы на трёх одинаковых строках — то есть ровно там, где читатель истории ничего бы
     * не понял.
     *
     * ОТКАЗ ЧИТАЕТ АВТОР, а не только проверяющий: причина адресована ему и уходит дословно (В5).
     * Его аудитория — `requester` (денег заявки ему не видно), и лента режется ею же
     * (`projectHistoryForAudience`); строка решения обязана эту резку пережить.
     */
    describe('след решения в истории заявки', () => {
      /** Единственная строка решения в ленте: по ней и проверяются слова каждого исхода. */
      const decisionEntry = (entries: HistoryEntry[]): HistoryEntry => {
        const found = entries.filter((e) => e.kind === 'equipmentCandidateDecided');
        expect(found, `в ленте ${found.length} строк решения вместо одной`).toHaveLength(1);
        return found[0]!;
      };

      it('подтверждение называет заведённую карточку', async () => {
        const pair = await makePair({ tag: 'H1' });
        const res = await decide('confirm', 'reviewer', pair.candidateId, confirmBody(pair));
        expect(res.statusCode, res.body).toBe(200);

        const entry = decisionEntry(await history(pair.requestId, 'author'));
        expect(entry.comment).toContain('Предмет подтверждён');
        // Подпись карточки целиком, той же функцией, что в списке и в письме: по ней решение
        // читают через полгода, когда карточку успели переименовать.
        expect(entry.comment).toContain(`Kyocera ECOSYS ${pair.serialNumber}`);
        expect(entry.comment).toContain(pair.inventoryNumber);
        // Автор события — тот, кто решал, а не тот, кто заводил заявку.
        expect(entry.actorName).toContain('Проверяющий');

        // И строка журнала легла именно на заявку: без неё лента не нашла бы событие вовсе.
        const rows = await auditRows(pair.requestId);
        expect(rows.map((r) => r.action)).toEqual(['serviceRequest.candidate_confirm']);
        expect(rows[0]!.metadata.candidateId).toBe(pair.candidateId);
        expect(rows[0]!.metadata.status).toBe('confirmed');
      });

      it('объединение называет существующую карточку', async () => {
        const pair = await makePair({ tag: 'H2' });
        const card = await makeCard('H2');
        const res = await decide('merge', 'reviewer', pair.candidateId, {
          expectedVersion: 1,
          officeEquipmentId: card.id,
        });
        expect(res.statusCode, res.body).toBe(200);

        const entry = decisionEntry(await history(pair.requestId, 'author'));
        expect(entry.comment).toContain('Предмет объединён с карточкой');
        expect(entry.comment).toContain(card.serialNumber);
        // Не «подтверждён»: второй карточки не появилось, и путать эти два исхода в ленте нельзя.
        expect(entry.comment).not.toContain('подтверждён');
        expect((await auditRows(pair.requestId)).map((r) => r.action)).toEqual([
          'serviceRequest.candidate_merge',
        ]);
      });

      it('отказ виден автору вместе с причиной — дословно', async () => {
        const pair = await makePair({ tag: 'H3' });
        const reason = 'В кабинете 214 стоит другой аппарат, инвентарный номер не совпал';
        const res = await decide('reject', 'reviewer', pair.candidateId, {
          expectedVersion: 1,
          reason,
        });
        expect(res.statusCode, res.body).toBe(200);

        /*
         * Заявку отказ не трогает вовсе (Р16) — и ровно поэтому строка в истории обязательна: без
         * неё у заявки не изменилось бы НИЧЕГО, и человек ждал бы решения, которое уже принято.
         */
        expect((await requestRow(pair.requestId)).office_equipment_id).toBeNull();

        const entry = decisionEntry(await history(pair.requestId, 'author'));
        expect(entry.comment).toBe(`Сообщение о технике отклонено: ${reason}`);
        // Та же строка у проверяющего: аудитории режут ЦИФРЫ ленты, а не решение по предмету.
        expect(decisionEntry(await history(pair.requestId, 'reviewer')).comment).toBe(
          entry.comment,
        );
      });

      it('до решения строки нет: лента не рассказывает о том, чего не случилось', async () => {
        // Отрицательный контроль ко всему разделу: событие пишет решение, а не заведение пары.
        const pair = await makePair({ tag: 'H4' });
        const entries = await history(pair.requestId, 'author');
        expect(entries.some((e) => e.kind === 'equipmentCandidateDecided')).toBe(false);
        // Сама заявка в ленте при этом есть — иначе утверждение выше зеленело бы на пустом ответе.
        expect(entries.some((e) => e.kind === 'created')).toBe(true);
      });
    });

    // ── 10. Блок сообщения в карточке заявки и отбор списка ──

    /**
     * ЗАЯВКА РАССКАЗЫВАЕТ О СВОЁМ ПРЕДМЕТЕ САМА (план кандидатов, Р5, Р15, §9).
     *
     * Раздел закрывает вторую половину пары «очередь ↔ заявка»: решения выше проверялись со стороны
     * кандидата, здесь — со стороны того, кто заявку открыл. Утверждения выбраны по цене ошибки:
     *
     *   · блок ВИДЕН АВТОРУ — а он читатель без `officeEquipment.read` и с аудиторией `requester`,
     *     то есть разом закрывает оба способа его случайно погасить: гейт по праву справочника
     *     (которым закрыт соседний `warrantyUntil`) и проекцию по аудитории. Погасни блок, экран не
     *     сломается — заявка покажется как «без предмета», и неправду эту заметить нечем;
     *   · СОСТАВ ПОЛЕЙ ровно шесть: очередь проверки живёт своей областью (Р9), и приехавшие в
     *     заявку версия, автор или комментарий отдали бы её всякому, кто заявку видит;
     *   · у заявки БЕЗ кандидата поле `null`, а не отсутствует: сервер отвечает одним написанием
     *     пустоты, необязательность типа оставлена окну между выкатами портала и сервера;
     *   · ПРИЧИНА ОТКАЗА доходит дословно — за ней автор в карточку и приходит (Р15, В5);
     *   · ОТБОР СПИСКА берёт ровно два состояния и считает то же, что показывает: условие стоит
     *     подзапросом `EXISTS`, потому что читателей у него три — страница, счётчик и «Отметить все
     *     прочитанными», — и соединения с кандидатом нет у двух из трёх.
     */
    describe('предмет заявки: блок в карточке и отбор списка', () => {
      it('автору виден целиком — шесть полей и ни одного лишнего', async () => {
        const pair = await makePair({ tag: 'D1' });
        const dto = await requestDto(pair.requestId, 'author');

        // Карточки парка у такой заявки нет: предмет называет само сообщение (Р5). Пустой
        // `equipment` при непустом блоке — законное состояние, а не потеря снимка.
        expect(dto.equipment).toBeNull();
        expect(dto.equipmentCandidate).toEqual({
          id: pair.candidateId,
          status: 'pending',
          declaredModel: 'Kyocera D1',
          serialNumber: pair.serialNumber,
          inventoryNumber: pair.inventoryNumber,
          decisionReason: '',
        });
        /*
         * Состав — утверждением по КЛЮЧАМ, а не «есть нужные поля»: лишнее поле блока (версия,
         * автор, площадка, комментарий) — это кусок области очереди проверки, уехавший всякому,
         * кто видит заявку, и проверка «нужное на месте» его бы не заметила.
         */
        expect(Object.keys(dto.equipmentCandidate!).sort()).toEqual([
          'decisionReason',
          'declaredModel',
          'id',
          'inventoryNumber',
          'serialNumber',
          'status',
        ]);
        // Автор — читатель без права справочника и с урезанной аудиторией: блок пережил обоих.
        expect(dto.audience).toBe('requester');
      });

      it('обычная заявка отвечает null, а не отсутствием поля', async () => {
        const plain = await makePlainRequest('D2');
        const dto = await requestDto(plain.id, 'author');
        // `in` проверяет именно НАПИСАНИЕ пустоты: сервер обязан отдавать одно, и отсутствие ключа
        // означало бы второе имя того же состояния — то самое, ради чего поле и объявлено `?`.
        expect('equipmentCandidate' in dto).toBe(true);
        expect(dto.equipmentCandidate).toBeNull();
      });

      it('причина отказа приезжает автору дословно', async () => {
        const pair = await makePair({ tag: 'D3' });
        const reason = 'В кабинете 214 стоит другой аппарат, инвентарный номер не совпал';
        const res = await decide('reject', 'reviewer', pair.candidateId, {
          expectedVersion: 1,
          reason,
        });
        expect(res.statusCode, res.body).toBe(200);

        const dto = await requestDto(pair.requestId, 'author');
        expect(dto.equipmentCandidate?.status).toBe('rejected');
        // Дословно, а не «решение принято, подробности в портале»: за причиной человек и пришёл.
        expect(dto.equipmentCandidate?.decisionReason).toBe(reason);
        // Предмета у заявки по-прежнему нет — отказ её не трогает (Р16), — и подпись предмета
        // держится на блоке: обнулись он вместе с решением, карточка стала бы «без аппарата».
        expect(dto.equipment).toBeNull();
        expect(dto.equipmentCandidate?.declaredModel).toBe('Kyocera D3');
      });

      it('после подтверждения рядом с блоком появляется карточка парка', async () => {
        const pair = await makePair({ tag: 'D4' });
        const res = await decide('confirm', 'reviewer', pair.candidateId, confirmBody(pair));
        expect(res.statusCode, res.body).toBe(200);

        const dto = await requestDto(pair.requestId, 'author');
        // Блок ОСТАЁТСЯ: заявка помнит, что предмет пришёл проверкой (Р4), — и по нему портал
        // снимает замок приёмки, не спрашивая справочник.
        expect(dto.equipmentCandidate?.status).toBe('confirmed');
        expect(dto.equipment?.serialNumber).toBe(pair.serialNumber);
        /*
         * Срок гарантии автору не приходит — у него нет `officeEquipment.read` (решение владельца
         * 04.09.2026). Утверждение стоит здесь намеренно: оно доказывает, что гейт справочника
         * ЖИВ и что блок кандидата рядом с ним открыт не по недосмотру, а решением.
         */
        expect(dto.equipment?.warrantyUntil).toBeNull();
      });

      it('отбор «на проверке» берёт ожидающих, решённых не берёт, и счёт сходится с выдачей', async () => {
        const waiting = await makePair({ tag: 'D5' });
        const decided = await makePair({ tag: 'D6' });
        const plain = await makePlainRequest('D7');
        const res = await decide('reject', 'reviewer', decided.candidateId, {
          expectedVersion: 1,
          reason: 'Такого аппарата в кабинете нет',
        });
        expect(res.statusCode, res.body).toBe(200);

        const page = await listRequests('author', 'candidateStatus=pending');
        const ids = page.items.map((row) => row.id);
        expect(ids).toContain(waiting.requestId);
        expect(ids).not.toContain(decided.requestId);
        // Заявка без кандидата в отборе состояния предмета не участвует вовсе — иначе «на
        // проверке» означало бы «всё, кроме подтверждённого».
        expect(ids).not.toContain(plain.id);
        /*
         * Счёт и выдача считаются РАЗНЫМИ запросами, и соединения с кандидатом у счётчика нет.
         * Разойдись они, человек прочитал бы «показано 3 из 7» и решил бы, что список что-то
         * прячет; условие по колонке кандидата вместо `EXISTS` уронило бы счётчик вовсе.
         */
        expect(page.total).toBe(page.items.length);
        // И блок у каждой отобранной строки на месте: отбор берёт из того же источника, что и
        // подпись предмета, а не из второго признака рядом.
        expect(page.items.every((row) => row.equipmentCandidate?.status === 'pending')).toBe(true);
      });

      it('отбор «отклонён» берёт только отказ', async () => {
        const waiting = await makePair({ tag: 'D8' });
        const rejected = await makePair({ tag: 'D9' });
        const res = await decide('reject', 'reviewer', rejected.candidateId, {
          expectedVersion: 1,
          reason: 'Сообщение недостоверно',
        });
        expect(res.statusCode, res.body).toBe(200);

        const page = await listRequests('author', 'candidateStatus=rejected');
        const ids = page.items.map((row) => row.id);
        expect(ids).toContain(rejected.requestId);
        expect(ids).not.toContain(waiting.requestId);
        expect(page.total).toBe(page.items.length);
        expect(page.items.every((row) => row.equipmentCandidate?.status === 'rejected')).toBe(true);
      });

      it('без отбора видны обе заявки: пустой параметр — не «любое из двух»', async () => {
        // Отрицательный контроль ко всему разделу: без него оба утверждения выше зеленели бы и на
        // сервере, который просто не показывает автору заявок с решённым кандидатом.
        const page = await listRequests('author', 'mine=true');
        const withCandidate = page.items.filter((row) => row.equipmentCandidate);
        expect(withCandidate.some((row) => row.equipmentCandidate!.status === 'pending')).toBe(
          true,
        );
        expect(withCandidate.some((row) => row.equipmentCandidate!.status === 'rejected')).toBe(
          true,
        );
      });

      it('тот же отбор принимает «Отметить все прочитанными» — третий читатель условия', async () => {
        /*
         * Кнопка гасит РОВНО то, что человек видит на экране, и разбирает тело той же схемой
         * списка. Свой запрос она строит сама, и соединения с кандидатом в нём нет: условие,
         * написанное колонкой вместо `EXISTS`, ответило бы здесь 500 «missing FROM-clause entry» —
         * причём только после того, как кто-нибудь выберет этот отбор и нажмёт кнопку.
         */
        const res = await inject('POST', `${REQUESTS}/messages/read-all`, ctx.users.author.auth, {
          candidateStatus: 'pending',
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(typeof (res.json() as { count: number }).count).toBe('number');
      });
    });
  },
);
