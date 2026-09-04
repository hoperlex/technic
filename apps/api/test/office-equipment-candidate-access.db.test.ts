import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficeEquipmentCandidateDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * ВИДИМОСТЬ СООБЩЕНИЯ ОБ ОТСУТСТВУЮЩЕЙ ТЕХНИКЕ — ТРИ ОСНОВАНИЯ И НИ ОДНОГО ЧЕТВЁРТОГО (план
 * `docs/office-equipment-candidate-plan.md`, Р9, Р12; ручки Э3).
 *
 * ЧТО ИМЕННО ДОКАЗЫВАЕТСЯ. Кандидат — не запись справочника (Р1), и его область считается не тем,
 * чем область парка: у него две оси сразу — площадка аппарата и снимок подразделения автора, — а
 * основания «у меня есть `officeEquipment.read`» нет вовсе. Последнее и есть главное утверждение
 * файла: чтение парка открыто почти каждой роли портала, и построй мы видимость на нём, сообщение
 * видели бы все. Проверяется это не чтением предиката, а его следствиями:
 *
 *   · `own` — автор видит СВОЁ сообщение и после того, как его перевели на другой объект: он
 *     свидетель, а не держатель площадки;
 *   · `related` — назначенный поимённо исполнитель видит предмет заявки, которую и так читает, но
 *     очередь проверки ему не открывается;
 *   · `review` — держатель права видит очередь СВОЕЙ области: объектная роль по площадке,
 *     отдельская по подразделению автора, роль без оси — всю компанию;
 *   · чужое — 404, а не 403 (§8): о существовании чужого сообщения знать не нужно, а 403 сам по
 *     себе сообщал бы, что такое сообщение есть.
 *
 * ЗАЧЕМ БАЗА, А НЕ МОКИ. Утверждение здесь — не «функция вернула SQL», а «эти строки видно, а эти
 * нет». Основание `related` целиком живёт коррелированным `EXISTS` по таблице заявок, третья ось
 * заявки (поимённое назначение) — вторым `EXISTS` внутри него, а очередь спрашивается тем же
 * запросом с пагинацией: подменить любую из трёх величин моком значило бы проверить собственную
 * подмену. Тот же поход в базу доказывает и правку (Р12) — условную запись с `ROW_COUNT = 1`,
 * которую без второго конкурента и без живой версии строки не воспроизвести.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: половина утверждений здесь — про ОТСУТСТВИЕ строк
 * («в очереди чужой площадки ноль сообщений»), и чужой прогон в тех же таблицах сделал бы их
 * ложными. База заводится, мигрируется с нуля и сносится в `afterAll` (образец —
 * `service-request-inactive-equipment.db.test.ts`).
 *
 * ПАРЫ «КАНДИДАТ + ЗАЯВКА» ЗАВОДЯТСЯ ПРЯМЫМ SQL, а не ручкой заведения заявки, и это сознательно.
 * Ручка (`POST /service-requests` с `equipmentCandidate`) — предмет соседнего этапа, и повесив на
 * неё фикстуры, файл проверял бы её приём и её же рубежи дублей вместо видимости: любая её правка
 * красила бы этот прогон, ничего не сообщая про Р9. Прямой вставке при этом доступны состояния,
 * которых транзакция заведения не производит, — ими и разделяются основания, которые иначе всегда
 * срабатывают вместе (см. `D2` ниже).
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/office-equipment-candidate-access.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_oe_candidate_access_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-candidate-access-password-123';
const CANDIDATES = '/api/v1/office-equipment-candidates';

/** Отказ «не найдено» дословно: по тексту видно, что 404 пришёл от области, а не от опечатки в id. */
const NOT_FOUND = 'Сообщение о технике не найдено';

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
  users: Record<UserTag, TestUser>;
  candidates: Record<CandidateTag, string>;
}

/**
 * Действующие лица. Имена читаются как утверждения файла: каждое отвечает ровно за одно основание
 * либо за его отсутствие.
 */
