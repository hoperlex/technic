import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceRequestDto, ServiceWarrantyRowDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as ServiceMail from '../src/services/service-request-mail';

/**
 * ЗАЯВКА С ПУСТЫМ ПРЕДМЕТОМ ЧИТАЕТСЯ ВСЕМИ РУЧКАМИ (Р8 плана
 * `docs/office-equipment-consumables-and-purchase-plan.md`, ADR 0146, решение 7; этап Э13).
 *
 * Зачем база, а не контрактный тест. Предмет проверки — ПОТЕРЯ СТРОКИ, а не форма ответа. Пока
 * соединения с карточкой техники, её типом и площадкой были внутренними, заявка без аппарата
 * пропадала из списка, из счётчика страницы, из реестра гарантий, из отбора «отметить все
 * прочитанными» и из выгрузки расхода — молча, без единой ошибки: SQL отрабатывал успешно, просто
 * строка в него не попадала. Такое видно только на живой схеме и настоящем запросе; на моках
 * проверялись бы моки.
 *
 * ПОЧЕМУ ЗАЯВКА ВСТАВЛЯЕТСЯ ПРЯМЫМ SQL, А НЕ РУЧКОЙ. Завести её сегодня нечем: право
 * `serviceRequests.createWithoutEquipment` и форма заведения приезжают следующим выпуском (2б), а
 * этот выпуск ничего не включает — он учит СЕРВЕР ЧИТАТЬ то, чего ещё нет. Ограничения снимать при
 * этом не приходится: миграция 0230 (соседняя волна того же пака) уже сняла `NOT NULL` с
 * `office_equipment_id` и `equipment_object_id` и поставила вместо них двусоставный
 * `service_requests_subject_check` — вставка ниже проходит его второй ветвью, «нет аппарата, ровно
 * один заказчик — отдел». Именно поэтому у всех заявок файла заказчиком стоит отдел: заявка без
 * аппарата и без заказчика запрещена схемой и невидима никому.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test service-request-empty-subject
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: база у db-тестов общая и переживает повторный запуск. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  mail: typeof ServiceMail;
  admin: Auth;
  adminId: string;
  /** Роль отдела — заказчик заявок без аппарата: только её осью они и видны. */
  dept: Auth;
  deptId: string;
  /** Роль площадки: заявка «от отдела» без аппарата к её объектам не относится никак. */
  shtab: Auth;
  objectId: string;
  departmentId: string;
  consumableId: string;
  /** Обычная заявка — с аппаратом: она стоит в тех же ответах рядом и обязана не измениться. */
  ordinary: ServiceRequestDto;
  /** Заявка без аппарата и без объекта: ремонт, «Новая». */
  emptyId: string;
  emptyNum: number;
  /** Она же на расходники — для выгрузки расхода. */
  consumableRequestId: string;
  /** Она же принятая, с выполненной позицией и действующей гарантией — для реестра. */
  warrantyRequestId: string;
  warrantyRequestNum: number;
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

/** Свой адрес на каждый вход: попытки входа ограничены по IP, а учёток здесь три. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.41.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
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

async function card(id: string, auth: Auth = ctx.admin): Promise<ServiceRequestDto> {
  const res = await inject('GET', `/api/v1/service-requests/${id}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

interface ListAnswer {
  items: ServiceRequestDto[];
  total: number;
}

async function list(query: string, auth: Auth = ctx.admin): Promise<ListAnswer> {
  const res = await inject('GET', `/api/v1/service-requests${query}`, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ListAnswer;
}

const idsOf = (answer: ListAnswer): string[] => answer.items.map((item) => item.id);

/**
 * Заявка без аппарата и без площадки — прямой вставкой. Заказчик всегда отдел: этого требует
 * `service_requests_subject_check`, и без него строка не легла бы в таблицу вовсе.
 */
