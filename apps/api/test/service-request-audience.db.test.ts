import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatServiceRequestNumber,
  moscowDateKeyOf,
  type ServiceRequestDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Карточка заявки на обслуживание в объёме аудитории (ADR 0160, план
 * `docs/office-equipment-requester-card-plan.md` §7.2) — на живой схеме и через настоящие HTTP-пути.
 *
 * Зачем база, когда рядом стоит контрактный файл. Контрактами проверяется САМА ПРОЕКЦИЯ — что она
 * вычищает и чего не трогает; здесь проверяется, что её ЗОВУТ ВЕЗДЕ. А «везде» — это девять разных
 * дорог к одним и тем же данным: карточка, список, ответы действий, история, подшивка, снятие
 * файла, отбор «Ожидаются документы» и архив. Дороги эти сходятся не в коде, а в базе: аудитория
 * строки считается по её `service_counterparty_id` и строкам `service_request_executors`, отбор
 * уходит в SQL, а история читает снимки из `audit_log`. Собери мы это на моках — проверили бы
 * моки, а типовая ошибка класса ровно в том, что одна из дорог осталась непроецированной
 * («карточка чистая, а список течёт»).
 *
 * Фикстура одна на файл (§7.2): две заявки одной базовой области, одна назначена внутреннему
 * исполнителю; у ремонта смета на 7 100 ₽, согласование, закрытие с актом, счётом и гарантийным
 * талоном. Учётки — заказчик (роль отдела), наблюдатель, «Ведение», ИТ-служба, внутренний
 * исполнитель (`execute` БЕЗ `.finance`), сервисная компания и архивариус.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test -- service-request-audience.db
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: база у db-тестов общая и переживает повторный запуск. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

/** День закрытия работ — сегодня по Москве: от него сервер отсчитывает гарантии строк. */
const TODAY = moscowDateKeyOf(new Date());

/** Итог сметы ремонта: 1 × 5 000 + 2 × 1 050. Ровно те 7 100 ₽, которых заявитель видеть не должен. */
const ESTIMATE_TOTAL = 7100;

interface Auth {
  authorization: string;
}

interface TestUser {
  id: string;
  email: string;
  /** ФИО считает БД (`full_name` — GENERATED): в эталоне стоит то, что она посчитала. */
  fullName: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: заводит декорации, удаляет заявку в архив и служит контролем «в базе суммы есть». */
  admin: TestUser;
  /** Заказчик — роль отдела: заводит заявки своего отдела и денег по ним не видит. */
  customer: TestUser;
  /**
   * Наблюдатель (ADR 0033): видит заявки всей компании и НЕ получает `.finance` (решение заказчика
   * 03.09.2026). Без него «заявитель» и «тот, кому не выдали право» неразличимы: у заказчика есть
   * своя заявка, и ответ мог бы держаться на авторстве, а не на праве.
   */
  observer: TestUser;
  /** «Ведение» — штаб площадки плюс надстройка `office_equipment_operator` (право `.finance`). */
  operator: TestUser;
  /** ИТ-служба: сквозная область модуля и то же право `.finance` надстройкой. */
  itApprover: TestUser;
  /**
   * Внутренний исполнитель: `serviceRequests.execute` набором прогона и НИ ОДНОГО `.finance`.
   * Деньги ему открывает только назначение — ровно на назначенной строке (ADR 0160, решение 1).
   */
  executor: TestUser;
  /** Оператор сервисной компании: назначенная заявка — его собственная смета и его счёт. */
  service: TestUser;
  /** Архивариус: `archive.read` набором прогона и опять же без `.finance` (решение 11). */
  archivist: TestUser;
  objectId: string;
  objectCode: string;
  objectName: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  serviceCounterpartyId: string;
  serviceCounterpartyName: string;
  /** Название типа оргтехники из сида: оно уходит снимком в карточку заявки. */
  typeName: string;
  /** Набор с одним правом `serviceRequests.finance`: им проверяется смена прав в живой сессии. */
  financeGrantId: string;
}

let ctx: Ctx;

interface FixtureRequest {
  id: string;
  num: number;
}