type UserTag =
  | 'admin'
  /** Автор `A1`, роль площадки на объекте A: у него `serviceRequests.read` от роли и ни грамма `review`. */
  | 'author'
  /** Автор `A3`, переведённый на объект C: его сообщение держится ТОЛЬКО основанием `own`. */
  | 'authorMoved'
  /** Автор `D1` и `D2`, роль отдела: его подразделение и есть отдельская ось проверяющего. */
  | 'authorDept'
  /** Автор `B1` на объекте B: он же «чужой» для всех проверок площадки A. */
  | 'stranger'
  /** Назначен поимённо на заявку `A1`, сам работает на объекте C: чистое основание `related`. */
  | 'executor'
  /** Проверяющий площадки A. */
  | 'reviewerA'
  /** Проверяющий площадки B: его очередь не должна содержать ни одной строки площадки A. */
  | 'reviewerB'
  /** Проверяющий отдела D: его ось — снимок подразделения автора, а не площадка. */
  | 'reviewerDept'
  /** Централизованный проверяющий без оси: очередь всей компании (Р8, «у очереди есть адресат»). */
  | 'reviewerCentral';

/**
 * Сообщения прогона. Пять из шести — то, что производит обычное заведение; шестое (`D2`) собрано
 * руками (см. `beforeAll`).
 */
type CandidateTag = 'A1' | 'A2' | 'A3' | 'B1' | 'D1' | 'D2';

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

function card(who: UserTag, candidate: CandidateTag) {
  return inject('GET', `${CANDIDATES}/${ctx.candidates[candidate]}`, ctx.users[who].auth);
}

function queue(who: UserTag, query = '?status=pending') {
  return inject('GET', `${CANDIDATES}${query}`, ctx.users[who].auth);
}

/** Идентификаторы страницы очереди в порядке выдачи: сам порядок — часть утверждения (старые сверху). */
async function queueIds(who: UserTag, query?: string): Promise<CandidateTag[]> {
  const res = await queue(who, query);
  expect(res.statusCode, res.body).toBe(200);
  const items = (res.json() as { items: OfficeEquipmentCandidateDto[] }).items;
  const byId = new Map(
    (Object.entries(ctx.candidates) as [CandidateTag, string][]).map(([tag, id]) => [id, tag]),
  );
  return items.map((item) => byId.get(item.id) ?? (`??${item.id}` as CandidateTag));
}

/** Полное тело правки: схема требует все шесть реквизитов сразу, разницей их не присылают (Р12). */
function editBody(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    expectedVersion: 1,
    equipmentTypeId: TYPE_ID,
    declaredModel: 'Kyocera ECOSYS M3145',
    serialNumber: 'SN-A1-CORRECTED',
    inventoryNumber: '0012345',
    objectId: OBJECT_A,
    location: 'каб. 214',
    comment: '',
    ...extra,
  };
}

/*
 * Идентификаторы справочников заполняются в `beforeAll` и читаются телом правки: держать их в
 * контексте значило бы таскать `ctx` в каждый вызов ради двух неизменных значений.
 */
let TYPE_ID = '';
let OBJECT_A = '';
let OBJECT_B = '';