async function insertEmptyRequest(input: {
  kind: 'repair' | 'consumable';
  status?: string;
  description: string;
}): Promise<{ id: string; num: number }> {
  const res = await ctx.db.execute<{ id: string; num: number }>(sql`
    INSERT INTO service_requests (kind, office_equipment_id, equipment_object_id,
                                  customer_department_id, equipment_name, description,
                                  responsible_name, responsible_phone, status, created_by)
    VALUES (${sql.raw(`'${input.kind}'`)}, NULL, NULL, ${ctx.departmentId}, '',
            ${input.description}, 'Иванов Иван Иванович', '9990000000',
            ${sql.raw(`'${input.status ?? 'new'}'::service_request_status`)}, ${ctx.deptId})
    RETURNING id, num`);
  return res.rows[0]!;
}

describe.skipIf(!DB_URL)('заявка с пустым предметом: сервер её читает (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const mail = await import('../src/services/service-request-mail');
    const passwordHash = await hashPassword(PASSWORD);

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`ES-${RUN}`}, ${`Площадка пустого предмета ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;
    const departmentRow = await db.execute<{ id: string }>(sql`
      INSERT INTO departments (code, name)
      VALUES (${`ES-D-${RUN}`}, ${`Отдел пустого предмета ${RUN}`})
      RETURNING id`);
    const departmentId = departmentRow.rows[0]!.id;

    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-es-${tag}-${RUN}@example.invalid`;
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: row.rows[0]!.id, email };
    }

    const admin = await makeUser('admin', 'admin');
    const dept = await makeUser('dept', 'department');
    const shtab = await makeUser('shtab', 'shtab');
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id) VALUES (${dept.id}, ${departmentId})`);
    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${shtab.id}, ${objectId})`);

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов оргтехники: миграция 0104 не применена');
    const equipmentRow = await db.execute<{ id: string }>(sql`
      INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id, location)
      VALUES (${typeId}, ${`МФУ пустого предмета ${RUN}`}, ${`ЕС-${RUN}`}, ${objectId},
              'кабинет 214')
      RETURNING id`);

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

    ctx = {
      app,
      db,
      closeDb,
      mail,
      admin: await login(admin.email),
      adminId: admin.id,
      dept: await login(dept.email),
      deptId: dept.id,
      shtab: await login(shtab.email),
      objectId,
      departmentId,
      consumableId: '',
      ordinary: undefined as unknown as ServiceRequestDto,
      emptyId: '',
      emptyNum: 0,
      consumableRequestId: '',
      warrantyRequestId: '',
      warrantyRequestNum: 0,
    };

    // Обычная заявка — настоящей ручкой: она соседствует в каждом ответе с пустой, и её поля
    // обязаны остаться прежними. Без неё файл проверял бы только новую ветку.
    const created = await inject('POST', '/api/v1/service-requests', ctx.admin, {
      officeEquipmentId: equipmentRow.rows[0]!.id,
      description: 'Не печатает',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      customerDepartmentId: departmentId,
    });
    expect(created.statusCode, created.body).toBe(201);
    ctx.ordinary = (created.json() as { request: ServiceRequestDto }).request;

    const consumable = await inject('POST', '/api/v1/office-equipment-consumables', ctx.admin, {
      code: `ЕС${RUN.toUpperCase()}01`,
      name: `Тонер пустого предмета ${RUN} (шт)`,
      quantity: 10,
    });
    expect(consumable.statusCode, consumable.body).toBe(201);
    ctx.consumableId = (consumable.json() as { id: string }).id;

    const empty = await insertEmptyRequest({ kind: 'repair', description: 'Поставьте розетку' });
    ctx.emptyId = empty.id;
    ctx.emptyNum = empty.num;
    ctx.consumableRequestId = (
      await insertEmptyRequest({ kind: 'consumable', description: 'Нужен тонер на склад отдела' })
    ).id;
    const warranty = await insertEmptyRequest({
      kind: 'repair',
      description: 'Заменили блок питания своими силами',
    });
    ctx.warrantyRequestId = warranty.id;
    ctx.warrantyRequestNum = warranty.num;
    /*
     * Принятая заявка собирается тремя шагами, а не одной вставкой: сторож
     * `service_request_executor_present` требует у заявки в рабочем статусе исполнителя, и строка,
     * сразу рождённая «Принятой» без него, в таблицу не легла бы. Поэтому сначала «Новая», затем
     * поимённый исполнитель, затем статус.
     */
    await ctx.db.execute(sql`
      INSERT INTO service_request_executors (request_id, user_id, assigned_by)
      VALUES (${ctx.warrantyRequestId}, ${ctx.adminId}, ${ctx.adminId})`);
    await ctx.db.execute(sql`
      UPDATE service_requests
         SET status = 'accepted', accepted_by = ${ctx.adminId}, accepted_at = now(),
             acceptance_source = 'human', completed_at = now()
       WHERE id = ${ctx.warrantyRequestId}`);
    // Выполненная позиция с действующей гарантией: носитель строки реестра — работа, а не аппарат.
    await ctx.db.execute(sql`
      INSERT INTO service_request_items (request_id, kind, name, quantity, unit_price, performed,
                                         actual_quantity, warranty_months, warranty_until)
      VALUES (${ctx.warrantyRequestId}, 'part', 'Блок питания', 1, 2500, true, 1, 12,
              CURRENT_DATE + 200)`);
  }, 180_000);

  /**
   * Уборка: база у db-тестов общая и живёт между прогонами, поэтому файл уносит ровно то, что завёл
   * сам, и в порядке внешних ключей.
   */
  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      // Уборка идёт и после падения в `beforeAll`, где часть идентификаторов ещё пуста: пустая
      // строка в `uuid` — это отказ разбора, и он унёс бы вместе с собой всю остальную уборку.
      const ids = [
        ctx.emptyId,
        ctx.consumableRequestId,
        ctx.warrantyRequestId,
        ctx.ordinary?.id ?? '',
      ].filter((id) => id !== '');
      const requests = sql`SELECT id FROM service_requests WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`;
      await ctx.db.execute(sql`
        ALTER TABLE office_equipment_consumable_stock_entries
          DISABLE TRIGGER office_equipment_consumable_stock_immutable`);
      if (ctx.consumableId) {
        await ctx.db.execute(sql`
          DELETE FROM office_equipment_consumable_stock_entries
           WHERE consumable_id = ${ctx.consumableId}`);
      }
      await ctx.db.execute(sql`
        ALTER TABLE office_equipment_consumable_stock_entries
          ENABLE ALWAYS TRIGGER office_equipment_consumable_stock_immutable`);
      await ctx.db.execute(sql`DELETE FROM mail_messages WHERE entity_id IN (${requests})`);
      await ctx.db.execute(sql`DELETE FROM service_requests WHERE id IN (${requests})`);
      if (ctx.consumableId) {
        await ctx.db.execute(
          sql`DELETE FROM office_equipment_consumables WHERE id = ${ctx.consumableId}`,
        );
      }
      await ctx.db.execute(
        sql`DELETE FROM office_equipment WHERE inventory_number = ${`ЕС-${RUN}`}`,
      );
      await ctx.db.execute(sql`
        DELETE FROM office_equipment_models m
         WHERE m.name = ${`МФУ пустого предмета ${RUN}`}
           AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-es-%-${RUN}@example.invalid`}`,
      );
      await ctx.db.execute(sql`DELETE FROM departments WHERE id = ${ctx.departmentId}`);
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE id = ${ctx.objectId}`);
      await ctx.closeDb();
    }
  }, 60_000);

  it('карточка отдаёт пустые предмет и площадку, а не отказ', async () => {
    const dto = await card(ctx.emptyId);
    expect(dto.equipment).toBeNull();
    expect(dto.object).toBeNull();
    // Остальное на месте: пустеет предмет, а не заявка.
    expect(dto.customerDepartment?.id).toBe(ctx.departmentId);
    expect(dto.description).toBe('Поставьте розетку');
    expect(dto.status).toBe('new');
    // Расхождения по объекту у заявки без аппарата не бывает: сравнивать снимок не с чем.
    expect(dto.objectOverridden).toBe(false);
    expect(dto.objectMismatch).toBe(false);
  });

  it('обычная заявка рядом отвечает ровно тем же, чем отвечала', async () => {
    const dto = await card(ctx.ordinary.id);
    expect(dto.equipment?.name).toBe(`МФУ пустого предмета ${RUN}`);
    expect(dto.equipment?.typeName).toBe('МФУ');
    expect(dto.object?.id).toBe(ctx.objectId);
    expect(dto).toEqual(ctx.ordinary);
  });

  it('список показывает её, и счётчик страницы с ним сходится', async () => {
    const answer = await list('?pageSize=100');
    expect(idsOf(answer)).toContain(ctx.emptyId);
    expect(idsOf(answer)).toContain(ctx.ordinary.id);
    // Число под списком считает отдельный запрос со своим соединением: разойдись они, вышло бы
    // «показано 3 из 2» — и заметил бы это только человек.
    expect(answer.total).toBe(answer.items.length);
  });

  it('сортировки по площадке и по технике её не теряют', async () => {
    for (const query of [
      '?pageSize=100&sortBy=object&sortOrder=asc',
      '?pageSize=100&sortBy=object&sortOrder=desc',
      '?pageSize=100&sortBy=equipment&sortOrder=asc',
      '?pageSize=100&sortBy=equipment&sortOrder=desc',
    ]) {
      expect(idsOf(await list(query)), query).toContain(ctx.emptyId);
    }
  });

  it('поиск по номеру находит её, а поиск по технике — нет', async () => {
    const byNum = await list(`?pageSize=100&search=${ctx.emptyNum}`);
    expect(idsOf(byNum)).toEqual([ctx.emptyId]);
    // Поиск по тому, как называют технику, ищет в снимке заявки: у пустого предмета он пуст, и
    // строка честно не находится — это не потеря, а отсутствие совпадения.
    const byText = await list(`?pageSize=100&search=${encodeURIComponent(`МФУ пустого предмета`)}`);
    expect(idsOf(byText)).toContain(ctx.ordinary.id);
    expect(idsOf(byText)).not.toContain(ctx.emptyId);
  });

  it('отбор по типу оргтехники её не показывает: спросили тип — просят аппарат', async () => {
    const typeRow = await ctx.db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const answer = await list(`?pageSize=100&equipmentTypeId=${typeRow.rows[0]!.id}`);
    expect(idsOf(answer)).toContain(ctx.ordinary.id);
    expect(idsOf(answer)).not.toContain(ctx.emptyId);
    expect(answer.total).toBe(answer.items.length);
  });

  it('область считается заказчиком: отдел её видит, площадка — нет', async () => {
    const mine = await list('?pageSize=100', ctx.dept);
    expect(idsOf(mine)).toContain(ctx.emptyId);
    const foreign = await list('?pageSize=100', ctx.shtab);
    expect(idsOf(foreign)).not.toContain(ctx.emptyId);
    // По прямой ссылке — тоже отказ, а не пустой предмет: «нет площадки» не значит «ничья».
    const denied = await inject('GET', `/api/v1/service-requests/${ctx.emptyId}`, ctx.shtab);
    expect(denied.statusCode, denied.body).toBe(403);
  });

  it('история и лента обсуждения открываются', async () => {
    const history = await inject(
      'GET',
      `/api/v1/service-requests/${ctx.emptyId}/history`,
      ctx.admin,
    );
    expect(history.statusCode, history.body).toBe(200);
    const messages = await inject(
      'GET',
      `/api/v1/service-requests/${ctx.emptyId}/messages`,
      ctx.admin,
    );
    expect(messages.statusCode, messages.body).toBe(200);
  });

  it('«отметить все прочитанными» гасит и её — отбор кнопки её видит', async () => {
    const sent = await inject(
      'POST',
      `/api/v1/service-requests/${ctx.emptyId}/messages`,
      ctx.dept,
      {
        body: 'Розетку ставим завтра',
        addressees: { sides: ['all'], users: [] },
      },
    );
    expect(sent.statusCode, sent.body).toBe(200);

    const before = await inject('GET', '/api/v1/service-requests/unread-count', ctx.admin);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().count).toBeGreaterThan(0);

    const marked = await inject(
      'POST',
      '/api/v1/service-requests/messages/read-all',
      ctx.admin,
      {},
    );
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json().count).toBeGreaterThan(0);

    // Главная проверка отрицательная: останься соединение внутренним, кнопка гасила бы всё, кроме
    // этой заявки, и счётчик не дошёл бы до нуля никогда.
    const after = await inject('GET', '/api/v1/service-requests/unread-count', ctx.admin);
    expect(after.json().count).toBe(0);
  });

  it('письмо собирается и называет пустой предмет словами', async () => {
    const data = await ctx.db.transaction(async (tx) =>
      ctx.mail.loadServiceLetterData(tx, ctx.emptyId),
    );
    expect(data.officeEquipmentId).toBeNull();
    expect(data.objectCode).toBeNull();
    expect(data.objectName).toBeNull();

    const letter = ctx.mail.renderServiceLetter('service_request_created', data);
    expect(letter.text).toContain('Техника: Без аппарата');
    // Строки «Где стоит» у заявки без площадки нет вовсе: прочерк отвечал бы на вопрос, которого
    // никто не задавал.
    expect(letter.text).not.toContain('Где стоит');
  });

  it('реестр гарантий держит работу по заявке без аппарата', async () => {
    const res = await inject('GET', '/api/v1/service-requests/warranties?kind=repair', ctx.admin);
    expect(res.statusCode, res.body).toBe(200);
    const rows = (res.json() as { items: ServiceWarrantyRowDto[] }).items;
    const mine = rows.find((row) => row.requestNum === ctx.warrantyRequestNum);
    expect(mine, 'строка гарантии по заявке без аппарата пропала из реестра').toBeDefined();
    expect(mine!.equipmentId).toBeNull();
    expect(mine!.typeName).toBeNull();
    expect(mine!.objectName).toBeNull();
    expect(mine!.subject).toBe('Блок питания');
  });

  it('выгрузка расхода показывает выдачу по заявке без аппарата', async () => {
    const id = ctx.consumableRequestId;
    const assigned = await inject('PUT', `/api/v1/service-requests/${id}/executors`, ctx.admin, {
      userIds: [ctx.adminId],
      serviceCounterpartyId: null,
      version: (await card(id)).version,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const started = await inject('PATCH', `/api/v1/service-requests/${id}/start`, ctx.admin, {
      version: (assigned.json() as { request: ServiceRequestDto }).request.version,
    });
    expect(started.statusCode, started.body).toBe(200);
    const put = await inject('PUT', `/api/v1/service-requests/${id}/consumables`, ctx.admin, {
      items: [{ consumableId: ctx.consumableId, requestedQuantity: 2 }],
      version: (started.json() as ServiceRequestDto).version,
    });
    expect(put.statusCode, put.body).toBe(200);
    const withLines = await card(id);
    const issued = await inject(
      'PATCH',
      `/api/v1/service-requests/${id}/consumables/issued`,
      ctx.admin,
      {
        items: [{ id: withLines.consumables[0]!.id, issuedQuantity: 2 }],
        version: withLines.version,
      },
    );
    expect(issued.statusCode, issued.body).toBe(200);

    const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    const report = await inject(
      'GET',
      `/api/v1/office-equipment-consumables/usage-report?from=2020-01-01&to=${today}`,
      ctx.admin,
    );
    expect(report.statusCode, report.body).toBe(200);
    const body = report.json() as {
      rows: { requestId: string; equipmentId: string | null; issued: number }[];
      totalIssued: number;
    };
    const mine = body.rows.find((row) => row.requestId === id);
    // Строка обязана быть: итог отчёта считается по журналу склада, и пропади она — сумма столбца
    // перестала бы сходиться с числом внизу, а спор о числах разбирают глазами.
    expect(mine, 'выдача по заявке без аппарата пропала из отчёта').toBeDefined();
    expect(mine!.equipmentId).toBeNull();
    expect(mine!.issued).toBe(2);
    expect(body.totalIssued).toBeGreaterThanOrEqual(2);
  });
});
