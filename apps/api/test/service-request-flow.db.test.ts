import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatServiceRequestNumber,
  moscowDateKeyOf,
  WARRANTY_EXPIRING_DAYS,
  type OfficeEquipmentServiceEntryDto,
  type ServiceRequestDto,
  type ServiceRequestItemDto,
  type ServiceWarrantyRowDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Заявка на обслуживание оргтехники от заведения до гарантийного обращения (ADR 0085, план §5) —
 * одной цепочкой на живой схеме, через настоящие HTTP-пути.
 *
 * Зачем база. Ценность модуля не в отдельных правилах, а в том, что состояние заявки переживает
 * весь цикл: смета доживает до закрытия ревизией, согласование — до сверки при закрытии, факт —
 * до приёмки, гарантия выполненной строки — до заявки, заведённой по ней через два месяца. Ни
 * одно из этих последствий контрактным тестом не видно: расходятся здесь не правила, а код,
 * схема и порядок шагов в транзакции. Итог по акту считает БД (`amount` и `actual_amount` —
 * GENERATED), сброс факта при возврате упирается в CHECK «гарантии без выполнения не бывает»,
 * «одна открытая заявка на единицу» держит частичный уникальный индекс, а `ON DELETE RESTRICT`
 * на гарантийной ссылке превращает `purge` заявки-источника в 409. Собрать это на моках —
 * значит проверить моки.
 *
 * Поэтому файл идёт **шагами одного сценария**, а не набором изолированных кейсов: каждый `it`
 * продолжает предыдущий, и порядок здесь — часть проверки.
 *
 * Данные готовятся настоящими ручками везде, где портал это умеет. Прямой SQL остаётся ровно в
 * трёх местах, и каждое отмечено комментарием: учётки и контрагенты (форма учётки — не предмет
 * этого файла), строка `files` под подшивку документа (загрузка идёт в S3, которого в тесте нет)
 * и одно состояние, недостижимое через API вовсе, — расхождение ревизий сметы в «В работе».
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/oe_flow_test \
 *     pnpm --filter @technic/api test service-request-flow --no-file-parallelism
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

/** День закрытия работ — сегодня по Москве: от него сервер отсчитывает гарантии строк. */
const TODAY = moscowDateKeyOf(new Date());

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
  /** Администратор: заводит то, чего не заводит никто другой, и делает `purge`. */
  admin: TestUser;
  /** Заказчик — штаб своей площадки: заводит заявку и наблюдает за ней. */
  customer: TestUser;
  /** Оператор оргтехники — тот же штаб плюс надстройка роли (ADR 0086). */
  operator: TestUser;
  /** Согласующий от ИТ (Р51): виза плюс сквозная область модуля — заявки всех площадок. */
  itApprover: TestUser;
  /** Исполнитель — учётка сервисной компании. */
  service: TestUser;
  /** Штаб чужой площадки: ни одна заявка этого файла на неё не заводится. */
  foreignShtab: TestUser;
  /** Сотрудник отдела: у него своя ось области — по отделам, а не по объектам. */
  department: TestUser;
  /**
   * Держатель справочников (роль `manager`): ведёт карточки техники, но заявок на обслуживание не
   * видит. Только им и проверяется, что секция обслуживания закрыта правом модуля, а не
   * справочника (§8.2): у всех прочих учёток файла оба права либо есть, либо нет разом.
   */
  keeper: TestUser;
  /**
   * Сотрудник **двух** отделов: без него ветки выбора заказчика (Р5) неразличимы — у учётки с
   * одним отделом подсказка из техники и «единственный отдел» дают один и тот же ответ.
   */
  multiDepartment: TestUser;
  objectId: string;
  /** Чужая площадка: её видит `foreignShtab`, и на неё же не переносится техника (Р7). */
  foreignObjectId: string;
  departmentId: string;
  /** Второй отдел учётки `multiDepartment`. */
  secondDepartmentId: string;
  /** Отдел, к которому ни одна учётка теста не приписана. */
  foreignDepartmentId: string;
  serviceCounterpartyId: string;
  /** Второй сервис: им проверяется, что исполнитель не видит чужие назначенные заявки. */
  otherServiceCounterpartyId: string;
  /** Тип оргтехники из сида: им заводятся единицы, в том числе по ходу самих шагов. */
  typeId: string;
  /** Единица, вокруг которой идёт весь цикл. */
  mfp: { id: string; inventoryNumber: string };
  /** Вторая единица: её заявка даёт «чужую» позицию ремонта для гарантийного обращения. */
  scanner: { id: string };
  /** Техника отдела: по ней роль отдела видит заявку, которую заводила не она. */
  deptPrinter: { id: string };
  /** Техника без владельца: на ней отдел заводит заявку от своего имени. */
  freePrinter: { id: string };
  /** Техника второго отдела: на ней проверяется подсказка из владельца единицы (Р5). */
  hintPrinter: { id: string };
  /** Неразмеченная техника: подсказки из неё нет, и отдел выбирают руками. */
  choicePrinter: { id: string };
  /** Техника чужого отдела: роли отдела она в справочнике не видна (Р7). */
  foreignDeptPrinter: { id: string };
}

let ctx: Ctx;

/**
 * Что сценарий накопил по дороге. Шаги идут цепочкой и передают друг другу идентификаторы —
 * заявку, её строки и заявки-спутники, из которых собираются гарантийные обращения.
 */
const state: {
  /** Главная заявка цикла. */
  main: { id: string; num: number };
  /** Вторая заявка на ту же единицу: отменена со сметой — источник «заявка не принята». */
  cancelled: { id: string; num: number; itemId: string };
  /** Третья заявка на ту же единицу: заведена по гарантии выполненной строки главной. */
  claim: { id: string; num: number };
  /** Заявка на второй единице: её строка — «чужая» позиция ремонта. */
  otherUnit: { id: string; itemId: string };
  /** Заявка на технике отдела, заведённая администратором. */
  deptOwned: { id: string };
  /** Заявка, заведённая самим отделом. */
  deptOwn: { id: string };
  /** Строки главной заявки после закрытия: по ним и обращаются по гарантии. */
  performedItemId: string;
  notPerformedItemId: string;
  expiredItemId: string;
  /** Счёт, подшитый в закрытую заявку: его же снимает распорядитель чужих файлов (§8.3). */
  attachedInvoiceId: string;
  /** Заявка со срочностью: на своей единице — по единице разрешена одна открытая заявка (Р21). */
  urgent: { id: string; num: number; equipmentId: string };
} = {
  main: { id: '', num: 0 },
  cancelled: { id: '', num: 0, itemId: '' },
  claim: { id: '', num: 0 },
  otherUnit: { id: '', itemId: '' },
  deptOwned: { id: '' },
  deptOwn: { id: '' },
  performedItemId: '',
  notPerformedItemId: '',
  expiredItemId: '',
  attachedInvoiceId: '',
  urgent: { id: '', num: 0, equipmentId: '' },
};

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // S3 в этом сценарии не участвует: документы подшиваются уже загруженными строками `files`.
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

/** Свой адрес на каждый вход: попытки входа ограничены по IP, а учёток здесь шесть. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/**
 * «Дата плюс N месяцев» календарём — ожидаемое значение гарантии, посчитанное независимо от
 * сервера. 31 января плюс месяц — это 28 (29) февраля: в феврале 31-го нет, и без подрезки дата
 * уехала бы в март.
 */
function plusMonths(dateKey: string, months: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1 + months, d!));
  if (at.getUTCDate() !== d) at.setUTCDate(0);
  return at.toISOString().slice(0, 10);
}

/** Заведомо истёкшая гарантия: год назад — и такой она останется в любом будущем прогоне. */
/**
 * Десятизначный ИНН по девяти цифрам основы: последняя считается по весам приказа ФНС, и портал
 * проверяет её на каждом заведении контрагента (`isValidInn`).
 */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

/** «Дата плюс N дней» — порог «истекает» считается сутками, а не месяцами (`WARRANTY_EXPIRING_DAYS`). */
function plusDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

const EXPIRED_ON = plusMonths(TODAY, -12);
/**
 * Дата из талона при закрытии: сервер не принимает гарантию, истекающую раньше даты выполнения
 * (это опечатка в году либо чужой талон), поэтому «короткая» гарантия задаётся сроком вперёд, а
 * ветка «гарантия истекла» собирается ниже прямым `UPDATE` — иначе такого состояния через API не
 * получить вовсе.
 */
const SHORT_WARRANTY_ON = plusMonths(TODAY, 1);

// ── Обращения к API ──

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

/** Карточка заявки; по умолчанию глазами оператора — он видит все заявки своей площадки. */
async function card(id: string, auth: Auth = ctx.operator.auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `/api/v1/service-requests/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

/** Текущая версия заявки: её спрашивает каждая изменяющая ручка (Р30). */
async function version(id: string, auth: Auth = ctx.operator.auth): Promise<number> {
  return (await card(id, auth)).version;
}

function itemNamed(dto: ServiceRequestDto, name: string): ServiceRequestItemDto {
  const item = dto.items.find((row) => row.name === name);
  if (!item) throw new Error(`В смете нет строки «${name}»`);
  return item;
}

/** Идентификаторы заявок, видимых субъекту: страница заведомо больше, чем данных у теста. */
async function listIds(auth: Auth, query = ''): Promise<string[]> {
  const res = await inject('GET', `/api/v1/service-requests?pageSize=200${query}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as ServiceRequestDto[]).map((row) => row.id);
}

/** Идентификаторы единиц справочника, видимых субъекту (Р7): страница заведомо больше данных. */
async function equipmentIds(auth: Auth): Promise<string[]> {
  const res = await inject('GET', '/api/v1/office-equipment?pageSize=200', auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as { id: string }[]).map((row) => row.id);
}

/**
 * Загруженный файл строкой в `files`. Настоящая загрузка идёт через presign в S3, которого в
 * тесте нет, а предмет проверки — правила подшивки (§8.3), а не транспорт.
 */