describe.skipIf(!DB_URL)('видимость сообщения о технике: три основания Р9', () => {
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
        VALUES (${`CA-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const objectA = await object('A');
    const objectB = await object('B');
    const objectC = await object('C');
    OBJECT_A = objectA;
    OBJECT_B = objectB;

    const departmentRow = await db.execute<{ id: string }>(sql`
      INSERT INTO departments (code, name)
      VALUES (${`CD-${RUN}`}, ${`Отдел D ${RUN}`})
      RETURNING id`);
    const departmentD = departmentRow.rows[0]!.id;

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    TYPE_ID = typeRow.rows[0]?.id ?? '';
    if (!TYPE_ID) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-oeca-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const raw = {
      admin: await makeUser('admin', 'admin'),
      author: await makeUser('author', 'shtab'),
      authorMoved: await makeUser('moved', 'shtab'),
      authorDept: await makeUser('authdept', 'department'),
      stranger: await makeUser('stranger', 'shtab'),
      executor: await makeUser('executor', 'shtab'),
      reviewerA: await makeUser('reva', 'shtab'),
      reviewerB: await makeUser('revb', 'shtab'),
      reviewerDept: await makeUser('revdept', 'department'),
      reviewerCentral: await makeUser('revcentral', 'manager'),
    } satisfies Record<UserTag, { id: string; email: string }>;

    const atObject = async (userId: string, objectId: string): Promise<void> => {
      await db.execute(sql`
        INSERT INTO user_construction_objects (user_id, construction_object_id)
        VALUES (${userId}, ${objectId})`);
    };
    await atObject(raw.author.id, objectA);
    await atObject(raw.reviewerA.id, objectA);
    await atObject(raw.stranger.id, objectB);
    await atObject(raw.reviewerB.id, objectB);
    // Автор `A3` и назначенный исполнитель служат на объекте C: ни площадка сообщения, ни площадка
    // его заявки к ним не относится — иначе их основания невозможно было бы отличить от роли.
    await atObject(raw.authorMoved.id, objectC);
    await atObject(raw.executor.id, objectC);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id)
      VALUES (${raw.authorDept.id}, ${departmentD}), (${raw.reviewerDept.id}, ${departmentD})`);

    /**
     * Наборы прогона — СВОИМИ кодами, а не системными. `office_equipment_operator` собрал бы
     * проверяющего одной строкой, но вместе с правом принёс бы и весь состав системного набора: файл
     * проверял бы тогда не предикат, а то, что кому-то выдали «Ведение». Свой набор называет ровно
     * те права, на которых стоит утверждение, — и `officeEquipment.write` рядом с `review` здесь не
     * украшение, а требование `PERMISSION_REQUIRES` (Р8), выраженное составом.
     */
    const makeGrant = async (
      code: string,
      permissions: string[],
      roles: string[],
      holderIds: string[],
    ): Promise<void> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO grants (code, name, description, is_system, created_by)
        VALUES (${code}, ${`Набор прогона ${code}`}, 'Видимость кандидатов (план Р9)', false,
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
      `oeca-review-${RUN}`,
      ['officeEquipment.read', 'officeEquipment.write', 'officeEquipment.review'],
      ['shtab', 'department', 'manager'],
      [raw.reviewerA.id, raw.reviewerB.id, raw.reviewerDept.id, raw.reviewerCentral.id],
    );
    // Централизованному проверяющему роль `manager` чтения заявок не даёт: без него он получил бы
    // 403 от стража карточки ещё до предиката, и утверждение «очередь всей компании» проверялось бы
    // наполовину.
    await makeGrant(
      `oeca-read-${RUN}`,
      ['serviceRequests.read'],
      ['manager'],
      [raw.reviewerCentral.id],
    );
    // Внутренний исполнитель: право «выполнять работу» плюс поимённое назначение ниже. Ровно эта
    // пара и открывает ему третью ось видимости заявки, а через неё — основание `related`.
    await makeGrant(
      `oeca-exec-${RUN}`,
      ['serviceRequests.read', 'serviceRequests.execute'],
      ['shtab'],
      [raw.executor.id],
    );

    /**
     * Пара «кандидат + заявка» одной вставкой на каждую строку прогона.
     *
     * `requestAuthorId` отдельным параметром нужен ровно одному сообщению — `D2`, — и вот зачем.
     * У объектных ролей основания `review` и `related` совпадают ПО ПОСТРОЕНИЮ: площадка кандидата
     * и площадка его заявки — одно и то же значение (Р5), и отличить «вижу как проверяющий» от
     * «вижу как участник заявки» на них нечем. Разводятся они только на отдельской оси, где
     * кандидат меряется подразделением АВТОРА, а заявка — отделом-заказчиком. `D2` и есть эта пара:
     * сообщение отдела D о технике на чужой площадке, заявка которого отделу D не принадлежит. В
     * бою транзакция заведения такого не производит (автор у пары один), и собрано оно здесь
     * нарочно — иначе третье основание проверялось бы только вместе со вторым и молча держалось бы
     * на нём.
     */
    const makePair = async (opts: {
      authorId: string;
      objectId: string;
      departmentId: string | null;
      tag: string;
      status?: 'pending' | 'rejected';
      requestAuthorId?: string;
      requestDepartmentId?: string | null;
    }): Promise<string> => {
      const decided = opts.status === 'rejected';
      const candidateRow = await db.execute<{ id: string }>(sql`
        INSERT INTO office_equipment_candidates (
          status, equipment_type_id, declared_model, serial_number, inventory_number,
          object_id, location, comment, requester_department_id, created_by,
          idempotency_key, idempotency_fingerprint,
          decided_by, decided_at, decision_reason)
        VALUES (
          ${opts.status ?? 'pending'}, ${TYPE_ID}, ${`Kyocera ${opts.tag}`},
          ${`SN-${opts.tag}-${RUN}`}, ${`INV-${opts.tag}-${RUN}`},
          ${opts.objectId}, ${`каб. ${opts.tag}`}, '', ${opts.departmentId}, ${opts.authorId},
          ${randomUUID()}, ${`fingerprint-${opts.tag}-${RUN}`},
          ${decided ? raw.admin.id : null}, ${decided ? sql`now()` : null},
          ${decided ? 'аппарата в названном месте нет' : ''})
        RETURNING id`);
      const candidateId = candidateRow.rows[0]!.id;
      await db.execute(sql`
        INSERT INTO service_requests (
          equipment_candidate_id, equipment_object_id, customer_department_id,
          equipment_name, equipment_serial_number, equipment_inventory_number, equipment_location,
          description, responsible_name, created_by)
        VALUES (
          ${candidateId}, ${opts.objectId},
          ${opts.requestDepartmentId === undefined ? opts.departmentId : opts.requestDepartmentId},
          ${`Kyocera ${opts.tag}`}, ${`SN-${opts.tag}-${RUN}`}, ${`INV-${opts.tag}-${RUN}`},
          ${`каб. ${opts.tag}`}, 'Не печатает, зажёвывает бумагу', 'Иванов Иван Иванович',
          ${opts.requestAuthorId ?? opts.authorId})`);
      return candidateId;
    };

    const candidates: Record<CandidateTag, string> = {
      A1: await makePair({
        authorId: raw.author.id,
        objectId: objectA,
        departmentId: null,
        tag: 'A1',
      }),
      A2: await makePair({
        authorId: raw.author.id,
        objectId: objectA,
        departmentId: null,
        tag: 'A2',
        status: 'rejected',
      }),
      A3: await makePair({
        authorId: raw.authorMoved.id,
        objectId: objectA,
        departmentId: null,
        tag: 'A3',
      }),
      B1: await makePair({
        authorId: raw.stranger.id,
        objectId: objectB,
        departmentId: null,
        tag: 'B1',
      }),
      D1: await makePair({
        authorId: raw.authorDept.id,
        objectId: objectA,
        departmentId: departmentD,
        tag: 'D1',
      }),
      D2: await makePair({
        authorId: raw.authorDept.id,
        objectId: objectB,
        departmentId: departmentD,
        tag: 'D2',
        requestAuthorId: raw.stranger.id,
        requestDepartmentId: null,
      }),
    };

    // Поимённое назначение на заявку `A1`: третья ось видимости заявки, а через неё — `related`.
    await db.execute(sql`
      INSERT INTO service_request_executors (request_id, user_id, assigned_by)
      SELECT sr.id, ${raw.executor.id}, ${raw.admin.id}
        FROM service_requests sr
       WHERE sr.equipment_candidate_id = ${candidates.A1}`);

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

    ctx = { app, db, closeDb, users, candidates };
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

  // ── 1. Основание `own`: автор ──

  describe('автор', () => {
    it('видит своё сообщение и не видит чужого', async () => {
      const own = await card('author', 'A1');
      expect(own.statusCode, own.body).toBe(200);
      expect((own.json() as OfficeEquipmentCandidateDto).id).toBe(ctx.candidates.A1);

      const foreign = await card('author', 'B1');
      // 404, а не 403: право читать заявки у него есть — не существует для него именно этой строки.
      expect(foreign.statusCode, foreign.body).toBe(404);
      expect((foreign.json() as { message: string }).message).toBe(NOT_FOUND);
    });

    it('видит своё и после перевода на другой объект — основание `own` стоит само по себе', async () => {
      // Автор `A3` служит на объекте C: ни площадка сообщения, ни площадка его заявки к нему больше
      // не относятся, и держит видимость только «это моё свидетельство».
      const own = await card('authorMoved', 'A3');
      expect(own.statusCode, own.body).toBe(200);

      // А чужое сообщение той же площадки ему не видно — значит `own` именно поимённое, а не
      // «сообщения объекта, где я когда-то работал».
      const foreign = await card('authorMoved', 'A1');
      expect(foreign.statusCode, foreign.body).toBe(404);
    });

    it('в очередь проверки не попадает вовсе — 403 от стража', async () => {
      const res = await queue('author');
      // Здесь именно 403: очередь закрыта ПРАВОМ, и о её существовании автор знать может — он
      // просто не проверяющий. Область к этому отказу отношения не имеет.
      expect(res.statusCode, res.body).toBe(403);
    });

    it('блока автора в своей карточке не получает — ФИО отдаётся только проверяющему', async () => {
      const res = await card('author', 'A1');
      expect(res.statusCode, res.body).toBe(200);
      // Отсутствие поля означает «этот срез ответа такого не содержит», а не «автор неизвестен».
      expect(res.json()).not.toHaveProperty('author');
    });
  });

  // ── 2. Основание `related`: видимая заявка ──

  describe('назначенный исполнитель', () => {
    it('видит предмет своей заявки, хоть служит на другом объекте', async () => {
      const res = await card('executor', 'A1');
      expect(res.statusCode, res.body).toBe(200);
      const dto = res.json() as OfficeEquipmentCandidateDto;
      expect(dto.id).toBe(ctx.candidates.A1);
      // Ссылка на заявку у него заполнена: он её и читает — именно через неё он сюда и попал.
      expect(dto.request?.displayNumber).toMatch(/^СО-\d+$/);
    });

    it('соседнее сообщение той же площадки ему не видно', async () => {
      // `A3` стоит на том же объекте A, что и `A1`, но исполнителем по её заявке он не назначен —
      // значит видимость дала именно строка назначения, а не площадка и не право `execute`.
      const res = await card('executor', 'A3');
      expect(res.statusCode, res.body).toBe(404);
    });

    it('очередь проверки ему не открывается', async () => {
      const res = await queue('executor');
      expect(res.statusCode, res.body).toBe(403);
    });
  });

  // ── 3. Основание `review`: очередь своей области ──

  describe('очередь проверяющего', () => {
    it('объектная ось: площадка A видит свои сообщения и ни одного чужого', async () => {
      // Порядок — часть утверждения: старые сверху, иначе сообщение, до которого не дошли руки в
      // первый день, не дождалось бы проверки никогда.
      expect(await queueIds('reviewerA')).toEqual(['A1', 'A3', 'D1']);
    });

    it('объектная ось: площадка B видит свои и ноль строк площадки A', async () => {
      expect(await queueIds('reviewerB')).toEqual(['B1', 'D2']);
    });

    it('отдельская ось считается подразделением автора, а не площадкой', async () => {
      // `D1` стоит на площадке A, `D2` — на площадке B, и обе видны отделу D: осью здесь работает
      // снимок подразделения автора. Сообщения без подразделения (`A1`, `A3`, `B1`) не видны ни
      // одному отделу — «пусто» здесь значит «у автора отделов нет», а не «ничьё».
      expect(await queueIds('reviewerDept')).toEqual(['D1', 'D2']);
    });

    it('роль без оси разбирает очередь всей компании', async () => {
      expect(await queueIds('reviewerCentral')).toEqual(['A1', 'A3', 'B1', 'D1', 'D2']);
    });

    it('отбор по состоянию: решённое сообщение видно только без отбора «ожидающие»', async () => {
      expect(await queueIds('reviewerA', '')).toEqual(['A1', 'A2', 'A3', 'D1']);
      expect(await queueIds('reviewerA', '?status=rejected')).toEqual(['A2']);
    });

    it('страница считает только свои строки: total не заглядывает в чужую область', async () => {
      const res = await queue('reviewerB');
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { total: number }).total).toBe(2);
    });
  });

  describe('карточка проверяющего', () => {
    it('чужая площадка — 404, а не 403', async () => {
      const res = await card('reviewerB', 'A1');
      expect(res.statusCode, res.body).toBe(404);
      expect((res.json() as { message: string }).message).toBe(NOT_FOUND);
    });

    it('чужой отдел — 404', async () => {
      // У проверяющего отдела D нет ни одного основания на `B1`: не автор, заявка чужого объекта
      // его отделу не принадлежит, подразделение автора пусто.
      const res = await card('reviewerDept', 'B1');
      expect(res.statusCode, res.body).toBe(404);
    });

    it('основание `review` работает и там, где заявка смотрящему не видна', async () => {
      const res = await card('reviewerDept', 'D2');
      expect(res.statusCode, res.body).toBe(200);
      const dto = res.json() as OfficeEquipmentCandidateDto;
      // Заявка есть всегда (пара 1:1), поэтому `null` здесь читается как «смотрящему не видна» —
      // ровно то состояние, ради которого поле и объявлено пустеющим.
      expect(dto.request).toBeNull();
    });

    it('проверяющему отдаются ФИО автора и снимок его подразделения', async () => {
      const res = await card('reviewerA', 'D1');
      expect(res.statusCode, res.body).toBe(200);
      const dto = res.json() as OfficeEquipmentCandidateDto;
      expect(dto.author?.id).toBe(ctx.users.authorDept.id);
      expect(dto.author?.departmentName).toContain(`Отдел D ${RUN}`);
    });
  });

  // ── 4. Правка реквизитов (Р12) ──

  describe('правка до решения', () => {
    it('автору закрыта — 403 от права, а не 404 от области', async () => {
      const res = await inject(
        'PATCH',
        `${CANDIDATES}/${ctx.candidates.A1}`,
        ctx.users.author.auth,
        editBody({}),
      );
      // Кандидат — свидетельство о том, что человек видел в кабинете; переписанное задним числом
      // свидетельство ничего не доказывает. Уточнения идут репликой в обсуждении заявки.
      expect(res.statusCode, res.body).toBe(403);
    });

    it('проверяющему чужой площадки — 404: чужое сообщение для него не существует', async () => {
      const res = await inject(
        'PATCH',
        `${CANDIDATES}/${ctx.candidates.A1}`,
        ctx.users.reviewerB.auth,
        editBody({}),
      );
      expect(res.statusCode, res.body).toBe(404);
    });

    it('устаревшая версия — 409 со свежим состоянием, а не молчаливое перетирание', async () => {
      const res = await inject(
        'PATCH',
        `${CANDIDATES}/${ctx.candidates.A1}`,
        ctx.users.reviewerA.auth,
        editBody({ expectedVersion: 99 }),
      );
      expect(res.statusCode, res.body).toBe(409);
      const details = (res.json() as { details?: { candidate?: OfficeEquipmentCandidateDto } })
        .details;
      // Свежее состояние целиком, а не один номер версии: иначе окно предложит нажать ту же кнопку.
      expect(details?.candidate?.contentVersion).toBe(1);
    });

    it('решённое сообщение не правится — 409 даже с верной версией', async () => {
      const res = await inject(
        'PATCH',
        `${CANDIDATES}/${ctx.candidates.A2}`,
        ctx.users.reviewerA.auth,
        editBody({ objectId: OBJECT_A }),
      );
      expect(res.statusCode, res.body).toBe(409);
    });

    it('объектному проверяющему чужая площадка в теле — 422, а не тихий переезд', async () => {
      const res = await inject(
        'PATCH',
        `${CANDIDATES}/${ctx.candidates.A1}`,
        ctx.users.reviewerA.auth,
        editBody({ objectId: OBJECT_B }),
      );
      // Переставленная площадка унесла бы строку из его очереди в чужую — тот же выход за область,
      // что и переезд карточки парка на чужой объект, только в другую сторону.
      expect(res.statusCode, res.body).toBe(422);
      expect((res.json() as { fields?: Record<string, string> }).fields).toHaveProperty('objectId');
    });

    it('отдельскому проверяющему площадка не ось — правка площадки ему открыта', async () => {
      const res = await inject(
        'PATCH',
        `${CANDIDATES}/${ctx.candidates.D2}`,
        ctx.users.reviewerDept.auth,
        editBody({
          objectId: OBJECT_A,
          serialNumber: `SN-D2-${RUN}`,
          inventoryNumber: `INV-D2-${RUN}`,
        }),
      );
      // Его очередь считается подразделением автора, а не площадкой: запрет на объект был бы здесь
      // правилом чужой оси, и отдел не смог бы поправить площадку, названную заявителем неверно.
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as OfficeEquipmentCandidateDto).object.id).toBe(OBJECT_A);
    });

    it('несуществующий тип отбивается полем, а не пятисоткой внешнего ключа', async () => {
      const res = await inject(
        'PATCH',
        `${CANDIDATES}/${ctx.candidates.A1}`,
        ctx.users.reviewerA.auth,
        editBody({ equipmentTypeId: '00000000-0000-4000-8000-000000000000' }),
      );
      expect(res.statusCode, res.body).toBe(400);
      expect((res.json() as { fields?: Record<string, string> }).fields).toHaveProperty(
        'equipmentTypeId',
      );
    });

    it('проверяющий своей области правит опечатку, версия растёт, второй заход — 409', async () => {
      const first = await inject(
        'PATCH',
        `${CANDIDATES}/${ctx.candidates.A3}`,
        ctx.users.reviewerA.auth,
        editBody({ serialNumber: `SN-A3-${RUN}-FIXED`, inventoryNumber: `INV-A3-${RUN}` }),
      );
      expect(first.statusCode, first.body).toBe(200);
      const dto = first.json() as OfficeEquipmentCandidateDto;
      expect(dto.serialNumber).toBe(`SN-A3-${RUN}-FIXED`);
      expect(dto.contentVersion).toBe(2);
      expect(dto.updatedByName).toContain('Тестовый');

      // Та же форма, отправленная вторично, — устаревшая: условная запись не находит версию 1.
      const second = await inject(
        'PATCH',
        `${CANDIDATES}/${ctx.candidates.A3}`,
        ctx.users.reviewerA.auth,
        editBody({ serialNumber: `SN-A3-${RUN}-AGAIN`, inventoryNumber: `INV-A3-${RUN}` }),
      );
      expect(second.statusCode, second.body).toBe(409);

      // Дифф в журнале: без него запись отвечала бы «сообщение правили», а правка ради номера и
      // заведена.
      const audit = await ctx.db.execute<{ metadata: { changes?: { field: string }[] } }>(sql`
        SELECT metadata FROM audit_log
         WHERE action = 'officeEquipmentCandidate.update'
           AND entity_id = ${ctx.candidates.A3}`);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.metadata.changes?.map((c) => c.field)).toContain('serialNumber');
    });
  });
});