/** Что фикстура накопила: заявки и подшитые к ним файлы — по ним и идут проверки. */
const state: {
  /** Ремонт полного цикла: смета 7 100, согласование, закрытие, четыре документа. */
  repair: FixtureRequest;
  /** Заявка, назначенная ПОИМЁННО внутреннему исполнителю: на ней его аудитория финансовая. */
  assigned: FixtureRequest;
  /** Заявка без исполнителей, к которой подшит счёт: единственная, которую заказчик ещё правит. */
  plain: FixtureRequest;
  /** Заявка на расходники: ею проверяется, что проекция не задела соседнюю вкладку. */
  supplies: FixtureRequest;
  /** Удалённая в архив заявка со сметой: её читает архивариус. */
  archived: FixtureRequest;
  files: {
    attachment: string;
    act: string;
    invoice: string;
    warranty: string;
    /** Счёт заявки `plain`: он и делает ответ на её правку отличимым от непроецированного. */
    plainInvoice: string;
  };
  /** Позиция номенклатуры заявки на расходники. */
  consumableId: string;
} = {
  repair: { id: '', num: 0 },
  assigned: { id: '', num: 0 },
  plain: { id: '', num: 0 },
  supplies: { id: '', num: 0 },
  archived: { id: '', num: 0 },
  files: { attachment: '', act: '', invoice: '', warranty: '', plainInvoice: '' },
  consumableId: '',
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
  // S3 и почта в этом файле не участвуют: документы подшиваются уже загруженными строками `files`,
  // а предмет проверки — состав ответа, а не транспорт.
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

/**
 * Свой адрес на каждый запрос: общий ограничитель считает обращения с адреса, а учёток здесь восемь
 * и цикл заявки файл проходит пять раз. С общего адреса он упирался бы в 429 на середине — и
 * падение выглядело бы дефектом модуля.
 */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.60.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
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

async function card(id: string, auth: Auth): Promise<ServiceRequestDto> {
  const res = await inject('GET', `/api/v1/service-requests/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

/** Текущая версия заявки глазами «Ведения»: её спрашивает каждая изменяющая ручка. */
async function version(id: string): Promise<number> {
  return (await card(id, ctx.operator.auth)).version;
}

/** Страница списка глазами субъекта: она заведомо шире, чем данных у этого файла. */
async function listIds(auth: Auth, query = ''): Promise<string[]> {
  const res = await inject('GET', `/api/v1/service-requests?pageSize=200${query}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as ServiceRequestDto[]).map((row) => row.id);
}

async function listRow(auth: Auth, id: string): Promise<ServiceRequestDto> {
  const res = await inject('GET', `/api/v1/service-requests?pageSize=200`, auth);
  expect(res.statusCode, res.body).toBe(200);
  const row = (res.json().items as ServiceRequestDto[]).find((item) => item.id === id);
  if (!row) throw new Error(`Заявки ${id} нет в списке — проверять проекцию списка не на чем`);
  return row;
}

interface HistoryChange {
  field: string;
  from: string | null;
  to: string | null;
}
interface HistoryEntry {
  kind: string;
  comment: string;
  changes: HistoryChange[];
}

async function history(id: string, auth: Auth): Promise<HistoryEntry[]> {
  const res = await inject('GET', `/api/v1/service-requests/${id}/history`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as HistoryEntry[];
}

function changesOf(entries: HistoryEntry[], field: string): HistoryChange[] {
  return entries.flatMap((entry) => entry.changes.filter((change) => change.field === field));
}

describe.skipIf(!DB_URL)('карточка заявки на обслуживание в объёме аудитории (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const passwordHash = await hashPassword(PASSWORD);

    // Учётки, контрагент, площадка и отделы заводятся SQL: форма учётки и справочник контрагентов —
    // предмет своих тестов, а здесь они декорации, без которых не разложить семь читателей.
    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string; fullName: string }> {
      const email = `db-aud-${input.tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string; full_name: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Читатель', ${input.tag}, ${passwordHash},
                ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
        RETURNING id, full_name`);
      const row = res.rows[0]!;
      return { id: row.id, email, fullName: row.full_name };
    }

    const objectCode = `AUD-OBJ-${RUN}`;
    const objectName = `Тестовая площадка аудиторий ${RUN}`;
    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${objectCode}, ${objectName}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const makeDepartment = async (code: string, name: string): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO departments (code, name) VALUES (${code}, ${name}) RETURNING id`);
      return row.rows[0]!.id;
    };
    const departmentCode = `AUD-D-${RUN}`;
    const departmentName = `Тестовый отдел заказчика ${RUN}`;
    const departmentId = await makeDepartment(departmentCode, departmentName);
    // Отдел ИТ-службы — заведомо ЧУЖОЙ заказчику: так проверяется, что заявки согласующий видит
    // сквозной областью набора, а не своей осью, и деньги в них — правом, а не соседством.
    const itDepartmentId = await makeDepartment(`AUD-IT-${RUN}`, `Тестовый отдел ИТ-службы ${RUN}`);

    /**
     * ИНН — с настоящей контрольной суммой, а не «77…01»: контрагент лежит в общей базе, а обмен
     * справочниками выгружает её целиком и на выдуманном ИНН падает — падение выглядело бы дефектом
     * чужого модуля.
     */
    const innOf = (base9: string): string => {
      const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
      const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
      return `${base9}${(sum % 11) % 10}`;
    };
    const serviceCounterpartyName = `Сервис-Аудитория ${RUN}`;
    const counterpartyRow = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service'::counterparty_type, ${serviceCounterpartyName},
              ${innOf(`78${String(Date.now()).slice(-7)}`)})
      RETURNING id`);
    const serviceCounterpartyId = counterpartyRow.rows[0]!.id;

    const admin = await makeUser({ tag: 'admin', role: 'admin' });
    const customer = await makeUser({ tag: 'cust', role: 'department' });
    const observer = await makeUser({ tag: 'obs', role: 'observer' });
    const operator = await makeUser({ tag: 'oper', role: 'shtab' });
    const itApprover = await makeUser({ tag: 'it', role: 'department' });
    const executor = await makeUser({ tag: 'exec', role: 'shtab' });
    const archivist = await makeUser({ tag: 'arch', role: 'shtab' });
    const service = await makeUser({
      tag: 'serv',
      role: 'operator',
      counterpartyId: serviceCounterpartyId,
    });

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${operator.id}, ${objectId}), (${executor.id}, ${objectId}),
             (${archivist.id}, ${objectId})`);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id)
      VALUES (${customer.id}, ${departmentId}), (${itApprover.id}, ${itDepartmentId})`);

    /**
     * Надстройки роли выдаются СЕРВИСОМ, а не вставкой в таблицу: с шага 1a реформы (ADR 0106)
     * выдача пишет две таблицы одной транзакцией, и прямая вставка в старую оставила бы половину —
     * права набора считаются из `user_grants`. «Ведение» и ИТ-служба получают `.finance` именно
     * отсюда (миграция 0259), и подмена этого пути обесценила бы половину файла.
     */
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, operator.id, ['office_equipment_operator'], admin.id);
      await replaceUserAddons(tx, itApprover.id, ['office_equipment_it_approver'], admin.id);
    });

    /**
     * Наборы прогона — своими кодами, а не системными. Внутреннего исполнителя без `.finance`
     * системным набором не собрать вовсе: обе надстройки модуля это право несут, а
     * `office_equipment_executor` плана профилей в дереве ещё нет. Ветка от этого не страдает — она
     * про ФАКТ НАЗНАЧЕНИЯ, а не про набор, и субъект здесь ровно то, чем этот набор станет.
     *
     * Роль в `grant_roles` обязательна: права набора считаются через гейт совместимости с ролью
     * (`grantPermissionsExpr`), и без строки учётка не получила бы ни одного права.
     */
    const makeGrant = async (
      code: string,
      name: string,
      permissions: string[],
      role: string,
      holderIds: string[],
    ): Promise<string> => {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO grants (code, name, description, is_system, created_by)
        VALUES (${code}, ${name}, 'Набор прогона теста аудиторий (ADR 0160, §7.2)', false,
                ${admin.id})
        RETURNING id`);
      const grantId = row.rows[0]!.id;
      await db.execute(sql`
        INSERT INTO grant_permissions (grant_id, permission)
        SELECT ${grantId}, permission FROM unnest(${sql.raw(
          `ARRAY[${permissions.map((p) => `'${p}'`).join(',')}]`,
        )}) AS permission`);
      await db.execute(sql`
        INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, ${sql.raw(`'${role}'::role`)})`);
      for (const holderId of holderIds) {
        await db.execute(sql`
          INSERT INTO user_grants (user_id, grant_id, granted_by)
          VALUES (${holderId}, ${grantId}, ${admin.id})`);
      }
      return grantId;
    };

    await makeGrant(
      `aud-exec-${RUN}`,
      `Оргтехника: внутренний исполнитель ${RUN}`,
      ['serviceRequests.read', 'serviceRequests.execute', 'serviceRequests.files'],
      'shtab',
      [executor.id],
    );
    await makeGrant(
      `aud-arch-${RUN}`,
      `Архив заявок ${RUN}`,
      ['serviceRequests.read', 'archive.read'],
      'shtab',
      [archivist.id],
    );
    // Набор с ОДНИМ правом и БЕЗ держателей: его выдадут заказчику посреди прогона — тем и
    // проверяется, что аудитория считается на каждом запросе, а не запоминается в сессии.
    const financeGrantId = await makeGrant(
      `aud-fin-${RUN}`,
      `Деньги заявок ${RUN}`,
      ['serviceRequests.finance'],
      'department',
      [],
    );

    const typeRow = await db.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const type = typeRow.rows[0];
    if (!type) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');

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
    const withAuth = async (u: {
      id: string;
      email: string;
      fullName: string;
    }): Promise<TestUser> => ({ ...u, auth: await login(u.email) });

    ctx = {
      app,
      db,
      closeDb,
      admin: await withAuth(admin),
      customer: await withAuth(customer),
      observer: await withAuth(observer),
      operator: await withAuth(operator),
      itApprover: await withAuth(itApprover),
      executor: await withAuth(executor),
      service: await withAuth(service),
      archivist: await withAuth(archivist),
      objectId,
      objectCode,
      objectName,
      departmentId,
      departmentCode,
      departmentName,
      serviceCounterpartyId,
      serviceCounterpartyName,
      typeName: type.name,
      financeGrantId,
    };

    /**
     * Единица техники на каждую заявку: по единице и виду незакрытая заявка бывает одна. Площадка —
     * общая (её видят «Ведение», исполнитель и архивариус), отдел-владелец — заказчика (по нему его
     * роль отдела заявку и видит): обе оси области нужны разом.
     */
    const makeEquipment = async (tag: string): Promise<string> => {
      const row = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id,
                                      owner_department_id, location)
        VALUES (${type.id}, ${`МФУ ${tag} ${RUN}`}, ${`АУД-${RUN}-${tag}`}, ${objectId},
                ${departmentId}, 'кабинет 214')
        RETURNING id`);
      return row.rows[0]!.id;
    };

    /**
     * Загруженный файл строкой в `files`. Настоящая загрузка идёт через presign в S3, которого в
     * тесте нет, а предмет проверки — видимость вида документа, а не транспорт.
     */
    const uploadedFile = async (
      userId: string,
      filename: string,
      contentType = 'application/pdf',
    ): Promise<string> => {
      const row = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
        VALUES ('test', ${`aud/${RUN}/${randomUUID()}`}, ${filename}, ${contentType}, 2048,
                'pending', ${userId})
        RETURNING id`);
      return row.rows[0]!.id;
    };

    const createRequest = async (
      tag: string,
      description: string,
      extra: Record<string, unknown> = {},
    ): Promise<ServiceRequestDto> => {
      const res = await inject('POST', '/api/v1/service-requests', ctx.customer.auth, {
        officeEquipmentId: await makeEquipment(tag),
        description,
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
        ...extra,
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { request: ServiceRequestDto }).request;
    };

    const assign = async (
      id: string,
      body: { userIds: string[]; serviceCounterpartyId: string | null; reason?: string },
    ): Promise<void> => {
      const res = await inject(
        'PUT',
        `/api/v1/service-requests/${id}/executors`,
        ctx.operator.auth,
        {
          ...body,
          version: await version(id),
        },
      );
      expect(res.statusCode, res.body).toBe(200);
    };

    const start = async (id: string, auth: Auth): Promise<void> => {
      const res = await inject('PATCH', `/api/v1/service-requests/${id}/start`, auth, {
        version: await version(id),
      });
      expect(res.statusCode, res.body).toBe(200);
    };

    const putEstimate = async (id: string, items: Record<string, unknown>[]): Promise<void> => {
      const res = await inject('PUT', `/api/v1/service-requests/${id}/estimate`, ctx.service.auth, {
        items,
        version: await version(id),
      });
      expect(res.statusCode, res.body).toBe(200);
    };

    const submitEstimate = async (id: string): Promise<void> => {
      const res = await inject(
        'PATCH',
        `/api/v1/service-requests/${id}/estimate/submit`,
        ctx.service.auth,
        { version: await version(id) },
      );
      expect(res.statusCode, res.body).toBe(200);
    };

    const approveEstimate = async (id: string): Promise<void> => {
      const res = await inject(
        'PATCH',
        `/api/v1/service-requests/${id}/estimate/approval`,
        ctx.operator.auth,
        { approved: true, version: await version(id) },
      );
      expect(res.statusCode, res.body).toBe(200);
    };

    const attach = async (
      id: string,
      kind: string,
      filename: string,
      user: TestUser,
      contentType = 'application/pdf',
    ): Promise<string> => {
      const fileId = await uploadedFile(user.id, filename, contentType);
      const res = await inject('POST', `/api/v1/service-requests/${id}/files`, user.auth, {
        fileIds: [fileId],
        kind,
      });
      expect(res.statusCode, res.body).toBe(200);
      return fileId;
    };

    // ── Заявка 1: ремонт полного цикла. Эталон обеих аудиторий собирается по ней ──
    //
    // Вложение подшивается ЗАВЕДЕНИЕМ, чтобы порядок файлов в карточке был задан фикстурой, а не
    // порядком тестов: список файлов отсортирован по времени подшивки, и эталон сравнивается целиком.
    state.files.attachment = await uploadedFile(ctx.customer.id, 'фото-поломки.jpg', 'image/jpeg');
    const repair = await createRequest('repair', 'Не печатает, мнёт бумагу', {
      fileIds: [state.files.attachment],
    });
    state.repair = { id: repair.id, num: repair.num };
    await assign(repair.id, { userIds: [], serviceCounterpartyId });
    await start(repair.id, ctx.service.auth);
    await putEstimate(repair.id, [
      { kind: 'part', name: 'Термоузел', quantity: 1, unitPrice: 5000 },
      { kind: 'service', name: 'Замена термоузла', quantity: 2, unitPrice: 1050 },
    ]);
    await submitEstimate(repair.id);
    await approveEstimate(repair.id);
    // Акт — до закрытия: без закрывающего документа заявка сервиса в «Решена» не уходит.
    state.files.act = await attach(repair.id, 'act', 'акт.pdf', ctx.service);
    const before = await card(repair.id, ctx.operator.auth);
    const completed = await inject(
      'PATCH',
      `/api/v1/service-requests/${repair.id}/complete`,
      ctx.service.auth,
      {
        completedOn: TODAY,
        items: before.items.map((item) => ({ id: item.id, performed: true })),
        version: before.version,
      },
    );
    expect(completed.statusCode, completed.body).toBe(200);
    state.files.invoice = await attach(repair.id, 'invoice', 'счёт.pdf', ctx.service);
    state.files.warranty = await attach(repair.id, 'warranty_card', 'талон.pdf', ctx.service);

    /**
     * Строка истории «прикреплены файлы» кладётся ПРЯМОЙ ЗАПИСЬЮ в аудит, и это единственная
     * декорация файла, сделанная мимо ручки. Причина не в удобстве: перечень `filesAdded` пишет
     * только `diffServiceRequests` (правка заявки), а правка файлов не меняет — то есть сегодня
     * ЖИВОГО ПРОИЗВОДИТЕЛЯ у этого ключа нет. Ключ при этом остаётся в карте аудиторий и обязан
     * резаться: записи прошлых месяцев лежат в `metadata.changes` снимком, и именно на них фильтр и
     * работает. Строка ниже — такая запись, слово в слово в формате `diffServiceRequests`.
     */
    await ctx.db.execute(sql`
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES (${ctx.service.id}, 'serviceRequest.update', 'serviceRequest', ${repair.id},
              ${JSON.stringify({
                changes: [
                  {
                    field: 'filesAdded',
                    from: null,
                    to: 'фото-поломки.jpg, Счёт: счёт.pdf, Акт: акт.pdf',
                  },
                ],
              })}::jsonb)`);

    // ── Заявка 2: назначена ПОИМЁННО внутреннему исполнителю ──
    //
    // Сервисная компания назначена рядом с ним намеренно: смету ведёт она, а исполнителю нужен
    // ФАКТ назначения — и на снятии этого факта проверяется, что аудитория не запоминается.
    const assigned = await createRequest('named', 'Замятие в лотке 2');
    state.assigned = { id: assigned.id, num: assigned.num };
    await assign(assigned.id, { userIds: [executor.id], serviceCounterpartyId });
    await start(assigned.id, ctx.service.auth);
    await putEstimate(assigned.id, [
      { kind: 'service', name: 'Чистка тракта подачи', quantity: 1, unitPrice: 3000 },
    ]);
    await submitEstimate(assigned.id);
    // Согласование гасит предъявление: под висящим заявку не переназначают, а снимать назначение
    // файл будет именно переназначением.
    await approveEstimate(assigned.id);

    // ── Заявка 3: без исполнителей, но со счётом ──
    //
    // Единственная, которую заказчик ещё правит (правка открыта, пока заявку никому не отдали), и
    // при этом несущая невидимый ему документ. Без этой пары ответ на правку неотличим от
    // непроецированного: у заявки без денег и без закрытых документов вычитать нечего.
    const plain = await createRequest('plain', 'Полосит при печати');
    state.plain = { id: plain.id, num: plain.num };
    await assign(plain.id, { userIds: [], serviceCounterpartyId });
    await start(plain.id, ctx.service.auth);
    state.files.plainInvoice = await attach(plain.id, 'invoice', 'счёт-2.pdf', ctx.service);
    // Переназначение из «В работе» возвращает заявку в «Новую», отказ поимённого снимает последнего
    // исполнителя — и заявка снова правится заказчиком, сохранив подшитый счёт.
    await assign(plain.id, {
      userIds: [executor.id],
      serviceCounterpartyId: null,
      reason: 'Передаём своими силами',
    });
    const declined = await inject(
      'PATCH',
      `/api/v1/service-requests/${plain.id}/decline`,
      ctx.executor.auth,
      { reason: 'Нет запчасти на складе', version: await version(plain.id) },
    );
    expect(declined.statusCode, declined.body).toBe(200);

    // ── Заявка 4: расходники ──
    //
    // Позиция заводится с НУЛЕВЫМ остатком: непустой остаток обязан быть покрыт журналом движений
    // (триггер `office_equipment_consumable_stock_covered`), а выдачи в этом файле не происходит —
    // предмет проверки в том, что строки номенклатуры доходят до заявителя целиком, а не в складе.
    const consumableRow = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO office_equipment_consumables (code, name)
      VALUES (${`АУД${RUN.toUpperCase()}001`}, ${`Тонер аудиторий ${RUN}`})
      RETURNING id`);
    state.consumableId = consumableRow.rows[0]!.id;
    const supplies = await createRequest('supply', 'Закончился тонер', {
      kind: 'consumable',
      consumables: [{ consumableId: state.consumableId, requestedQuantity: 2 }],
    });
    state.supplies = { id: supplies.id, num: supplies.num };

    // ── Заявка 5: со сметой и удалённая в архив ──
    const archived = await createRequest('archive', 'Скрипит при подаче');
    state.archived = { id: archived.id, num: archived.num };
    await assign(archived.id, { userIds: [], serviceCounterpartyId });
    await start(archived.id, ctx.service.auth);
    await putEstimate(archived.id, [
      { kind: 'part', name: 'Ролик захвата', quantity: 1, unitPrice: 4200 },
    ]);
    await submitEstimate(archived.id);
    // Удаляет администратор: площадочной роли «В работе» уже не отдают, а предмет проверки —
    // архивная заявка со сметой, а не правило удаления.
    const removed = await inject(
      'DELETE',
      `/api/v1/service-requests/${archived.id}`,
      ctx.admin.auth,
    );
    expect(removed.statusCode, removed.body).toBe(200);
  }, 300_000);

  /**
   * Уборка: база у db-тестов общая и живёт между прогонами, поэтому файл уносит ровно то, что завёл
   * сам, и в порядке внешних ключей. Заявки держат технику, автора и контрагента; история статусов
   * ссылается на учётку `RESTRICT` — значит заявки удаляются раньше людей, а техника раньше
   * площадки и отделов.
   */
  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      const equipment = sql`SELECT id FROM office_equipment WHERE inventory_number LIKE ${`АУД-${RUN}-%`}`;
      const users = sql`SELECT id FROM users WHERE email LIKE ${`db-aud-%-${RUN}@example.invalid`}`;
      await ctx.db.execute(
        sql`DELETE FROM service_requests WHERE office_equipment_id IN (${equipment})`,
      );
      await ctx.db.execute(
        sql`DELETE FROM office_equipment_consumables WHERE code = ${`АУД${RUN.toUpperCase()}001`}`,
      );
      await ctx.db.execute(
        sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`АУД-${RUN}-%`}`,
      );
      /*
       * Модели, заведённые карточками этого файла. С миграции `0171` наименование карточки — это имя
       * строки справочника `office_equipment_models`: вставка без `model_id` заводит модель сама, а
       * удаление карточки её за собой не уносит. Отбор идёт по суффиксу прогона в самом
       * наименовании — копию боевого парка в этой базе он не заденет.
       */
      await ctx.db.execute(sql`
        DELETE FROM office_equipment_models m
         WHERE m.name LIKE ${`% ${RUN}`}
           AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
      // Отложенное удаление из S3 вместе с самим файлом: хранилища в тесте нет, и задача осталась бы
      // висеть в очереди живого планировщика.
      await ctx.db.execute(
        sql`DELETE FROM jobs WHERE payload->>'objectKey' LIKE ${`aud/${RUN}/%`}`,
      );
      await ctx.db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`aud/${RUN}/%`}`);
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-aud-%-${RUN}@example.invalid`}`,
      );
      // Наборы прогона: назначения ушли каскадом с учётками, состав и роли уйдут с самим набором.
      await ctx.db.execute(sql`DELETE FROM grants WHERE code LIKE ${`aud-%-${RUN}`}`);
      await ctx.db.execute(
        sql`DELETE FROM counterparties WHERE name = ${`Сервис-Аудитория ${RUN}`}`,
      );
      // Отделы раньше площадок: у отдела бывает своя площадка (ADR 0062), и ссылка на неё —
      // `RESTRICT`. У отделов этого файла её нет, но порядок не должен зависеть от этого.
      await ctx.db.execute(sql`DELETE FROM departments WHERE code LIKE ${`AUD-%-${RUN}`}`);
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${`AUD-OBJ-${RUN}`}`);
    }
    await ctx?.closeDb();
  });

  // ── Эталоны карточки ремонта ──
  //
  // ЛИТЕРАЛОМ, а не снимком чужого ответа, и сравнение идёт `toEqual` — целиком. Снимок поймал бы
  // только лишнее; потерянное поле он унёс бы вместе с собой, и «Ведение» осталось бы без суммы
  // молча. Динамические значения (идентификаторы, времена, версия) закрыты матчерами — но
  // закрыты ИМЕННО ОНИ: всё, о чём план принимал решение, стоит здесь числом и строкой.

  function fileDto(id: string, filename: string, kind: string, contentType = 'application/pdf') {
    return {
      id,
      filename,
      contentType,
      size: 2048,
      kind,
      attachedAt: expect.any(String),
    };
  }

  /**
   * Блок обсуждения сравнивается по составу, а стороны и право письма — матчерами: они считаются
   * ПРО ЧИТАТЕЛЯ (ADR 0141) и у семи учёток этого файла законно разные. Аудитория их не трогает —
   * в карте полей `chat` помечен `all`, — а состав блока эталон всё равно держит целиком.
   */
  const emptyChat = {
    canWrite: expect.any(Boolean),
    participantSides: expect.any(Array),
    total: 0,
    unreadMine: 0,
    unreadOthers: false,
    lastSeq: 0,
    readThroughSeq: 0,
  };

  function financeRepairCard(): Record<string, unknown> {
    return {
      audience: 'finance',
      id: state.repair.id,
      num: state.repair.num,
      displayNumber: formatServiceRequestNumber(state.repair.num),
      kind: 'repair',
      status: 'done',
      statusChangedAt: expect.any(String),
      // «Решена» ждёт приёмки — ход «Ведения».
      waitingOn: 'operator',
      heldFromStatus: null,
      holdReason: '',
      equipment: {
        id: expect.any(String),
        name: `МФУ repair ${RUN}`,
        serialNumber: '',
        inventoryNumber: `АУД-${RUN}-repair`,
        typeName: ctx.typeName,
        location: 'кабинет 214',
      },
      object: { id: ctx.objectId, code: ctx.objectCode, name: ctx.objectName },
      objectOverridden: false,
      objectMismatch: false,
      customerDepartment: {
        id: ctx.departmentId,
        code: ctx.departmentCode,
        name: ctx.departmentName,
      },
      equipmentDepartment: {
        id: ctx.departmentId,
        code: ctx.departmentCode,
        name: ctx.departmentName,
      },
      requesterPlace: { kind: 'department', id: ctx.departmentId, name: ctx.departmentName },
      description: 'Не печатает, мнёт бумагу',
      responsibleName: 'Иванов Иван Иванович',
      // Телефон хранится десятью цифрами: схема нормализует его на входе.
      responsiblePhone: '9990000000',
      isUrgent: false,
      urgencyReason: '',
      service: { id: ctx.serviceCounterpartyId, name: ctx.serviceCounterpartyName },
      executors: [],
      itApproval: null,
      warrantyClaim: null,
      estimateRevision: 1,
      estimatePendingRevision: null,
      estimateSubmittedAt: expect.any(String),
      estimatedTotalAmount: ESTIMATE_TOTAL,
      approval: {
        by: ctx.operator.id,
        byName: ctx.operator.fullName,
        at: expect.any(String),
        revision: 1,
      },
      items: [
        {
          id: expect.any(String),
          kind: 'part',
          name: 'Термоузел',
          quantity: 1,
          unitPrice: 5000,
          amount: 5000,
          performed: true,
          actualQuantity: null,
          actualAmount: 5000,
          warrantyMonths: null,
          warrantyUntil: null,
          warrantyUntilManual: false,
        },
        {
          id: expect.any(String),
          kind: 'service',
          name: 'Замена термоузла',
          quantity: 2,
          unitPrice: 1050,
          amount: 2100,
          performed: true,
          actualQuantity: null,
          actualAmount: 2100,
          warrantyMonths: null,
          warrantyUntil: null,
          warrantyUntilManual: false,
        },
      ],
      consumables: [],
      completion: {
        completedAt: expect.any(String),
        totalAmount: ESTIMATE_TOTAL,
        adjustmentAmount: null,
        adjustmentReason: '',
      },
      acceptedByName: '',
      acceptedAt: null,
      acceptanceSource: null,
      replacementRecommended: false,
      rejectionResolution: '',
      comment: '',
      serviceComment: '',
      chat: emptyChat,
      files: [
        fileDto(state.files.attachment, 'фото-поломки.jpg', 'attachment', 'image/jpeg'),
        fileDto(state.files.act, 'акт.pdf', 'act'),
        fileDto(state.files.invoice, 'счёт.pdf', 'invoice'),
        fileDto(state.files.warranty, 'талон.pdf', 'warranty_card'),
      ],
      createdByName: ctx.customer.fullName,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      deletedAt: null,
      version: expect.any(Number),
    };
  }

  /**
   * Эталон заявителя — тот же литерал с ПЕРЕЧИСЛЕННЫМИ вычетами (таблица Р4). Собран через
   * расширение финансового намеренно: так видно, что различий ровно столько, сколько решил план, а
   * поле, потерянное у обеих сторон, всё равно уронит финансовое сравнение — литерал-то один.
   */
  function requesterRepairCard(): Record<string, unknown> {
    return {
      ...financeRepairCard(),
      audience: 'requester',
      // Ноль, а не `null`: ревизия — счётчик, и при `requester` число не значит ничего.
      estimateRevision: 0,
      estimatePendingRevision: null,
      estimateSubmittedAt: null,
      estimatedTotalAmount: null,
      approval: null,
      items: [],
      // Дата закрытия ОСТАЁТСЯ: «работы закрыты 14 августа» — не деньги, а факт, которого заявитель
      // ждёт больше всего остального в этой карточке.
      completion: {
        completedAt: expect.any(String),
        totalAmount: null,
        adjustmentAmount: null,
        adjustmentReason: '',
      },
      files: [
        fileDto(state.files.attachment, 'фото-поломки.jpg', 'attachment', 'image/jpeg'),
        fileDto(state.files.warranty, 'талон.pdf', 'warranty_card'),
      ],
    };
  }

  // ── 1–3. Карточка: три читателя, один эталон ──

  it('заказчику карточка приходит без денег, объёма работ и закрытых документов', async () => {
    const dto = await card(state.repair.id, ctx.customer.auth);
    // Целиком, а не по полям: список полей DTO — часть решения, и новое поле обязано быть внесено в
    // эталон осознанно, а не «уехать заодно».
    expect(dto).toEqual(requesterRepairCard());
  });

  it('«Ведению» и сервисной компании — та же карточка целиком', async () => {
    // Оба сравнения полные и по одному литералу: сжатая до «сумма на месте» проверка пропустила бы
    // ровно ту ошибку, которой боится план с другой стороны, — потерю поля у привилегированного
    // читателя. Сервис здесь важен отдельно: право ему даёт ТИП КОНТРАГЕНТА, а не набор.
    expect(await card(state.repair.id, ctx.operator.auth)).toEqual(financeRepairCard());
    expect(await card(state.repair.id, ctx.service.auth)).toEqual(financeRepairCard());
    // ИТ-служба видит заявку чужого отдела сквозной областью набора, а деньги — своим правом.
    expect(await card(state.repair.id, ctx.itApprover.auth)).toEqual(financeRepairCard());
  });

  it('наблюдателю — как заказчику: право не выдано, а сквозная видимость его не заменяет', async () => {
    // Наблюдатель видит заявки всей компании и не является ни автором, ни исполнителем: если бы
    // аудитория держалась на авторстве или области, здесь она и разошлась бы с заказчиком.
    expect(await card(state.repair.id, ctx.observer.auth)).toEqual(requesterRepairCard());
  });

  // ── 4. Список идёт своим запросом ──

  it('список отдаёт заказчику ту же урезанную строку, что и карточка', async () => {
    /*
     * Отдельно от карточки, и это не дублирование: список собирается своим запросом (`loadDtos` по
     * странице), а карточка — своим (`getDto` по одной строке). «Карточка чистая, список течёт» —
     * типовая ошибка этого класса, и увидеть её можно только сравнив выдачу списка с эталоном.
     */
    expect(await listRow(ctx.customer.auth, state.repair.id)).toEqual(requesterRepairCard());
    expect(await listRow(ctx.operator.auth, state.repair.id)).toEqual(financeRepairCard());
  });

  // ── 5. История ──

  it('история заказчику: события на месте, цифры вычищены', async () => {
    const mine = await history(state.repair.id, ctx.customer.auth);
    const full = await history(state.repair.id, ctx.operator.auth);

    // Фикстура настоящая: у «Ведения» строки сметы в истории есть, и цена в них написана текстом.
    const priced = changesOf(full, 'estimateItemsAdded');
    expect(priced).toHaveLength(1);
    expect(priced[0]!.to).toContain('Термоузел');
    expect(priced[0]!.to).toContain('5000.00 ₽');

    // СОБЫТИЙ СТОЛЬКО ЖЕ: событие с опустевшим списком изменений не выбрасывается — «Объём работ
    // предъявлен» без цифр и есть ответ на вопрос «что происходило с моей заявкой», а провал в
    // ленте читался бы как поломка портала.
    expect(mine.map((entry) => entry.kind)).toEqual(full.map((entry) => entry.kind));
    expect(mine.some((entry) => entry.kind === 'estimateSubmitted')).toBe(true);

    // А цифр нет ни одной: ни ключа, ни цены, ни наименования позиции ремонта.
    expect(changesOf(mine, 'estimateItemsAdded')).toEqual([]);
    const text = JSON.stringify(mine.map((entry) => entry.changes));
    expect(text).not.toContain('5000.00');
    expect(text).not.toContain('Термоузел');

    // Перечень подшитых файлов режется по видимым видам, а не выбрасывается целиком: вложение в
    // строке остаётся, счёт и акт из неё уходят вместе со своими подписями.
    const mineFiles = changesOf(mine, 'filesAdded');
    expect(mineFiles).toHaveLength(1);
    expect(mineFiles[0]!.to).toBe('фото-поломки.jpg');
    expect(changesOf(full, 'filesAdded')[0]!.to).toBe(
      'фото-поломки.jpg, Счёт: счёт.pdf, Акт: акт.pdf',
    );
  });

  // ── 6. Отбор «Ожидаются документы» ──

  it('отбор «Ожидаются документы» заказчику молча игнорируется', async () => {
    /*
     * Молча, а не 422 (решение 9): отличие ответов «отказ» и «пустая выдача» само по себе оракул —
     * по нему перебором читается, подшит ли по заявке счёт, то есть ровно то, что закрыто в
     * карточке. Проверяется поэтому РАВЕНСТВО выдач, а не код ответа.
     */
    const plain = await listIds(ctx.customer.auth);
    const filtered = await listIds(ctx.customer.auth, '&awaitingDocuments=true');
    expect(filtered).toEqual(plain);
    // Фильтр и правда что-то отсекал бы: ни одна из заявок заказчика под него не подходит —
    // «Решена» у него с актом и счётом, остальные ещё не закрыты.
    expect(plain).toContain(state.repair.id);
    expect(await listIds(ctx.operator.auth, '&awaitingDocuments=true')).not.toContain(
      state.repair.id,
    );
  });

  // ── 7. Архив ──

  it('архивариус читает удалённую заявку, но без сумм', async () => {
    const mine = await card(state.archived.id, ctx.archivist.auth);
    expect(mine.audience).toBe('requester');
    expect(mine.deletedAt).not.toBeNull();
    expect(mine.estimatedTotalAmount).toBeNull();
    expect(mine.items).toEqual([]);

    // Контроль: в самой заявке смета есть — архив её не «потерял», а именно не показал.
    const full = await card(state.archived.id, ctx.admin.auth);
    expect(full.audience).toBe('finance');
    expect(full.estimatedTotalAmount).toBe(4200);
    expect(full.items).toHaveLength(1);

    // Заказчику архив закрыт целиком — правом, а не аудиторией: это разные вопросы.
    const closed = await inject(
      'GET',
      `/api/v1/service-requests/${state.archived.id}`,
      ctx.customer.auth,
    );
    expect(closed.statusCode).toBe(404);
  });

  // ── 8. Подшивка ──

  it('заказчик кладёт вложение, но не счёт: 403 по праву, а не 422 по форме', async () => {
    const fileId = await (async () => {
      const row = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
        VALUES ('test', ${`aud/${RUN}/${randomUUID()}`}, 'мой-счёт.pdf', 'application/pdf', 2048,
                'pending', ${ctx.customer.id})
        RETURNING id`);
      return row.rows[0]!.id;
    })();
    const denied = await inject(
      'POST',
      `/api/v1/service-requests/${state.plain.id}/files`,
      ctx.customer.auth,
      { fileIds: [fileId], kind: 'invoice' },
    );
    /*
     * 403, а не 422: неподходящий статус — ошибка формы, которую человек исправляет выбором, а
     * запрет по аудитории — отсутствие права. Слитые в один ответ, они предложили бы заявителю
     * «исправить» то, что исправить нельзя.
     */
    expect(denied.statusCode, denied.body).toBe(403);

    const photo = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
      VALUES ('test', ${`aud/${RUN}/${randomUUID()}`}, 'моё-фото.jpg', 'image/jpeg', 2048,
              'pending', ${ctx.customer.id})
      RETURNING id`);
    const ok = await inject(
      'POST',
      `/api/v1/service-requests/${state.plain.id}/files`,
      ctx.customer.auth,
      { fileIds: [photo.rows[0]!.id], kind: 'attachment' },
    );
    expect(ok.statusCode, ok.body).toBe(200);
    // Вложение своё — и в ответе оно есть: «подшил и потерял» здесь не случается.
    const dto = ok.json() as ServiceRequestDto;
    expect(dto.files.map((f) => f.id)).toContain(photo.rows[0]!.id);
  });

  // ── 9. Снятие ──

  it('заказчик снимает своё вложение и не снимает чужой акт — 404, а не 403', async () => {
    /*
     * 404 тем же текстом, что «связи нет вовсе»: разведи мы ответы, по коду читалось бы, есть ли у
     * заявки акт, — перебором идентификаторов и без единого скачивания.
     */
    const foreign = await inject(
      'DELETE',
      `/api/v1/service-requests/${state.repair.id}/files/${state.files.act}`,
      ctx.customer.auth,
    );
    expect(foreign.statusCode, foreign.body).toBe(404);
    // Отказ ничего не тронул: акт на месте у того, кому он виден.
    expect((await card(state.repair.id, ctx.operator.auth)).files.map((f) => f.id)).toContain(
      state.files.act,
    );

    const own = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
      VALUES ('test', ${`aud/${RUN}/${randomUUID()}`}, 'снимаемое.jpg', 'image/jpeg', 2048,
              'pending', ${ctx.customer.id})
      RETURNING id`);
    const ownId = own.rows[0]!.id;
    const attached = await inject(
      'POST',
      `/api/v1/service-requests/${state.plain.id}/files`,
      ctx.customer.auth,
      { fileIds: [ownId], kind: 'attachment' },
    );
    expect(attached.statusCode, attached.body).toBe(200);
    const detached = await inject(
      'DELETE',
      `/api/v1/service-requests/${state.plain.id}/files/${ownId}`,
      ctx.customer.auth,
    );
    expect(detached.statusCode, detached.body).toBe(200);
  });

  // ── 10. Смена прав в живой сессии ──

  it('выданное посреди сессии право открывает деньги тем же токеном', async () => {
    // Аудитория считается на КАЖДОМ запросе, а не запоминается при входе: токен ниже выдан до
    // выдачи права и не перевыпускается.
    expect((await card(state.repair.id, ctx.customer.auth)).estimatedTotalAmount).toBeNull();
    try {
      await ctx.db.execute(sql`
        INSERT INTO user_grants (user_id, grant_id, granted_by)
        VALUES (${ctx.customer.id}, ${ctx.financeGrantId}, ${ctx.admin.id})`);
      expect(await card(state.repair.id, ctx.customer.auth)).toEqual(financeRepairCard());
    } finally {
      // Право снимается тут же: остальные проверки файла читают заказчика без него, и оставленная
      // выдача сделала бы порядок тестов частью условия.
      await ctx.db.execute(sql`
        DELETE FROM user_grants
         WHERE user_id = ${ctx.customer.id} AND grant_id = ${ctx.financeGrantId}`);
    }
    expect((await card(state.repair.id, ctx.customer.auth)).estimatedTotalAmount).toBeNull();
  });

  // ── 11. Соседняя вкладка ──

  it('расходники у заказчика остаются целиком: проекция не задела соседнюю вкладку', async () => {
    const mine = await card(state.supplies.id, ctx.customer.auth);
    const full = await card(state.supplies.id, ctx.operator.auth);
    expect(mine.audience).toBe('requester');
    expect(mine.kind).toBe('consumable');
    // Цен в строках расходников нет ни одной, и вкладка «Номенклатура» — предмет заявки этого вида,
    // а не её финансовая сторона: обе аудитории видят один и тот же состав.
    expect(mine.consumables).toEqual(full.consumables);
    expect(mine.consumables).toHaveLength(1);
    expect(mine.consumables[0]!.requestedQuantity).toBe(2);
  });

  // ── 12. Ответ действия ──

  it('ответ на правку заявки проецируется так же, как карточка', async () => {
    /*
     * Ответы действий идут той же сборкой, что карточка, и «через карточку не видно, а через ответ
     * на сохранение видно» было бы дырой ровно того же класса, что прямая ссылка на файл. Заявка
     * `plain` для этого и собрана: заказчик её ещё правит (исполнителей у неё нет), а счёт к ней уже
     * подшит — значит вычитать есть что, и непроецированный ответ отличим от проецированного.
     */
    const fullBefore = await card(state.plain.id, ctx.operator.auth);
    expect(fullBefore.files.map((f) => f.id)).toContain(state.files.plainInvoice);

    const before = await card(state.plain.id, ctx.customer.auth);
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.plain.id}`,
      ctx.customer.auth,
      {
        responsiblePhone: '+79991112233',
        version: before.version,
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json() as ServiceRequestDto;
    expect(after.audience).toBe('requester');
    expect(after.responsiblePhone).toBe('9991112233');
    // Счёта в ответе нет — и ответ совпадает с тем, что отдаёт карточка тому же читателю.
    expect(after.files.map((f) => f.id)).not.toContain(state.files.plainInvoice);
    expect(after.files.map((f) => f.kind)).not.toContain('invoice');
    expect(after).toEqual(await card(state.plain.id, ctx.customer.auth));
  });

  // ── 13–14. Внутренний исполнитель: две аудитории в одной выдаче ──

  it('исполнителю назначенная заявка финансовая, соседняя — нет', async () => {
    /*
     * Одна выдача законно содержит обе аудитории: право `.finance` у исполнителя ОТСУТСТВУЕТ, и
     * деньги ему открывает факт назначения — ровно на назначенной строке. Это не третья аудитория,
     * а построчное применение двух.
     */
    const named = await card(state.assigned.id, ctx.executor.auth);
    expect(named.audience).toBe('finance');
    expect(named.estimatedTotalAmount).toBe(3000);
    expect(named.items).toHaveLength(1);

    const neighbour = await card(state.repair.id, ctx.executor.auth);
    expect(neighbour.audience).toBe('requester');
    expect(neighbour.estimatedTotalAmount).toBeNull();
    expect(neighbour.items).toEqual([]);
    expect(neighbour.files.map((f) => f.kind)).toEqual(['attachment', 'warranty_card']);

    // То же самое в списке, а не только в карточке: строки собираются одной страницей, и аудитория
    // считается по каждой отдельно.
    expect((await listRow(ctx.executor.auth, state.assigned.id)).audience).toBe('finance');
    expect((await listRow(ctx.executor.auth, state.repair.id)).audience).toBe('requester');
  });

  it('отбор «Ожидаются документы» исполнителю игнорируется целиком, а не построчно', async () => {
    /*
     * Право спрашивается СУБЪЕКТНОЕ, а не аудитория строки: отдельные строки выдачи у него законно
     * финансовые, но глобальный фильтр по ним стал бы оракулом по СОСЕДНИМ — неназначенным строкам
     * его базовой области.
     */
    const plain = await listIds(ctx.executor.auth);
    expect(await listIds(ctx.executor.auth, '&awaitingDocuments=true')).toEqual(plain);
    expect(plain).toContain(state.assigned.id);
    expect(plain).toContain(state.repair.id);
  });

  it('снятое назначение закрывает деньги тем же токеном', async () => {
    // Последним в файле: шаг снимает исполнителя с заявки, и заявка `assigned` дальше не нужна.
    const res = await inject(
      'PUT',
      `/api/v1/service-requests/${state.assigned.id}/executors`,
      ctx.operator.auth,
      {
        userIds: [],
        serviceCounterpartyId: ctx.serviceCounterpartyId,
        reason: 'Ведём силами подрядчика',
        version: await version(state.assigned.id),
      },
    );
    expect(res.statusCode, res.body).toBe(200);

    // Токен прежний, права прежние — изменился только факт назначения, и обе строки стали
    // одинаково редуцированными.
    expect((await card(state.assigned.id, ctx.executor.auth)).audience).toBe('requester');
    expect((await card(state.repair.id, ctx.executor.auth)).audience).toBe('requester');
  });
});