async function uploadedFile(userId: string, filename: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`oe/${RUN}/${randomUUID()}`}, ${filename}, 'application/pdf', 2048,
            'pending', ${userId})
    RETURNING id`);
  return res.rows[0]!.id;
}

// ── Подготовка данных ──

/** Единица справочника — ручкой оператора: справочник ведёт он (ADR 0085 §3). */
async function makeEquipment(input: {
  typeId: string;
  name: string;
  inventoryNumber: string;
  objectId: string;
  departmentId?: string | null;
}): Promise<string> {
  const res = await inject('POST', '/api/v1/office-equipment', ctx.operator.auth, {
    equipmentTypeId: input.typeId,
    name: input.name,
    inventoryNumber: input.inventoryNumber,
    objectId: input.objectId,
    departmentId: input.departmentId ?? null,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Заявка заказчика: общий вход всех веток сценария. */
async function createRequest(
  auth: Auth,
  officeEquipmentId: string,
  description: string,
  extra: Record<string, unknown> = {},
): Promise<ServiceRequestDto> {
  const res = await inject('POST', '/api/v1/service-requests', auth, {
    officeEquipmentId,
    description,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  // Заведение отвечает заявкой и исходом письма службе (план `office-equipment-mail-and-history-plan.md`,
  // Р67): сама заявка лежит в `request`.
  return (res.json() as { request: ServiceRequestDto }).request;
}

/**
 * Виза отдела ИТ (Р51) — первый шаг цикла: без неё сервис не назначают. Отдельной функцией,
 * потому что через неё проходит **каждая** ветка сценария: заявка, не прошедшая ИТ, дальше
 * «Новой» не двигается вовсе.
 */
async function approveByIt(id: string): Promise<void> {
  const before = await card(id, ctx.itApprover.auth);
  // Повторная виза не нужна и невозможна: заявка, вернувшаяся от исполнителя, подпись сохраняет
  // (Р51). Помощник это учитывает — иначе ветки, продолжающие отказ, ломались бы о собственный шаг.
  if (before.status !== 'new') return;
  const res = await inject(
    'PATCH',
    `/api/v1/service-requests/${id}/it-approval`,
    ctx.itApprover.auth,
    { approved: true, version: before.version },
  );
  expect(res.statusCode, res.body).toBe(200);
}

/** Назначение → диагностика → смета: три шага, которыми открывается любая ветка со сметой. */
async function toDiagnostics(id: string): Promise<void> {
  await approveByIt(id);
  const assigned = await inject(
    'PATCH',
    `/api/v1/service-requests/${id}/service`,
    ctx.operator.auth,
    {
      serviceCounterpartyId: ctx.serviceCounterpartyId,
      version: await version(id),
    },
  );
  expect(assigned.statusCode, assigned.body).toBe(200);
  const started = await inject('PATCH', `/api/v1/service-requests/${id}/start`, ctx.service.auth, {
    version: assigned.json().version,
  });
  expect(started.statusCode, started.body).toBe(200);
}

describe.skipIf(!DB_URL)('обслуживание оргтехники: сквозной цикл на живой схеме', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const passwordHash = await hashPassword(PASSWORD);

    // Учётки, контрагенты, площадка и отдел заводятся SQL: форма учётки и справочник контрагентов —
    // предмет своих тестов, а здесь они только декорации, без которых не разложить три стороны.
    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${`db-oe-${input.tag}-${RUN}@example.invalid`}, 'Тестовый', 'Пользователь',
                ${input.tag}, ${passwordHash}, ${sql.raw(`'${input.role}'::role`)},
                true, now(), ${input.counterpartyId ?? null})
        RETURNING id, email`);
      const row = res.rows[0]!;
      return { id: row.id, email: `db-oe-${input.tag}-${RUN}@example.invalid` };
    }

    const counterparty = async (name: string, inn: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO counterparties (type, name, inn)
        VALUES ('service'::counterparty_type, ${name}, ${inn})
        RETURNING id`);
      return res.rows[0]!.id;
    };
    // ИНН — с настоящей контрольной суммой, а не «77…01»: пока идёт прогон, контрагенты лежат в
    // общей базе (а после падения остаются там и вовсе), а обмен справочниками
    // (`directory-transfer.db`) выгружает её целиком и загружает обратно — на выдуманном ИНН он
    // падает, и падение выглядит как дефект чужого модуля.
    const digits = String(Date.now()).slice(-6);
    const serviceCounterpartyId = await counterparty(`Сервис-Про ${RUN}`, innOf(`77${digits}0`));
    const otherServiceCounterpartyId = await counterparty(
      `Сервис-Альт ${RUN}`,
      innOf(`77${digits}1`),
    );

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`OE-${RUN}`}, ${`Тестовая площадка ОЕ ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;
    const foreignRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`OE-F-${RUN}`}, ${`Тестовая чужая площадка ОЕ ${RUN}`}, 'г Москва, ул Чужая, д 2')
      RETURNING id`);
    const foreignObjectId = foreignRow.rows[0]!.id;

    /** Отдел — три штуки: свой, второй у сотрудника двух отделов и заведомо чужой (Р5, Р7). */
    const makeDepartment = async (tag: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO departments (code, name)
        VALUES (${`OE-${tag}-${RUN}`}, ${`Тестовый отдел ${tag} ${RUN}`})
        RETURNING id`);
      return row.rows[0]!.id;
    };
    const departmentId = await makeDepartment('D');
    const secondDepartmentId = await makeDepartment('D2');
    const foreignDepartmentId = await makeDepartment('DF');

    const admin = await makeUser({ tag: 'admin', role: 'admin' });
    const customer = await makeUser({ tag: 'cust', role: 'shtab' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const service = await makeUser({
      tag: 'serv',
      role: 'operator',
      counterpartyId: serviceCounterpartyId,
    });
    const foreignShtab = await makeUser({ tag: 'fshtab', role: 'shtab' });
    const department = await makeUser({ tag: 'dept', role: 'department' });
    const multiDepartment = await makeUser({ tag: 'dept2', role: 'department' });
    const keeper = await makeUser({ tag: 'keeper', role: 'manager' });
    // Согласующий от ИТ: роль отдела и **чужой** отдел в области. Именно чужой — так проверяется,
    // что заявки он видит не по своей роли, а по надстройке (Р54).
    const itApprover = await makeUser({ tag: 'it', role: 'department' });

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${customer.id}, ${objectId}), (${operator.id}, ${objectId}),
             (${foreignShtab.id}, ${foreignObjectId})`);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id)
      VALUES (${department.id}, ${departmentId}),
             (${multiDepartment.id}, ${departmentId}),
             (${multiDepartment.id}, ${secondDepartmentId}),
             (${itApprover.id}, ${foreignDepartmentId})`);
    // Надстройка роли (ADR 0086): тот же штаб, но со стороной оператора оргтехники. Роль у него
    // остаётся `shtab` — именно это и проверяет коридор: право статуса у надстройки есть, а шаги
    // исполнителя ей всё равно не положены.
    await db.execute(sql`
      INSERT INTO user_role_addons (user_id, addon)
      VALUES (${operator.id}, 'office_equipment_operator'::role_addon),
             (${itApprover.id}, 'office_equipment_it_approver'::role_addon)`);

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
      foreignShtab: await withAuth(foreignShtab),
      department: await withAuth(department),
      multiDepartment: await withAuth(multiDepartment),
      keeper: await withAuth(keeper),
      itApprover: await withAuth(itApprover),
      objectId,
      foreignObjectId,
      departmentId,
      secondDepartmentId,
      foreignDepartmentId,
      serviceCounterpartyId,
      otherServiceCounterpartyId,
      typeId,
      mfp: { id: '', inventoryNumber: '' },
      scanner: { id: '' },
      deptPrinter: { id: '' },
      freePrinter: { id: '' },
      hintPrinter: { id: '' },
      choicePrinter: { id: '' },
      foreignDeptPrinter: { id: '' },
    };

    const inventoryNumber = `ОЕ-${RUN}-1`;
    ctx.mfp = {
      id: await makeEquipment({
        typeId,
        name: 'Kyocera ECOSYS M3145',
        inventoryNumber,
        objectId,
      }),
      inventoryNumber,
    };
    ctx.scanner = {
      id: await makeEquipment({
        typeId,
        name: 'HP ScanJet 5000',
        inventoryNumber: `ОЕ-${RUN}-2`,
        objectId,
      }),
    };
    ctx.deptPrinter = {
      id: await makeEquipment({
        typeId,
        name: 'Xerox B310',
        inventoryNumber: `ОЕ-${RUN}-3`,
        objectId,
        departmentId,
      }),
    };
    ctx.freePrinter = {
      id: await makeEquipment({
        typeId,
        name: 'Brother HL-1223',
        inventoryNumber: `ОЕ-${RUN}-4`,
        objectId,
      }),
    };
    // Владелец — **второй** отдел учётки: подсказка обязана прийти из карточки техники, а не из
    // набора отделов автора, и на первом отделе набора эти два ответа неразличимы.
    ctx.hintPrinter = {
      id: await makeEquipment({
        typeId,
        name: 'Canon i-SENSYS LBP223',
        inventoryNumber: `ОЕ-${RUN}-5`,
        objectId,
        departmentId: secondDepartmentId,
      }),
    };
    ctx.choicePrinter = {
      id: await makeEquipment({
        typeId,
        name: 'Pantum P3300',
        inventoryNumber: `ОЕ-${RUN}-6`,
        objectId,
      }),
    };
    ctx.foreignDeptPrinter = {
      id: await makeEquipment({
        typeId,
        name: 'Ricoh SP 330',
        inventoryNumber: `ОЕ-${RUN}-7`,
        objectId,
        departmentId: foreignDepartmentId,
      }),
    };
  }, 180_000);

  /**
   * Уборка: база у db-тестов общая и живёт между прогонами, поэтому файл уносит ровно то, что
   * завёл сам. Опознаётся всё по суффиксу прогона (`RUN`), а порядок задан внешними ключами:
   * гарантийная ссылка объявлена `RESTRICT` и держит строку сметы, заявки держат технику,
   * учётку-автора и контрагента-исполнителя, техника — площадку и отдел. Каскады остального
   * (строки сметы, документы, история статусов, объекты и отделы учёток) сработают сами.
   */
  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      const equipment = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE ${`ОЕ-${RUN}-%`}`;
      const users = sql`SELECT id FROM users WHERE email LIKE ${`db-oe-%-${RUN}@example.invalid`}`;
      // Обращение по гарантии ссылается на строку сметы другой заявки: пока ссылка стоит, ни ту,
      // ни другую заявку не удалить одним запросом — `RESTRICT` проверяется построчно.
      await ctx.db.execute(sql`
        UPDATE service_requests SET warranty_claim_source = NULL, warranty_claim_item_id = NULL
        WHERE office_equipment_id IN (${equipment})`);
      await ctx.db.execute(
        sql`DELETE FROM service_requests WHERE office_equipment_id IN (${equipment})`,
      );
      await ctx.db.execute(
        sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`ОЕ-${RUN}-%`}`,
      );
      // Отложенное удаление из S3 (задача outbox) вместе с самим файлом: хранилища в тесте нет,
      // и задача осталась бы висеть в очереди живого планировщика.
      await ctx.db.execute(sql`DELETE FROM jobs WHERE payload->>'objectKey' LIKE ${`oe/${RUN}/%`}`);
      await ctx.db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`oe/${RUN}/%`}`);
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-oe-%-${RUN}@example.invalid`}`,
      );
      await ctx.db.execute(sql`DELETE FROM counterparties WHERE name LIKE ${`Сервис-% ${RUN}`}`);
      // Отделы раньше площадок: у отдела бывает своя площадка (ADR 0062), и ссылка на неё —
      // `RESTRICT`. У отделов этого теста её нет, но порядок не должен зависеть от этого.
      await ctx.db.execute(sql`DELETE FROM departments WHERE code LIKE ${`OE-%${RUN}`}`);
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${`OE-%${RUN}`}`);
    }
    await ctx?.closeDb();
  });

  // ── Шаг 1. Заявка заведена ──

  it('заказчик заводит заявку: снимок предмета, статус «Новая», ждут ИТ', async () => {
    const dto = await createRequest(
      ctx.customer.auth,
      ctx.mfp.id,
      'Не захватывает бумагу из нижнего лотка',
      { dueDate: plusMonths(TODAY, 1) },
    );
    state.main = { id: dto.id, num: dto.num };

    expect(dto.status).toBe('new');
    // Кого ждут — считает сервер: правило одно на список, карточку и бейдж раздела (Р35).
    // «Новая» ждёт отдел ИТ: до визы сервис не назначают (Р51).
    expect(dto.waitingOn).toBe('it');
    expect(dto.itApproval).toBeNull();
    expect(dto.displayNumber).toBe(formatServiceRequestNumber(dto.num));
    // Реквизиты предмета — снимок: единицу перенесут и переименуют, а заявка обязана остаться
    // рассказом о том, что чинили тогда (Р10).
    expect(dto.equipment).toMatchObject({
      id: ctx.mfp.id,
      name: 'Kyocera ECOSYS M3145',
      inventoryNumber: ctx.mfp.inventoryNumber,
      typeName: 'МФУ',
      // Место внутри объекта — часть того же снимка (Р57): по нему едет мастер, а карточка к
      // моменту ремонта могла переехать.
      location: 'кабинет 214',
    });
    expect(dto.object.id).toBe(ctx.objectId);
    // Заявку завёл штаб: отделов у него нет, и заявка объектная, а не «ничья, видная всем».
    expect(dto.customerDepartment).toBeNull();
    expect(dto.service).toBeNull();
    expect(dto.estimateRevision).toBe(0);
    expect(dto.items).toEqual([]);
    expect(dto.version).toBe(0);
  });

  it('вторая заявка на ту же единицу отклоняется номером первой (Р21)', async () => {
    // Две параллельные заявки означали бы два сервиса, два акта и две гарантии на одну работу.
    // Номер в ответе — не украшение: портал вместо глухого отказа предлагает открыть эту заявку.
    const res = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
      officeEquipmentId: ctx.mfp.id,
      description: 'Тот же аппарат, второй заход',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain(formatServiceRequestNumber(state.main.num));
  });

  it('«Новую» заявку сервис не видит: исполнителя в ней ещё нет', async () => {
    // Следствие области исполнителя, принятое в ADR 0085 сознательно: до назначения заявка ничья.
    expect(await listIds(ctx.service.auth)).not.toContain(state.main.id);
    const direct = await inject(
      'GET',
      `/api/v1/service-requests/${state.main.id}`,
      ctx.service.auth,
    );
    expect(direct.statusCode, direct.body).toBe(403);
  });

  // ── Шаг 2. Виза отдела ИТ (Р51) ──

  it('до визы ИТ сервис не назначают: решение «звать ли подрядчика» принимает не оператор', async () => {
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/service`,
      ctx.operator.auth,
      { serviceCounterpartyId: ctx.serviceCounterpartyId, version: await version(state.main.id) },
    );
    // 403, а не 422: дуги «Новая → Назначен сервис» нет ни у кого — коридор оператора начинается
    // после визы, и дело не в состоянии записи, а в том, что такого шага у него не бывает.
    expect(res.statusCode, res.body).toBe(403);
  });

  it('согласующий от ИТ видит чужую площадку: область даёт надстройка, а не роль', async () => {
    // Учётка ИТ приписана к постороннему отделу и не имеет ни одного объекта: по своей роли она не
    // увидела бы эту заявку вовсе (Р54).
    expect(await listIds(ctx.itApprover.auth)).toContain(state.main.id);
    const card = await inject(
      'GET',
      `/api/v1/service-requests/${state.main.id}`,
      ctx.itApprover.auth,
    );
    expect(card.statusCode, card.body).toBe(200);
    // Справочник — тоже: перед визой смотрят, что за аппарат и что с ним уже делали.
    const equipment = await inject(
      'GET',
      `/api/v1/office-equipment/${ctx.mfp.id}`,
      ctx.itApprover.auth,
    );
    expect(equipment.statusCode, equipment.body).toBe(200);
  });

  it('«Новая» ждёт ИТ, и очередь «ждут меня» у оператора её не показывает', async () => {
    const card = await inject(
      'GET',
      `/api/v1/service-requests/${state.main.id}`,
      ctx.operator.auth,
    );
    expect(card.json().waitingOn).toBe('it');
    expect(await listIds(ctx.operator.auth, '&waitingOnMe=true')).not.toContain(state.main.id);
    expect(await listIds(ctx.itApprover.auth, '&waitingOnMe=true')).toContain(state.main.id);
  });

  it('отдел ИТ визирует заявку: снимок «кто и когда», дальше ход у оператора', async () => {
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/it-approval`,
      ctx.itApprover.auth,
      { approved: true, version: await version(state.main.id, ctx.itApprover.auth) },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('it_approved');
    expect(dto.waitingOn).toBe('operator');
    expect(dto.itApproval?.by).toBe(ctx.itApprover.id);
    expect(dto.itApproval?.auto).toBe(false);
    expect(dto.itApproval?.byName).toBeTruthy();
  });

  it('оператор визы не имеет: подписать заявку себе он не может', async () => {
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/it-approval`,
      ctx.operator.auth,
      { approved: true, version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(403);
  });

  it('отказ ИТ закрывает заявку с причиной, и без причины его не принимают', async () => {
    const dto = await createRequest(
      ctx.customer.auth,
      ctx.choicePrinter.id,
      'Хочу второй монитор к рабочему месту',
    );

    const silent = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/it-approval`,
      ctx.itApprover.auth,
      { approved: false, version: dto.version },
    );
    // Причина обязательна схемой: «ИТ отказал» без объяснения заказчик прочитает как молчание.
    expect(silent.statusCode, silent.body).toBe(400);

    const rejected = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/it-approval`,
      ctx.itApprover.auth,
      {
        approved: false,
        reason: 'Второй монитор выдаём со склада, ремонт не нужен',
        version: dto.version,
      },
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    // Своего терминального статуса у отказа нет (Р53): заявка закрыта тем же «Отменена», а
    // отличает его событие истории.
    expect(rejected.json().status).toBe('cancelled');
    expect(rejected.json().itApproval).toBeNull();

    const history = await inject(
      'GET',
      `/api/v1/service-requests/${dto.id}/history`,
      ctx.itApprover.auth,
    );
    const kinds = (history.json() as { kind: string; comment: string }[]).map((e) => e.kind);
    expect(kinds).toContain('itRejected');
  });

  it('заявку согласующего от ИТ визирует сама система, а заявку администратора — нет', async () => {
    const own = await createRequest(
      ctx.itApprover.auth,
      ctx.foreignDeptPrinter.id,
      'Гудит блок питания',
    );
    // Виза проставлена заведением (Р52): подписывать себе заявку вторым действием — ритуал.
    expect(own.status).toBe('it_approved');
    expect(own.itApproval?.auto).toBe(true);
    expect(own.itApproval?.by).toBe(ctx.itApprover.id);

    // Администратор заводит заявку не от имени ИТ (ADR 0032): его заявка ждёт визы наравне со
    // всеми, и автовиза ему не положена.
    const byAdmin = await createRequest(ctx.admin.auth, ctx.hintPrinter.id, 'Не включается');
    expect(byAdmin.status).toBe('new');
    expect(byAdmin.itApproval).toBeNull();

    // Прибираем за собой: обе заявки открытые, а по единице разрешена одна (Р21).
    for (const id of [own.id, byAdmin.id]) {
      const cancelled = await inject(
        'PATCH',
        `/api/v1/service-requests/${id}/status`,
        ctx.admin.auth,
        {
          status: 'cancelled',
          reason: 'Служебная заявка теста',
          version: await version(id, ctx.admin.auth),
        },
      );
      expect(cancelled.statusCode, cancelled.body).toBe(200);
    }
  });

  // ── Шаг 3. Исполнитель назначен ──

  it('оператор назначает сервис — заявка становится видна исполнителю', async () => {
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/service`,
      ctx.operator.auth,
      { serviceCounterpartyId: ctx.serviceCounterpartyId, version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('assigned');
    expect(dto.waitingOn).toBe('service');
    expect(dto.service?.id).toBe(ctx.serviceCounterpartyId);

    expect(await listIds(ctx.service.auth)).toContain(state.main.id);
  });

  // ── Шаг 3. Коридоры: у каждой стороны свои дуги (Р17) ──

  it('оператор не выполняет шаги исполнителя: диагностика, смета и закрытие — 403', async () => {
    // Право `serviceRequests.status` у надстройки есть, и по общей таблице переходов оператор смог
    // бы взять заявку в диагностику. Коридор исполнителя ему недоступен именно как коридор, а не
    // как отсутствующее право: отказ приходит от `assertSideAllowed`, а не от `requirePermission`.
    const start = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/start`,
      ctx.operator.auth,
      { version: await version(state.main.id) },
    );
    expect(start.statusCode, start.body).toBe(403);
    expect(start.json().message).toContain('шаг другой стороны');

    // Смета — право стороны исполнителя, и у надстройки его нет намеренно: выданные одному
    // субъекту, смета и её согласование превратили бы согласование в подпись под своей работой.
    // Здесь отказ приходит уже от права, и это разные отказы: сообщение их и различает.
    const submit = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/submit`,
      ctx.operator.auth,
      { version: await version(state.main.id) },
    );
    expect(submit.statusCode, submit.body).toBe(403);
    expect(submit.json().message).toContain('Смету ведёт исполнитель');

    const complete = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/complete`,
      ctx.operator.auth,
      { completedOn: TODAY, items: [], version: await version(state.main.id) },
    );
    expect(complete.statusCode, complete.body).toBe(403);
    expect(complete.json().message).toContain('Смету ведёт исполнитель');
  });

  it('сервис не согласует смету, не принимает работу и не отменяет заявку — 403', async () => {
    const approve = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/approval`,
      ctx.service.auth,
      { approved: true, version: await version(state.main.id) },
    );
    expect(approve.statusCode, approve.body).toBe(403);
    expect(approve.json().message).toContain('Смету согласует заказчик');

    // Право статуса у исполнителя есть — и приёмку, и отмену закрывает именно коридор.
    const accept = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/accept`,
      ctx.service.auth,
      { version: await version(state.main.id) },
    );
    expect(accept.statusCode, accept.body).toBe(403);
    expect(accept.json().message).toContain('шаг другой стороны');

    const cancel = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/status`,
      ctx.service.auth,
      {
        status: 'cancelled',
        reason: 'Не хотим этим заниматься',
        version: await version(state.main.id),
      },
    );
    expect(cancel.statusCode, cancel.body).toBe(403);
    expect(cancel.json().message).toContain('шаг другой стороны');
  });

  // ── Шаг 4. Диагностика и смета ──

  it('сервис берёт заявку в диагностику и наполняет смету', async () => {
    const started = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/start`,
      ctx.service.auth,
      { version: await version(state.main.id) },
    );
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().status).toBe('diagnostics');

    const put = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/estimate`,
      ctx.service.auth,
      {
        items: [
          { kind: 'part', name: 'Ролик подачи', quantity: 2, unitPrice: 1800, warrantyMonths: 6 },
          {
            kind: 'part',
            name: 'Тормозная площадка',
            quantity: 1,
            unitPrice: 900,
            warrantyMonths: 6,
          },
          {
            kind: 'service',
            name: 'Замена узла подачи',
            quantity: 1,
            unitPrice: 1500,
            warrantyMonths: 3,
          },
        ],
        version: started.json().version,
      },
    );
    expect(put.statusCode, put.body).toBe(200);
    const dto = put.json() as ServiceRequestDto;
    // Сумму строки считает БД (`amount` — GENERATED): производная не может разойтись со слагаемыми.
    expect(itemNamed(dto, 'Ролик подачи').amount).toBe(3600);
    expect(itemNamed(dto, 'Тормозная площадка').amount).toBe(900);
    expect(itemNamed(dto, 'Замена узла подачи').amount).toBe(1500);
    // Факт до закрытия не заполнен вовсе: `null`, а не `false` — иначе план читался бы как факт.
    expect(dto.items.map((i) => i.performed)).toEqual([null, null, null]);
    // Предъявленной суммы пока нет: смета — черновик, и ревизия у неё нулевая.
    expect(dto.estimatedTotalAmount).toBeNull();
    expect(dto.estimateRevision).toBe(0);
  });

  it('правка сметы с чужой версией — 409: окно простояло, пока смету меняли (Р30)', async () => {
    const stale = await version(state.main.id);
    const first = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/estimate`,
      ctx.service.auth,
      {
        items: [
          { kind: 'part', name: 'Ролик подачи', quantity: 2, unitPrice: 1800, warrantyMonths: 6 },
          {
            kind: 'part',
            name: 'Тормозная площадка',
            quantity: 1,
            unitPrice: 900,
            warrantyMonths: 6,
          },
          {
            kind: 'service',
            name: 'Замена узла подачи',
            quantity: 1,
            unitPrice: 1500,
            warrantyMonths: 3,
          },
        ],
        version: stale,
      },
    );
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().version).toBe(stale + 1);

    // Второе окно с той же версией: правка уже прошла, и его данные относятся к прошлой смете.
    const second = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/estimate`,
      ctx.service.auth,
      { items: [{ kind: 'service', name: 'Чистка', quantity: 1, unitPrice: 500 }], version: stale },
    );
    expect(second.statusCode, second.body).toBe(409);
    // Состав от отказавшей правки не пострадал: строки остались прежними.
    expect((await card(state.main.id)).items).toHaveLength(3);
  });

  it('сервис предъявляет смету: ревизия 1, сумма зафиксирована, смета заперта', async () => {
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/submit`,
      ctx.service.auth,
      { version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('estimate_review');
    expect(dto.waitingOn).toBe('operator');
    expect(dto.estimateRevision).toBe(1);
    // Снимок предъявленной суммы: по нему потом сверяется закрытие.
    expect(dto.estimatedTotalAmount).toBe(6000);
    expect(dto.estimateSubmittedAt).not.toBeNull();
    expect(dto.approval).toBeNull();
  });

  it('предъявленная смета правке не подлежит — 409 (Р14)', async () => {
    // 409, а не 422: смету запер не сам исполнитель, а её предъявление, — и человеку нужно
    // обновить окно, а не исправить данные.
    const res = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/estimate`,
      ctx.service.auth,
      {
        items: [{ kind: 'part', name: 'Ролик подачи', quantity: 9, unitPrice: 1800 }],
        version: await version(state.main.id),
      },
    );
    expect(res.statusCode, res.body).toBe(409);
    expect((await card(state.main.id)).estimatedTotalAmount).toBe(6000);
  });

  // ── Шаг 5. Согласование и вторая ревизия ──

  it('оператор согласует смету: снимок «кто, когда, какая ревизия»', async () => {
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/approval`,
      ctx.operator.auth,
      { approved: true, version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('in_work');
    expect(dto.waitingOn).toBe('service');
    expect(dto.approval).toMatchObject({ by: ctx.operator.id, revision: 1 });
  });

  it('сервис переоткрывает смету: согласование сброшено, состав и ревизия сохранены', async () => {
    // Единственный путь изменить согласованную смету (Р14): дуги `in_work → estimate_review` нет
    // намеренно, и второй путь назад сделал бы этот инвариант необязательным.
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/reopen`,
      ctx.service.auth,
      {
        reason: 'Нужен ещё термоузел — без него ремонт не держит',
        version: await version(state.main.id),
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('diagnostics');
    // Матрица §5.4: снимок согласования недействителен, а смета остаётся черновиком той же ревизии.
    expect(dto.approval).toBeNull();
    expect(dto.estimateRevision).toBe(1);
    expect(dto.items).toHaveLength(3);
    expect(dto.estimatedTotalAmount).toBe(6000);
  });

  it('сервис меняет состав и предъявляет ревизию 2', async () => {
    const put = await inject(
      'PUT',
      `/api/v1/service-requests/${state.main.id}/estimate`,
      ctx.service.auth,
      {
        items: [
          { kind: 'part', name: 'Ролик подачи', quantity: 2, unitPrice: 1800, warrantyMonths: 6 },
          {
            kind: 'part',
            name: 'Тормозная площадка',
            quantity: 1,
            unitPrice: 900,
            warrantyMonths: 6,
          },
          {
            kind: 'service',
            name: 'Замена узла подачи',
            quantity: 1,
            unitPrice: 1500,
            warrantyMonths: 3,
          },
          { kind: 'part', name: 'Термоузел', quantity: 1, unitPrice: 4400, warrantyMonths: 12 },
        ],
        version: await version(state.main.id),
      },
    );
    expect(put.statusCode, put.body).toBe(200);

    const submit = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/submit`,
      ctx.service.auth,
      { version: put.json().version },
    );
    expect(submit.statusCode, submit.body).toBe(200);
    const dto = submit.json() as ServiceRequestDto;
    expect(dto.estimateRevision).toBe(2);
    expect(dto.estimatedTotalAmount).toBe(10400);
    expect(dto.approval).toBeNull();
  });

  it('до повторного согласования работы не закрываются', async () => {
    // Заявка стоит в «Смете на согласовании», и закрытие упирается в коридор исполнителя: из этого
    // статуса у него дуг нет вовсе. Проверка совпадения ревизий (409) сюда не доходит и дойти не
    // может — она сторожит другое состояние, и оно проверяется следующим тестом.
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/complete`,
      ctx.service.auth,
      { completedOn: TODAY, items: [], version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(403);
    // Отказ по коридору, а не по праву: закрывать работы исполнителю можно, но не из этого статуса.
    expect(res.json().message).toContain('не может перевести заявку');
  });

  it('оператор согласует ревизию 2', async () => {
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/estimate/approval`,
      ctx.operator.auth,
      { approved: true, version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('in_work');
    expect(res.json().approval.revision).toBe(2);
  });

  it('работы по несогласованной ревизии сметы не закрываются — 409', async () => {
    // Состояние «в работе, а ревизии разошлись» через API недостижимо: смета правится только в
    // «Диагностике», а вернуться из неё в «В работе» можно лишь через согласование, которое
    // ревизии и равняет. Поэтому расхождение делается прямым UPDATE — иначе страховку инварианта
    // (Р12) не проверить вовсе, а сработает она ровно на испорченных данных.
    const before = await card(state.main.id);
    await ctx.db.execute(sql`
      UPDATE service_requests SET estimate_revision = estimate_revision + 1
      WHERE id = ${state.main.id}`);

    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/complete`,
      ctx.service.auth,
      { completedOn: TODAY, items: [], version: before.version },
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain('Согласована ревизия сметы 2');

    await ctx.db.execute(sql`
      UPDATE service_requests SET estimate_revision = ${before.estimateRevision}
      WHERE id = ${state.main.id}`);
    expect((await card(state.main.id)).estimateRevision).toBe(2);
  });

  // ── Шаг 6. Закрытие работ ──

  it('сервис закрывает работы: итог считает сервер, гарантии — только выполненным строкам', async () => {
    const before = await card(state.main.id);
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/complete`,
      ctx.service.auth,
      {
        completedOn: TODAY,
        items: [
          // Роликов согласовали два, поставили один: фактическое количество меньше планового.
          {
            id: itemNamed(before, 'Ролик подачи').id,
            performed: true,
            actualQuantity: 1,
          },
          // Тормозная площадка не понадобилась — гарантии на неустановленную деталь не бывает.
          { id: itemNamed(before, 'Тормозная площадка').id, performed: false },
          { id: itemNamed(before, 'Замена узла подачи').id, performed: true },
          // Дата из талона побеждает расчёт и помечается введённой руками. Талон здесь заведомо
          // просроченный: по нему проверяется отказ гарантийного обращения ниже.
          {
            id: itemNamed(before, 'Термоузел').id,
            performed: true,
            warrantyUntil: SHORT_WARRANTY_ON,
          },
        ],
        adjustmentAmount: -700,
        adjustmentReason: 'Скидка по акту: выезд не выставляли',
        version: before.version,
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('done');
    expect(dto.waitingOn).toBe('operator');

    // Итог не принимается от клиента: сумма выполненных (1800 + 0 + 1500 + 4400) плюс скидка.
    expect(dto.completion).toMatchObject({
      totalAmount: 7000,
      adjustmentAmount: -700,
      adjustmentReason: 'Скидка по акту: выезд не выставляли',
    });

    const roller = itemNamed(dto, 'Ролик подачи');
    expect(roller).toMatchObject({ performed: true, actualQuantity: 1, actualAmount: 1800 });
    // Гарантия считается от даты выполнения календарными месяцами, а не тридцатью днями.
    expect(roller.warrantyUntil).toBe(plusMonths(TODAY, 6));
    expect(roller.warrantyUntilManual).toBe(false);

    const plate = itemNamed(dto, 'Тормозная площадка');
    expect(plate).toMatchObject({ performed: false, actualAmount: 0, warrantyUntil: null });

    const work = itemNamed(dto, 'Замена узла подачи');
    expect(work).toMatchObject({ performed: true, actualAmount: 1500 });
    expect(work.warrantyUntil).toBe(plusMonths(TODAY, 3));

    const fuser = itemNamed(dto, 'Термоузел');
    expect(fuser).toMatchObject({ warrantyUntil: SHORT_WARRANTY_ON, warrantyUntilManual: true });

    state.performedItemId = roller.id;
    state.notPerformedItemId = plate.id;
    state.expiredItemId = fuser.id;
  });

  // ── Шаг 7. Возврат на доработку ──

  it('возврат на доработку снимает факт целиком, а смету и согласование сохраняет', async () => {
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/rework`,
      ctx.operator.auth,
      { reason: 'Лоток по-прежнему заедает — доделайте', version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('in_work');

    // Матрица §5.4: дата, итог, корректировка, отметки строк и гарантии — всё это предъявят заново.
    expect(dto.completion).toBeNull();
    for (const item of dto.items) {
      expect(item.performed).toBeNull();
      expect(item.actualQuantity).toBeNull();
      expect(item.actualAmount).toBeNull();
      // Гарантия снимается и посчитанная, и введённая руками: возврат отменяет само выполнение, а
      // строка без выполнения гарантии не держит (CHECK в БД).
      expect(item.warrantyUntil).toBeNull();
      expect(item.warrantyUntilManual).toBe(false);
    }
    // Смета и согласование остаются: работу возвращают ту же и по той же согласованной цене.
    expect(dto.items).toHaveLength(4);
    expect(dto.estimateRevision).toBe(2);
    expect(dto.estimatedTotalAmount).toBe(10400);
    expect(dto.approval?.revision).toBe(2);
  });

  it('повторное закрытие проходит и даёт тот же итог', async () => {
    const before = await card(state.main.id);
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/complete`,
      ctx.service.auth,
      {
        completedOn: TODAY,
        items: [
          { id: itemNamed(before, 'Ролик подачи').id, performed: true, actualQuantity: 1 },
          { id: itemNamed(before, 'Тормозная площадка').id, performed: false },
          { id: itemNamed(before, 'Замена узла подачи').id, performed: true },
          {
            id: itemNamed(before, 'Термоузел').id,
            performed: true,
            warrantyUntil: SHORT_WARRANTY_ON,
          },
        ],
        adjustmentAmount: -700,
        adjustmentReason: 'Скидка по акту: выезд не выставляли',
        version: before.version,
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('done');
    expect(dto.completion?.totalAmount).toBe(7000);
    // Идентичность строк возврат не трогал: гарантийные обращения ниже ссылаются на те же id.
    expect(itemNamed(dto, 'Ролик подачи').id).toBe(state.performedItemId);
    expect(itemNamed(dto, 'Ролик подачи').warrantyUntil).toBe(plusMonths(TODAY, 6));
  });

  // ── Шаг 8. Приёмка ──

  it('оператор принимает работу — заявка становится терминальной', async () => {
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/accept`,
      ctx.operator.auth,
      { version: await version(state.main.id) },
    );
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as ServiceRequestDto;
    expect(dto.status).toBe('accepted');
    expect(dto.waitingOn).toBe('nobody');
    expect(dto.acceptedAt).not.toBeNull();
    expect(dto.acceptedByName).not.toBe('');
  });

  // ── Шаг 9. Документы после приёмки (§8.3) ──

  it('акт подшивается и после приёмки, вложение — нет, а снять документ уже нельзя', async () => {
    // «Акт пришлю завтра» иначе означало бы потерянную бумагу (Р16, Р29): закрытая заявка бумаги
    // принимает и ничего не отдаёт.
    const actFile = await uploadedFile(ctx.service.id, 'akt.pdf');
    const act = await inject(
      'POST',
      `/api/v1/service-requests/${state.main.id}/files`,
      ctx.service.auth,
      { fileIds: [actFile], kind: 'act' },
    );
    expect(act.statusCode, act.body).toBe(200);
    expect((act.json() as ServiceRequestDto).files).toEqual([
      expect.objectContaining({ id: actFile, kind: 'act' }),
    ]);

    // Вложение — вид «обычной жизни» заявки, и после терминального статуса его не принимают:
    // правило одной строкой — закрытая заявка принимает только документы (акт, счёт, талон).
    const attachment = await uploadedFile(ctx.service.id, 'foto.pdf');
    const plain = await inject(
      'POST',
      `/api/v1/service-requests/${state.main.id}/files`,
      ctx.service.auth,
      { fileIds: [attachment], kind: 'attachment' },
    );
    expect(plain.statusCode, plain.body).toBe(422);

    // Снимает документ из закрытой заявки только тот, кто распоряжается чужими файлами; у
    // исполнителя такого права нет, даже если акт подшил он сам.
    const detach = await inject(
      'DELETE',
      `/api/v1/service-requests/${state.main.id}/files/${actFile}`,
      ctx.service.auth,
    );
    expect(detach.statusCode, detach.body).toBe(403);
    expect((await card(state.main.id)).files).toHaveLength(1);
  });

  // ── Шаг 10. Заявки-спутники: источники гарантийных обращений ──

  it('после приёмки на ту же единицу заводится новая заявка — и её отменяют со сметой', async () => {
    // Первая половина проверки Р21 была отказом (409); вторая — что закрытая заявка место больше
    // не занимает. Эта заявка нужна и дальше: отменённая, но со сметой, она даёт позицию ремонта
    // из **непринятой** заявки на той же единице.
    const dto = await createRequest(
      ctx.customer.auth,
      ctx.mfp.id,
      'Полосит при печати — посмотрите заодно',
    );
    state.cancelled = { id: dto.id, num: dto.num, itemId: '' };

    await toDiagnostics(dto.id);
    const put = await inject(
      'PUT',
      `/api/v1/service-requests/${dto.id}/estimate`,
      ctx.service.auth,
      {
        items: [
          { kind: 'part', name: 'Девелопер', quantity: 1, unitPrice: 2500, warrantyMonths: 6 },
        ],
        version: await version(dto.id),
      },
    );
    expect(put.statusCode, put.body).toBe(200);
    state.cancelled.itemId = itemNamed(put.json() as ServiceRequestDto, 'Девелопер').id;

    const cancelled = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/status`,
      ctx.operator.auth,
      { status: 'cancelled', reason: 'Аппарат решили менять целиком', version: put.json().version },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    // Отмена шлёт письмо службе, поэтому ответ у неё такой же, как у заведения: заявка и исход.
    const after = (cancelled.json() as { request: ServiceRequestDto }).request;
    expect(after.status).toBe('cancelled');
    // Отмена возвращает заявку в состояние «ничего не делали»: исполнителя и согласования у неё
    // больше нет, но состав сметы остаётся историей того, что собирались чинить.
    expect(after.service).toBeNull();
    expect(after.items).toHaveLength(1);
  });

  it('отказ исполнителя возвращает заявку оператору и снимает сервис, но не визу ИТ', async () => {
    const dto = await createRequest(ctx.customer.auth, ctx.scanner.id, 'Не протягивает лист');
    state.otherUnit = { id: dto.id, itemId: '' };
    await approveByIt(dto.id);

    const assigned = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/service`,
      ctx.operator.auth,
      { serviceCounterpartyId: ctx.serviceCounterpartyId, version: await version(dto.id) },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);

    const declined = await inject(
      'PATCH',
      `/api/v1/service-requests/${dto.id}/decline`,
      ctx.service.auth,
      { reason: 'Сканеры этой серии не обслуживаем', version: assigned.json().version },
    );
    expect(declined.statusCode, declined.body).toBe(200);
    const after = declined.json() as ServiceRequestDto;
    // Матрица §5.4: исполнителя снимает сам переход — заявка снова ничья и ждёт оператора. Виза
    // ИТ при ней остаётся: решение «внешний ремонт нужен» отказом подрядчика не отменяется (Р51).
    expect(after.status).toBe('it_approved');
    expect(after.service).toBeNull();
    expect(after.waitingOn).toBe('operator');
    expect(after.itApproval?.at).toBeTruthy();
    // И она снова невидима исполнителю, который от неё отказался.
    expect(await listIds(ctx.service.auth)).not.toContain(dto.id);
  });

  it('после повторного назначения та же заявка даёт «чужую» позицию ремонта', async () => {
    const dto = await card(state.otherUnit.id);
    await toDiagnostics(dto.id);
    const put = await inject(
      'PUT',
      `/api/v1/service-requests/${dto.id}/estimate`,
      ctx.service.auth,
      {
        items: [
          { kind: 'part', name: 'Ролик сканера', quantity: 1, unitPrice: 700, warrantyMonths: 6 },
        ],
        version: await version(dto.id),
      },
    );
    expect(put.statusCode, put.body).toBe(200);
    state.otherUnit.itemId = itemNamed(put.json() as ServiceRequestDto, 'Ролик сканера').id;
  });

  // ── Шаг 11. Гарантийное обращение (Р26) ──

  it('обращение по выполненной строке принятой заявки проходит', async () => {
    const dto = await createRequest(
      ctx.customer.auth,
      ctx.mfp.id,
      'Снова не тянет бумагу — месяц после ремонта',
      { warrantyClaim: { source: 'item', itemId: state.performedItemId } },
    );
    state.claim = { id: dto.id, num: dto.num };
    expect(dto.warrantyClaim).toMatchObject({
      source: 'item',
      itemId: state.performedItemId,
      itemName: 'Ролик подачи',
      // Спор с сервисом ведут по номеру заявки-источника — он и приезжает в карточке.
      sourceRequestNum: state.main.num,
    });
  });

  it('обращение отклоняется, если основание не годится: четыре ветки проверки', async () => {
    /** Смена источника у заведённой заявки: обращение проверяется заново, как при заведении. */
    const claim = async (id: string, itemId: string) =>
      inject('PATCH', `/api/v1/service-requests/${id}`, ctx.customer.auth, {
        warrantyClaim: { source: 'item', itemId },
        version: await version(id, ctx.customer.auth),
      });

    // Работа не выполнялась — гарантии на неё нет вовсе.
    const notPerformed = await claim(state.claim.id, state.notPerformedItemId);
    expect(notPerformed.statusCode, notPerformed.body).toBe(422);
    expect(notPerformed.json().message).toContain('не выполнялась');

    // Срок кончился. Такого состояния через API не получить: сервер не принимает талон, гарантия
    // по которому истекает раньше даты выполнения, — поэтому дата состаривается прямым UPDATE, как
    // и расхождение ревизий выше. Проверяется здесь именно ветка «гарантия была, но истекла», а не
    // ввод испорченного талона.
    await ctx.db.execute(sql`
      UPDATE service_request_items SET warranty_until = ${EXPIRED_ON}
      WHERE id = ${state.expiredItemId}`);
    const expired = await claim(state.claim.id, state.expiredItemId);
    expect(expired.statusCode, expired.body).toBe(422);
    expect(expired.json().message).toContain('истекла');

    // Позиция из заявки на другой единице: гарантия на ролик сканера этому МФУ не поможет.
    const foreign = await claim(state.claim.id, state.otherUnit.itemId);
    expect(foreign.statusCode, foreign.body).toBe(422);
    expect(foreign.json().message).toContain('другой единице');

    // Заявка-источник не принята (отменена): ремонта не было, гарантировать нечего.
    const notAccepted = await claim(state.claim.id, state.cancelled.itemId);
    expect(notAccepted.statusCode, notAccepted.body).toBe(422);
    expect(notAccepted.json().message).toContain('не принята');

    // Ни одна отклонённая попытка обращение не сдвинула.
    expect((await card(state.claim.id)).warrantyClaim?.itemId).toBe(state.performedItemId);
  });

  it('заявку, по гарантии которой обратились, нельзя удалить насовсем — 409 с номером обращения', async () => {
    // Ссылка объявлена `ON DELETE RESTRICT`, и человеку нужен не код 23503, а номер заявки,
    // которая на неё сослалась: спор с сервисом ведут именно по нему.
    const removed = await inject(
      'DELETE',
      `/api/v1/service-requests/${state.main.id}`,
      ctx.admin.auth,
    );
    expect(removed.statusCode, removed.body).toBe(200);

    const purged = await inject(
      'DELETE',
      `/api/v1/service-requests/${state.main.id}/purge`,
      ctx.admin.auth,
    );
    expect(purged.statusCode, purged.body).toBe(409);
    expect(purged.json().message).toContain(formatServiceRequestNumber(state.claim.num));

    // Заявка возвращается из архива: закрытая, место по единице она не занимает (Р21).
    const restored = await inject(
      'POST',
      `/api/v1/service-requests/${state.main.id}/restore`,
      ctx.admin.auth,
    );
    expect(restored.statusCode, restored.body).toBe(200);
    expect((restored.json() as ServiceRequestDto).deletedAt).toBeNull();
  });

  // ── Шаг 12. Область видимости ──

  it('штаб чужой площадки заявку не видит — ни в списке, ни по прямому id', async () => {
    expect(await listIds(ctx.foreignShtab.auth)).not.toContain(state.main.id);
    const direct = await inject(
      'GET',
      `/api/v1/service-requests/${state.main.id}`,
      ctx.foreignShtab.auth,
    );
    expect(direct.statusCode, direct.body).toBe(403);
  });

  it('роль отдела видит заявку своего отдела и заявку по технике своего отдела', async () => {
    // Ось отдела двойная (Р5): заявку ведёт и тот, кто её подал, и отдел, за которым числится
    // техника. Первую заводит сам отдел, вторую — администратор на технику этого отдела.
    const own = await createRequest(
      ctx.department.auth,
      ctx.freePrinter.id,
      'Зажёвывает бумагу при двусторонней печати',
    );
    state.deptOwn = { id: own.id };
    expect(own.customerDepartment?.id).toBe(ctx.departmentId);
    expect(own.equipmentDepartment).toBeNull();

    const owned = await createRequest(ctx.admin.auth, ctx.deptPrinter.id, 'Не видит сеть');
    state.deptOwned = { id: owned.id };
    // Администратор отделов не имеет — заявка объектная, но техника числится за отделом.
    expect(owned.customerDepartment).toBeNull();
    expect(owned.equipmentDepartment?.id).toBe(ctx.departmentId);

    const visible = await listIds(ctx.department.auth);
    expect(visible).toContain(state.deptOwn.id);
    expect(visible).toContain(state.deptOwned.id);
    // Заявка площадки без отделов отделу не видна: `NULL` означает «к отделам не относится», а не
    // «видна всем» — иначе «ничья» заявка осталась бы видна каждому отделу навсегда.
    expect(visible).not.toContain(state.main.id);
    const foreign = await inject(
      'GET',
      `/api/v1/service-requests/${state.main.id}`,
      ctx.department.auth,
    );
    expect(foreign.statusCode, foreign.body).toBe(403);
  });

  it('сервис видит только назначенные ему заявки', async () => {
    // Заявку отдела назначают другому исполнителю: она перестаёт быть «Новой», но нашему сервису
    // от этого видна не становится — область исполнителя считается по контрагенту, а не по статусу.
    await approveByIt(state.deptOwned.id);
    const assigned = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.deptOwned.id}/service`,
      ctx.admin.auth,
      {
        serviceCounterpartyId: ctx.otherServiceCounterpartyId,
        version: await version(state.deptOwned.id, ctx.admin.auth),
      },
    );
    expect(assigned.statusCode, assigned.body).toBe(200);

    const visible = await listIds(ctx.service.auth);
    // Свои: главная заявка и заявка на сканере, которую он ведёт.
    expect(visible).toContain(state.main.id);
    expect(visible).toContain(state.otherUnit.id);
    // Чужие: назначенная другому сервису и ещё никому не назначенная.
    expect(visible).not.toContain(state.deptOwned.id);
    expect(visible).not.toContain(state.deptOwn.id);
    expect(visible).not.toContain(state.claim.id);

    const direct = await inject(
      'GET',
      `/api/v1/service-requests/${state.deptOwned.id}`,
      ctx.service.auth,
    );
    expect(direct.statusCode, direct.body).toBe(403);
  });

  // ── Шаг 13. Справочник и незакрытая заявка (Р33) ──

  it('единицу с незакрытой заявкой из справочника не удаляют — 409', async () => {
    // По МФУ висит гарантийное обращение: пока аппарат в работе, его карточка — единственное, чем
    // заявка объясняет, что именно чинят.
    const res = await inject('DELETE', `/api/v1/office-equipment/${ctx.mfp.id}`, ctx.operator.auth);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain(formatServiceRequestNumber(state.claim.num));

    // Карточка на месте: отказ ничего не унёс побочным эффектом.
    const still = await inject('GET', `/api/v1/office-equipment/${ctx.mfp.id}`, ctx.operator.auth);
    expect(still.statusCode, still.body).toBe(200);
    expect(still.json().deletedAt).toBeNull();
  });

  // ── Шаг 14. Остальные правила документов (§8.3) ──
  //
  // Шаг 9 закрыл главную пару: акт после приёмки принимают, вложение — нет, и снять документ
  // приложивший уже не может. Здесь дописано остальное из таблицы §8.3, потому что «принимает
  // только документы» — это три вида из пяти, а не один, и «снять нельзя» — правило про право, а
  // не про человека.

  it('закрытая заявка принимает счёт и гарантийный талон, но не смету', async () => {
    const attach = async (kind: string, filename: string) => {
      const fileId = await uploadedFile(ctx.service.id, filename);
      const res = await inject(
        'POST',
        `/api/v1/service-requests/${state.main.id}/files`,
        ctx.service.auth,
        { fileIds: [fileId], kind },
      );
      return { fileId, res };
    };

    const invoice = await attach('invoice', 'schet.pdf');
    expect(invoice.res.statusCode, invoice.res.body).toBe(200);
    const warrantyCard = await attach('warranty_card', 'talon.pdf');
    expect(warrantyCard.res.statusCode, warrantyCard.res.body).toBe(200);

    // Смета — вид исполнителя из середины цикла: после приёмки она не «ещё один документ», а
    // попытка переписать то, что уже согласовали и приняли.
    const estimate = await attach('estimate', 'smeta.pdf');
    expect(estimate.res.statusCode, estimate.res.body).toBe(422);
    expect(estimate.res.json().message).toContain('принимает только документы');

    // В заявке остались акт шага 9 и две принятые бумаги: отказ ничего не подшил побочно.
    const files = (await card(state.main.id)).files;
    expect(files.map((f) => f.kind).sort()).toEqual(['act', 'invoice', 'warranty_card']);
    state.attachedInvoiceId = invoice.fileId;
  });

  it('снимает документ из закрытой заявки только распорядитель чужих файлов', async () => {
    // Отказ исполнителю проверен шагом 9; здесь — вторая половина того же правила: закрывает
    // снятие отсутствие `files.manageAny`, а не то, кто именно подшивал бумагу. Иначе «снять
    // нельзя» читалось бы как «нельзя никому», и ошибочно подшитый счёт остался бы в заявке
    // навсегда.
    const res = await inject(
      'DELETE',
      `/api/v1/service-requests/${state.main.id}/files/${state.attachedInvoiceId}`,
      ctx.admin.auth,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as ServiceRequestDto).files.map((f) => f.kind).sort()).toEqual([
      'act',
      'warranty_card',
    ]);
  });

  it('смету снимают в «Диагностике» и не снимают после предъявления', async () => {
    // Заявка на сканере стоит в «Диагностике» со своей строкой сметы — на ней и проверяется
    // единственное исключение из «вложение снимает приложивший»: предъявленную смету не вынимают
    // из карточки, её возвращают в диагностику (Р14).
    const attach = async (filename: string) => {
      const fileId = await uploadedFile(ctx.service.id, filename);
      const res = await inject(
        'POST',
        `/api/v1/service-requests/${state.otherUnit.id}/files`,
        ctx.service.auth,
        { fileIds: [fileId], kind: 'estimate' },
      );
      expect(res.statusCode, res.body).toBe(200);
      return fileId;
    };
    const detach = (fileId: string) =>
      inject(
        'DELETE',
        `/api/v1/service-requests/${state.otherUnit.id}/files/${fileId}`,
        ctx.service.auth,
      );

    const draft = await attach('kp-chernovik.pdf');
    const removed = await detach(draft);
    expect(removed.statusCode, removed.body).toBe(200);
    expect((removed.json() as ServiceRequestDto).files).toEqual([]);

    const final = await attach('kp.pdf');
    const submitted = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.otherUnit.id}/estimate/submit`,
      ctx.service.auth,
      { version: await version(state.otherUnit.id) },
    );
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json().status).toBe('estimate_review');

    const locked = await detach(final);
    expect(locked.statusCode, locked.body).toBe(422);
    expect(locked.json().message).toContain('Предъявленная смета не снимается');
    expect((await card(state.otherUnit.id)).files).toHaveLength(1);
  });

  // ── Шаг 15. От чьего имени заявка: выбор отдела заказчика (Р5) ──
  //
  // Ветка «у автора ровно один отдел» пройдена шагом 12 (заявка сотрудника отдела на неразмеченную
  // технику), ветки «отделов нет вовсе» — шагом 1 (штаб) и тем же шагом 12 (администратор). Здесь
  // остаются три, которые видны только на учётке с **двумя** отделами: на одном подсказка из
  // техники и единственный отдел дают один и тот же ответ.

  it('подсказка приходит из отдела-владельца техники, а не из набора отделов автора', async () => {
    const dto = await createRequest(
      ctx.multiDepartment.auth,
      ctx.hintPrinter.id,
      'Печатает с полосой по краю',
    );
    // Техника числится за вторым отделом учётки — от его имени заявка и заведена, хотя выбор
    // человеку не предъявляли: спрашивать нечего, ответ уже есть в карточке техники.
    expect(dto.customerDepartment?.id).toBe(ctx.secondDepartmentId);
    expect(dto.equipmentDepartment?.id).toBe(ctx.secondDepartmentId);
  });

  it('без подсказки из техники отдел у автора нескольких отделов обязателен — 422', async () => {
    const payload = {
      officeEquipmentId: ctx.choicePrinter.id,
      description: 'Не включается',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
    };
    const res = await inject('POST', '/api/v1/service-requests', ctx.multiDepartment.auth, payload);
    // 422, а не «взяли первый отдел набора»: первый элемент массива — это случайный отдел, и
    // заявка ушла бы в область, к которой человек её не относил.
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('Укажите отдел');

    // Тупика при этом нет: названный свой отдел принимается тем же запросом.
    const chosen = await inject('POST', '/api/v1/service-requests', ctx.multiDepartment.auth, {
      ...payload,
      customerDepartmentId: ctx.secondDepartmentId,
    });
    expect(chosen.statusCode, chosen.body).toBe(201);
    const dto = (chosen.json() as { request: ServiceRequestDto }).request;
    expect(dto.customerDepartment?.id).toBe(ctx.secondDepartmentId);
    // Техника не размечена — второй отдельской оси у заявки нет вовсе.
    expect(dto.equipmentDepartment).toBeNull();
  });

  it('заявку от чужого отдела роль отдела не заводит — 403', async () => {
    const res = await inject('POST', '/api/v1/service-requests', ctx.multiDepartment.auth, {
      officeEquipmentId: ctx.freePrinter.id,
      description: 'Проверка чужого отдела',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      customerDepartmentId: ctx.foreignDepartmentId,
    });
    // 403, а не 422: дело не в состоянии заявки, а в том, что от имени этого отдела учётке
    // работать не положено вовсе (`resolveCustomerDepartment`, Р5).
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().message).toContain('только от своих отделов');
  });

  // ── Шаг 16. Область справочника оргтехники (Р7) ──
  //
  // Коды ответов по правам — предмет `access-matrix.test.ts`: там закреплено, что справочник
  // закрыт коменданту и сервисной компании целиком, а ведение приходит надстройкой. Здесь
  // проверяется то, чего матрица прав не видит, — **область**: право есть, а строка чужая.

  it('объект правкой карточки не меняется вовсе — для переезда есть своя ручка (Р59)', async () => {
    const res = await inject('PATCH', `/api/v1/office-equipment/${ctx.mfp.id}`, ctx.operator.auth, {
      objectId: ctx.foreignObjectId,
    });
    // 400 схемы, а не 403 области: поле из правки убрано — переезд обязан оставлять след в
    // журнале, и тихая смена площадки в форме такого следа не оставляла.
    expect(res.statusCode, res.body).toBe(400);

    const still = await inject('GET', `/api/v1/office-equipment/${ctx.mfp.id}`, ctx.operator.auth);
    expect(still.statusCode, still.body).toBe(200);
    expect(still.json().object.id).toBe(ctx.objectId);
  });

  it('чужую единицу не перемещают: область проверяется по исходной стороне (Р60)', async () => {
    const res = await inject(
      'POST',
      `/api/v1/office-equipment/${ctx.foreignDeptPrinter.id}/move`,
      ctx.department.auth,
      {
        objectId: ctx.objectId,
        movedOn: TODAY,
        reason: 'Забираем к себе',
      },
    );
    // «Забрать» чужую технику нельзя: перемещение фиксирует отдающая сторона.
    expect(res.statusCode, res.body).toBe(403);
  });

  it('штаб чужой площадки техники не видит — ни в списке, ни по прямому id', async () => {
    expect(await equipmentIds(ctx.foreignShtab.auth)).not.toContain(ctx.mfp.id);
    const direct = await inject(
      'GET',
      `/api/v1/office-equipment/${ctx.mfp.id}`,
      ctx.foreignShtab.auth,
    );
    expect(direct.statusCode, direct.body).toBe(403);
  });

  it('роль отдела видит свою и неразмеченную технику, но не технику чужого отдела', async () => {
    const visible = await equipmentIds(ctx.department.auth);
    expect(visible).toContain(ctx.deptPrinter.id);
    // Неразмеченная техника открыта намеренно: разметить её больше некому, и спрятать её от
    // единственного, кто может проставить владельца, значит закрыть разметку навсегда.
    expect(visible).toContain(ctx.freePrinter.id);
    expect(visible).not.toContain(ctx.foreignDeptPrinter.id);
    // Второй отдел этой учётке не принадлежит: техника соседнего отдела ей так же чужая.
    expect(visible).not.toContain(ctx.hintPrinter.id);

    const direct = await inject(
      'GET',
      `/api/v1/office-equipment/${ctx.foreignDeptPrinter.id}`,
      ctx.department.auth,
    );
    expect(direct.statusCode, direct.body).toBe(403);
    expect(direct.json().message).toContain('только с техникой своих отделов');
  });

  /**
   * Реестр действующих гарантий (§9.5) и секция обслуживания в карточке единицы (§8.2).
   *
   * Оба ответа собираются из одних и тех же данных, но по разным правилам видимости, и проверяются
   * вместе именно поэтому: реестр сужается **двумя** областями сразу — парк техники отдаётся по
   * области справочника, ремонты по области заявок, — а секция карточки открывается правом модуля,
   * хотя живёт в справочнике.
   */
  describe('гарантии: реестр и карточка единицы', () => {
    /** Гарантия поставщика — своя, не из ремонта: без неё в реестре был бы один носитель из двух. */
    const SUPPLIER_WARRANTY_ON = plusMonths(TODAY, 24);

    async function warranties(auth: Auth, query = ''): Promise<ServiceWarrantyRowDto[]> {
      const res = await inject('GET', `/api/v1/service-requests/warranties${query}`, auth);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().items as ServiceWarrantyRowDto[];
    }

    it('оператор видит оба носителя: гарантию поставщика и гарантию на выполненный ремонт', async () => {
      const patch = await inject(
        'PATCH',
        `/api/v1/office-equipment/${ctx.mfp.id}`,
        ctx.operator.auth,
        {
          warrantyUntil: SUPPLIER_WARRANTY_ON,
        },
      );
      expect(patch.statusCode, patch.body).toBe(200);

      const rows = await warranties(ctx.operator.auth);
      const supplier = rows.find((r) => r.kind === 'equipment' && r.equipmentId === ctx.mfp.id);
      expect(supplier, 'гарантия поставщика в реестре').toBeDefined();
      expect(supplier).toMatchObject({ warrantyUntil: SUPPLIER_WARRANTY_ON, state: 'active' });
      // Заявки у гарантии поставщика нет: её источник — покупка, а не ремонт.
      expect(supplier!.requestId).toBeNull();

      const repair = rows.find((r) => r.itemId === state.performedItemId);
      expect(repair, 'гарантия на выполненный ремонт в реестре').toBeDefined();
      // Реестр — единственное место, где портал берёт `itemId` для обращения по прошлому ремонту
      // (Р26): без него ссылку на позицию сметы человеку взять негде.
      expect(repair).toMatchObject({
        kind: 'repair',
        equipmentId: ctx.mfp.id,
        requestId: state.main.id,
        displayNumber: `СО-${state.main.num}`,
      });

      // Истёкшая гарантия — история: реестр отвечает на вопрос «что ещё покрыто», и просроченная
      // строка в нём означала бы, что по ней ещё можно обратиться.
      expect(rows.some((r) => r.itemId === state.expiredItemId)).toBe(false);
      // Невыполненная позиция гарантии не несёт вовсе (Р12) — ни в реестре, ни в базе.
      expect(rows.some((r) => r.itemId === state.notPerformedItemId)).toBe(false);
    });

    it('сервисная компания видит свои ремонты и не видит парка заказчика', async () => {
      const rows = await warranties(ctx.service.auth);
      expect(rows.some((r) => r.itemId === state.performedItemId)).toBe(true);
      // Справочник исполнителю закрыт (Р7), и реестр — не обход этого запрета: «его» техника в
      // справочнике ничем не отмечена, поэтому гарантии парка означали бы для сервиса весь парк.
      expect(rows.every((r) => r.kind === 'repair')).toBe(true);
    });

    it('штаб чужой площадки не видит ни гарантий техники, ни гарантий её ремонтов', async () => {
      expect(await warranties(ctx.foreignShtab.auth)).toEqual([]);
    });

    it('фильтр «истекает» отбирает по порогу подсветки, а не по всему сроку', async () => {
      // Гарантия, которая правда кончается на днях: месячный срок ремонта в порог не попадает —
      // тридцать дней порога короче календарного месяца, и проверять фильтр им значило бы
      // проверять длину августа.
      const soon = plusDays(TODAY, 10);
      const patch = await inject(
        'PATCH',
        `/api/v1/office-equipment/${ctx.scanner.id}`,
        ctx.operator.auth,
        { warrantyUntil: soon },
      );
      expect(patch.statusCode, patch.body).toBe(200);

      const rows = await warranties(ctx.operator.auth, '?expiring=true');
      expect(rows.some((r) => r.equipmentId === ctx.scanner.id && r.kind === 'equipment')).toBe(
        true,
      );
      // Гарантия поставщика на два года — не «истекает»: иначе срез «что продлевать в этом
      // месяце» вернул бы весь парк.
      expect(rows.some((r) => r.kind === 'equipment' && r.equipmentId === ctx.mfp.id)).toBe(false);
      expect(rows.every((r) => (r.daysLeft ?? 0) <= WARRANTY_EXPIRING_DAYS)).toBe(true);
    });

    it('карточка единицы рассказывает оператору, что с техникой уже делали', async () => {
      const res = await inject('GET', `/api/v1/office-equipment/${ctx.mfp.id}`, ctx.operator.auth);
      expect(res.statusCode, res.body).toBe(200);
      const history = res.json().serviceHistory as OfficeEquipmentServiceEntryDto[];
      expect(history, 'секция обслуживания').toBeDefined();

      const main = history.find((e) => e.id === state.main.id);
      expect(main, 'закрытая заявка в истории').toBeDefined();
      expect(main).toMatchObject({ displayNumber: `СО-${state.main.num}`, status: 'accepted' });
      // Гарантии — только действующие и только по выполненным позициям: карточку открывают, чтобы
      // понять, за что второй раз платить не нужно.
      const covered = main!.warranties.map((w) => w.itemId);
      expect(covered).toContain(state.performedItemId);
      expect(covered).not.toContain(state.expiredItemId);
      expect(covered).not.toContain(state.notPerformedItemId);
    });

    it('держателю справочника секции нет вовсе — право справочника её не открывает', async () => {
      const res = await inject('GET', `/api/v1/office-equipment/${ctx.mfp.id}`, ctx.keeper.auth);
      // Карточка ему открыта: техникой он и занимается.
      expect(res.statusCode, res.body).toBe(200);
      // А поля нет совсем, а не пустым списком: пустой список означал бы «ремонтов не было», и
      // менеджер решил бы, что аппарат ни разу не чинили.
      expect(res.json().serviceHistory).toBeUndefined();
    });
  });

  // ── Шаг 18. Приём заявки и срочность (план модернизации, Р49, Р56, Р57) ──

  describe('заявитель и срочность', () => {
    it('заявка без ФИО и телефона не заводится — обязательность живёт на сервере, а не в форме', async () => {
      // Своя единица: по каждой разрешена одна открытая заявка (Р21), и занимать чужую нельзя.
      state.urgent.equipmentId = await makeEquipment({
        typeId: ctx.typeId,
        name: 'HP LaserJet M404',
        inventoryNumber: `ОЕ-${RUN}-9`,
        objectId: ctx.objectId,
      });

      const noName = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
        officeEquipmentId: state.urgent.equipmentId,
        description: 'Мигает лампа замятия',
        responsiblePhone: '+79990000000',
      });
      expect(noName.statusCode, noName.body).toBe(400);

      const noPhone = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
        officeEquipmentId: state.urgent.equipmentId,
        description: 'Мигает лампа замятия',
        responsibleName: 'Иванов Иван Иванович',
      });
      expect(noPhone.statusCode, noPhone.body).toBe(400);
    });

    it('срочность ставится парой «флаг + причина» и снимается вместе с причиной', async () => {
      const dto = await createRequest(
        ctx.customer.auth,
        state.urgent.equipmentId,
        'Не тянет бумагу',
        {
          isUrgent: true,
          urgencyReason: 'Единственный принтер на площадке',
        },
      );
      state.urgent = { ...state.urgent, id: dto.id, num: dto.num };
      expect(dto.isUrgent).toBe(true);
      expect(dto.urgencyReason).toBe('Единственный принтер на площадке');

      // Флаг без объяснения не проходит ни в заведении, ни в своей ручке: срочность без причины
      // через месяц стоит у всех заявок, и отбирать ею становится нечего (Р56).
      const halfPair = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/urgency`,
        ctx.operator.auth,
        { isUrgent: true, version: dto.version },
      );
      expect(halfPair.statusCode, halfPair.body).toBe(400);

      const cleared = await inject(
        'PATCH',
        `/api/v1/service-requests/${dto.id}/urgency`,
        ctx.operator.auth,
        { isUrgent: false, version: await version(dto.id) },
      );
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().isUrgent).toBe(false);
      // Причина уходит вместе с флагом: оставшийся текст читался бы как «срочность сняли, но
      // повод остался».
      expect(cleared.json().urgencyReason).toBe('');
    });

    it('оператор ставит срочность и после назначения сервиса, а исполнитель — не ставит вовсе', async () => {
      const id = state.urgent.id;
      await approveByIt(id);
      const assigned = await inject(
        'PATCH',
        `/api/v1/service-requests/${id}/service`,
        ctx.operator.auth,
        {
          serviceCounterpartyId: ctx.serviceCounterpartyId,
          version: await version(id),
        },
      );
      expect(assigned.statusCode, assigned.body).toBe(200);

      // Заказчику заявка уже не правится (§5.3), и срочность вместе с ней: «Новой» она больше не
      // является.
      const byCustomer = await inject(
        'PATCH',
        `/api/v1/service-requests/${id}/urgency`,
        ctx.customer.auth,
        { isUrgent: true, urgencyReason: 'Совсем встало', version: await version(id) },
      );
      expect(byCustomer.statusCode, byCustomer.body).toBe(403);

      // Исполнителю признак не принадлежит вовсе: срочность — решение заказывающей стороны.
      const byService = await inject(
        'PATCH',
        `/api/v1/service-requests/${id}/urgency`,
        ctx.service.auth,
        { isUrgent: true, urgencyReason: 'Поставим себе в приоритет', version: await version(id) },
      );
      expect(byService.statusCode, byService.body).toBe(403);

      const byOperator = await inject(
        'PATCH',
        `/api/v1/service-requests/${id}/urgency`,
        ctx.operator.auth,
        { isUrgent: true, urgencyReason: 'Встала выдача пропусков', version: await version(id) },
      );
      expect(byOperator.statusCode, byOperator.body).toBe(200);
      expect(byOperator.json().isUrgent).toBe(true);
      // Возраст в статусе срочность не сбрасывает: она не ожидание, и очередь «дольше всех ждут»
      // не должна обнуляться от того, что заявку пометили красным.
      expect(byOperator.json().statusChangedAt).toBe(assigned.json().statusChangedAt);
    });

    it('срочные идут первыми в списке и отбираются своим фильтром', async () => {
      const all = await inject('GET', '/api/v1/service-requests?pageSize=100', ctx.operator.auth);
      expect(all.statusCode, all.body).toBe(200);
      const items = all.json().items as ServiceRequestDto[];
      expect(items[0]?.id, 'срочная заявка первой строкой').toBe(state.urgent.id);

      const onlyUrgent = await inject(
        'GET',
        '/api/v1/service-requests?urgent=true&pageSize=100',
        ctx.operator.auth,
      );
      expect(onlyUrgent.statusCode, onlyUrgent.body).toBe(200);
      const urgentItems = onlyUrgent.json().items as ServiceRequestDto[];
      expect(urgentItems.every((r) => r.isUrgent)).toBe(true);
      expect(urgentItems.map((r) => r.id)).toContain(state.urgent.id);
    });

    it('снимок места в заявке не переписывается переездом карточки', async () => {
      const moved = await inject(
        'PATCH',
        `/api/v1/office-equipment/${state.urgent.equipmentId}`,
        ctx.operator.auth,
        { location: 'кабинет 305' },
      );
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().location).toBe('кабинет 305');

      const request = await inject(
        'GET',
        `/api/v1/service-requests/${state.urgent.id}`,
        ctx.operator.auth,
      );
      expect(request.statusCode, request.body).toBe(200);
      // Заявка помнит место, где аппарат стоял в момент заведения: по нему ехали, и переезд
      // карточки этого не отменяет (Р57).
      expect(request.json().equipment.location).toBe('кабинет 214');
    });

    it('история заявки читает срочность отдельным событием, а не правкой', async () => {
      const res = await inject(
        'GET',
        `/api/v1/service-requests/${state.urgent.id}/history`,
        ctx.operator.auth,
      );
      expect(res.statusCode, res.body).toBe(200);
      const kinds = (res.json() as { kind: string; changes: { field: string }[] }[]).filter(
        (e) => e.kind === 'urgencyChanged',
      );
      expect(kinds.length, 'событий срочности').toBeGreaterThanOrEqual(2);
      expect(kinds.some((e) => e.changes.some((c) => c.field === 'isUrgent'))).toBe(true);
    });
  });

  // ── Шаг 19. Перемещения и местонахождение единицы (Р59–Р63) ──

  describe('перемещения техники', () => {
    it('перемещение записывает обе стороны, меняет карточку и попадает в ленту (Р59, Р62)', async () => {
      const equipmentId = state.urgent.equipmentId;
      const before = await inject(
        'GET',
        `/api/v1/office-equipment/${equipmentId}`,
        ctx.operator.auth,
      );
      expect(before.json().state).toBe('on_site');

      // Увезли в сервис — переезд, вызванный ремонтом: у записи есть ссылка на заявку.
      const away = await inject(
        'POST',
        `/api/v1/office-equipment/${equipmentId}/move`,
        ctx.operator.auth,
        {
          objectId: ctx.objectId,
          location: '',
          state: 'at_service',
          movedOn: TODAY,
          reason: 'Увезли в сервис по заявке',
          serviceRequestId: state.urgent.id,
        },
      );
      expect(away.statusCode, away.body).toBe(201);
      expect(away.json().state).toBe('at_service');

      // Переезд на чужую площадку разрешён (Р60): отдающий теряет технику из своего списка.
      const moved = await inject(
        'POST',
        `/api/v1/office-equipment/${equipmentId}/move`,
        ctx.operator.auth,
        {
          objectId: ctx.foreignObjectId,
          location: 'кабинет 12',
          state: 'on_site',
          movedOn: TODAY,
          reason: 'Перевод бухгалтерии на другую площадку',
        },
      );
      expect(moved.statusCode, moved.body).toBe(201);
      expect(moved.json().object.id).toBe(ctx.foreignObjectId);
      expect(moved.json().location).toBe('кабинет 12');

      // И из справочника отдающего она исчезла — это и есть «утрата, а не захват».
      expect(
        (await inject('GET', '/api/v1/office-equipment?pageSize=200', ctx.operator.auth))
          .json()
          .items.map((row: { id: string }) => row.id),
      ).not.toContain(equipmentId);

      // Лента карточки читается администратором: у него область сквозная.
      const history = await inject(
        'GET',
        `/api/v1/office-equipment/${equipmentId}/history`,
        ctx.admin.auth,
      );
      expect(history.statusCode, history.body).toBe(200);
      // Лента — один поток событий с курсором (Р75–Р79): перемещения приходят в нём наравне с
      // ремонтами, правками карточки и гарантиями, а не отдельным массивом.
      const page = history.json() as {
        items: {
          kind: string;
          toObject?: { id: string };
          toState?: string;
          serviceRequestNum?: number | null;
        }[];
        serviceVisible: boolean;
      };
      const movements = page.items.filter((event) => event.kind === 'movement');
      expect(movements).toHaveLength(2);
      // Свежее сверху: карточку открывают вопросом «где оно сейчас и откуда приехало».
      expect(movements[0]).toMatchObject({
        toObject: { id: ctx.foreignObjectId },
        toState: 'on_site',
      });
      expect(movements[1]).toMatchObject({
        toState: 'at_service',
        serviceRequestNum: state.urgent.num,
      });
      // Ремонтная часть открыта тому, кому открыт модуль.
      expect(page.serviceVisible).toBe(true);
      expect(page.items.some((event) => event.kind === 'service_request')).toBe(true);
    });

    it('перемещение без изменений и без причины не записывается', async () => {
      const equipmentId = ctx.scanner.id;
      const same = await inject(
        'POST',
        `/api/v1/office-equipment/${equipmentId}/move`,
        ctx.operator.auth,
        { objectId: ctx.objectId, location: 'кабинет 214', movedOn: TODAY, reason: 'Просто так' },
      );
      // Запись «переехало туда, где стояло» — строка ни о чём: журнал, которому нельзя верить,
      // хуже отсутствующего.
      expect(same.statusCode, same.body).toBe(422);

      const noReason = await inject(
        'POST',
        `/api/v1/office-equipment/${equipmentId}/move`,
        ctx.operator.auth,
        { objectId: ctx.foreignObjectId, movedOn: TODAY, reason: '' },
      );
      expect(noReason.statusCode, noReason.body).toBe(400);
    });

    it('«на складе» без уточнения не принимается: искать такую технику негде (Р61)', async () => {
      const res = await inject(
        'POST',
        `/api/v1/office-equipment/${ctx.scanner.id}/move`,
        ctx.operator.auth,
        {
          objectId: ctx.objectId,
          state: 'in_stock',
          movedOn: TODAY,
          reason: 'Сняли с эксплуатации до переезда',
        },
      );
      expect(res.statusCode, res.body).toBe(400);

      const ok = await inject(
        'POST',
        `/api/v1/office-equipment/${ctx.scanner.id}/move`,
        ctx.operator.auth,
        {
          objectId: ctx.objectId,
          state: 'in_stock',
          stateNote: 'Склад АХО, стеллаж 3',
          movedOn: TODAY,
          reason: 'Сняли с эксплуатации до переезда',
        },
      );
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json().stateNote).toBe('Склад АХО, стеллаж 3');

      // Срез «в ремонте, а заявок нет» её не показывает: она на складе, а не в сервисе.
      const stranded = await inject(
        'GET',
        '/api/v1/office-equipment?strandedAtService=true&pageSize=200',
        ctx.admin.auth,
      );
      expect(stranded.statusCode, stranded.body).toBe(200);
      expect(stranded.json().items.map((row: { id: string }) => row.id)).not.toContain(
        ctx.scanner.id,
      );
    });

    it('ленту обслуживания не отдают тому, кому закрыт модуль', async () => {
      const res = await inject(
        'GET',
        `/api/v1/office-equipment/${ctx.mfp.id}/history`,
        ctx.keeper.auth,
      );
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json() as { items: { kind: string }[]; serviceVisible: boolean };
      // События самой карточки он видит: это справочник, который он и ведёт (заведение,
      // перемещения, правки).
      expect(
        page.items.some((event) =>
          ['card_lifecycle', 'movement', 'card_change'].includes(event.kind),
        ),
      ).toBe(true);
      // А ремонтной части нет вовсе, и признак говорит именно «не положено видеть», а не «пусто»:
      // то же правило, что у секции карточки.
      expect(page.serviceVisible).toBe(false);
      expect(page.items.some((event) => event.kind === 'service_request')).toBe(false);
    });
  });
});
