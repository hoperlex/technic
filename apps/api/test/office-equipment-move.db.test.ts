import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OFFICE_EQUIPMENT_MOVE_CONFLICT_CODE,
  type EquipmentMovementRowDto,
  type EquipmentMovementsPageDto,
  type MoveOfficeEquipmentSide,
  type OfficeEquipmentDto,
  type OfficeEquipmentMoveConflictDetails,
  type ServiceRequestDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * ПЕРЕМЕЩЕНИЕ ОРГТЕХНИКИ ИЗ КАРТОЧКИ ЗАЯВКИ — серверные случаи §9.1 плана
 * `docs/office-equipment-move-from-request-plan.md` (пункт 12 разбора 02.09.2026).
 *
 * ЗАЧЕМ ФАЙЛ. Ручка `POST /office-equipment/:id/move` за одну волну получила четыре новых свойства,
 * и ни одно из них не проверяется ничем: блокировку строки `FOR UPDATE` (Р4, закрывает Н1), сверку
 * присланного «откуда» (Р3), своё право `officeEquipment.move` (Р1, Р2) и пару «уточнение места в
 * журнале + признак подтверждения заявленного» (Р5, Р8). Все четыре живут не в одной функции: замок
 * держит база, право — реестр доступа, область — предикат справочника, а гашение очереди
 * расхождений считается соединением заявки с карточкой техники. Собранное на моках доказывало бы
 * моки, поэтому здесь живая схема и настоящие ручки.
 *
 * ЧТО ЗАКРЕПЛЕНО — девять групп §9.1:
 *
 *   1. гонка: два перемещения с одним `from` дают одну строку журнала, второе — `409 equipment_moved`;
 *      и отдельно — что блокировка работает САМА, без `from`: цепочка журнала не рвётся (Р3, Р4);
 *   2. разошедшийся `from` объясняет отказ текущим местом, а не «обновите страницу»;
 *   3. область — по ИСХОДНОЙ стороне: чужая площадка `403`, перенос НА чужую `201` (Р10, Н8);
 *   4. право: держатель `.write` без `.move` — `403`, держатель `.move` без `.write` — `201` (Р1);
 *   5. смена одного лишь уточнения места — перемещение, и обе стороны видны в журнале (Р5);
 *   6. смена одного лишь отдела — перемещение; правка карточки тем же отделом строки не пишет (Р13);
 *   7. связанная заявка: архивная — `404`, чужой аппарат — `422`, подтверждение без заявления — `422`;
 *   8. очередь расхождений ИТ-службы после переноса в третье место и обратно (Н6, Р8);
 *   9. перемещение по ЗАКРЫТОЙ заявке принимается (Р6).
 *
 * ГДЕ ТЕСТ РАСХОДИТСЯ С ПЛАНОМ — сказано на месте, в комментарии соответствующего случая, и
 * записано под фактическое поведение сервера, а не под желаемое (см. случаи 7 и 8).
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test` (образец — `service-request-warranty-transitions.db.test.ts`):
 * файл считает СТРОКИ ЖУРНАЛА по единице и заявки в очереди расхождений, а по общей базе идут
 * параллельные прогоны и лежит копия боевого парка. База заводится, мигрируется с нуля и сносится
 * в `afterAll`.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     pnpm --filter @technic/api exec vitest run test/office-equipment-move.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_oe_move_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-oe-move-password-123';
const EQUIPMENT = '/api/v1/office-equipment';
const REQUESTS = '/api/v1/service-requests';

/** День переезда: ручка будущим числом не ограничивает, но фикстуре ходить в будущее незачем. */
const TODAY = new Date().toISOString().slice(0, 10);

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
  /** Администратор: заводит карточки на ЧУЖОЙ площадке — объектной области у него нет. */
  admin: TestUser;
  /**
   * «Оргтехника: ведение» на роли штаба с площадками A и B: у него есть и `.write`, и `.move`, и
   * права модуля заявок — им ведётся основная часть случаев. Область объектная, поэтому площадка C
   * для него чужая.
   */
  operator: TestUser;
  /** Ведение справочника БЕЗ подтверждения перемещения: собранный набор с одним `.write`. */
  writer: TestUser;
  /** Подтверждение перемещения БЕЗ ведения справочника — то самое сужение круга (Р1). */
  mover: TestUser;
  objectA: string;
  objectB: string;
  objectC: string;
  departmentOne: string;
  departmentTwo: string;
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
  // S3 здесь не участвует: файлов ни одна ручка этого файла не трогает.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  // Письма гасятся рубильником: предмет файла — журнал перемещений, а не почтовый контур.
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

/** Карточка единицы. */
async function card(id: string, auth: Auth = ctx.operator.auth): Promise<OfficeEquipmentDto> {
  const res = await inject('GET', `${EQUIPMENT}/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as OfficeEquipmentDto;
}

/**
 * «Откуда, как я это видел» — исходная сторона, снятая с ПОКАЗАННОЙ карточки (Р3). Пять полей, ни
 * одним меньше: сверка сравнивает и пустое уточнение тоже.
 */
function sideOf(dto: OfficeEquipmentDto): MoveOfficeEquipmentSide {
  return {
    objectId: dto.object.id,
    departmentId: dto.department?.id ?? null,
    location: dto.location,
    state: dto.state,
    stateNote: dto.stateNote,
  };
}

/** Журнал перемещений единицы — тот же блок «Перемещения», которым его читает портал. */
async function movements(
  id: string,
  auth: Auth = ctx.operator.auth,
): Promise<EquipmentMovementRowDto[]> {
  const res = await inject('GET', `${EQUIPMENT}/${id}/movements?pageSize=100`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as EquipmentMovementsPageDto).items;
}

/** Своя единица на каждый случай: половина случаев меняет её место, и общая карточка их спутала бы. */
let unitNo = 0;
async function makeEquipment(
  tag: string,
  opts: { objectId?: string; auth?: Auth; location?: string } = {},
): Promise<string> {
  unitNo += 1;
  const res = await inject('POST', EQUIPMENT, opts.auth ?? ctx.operator.auth, {
    equipmentTypeId: ctx.typeId,
    name: `Kyocera ECOSYS ${tag} ${RUN}`,
    inventoryNumber: `MV-${RUN}-${unitNo}`,
    objectId: opts.objectId ?? ctx.objectA,
    location: opts.location ?? 'кабинет 101',
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

interface MoveBody {
  from?: MoveOfficeEquipmentSide;
  objectId: string;
  departmentId?: string | null;
  location?: string;
  state?: string;
  stateNote?: string;
  movedOn?: string;
  reason?: string;
  serviceRequestId?: string;
  confirmsDeclaredPlace?: boolean;
}

function move(id: string, body: MoveBody, auth: Auth = ctx.operator.auth) {
  return inject('POST', `${EQUIPMENT}/${id}/move`, auth, {
    movedOn: TODAY,
    reason: 'Проверка перемещения',
    ...body,
  });
}

/** Заявка на ремонт по этой единице; `declaredObjectId` — «аппарат стоит вон там» (Р16 ADR 0145). */
async function createRequest(
  equipmentId: string,
  description: string,
  declaredObjectId?: string,
): Promise<ServiceRequestDto> {
  const res = await inject('POST', REQUESTS, ctx.operator.auth, {
    officeEquipmentId: equipmentId,
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    // Площадка заявителя названа явно: у учётки штаба их две, и подразделение заявки сервер
    // вывести не может (Н11) — он отвечает 422 и просит выбрать.
    requesterObjectId: ctx.objectA,
    ...(declaredObjectId ? { objectOverridden: true, objectId: declaredObjectId } : {}),
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { request: ServiceRequestDto }).request;
}

/** Заявка в очереди расхождений ИТ-службы? Тем же отбором, каким её читает вкладка модуля. */
async function inMismatchQueue(requestId: string): Promise<boolean> {
  const res = await inject(
    'GET',
    `${REQUESTS}?objectMismatch=true&pageSize=200`,
    ctx.operator.auth,
  );
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: ServiceRequestDto[] }).items.some((row) => row.id === requestId);
}

/** Признак расхождения в карточке заявки — «заявили и не устранили», независимо от статуса. */
async function requestMismatch(requestId: string): Promise<boolean> {
  const res = await inject('GET', `${REQUESTS}/${requestId}`, ctx.operator.auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as ServiceRequestDto).objectMismatch;
}

describe.skipIf(!DB_URL)('перемещение оргтехники из карточки заявки (§9.1 плана)', () => {
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

    const makeObject = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`MV-${tag}-${RUN}`}, ${`Площадка ${tag} ${RUN}`}, 'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const objectA = await makeObject('A');
    const objectB = await makeObject('B');
    const objectC = await makeObject('C');

    const makeDepartment = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO departments (code, name)
        VALUES (${`MVD-${tag}-${RUN}`}, ${`Отдел ${tag} ${RUN}`})
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const departmentOne = await makeDepartment('1');
    const departmentTwo = await makeDepartment('2');

    const counterparty = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${`Сервис-Переезд ${RUN}`},
              ${String(Date.now()).slice(-10)})
      RETURNING id`);
    const serviceCounterpartyId = counterparty.rows[0]!.id;

    /*
     * Учётки — прямым SQL: форма учётки предмет своего теста, а здесь она декорация, без которой
     * не разложить четыре стороны доступа.
     */
    async function makeUser(
      tag: string,
      role: string,
      objectIds: string[] = [],
    ): Promise<{ id: string; email: string }> {
      const email = `db-mv-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      const id = res.rows[0]!.id;
      for (const objectId of objectIds) {
        await db.execute(sql`
          INSERT INTO user_construction_objects (user_id, construction_object_id)
          VALUES (${id}, ${objectId})`);
      }
      return { id, email };
    }

    const adminUser = await makeUser('admin', 'admin');
    const operatorUser = await makeUser('oper', 'shtab', [objectA, objectB]);
    const writerUser = await makeUser('writer', 'shtab', [objectA]);
    const moverUser = await makeUser('mover', 'shtab', [objectA]);

    /*
     * Надстройка «Оргтехника: ведение» — сервисом, а не прямой вставкой: с шага 1a перехода на
     * назначаемые полномочия (ADR 0106) выдача пишет две таблицы одной транзакцией.
     */
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operatorUser.id, ['office_equipment_operator'], adminUser.id);
    });

    /*
     * СОБРАННЫЙ АДМИНИСТРАТОРОМ НАБОР — единственный способ развести `.write` и `.move` поимённо:
     * системные наборы несут оба права разом (Р2), а роли штаба перемещение не даёт вовсе. Набор
     * заводится прямым SQL по той же причине, что и учётки: предмет здесь — маршрут, а не витрина
     * полномочий, у которой свой файл (`grants-routes.db.test.ts`).
     *
     * `grant_roles` обязателен: права набора считаются соединением с ним по роли держателя
     * (`grantPermissionsExpr`), и без строки набор виден, а прав не даёт — это гейт совместимости,
     * а не оптимизация.
     */
    async function grantWith(code: string, userId: string, permissions: string[]): Promise<void> {
      const grant = await db.execute<{ id: string }>(sql`
        INSERT INTO grants (code, name, is_system)
        VALUES (${`${code}_${RUN}`}, ${`Набор ${code} ${RUN}`}, false)
        RETURNING id`);
      const grantId = grant.rows[0]!.id;
      await db.execute(sql`
        INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'shtab'::role)`);
      for (const permission of permissions) {
        await db.execute(sql`
          INSERT INTO grant_permissions (grant_id, permission) VALUES (${grantId}, ${permission})`);
      }
      await db.execute(sql`
        INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
        VALUES (${userId}, ${grantId}, ${adminUser.id}, 'manual')`);
    }
    // Чтение справочника роль штаба даёт сама, поэтому в наборе стоит ровно спорное право.
    await grantWith('write_only', writerUser.id, ['officeEquipment.write']);
    await grantWith('move_only', moverUser.id, ['officeEquipment.move']);

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

    ctx = {
      app,
      db,
      closeDb,
      admin: await withAuth(adminUser),
      operator: await withAuth(operatorUser),
      writer: await withAuth(writerUser),
      mover: await withAuth(moverUser),
      objectA,
      objectB,
      objectC,
      departmentOne,
      departmentTwo,
      serviceCounterpartyId,
      typeId,
    };
  }, 300_000);

  afterAll(async () => {
    // База своя — уносим её целиком: чужих строк в ней нет по построению.
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

  // ── 1. Гонка двух перемещений (Р3, Р4, закрывает Н1) ──

  describe('гонка', () => {
    it('два перемещения с одинаковым «откуда»: одна строка журнала, второму — 409', async () => {
      /*
       * Главный случай плана. Два человека открыли окно на одной и той же карточке и нажали
       * «Записать» почти одновременно. Без блокировки оба прочитали бы «откуда = A», и в журнале
       * остались бы `A → B` и `A → C` при карточке в `C`: вопрос «где аппарат стоял в мае» получил
       * бы два ответа. Замок сериализует записи, а сверка `from` объясняет отказ словами.
       */
      const id = await makeEquipment('race');
      const from = sideOf(await card(id));

      const targets = [
        { objectId: ctx.objectB, location: 'кабинет 202', reason: 'Переезд первый' },
        { objectId: ctx.objectC, location: 'кабинет 303', reason: 'Переезд второй' },
      ];
      const results = await Promise.all(targets.map((target) => move(id, { from, ...target })));

      const codes = results.map((res) => res.statusCode).sort();
      expect(codes, results.map((r) => r.body).join('\n')).toEqual([201, 409]);

      const winner = targets[results.findIndex((res) => res.statusCode === 201)]!;
      const loser = results.find((res) => res.statusCode === 409)!;

      // Отказ называет МЕСТО, а не номер версии: своим кодом, потому что исход у него другой —
      // перечитать карточку и решить заново.
      const body = loser.json() as {
        code: string;
        message: string;
        details: OfficeEquipmentMoveConflictDetails;
      };
      expect(body.code).toBe(OFFICE_EQUIPMENT_MOVE_CONFLICT_CODE);
      expect(body.message).toContain('уже переехала');
      expect(body.details.current.objectId).toBe(winner.objectId);
      expect(body.details.current.location).toBe(winner.location);
      // Название площадки с кодом: «объект 7f3c…» не отвечает на вопрос, ради которого отказ и
      // объясняют.
      expect(body.details.current.objectName).toContain('MV-');

      // Журнал не разветвился, карточка — в состоянии победителя.
      const journal = await movements(id, ctx.admin.auth);
      expect(journal).toHaveLength(1);
      expect(journal[0]!.toObject.id).toBe(winner.objectId);
      const after = await card(id, ctx.admin.auth);
      expect(after.object.id).toBe(winner.objectId);
      expect(after.location).toBe(winner.location);
    });

    it('без «откуда» цепочка журнала всё равно не рвётся: второе перемещение идёт от первого', async () => {
      /*
       * Выпуск A принимает тело без `from` — в браузерах ещё работает прежний портал (Р3). Значит
       * защита обязана держаться на ОДНОЙ блокировке: оба перемещения проходят, но второе читает
       * карточку уже после первого, и в журнале остаётся связная цепочка `A → B → C`, а не две
       * ветки из одного «откуда». Это и есть проверка того, что `FOR UPDATE` работает сам по себе.
       */
      const id = await makeEquipment('race-nofrom');
      const results = await Promise.all([
        move(id, { objectId: ctx.objectB, location: 'кабинет 202', reason: 'Без сверки первый' }),
        move(id, { objectId: ctx.objectC, location: 'кабинет 303', reason: 'Без сверки второй' }),
      ]);
      expect(results.map((r) => r.statusCode)).toEqual([201, 201]);

      const journal = await movements(id, ctx.admin.auth);
      expect(journal).toHaveLength(2);
      // Свежее сверху: «куда» старшей строки обязано совпасть с «откуда» младшей.
      const [second, first] = journal;
      expect(first!.fromObject.id).toBe(ctx.objectA);
      expect(second!.fromObject.id).toBe(first!.toObject.id);
      expect((await card(id, ctx.admin.auth)).object.id).toBe(second!.toObject.id);
    });
  });

  // ── 2. Разошедшийся `from` (Р3) ──

  it('«откуда» не сошлось с карточкой — 409 с текущим местом в теле', async () => {
    const id = await makeEquipment('stale');
    const stale = sideOf(await card(id));

    const first = await move(id, {
      from: stale,
      objectId: ctx.objectB,
      location: 'кабинет 202',
      reason: 'Переезд бухгалтерии',
    });
    expect(first.statusCode, first.body).toBe(201);

    // Окно осталось открытым со старым «откуда»: аппарат уже уехал.
    const second = await move(id, {
      from: stale,
      objectId: ctx.objectC,
      location: 'кабинет 303',
      reason: 'Переезд по второму окну',
    });
    expect(second.statusCode, second.body).toBe(409);
    const body = second.json() as { details: OfficeEquipmentMoveConflictDetails };
    expect(body.details.current).toMatchObject({
      objectId: ctx.objectB,
      location: 'кабинет 202',
      state: 'on_site',
      stateNote: '',
      departmentId: null,
    });
    expect(await movements(id, ctx.admin.auth)).toHaveLength(1);
  });

  // ── 3. Область — по исходной стороне (Р10, закрывает Н8) ──

  describe('область', () => {
    it('своя исходная площадка — можно', async () => {
      const id = await makeEquipment('scope-own');
      const res = await move(id, {
        objectId: ctx.objectB,
        location: 'кабинет 202',
        reason: 'Переезд внутри своей области',
      });
      expect(res.statusCode, res.body).toBe(201);
    });

    it('чужая исходная площадка — 403', async () => {
      // Карточку на площадке C заводит администратор: объектной области у него нет.
      const id = await makeEquipment('scope-foreign', {
        objectId: ctx.objectC,
        auth: ctx.admin.auth,
      });
      const res = await move(id, {
        objectId: ctx.objectA,
        location: 'кабинет 101',
        reason: 'Забрать с чужой площадки',
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(await movements(id, ctx.admin.auth)).toHaveLength(0);
    });

    it('перенос НА чужую площадку — 201, и единица уходит из своей области', async () => {
      /*
       * Правило Р60/Р10: перемещение — утрата, а не захват. Требование «обе стороны в области»
       * сделало бы штатный перенос невозможным именно для отдающего: у штаба своя площадка одна.
       */
      const id = await makeEquipment('scope-away');
      const res = await move(id, {
        objectId: ctx.objectC,
        location: 'кабинет 303',
        reason: 'Отдали на соседнюю площадку',
      });
      expect(res.statusCode, res.body).toBe(201);

      // Отдающий её больше не видит — и это тот же предикат области, что закрыл вход выше.
      const gone = await inject('GET', `${EQUIPMENT}/${id}`, ctx.operator.auth);
      expect(gone.statusCode).toBe(403);
      expect(await movements(id, ctx.admin.auth)).toHaveLength(1);
    });
  });

  // ── 4. Своё право (Р1, Р2) ──

  describe('право', () => {
    it('держатель `officeEquipment.write` без `.move` — 403', async () => {
      const id = await makeEquipment('perm-write');
      const res = await move(
        id,
        { objectId: ctx.objectB, location: 'кабинет 202', reason: 'Ведение справочника' },
        ctx.writer.auth,
      );
      expect(res.statusCode, res.body).toBe(403);
      expect(await movements(id, ctx.admin.auth)).toHaveLength(0);

      // Ведение справочника у него при этом работает — иначе случай доказывал бы, что учётка
      // сломана, а не что право разделено.
      const patched = await inject('PATCH', `${EQUIPMENT}/${id}`, ctx.writer.auth, {
        comment: 'Правка ведением',
      });
      expect(patched.statusCode, patched.body).toBe(200);
    });

    it('держатель `.move` без `.write` — 201, и это то самое сужение круга', async () => {
      const id = await makeEquipment('perm-move');
      const res = await move(
        id,
        { objectId: ctx.objectA, location: 'кабинет 105', reason: 'Приехал и увидел' },
        ctx.mover.auth,
      );
      expect(res.statusCode, res.body).toBe(201);
      expect(await movements(id, ctx.admin.auth)).toHaveLength(1);

      // Справочник ему при этом закрыт: перемещение открыло ровно одну дверь.
      const patched = await inject('PATCH', `${EQUIPMENT}/${id}`, ctx.mover.auth, {
        comment: 'Правка подтверждающим',
      });
      expect(patched.statusCode, patched.body).toBe(403);
    });
  });

  // ── 5. Уточнение места (Р5, закрывает Н5) ──

  it('сменилось одно лишь уточнение места — перемещение записывается обеими сторонами', async () => {
    const id = await makeEquipment('note');
    // Сначала переводим единицу «к сотруднику»: уточнение обязательно у этого состояния.
    const first = await move(id, {
      objectId: ctx.objectA,
      location: 'кабинет 101',
      state: 'with_employee',
      stateNote: 'Иванов И.И.',
      reason: 'Выдали сотруднику',
    });
    expect(first.statusCode, first.body).toBe(201);

    // «Был у Иванова, стал у Петрова»: до миграции 0277 такая запись отбивалась как «ничего не
    // изменилось», и оформить её можно было только тихой правкой карточки.
    const second = await move(id, {
      objectId: ctx.objectA,
      location: 'кабинет 101',
      state: 'with_employee',
      stateNote: 'Петров П.П.',
      reason: 'Передали другому сотруднику',
    });
    expect(second.statusCode, second.body).toBe(201);

    const journal = await movements(id, ctx.admin.auth);
    expect(journal).toHaveLength(2);
    expect(journal[0]).toMatchObject({
      fromStateNote: 'Иванов И.И.',
      toStateNote: 'Петров П.П.',
      fromState: 'with_employee',
      toState: 'with_employee',
      confirmsDeclaredPlace: false,
    });
    expect((await card(id)).stateNote).toBe('Петров П.П.');

    // Повтор того же тела не переместил ничего — и записывать нечего.
    const again = await move(id, {
      objectId: ctx.objectA,
      location: 'кабинет 101',
      state: 'with_employee',
      stateNote: 'Петров П.П.',
      reason: 'Повтор',
    });
    expect(again.statusCode, again.body).toBe(422);
    expect(again.json().message).toContain('Ничего не изменилось');
  });

  // ── 6. Отдел двоедверный (Р13, ответ на Н10) ──

  it('сменился один лишь отдел: перемещение пишет строку, правка карточки — нет', async () => {
    const id = await makeEquipment('dept');
    const moved = await move(id, {
      objectId: ctx.objectA,
      departmentId: ctx.departmentOne,
      location: 'кабинет 101',
      reason: 'Закрепили за отделом',
    });
    expect(moved.statusCode, moved.body).toBe(201);

    const journal = await movements(id, ctx.admin.auth);
    expect(journal).toHaveLength(1);
    expect(journal[0]!.fromDepartment).toBeNull();
    expect(journal[0]!.toDepartment?.id).toBe(ctx.departmentOne);
    expect(journal[0]!.fromObject.id).toBe(journal[0]!.toObject.id);

    // Вторая дверь: разметка парка правкой карточки. Она законна и журнала не пишет — так и
    // задумано (Р13), и именно поэтому у правила есть караул.
    const patched = await inject('PATCH', `${EQUIPMENT}/${id}`, ctx.operator.auth, {
      departmentId: ctx.departmentTwo,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await movements(id, ctx.admin.auth)).toHaveLength(1);
    expect((await card(id)).department?.id).toBe(ctx.departmentTwo);

    // След у правки всё же остаётся — в аудите карточки, откуда его берёт блок «Ручные правки».
    const audit = await ctx.db.execute<{ metadata: { changes?: { field: string }[] } }>(sql`
      SELECT metadata FROM audit_log
       WHERE action = 'officeEquipment.update' AND entity_type = 'officeEquipment'
         AND entity_id = ${id}
       ORDER BY created_at DESC LIMIT 1`);
    expect(audit.rows[0]!.metadata.changes?.map((c) => c.field)).toContain('department');
  });

  // ── 7. Связанная заявка (Р6, находка Н11) ──

  describe('ссылка на заявку', () => {
    it('архивная заявка — общий 404, чужая техника — 422', async () => {
      const id = await makeEquipment('link');
      const other = await makeEquipment('link-other');
      const foreign = await createRequest(other, 'Заявка по соседнему аппарату');

      // Чужой аппарат — безопасный 422: заявку человек видит, объяснить можно словами.
      const wrongUnit = await move(id, {
        objectId: ctx.objectB,
        location: 'кабинет 202',
        reason: 'Увезли в сервис',
        serviceRequestId: foreign.id,
      });
      expect(wrongUnit.statusCode, wrongUnit.body).toBe(422);
      expect(wrongUnit.json().message).toContain('не на эту технику');

      // Архивная (снесённая) заявка — тот же 404, что и «нет такой»: различие отказов само по себе
      // рассказывало бы о существовании строки.
      const own = await createRequest(id, 'Заявка, которую снесут');
      await ctx.db.execute(
        sql`UPDATE service_requests SET deleted_at = now() WHERE id = ${own.id}`,
      );
      const archived = await move(id, {
        objectId: ctx.objectB,
        location: 'кабинет 202',
        reason: 'Увезли в сервис',
        serviceRequestId: own.id,
      });
      expect(archived.statusCode, archived.body).toBe(404);
      expect(await movements(id, ctx.admin.auth)).toHaveLength(0);
    });

    it('подтверждение без заявки и подтверждение заявки без заявления — отбиваются', async () => {
      const id = await makeEquipment('confirm-guard');

      /*
       * РАСХОЖДЕНИЕ С ПЛАНОМ, названное словами. §9.1 (случай 7) ждёт здесь `422`, а сервер
       * отвечает `400 validation_error`: пара «подтверждение без заявки» отбивается не маршрутом, а
       * `refine` схемы тела (`moveOfficeEquipmentSchema`), и общий обработчик ошибок переводит
       * промахи zod в 400. Поведение при этом верное — тело не принимается, поле помечено, — и
       * дефектом это не является: расходится КОД отказа, а не решение. Тест закрепляет
       * сегодняшнее поведение и помечает поле, по которому портал подсветит галочку.
       */
      const noRequest = await move(id, {
        objectId: ctx.objectB,
        location: 'кабинет 202',
        reason: 'Подтверждаю место',
        confirmsDeclaredPlace: true,
      });
      expect(noRequest.statusCode, noRequest.body).toBe(400);
      expect(noRequest.json().fields).toHaveProperty('confirmsDeclaredPlace');

      // Заявка без заявления о месте: подтверждать нечего — и это уже 422 маршрута.
      const plain = await createRequest(id, 'Заявка без заявления о месте');
      const nothingDeclared = await move(id, {
        objectId: ctx.objectB,
        location: 'кабинет 202',
        reason: 'Подтверждаю место',
        serviceRequestId: plain.id,
        confirmsDeclaredPlace: true,
      });
      expect(nothingDeclared.statusCode, nothingDeclared.body).toBe(422);
      expect(nothingDeclared.json().message).toContain('не заявлено другое место');
      expect(await movements(id, ctx.admin.auth)).toHaveLength(0);
    });
  });

  // ── 8. Очередь расхождений ИТ-службы (находка Н6, Р8) ──

  describe('очередь расхождений', () => {
    /** Единица на площадке A с заявкой «а стоит он на B». */
    async function declaredOnB(tag: string): Promise<{ id: string; request: ServiceRequestDto }> {
      const id = await makeEquipment(tag);
      const request = await createRequest(id, `Аппарат стоит не там — ${tag}`, ctx.objectB);
      expect(request.objectOverridden).toBe(true);
      expect(request.objectMismatch).toBe(true);
      expect(await inMismatchQueue(request.id)).toBe(true);
      return { id, request };
    }

    it('перенесли в третье место без подтверждения — заявка остаётся в очереди', async () => {
      const { id, request } = await declaredOnB('queue-c');
      const res = await move(id, {
        objectId: ctx.objectC,
        location: 'кабинет 303',
        reason: 'Нашёлся на третьей площадке',
        serviceRequestId: request.id,
      });
      expect(res.statusCode, res.body).toBe(201);
      // Заявили `B`, аппарат оказался на `C`: снимок с карточкой по-прежнему не сходится.
      expect(await inMismatchQueue(request.id)).toBe(true);
      expect(await requestMismatch(request.id)).toBe(true);
    });

    it('перенесли в третье место С подтверждением — очередь гаснет, и видно, кем разобрано (Р8)', async () => {
      const { id, request } = await declaredOnB('queue-c-confirmed');
      const res = await move(id, {
        objectId: ctx.objectC,
        location: 'кабинет 303',
        reason: 'Проверил: стоит на третьей площадке',
        serviceRequestId: request.id,
        confirmsDeclaredPlace: true,
      });
      expect(res.statusCode, res.body).toBe(201);

      // Флаг записан — журнал помнит, кто и чем разобрал расхождение.
      const journal = await movements(id, ctx.admin.auth);
      expect(journal[0]).toMatchObject({
        confirmsDeclaredPlace: true,
        serviceRequestId: request.id,
      });

      /*
       * ГЛАВНЫЙ СЛУЧАЙ Р8 (находка Н6). Аппарат заявили на «B», нашёлся он на «C» — снимок заявки со
       * справочником так и не сравнялся, и по двум прежним условиям заявка висела бы в очереди
       * ИТ-службы до самого закрытия, хотя разбор состоялся. Третий член условия — «нет
       * подтверждающего перемещения по этой заявке» — гасит её ровно тем действием, которым
       * ответственный и сказал «аппарат стоит здесь».
       *
       * Проверяются обе стороны: и отбор очереди, и признак строки. Разъедься они — ИТ-служба
       * видела бы в списке одно, а в карточке другое; поэтому считает их один модуль
       * (`services/service-request-place.ts`).
       */
      expect(await inMismatchQueue(request.id)).toBe(false);
      expect(await requestMismatch(request.id)).toBe(false);
    });

    it('перенесли туда, где заявили, — очередь гаснет и без подтверждения, и с ним', async () => {
      const plain = await declaredOnB('queue-b');
      const movedToB = await move(plain.id, {
        objectId: ctx.objectB,
        location: 'кабинет 202',
        reason: 'Стоит там, где сказали',
        serviceRequestId: plain.request.id,
      });
      expect(movedToB.statusCode, movedToB.body).toBe(201);
      expect(await inMismatchQueue(plain.request.id)).toBe(false);
      expect(await requestMismatch(plain.request.id)).toBe(false);

      const confirmed = await declaredOnB('queue-b-confirmed');
      const movedWithFlag = await move(confirmed.id, {
        objectId: ctx.objectB,
        location: 'кабинет 202',
        reason: 'Проверил: стоит там, где сказали',
        serviceRequestId: confirmed.request.id,
        confirmsDeclaredPlace: true,
      });
      expect(movedWithFlag.statusCode, movedWithFlag.body).toBe(201);
      expect(await inMismatchQueue(confirmed.request.id)).toBe(false);
      expect(await requestMismatch(confirmed.request.id)).toBe(false);
    });
  });

  // ── 9. Закрытая заявка (Р6, закрывает Н3) ──

  describe('закрытая заявка', () => {
    it('по отменённой заявке перемещение принимается', async () => {
      const id = await makeEquipment('closed-cancelled');
      const request = await createRequest(id, 'Ремонт нецелесообразен');
      const cancelled = await inject(
        'PATCH',
        `${REQUESTS}/${request.id}/status`,
        ctx.operator.auth,
        { status: 'cancelled', reason: 'Ремонт нецелесообразен', version: request.version },
      );
      expect(cancelled.statusCode, cancelled.body).toBe(200);

      const res = await move(id, {
        objectId: ctx.objectB,
        location: 'склад',
        state: 'in_stock',
        stateNote: 'стеллаж 4',
        reason: 'Увезли на склад после отмены',
        serviceRequestId: request.id,
      });
      expect(res.statusCode, res.body).toBe(201);
      expect((await movements(id, ctx.admin.auth))[0]!.serviceRequestId).toBe(request.id);
    });

    it('по принятой заявке — тоже: «вернулась из сервиса» пишут именно тогда', async () => {
      const id = await makeEquipment('closed-accepted');
      const request = await createRequest(id, 'Вернуть после ремонта');
      /*
       * Статус проставляется прямым SQL: довести заявку до «Принята» настоящим циклом — это смета,
       * её согласование, закрытие работ и приёмка, то есть предмет соседнего файла
       * (`service-request-warranty-transitions.db.test.ts`). Здесь важно только одно: сервер статус
       * связанной заявки не спрашивает вовсе. Контрагент проставляется вместе со статусом —
       * заявка в рабочем статусе без исполнителя не проходит отложенный триггер `0178`.
       */
      await ctx.db.execute(sql`
        UPDATE service_requests
           SET status = 'accepted', service_counterparty_id = ${ctx.serviceCounterpartyId}
         WHERE id = ${request.id}`);

      // Сначала увезли — это записывают, когда заявка ещё открыта.
      const away = await move(id, {
        objectId: ctx.objectA,
        location: 'сервисный центр',
        state: 'at_service',
        reason: 'Увезли в сервис',
        serviceRequestId: request.id,
      });
      expect(away.statusCode, away.body).toBe(201);

      const res = await move(id, {
        objectId: ctx.objectA,
        location: 'кабинет 101',
        reason: 'Вернулась из сервиса',
        serviceRequestId: request.id,
      });
      expect(res.statusCode, res.body).toBe(201);
      expect((await movements(id, ctx.admin.auth))[0]!.serviceRequestId).toBe(request.id);
    });
  });
});
