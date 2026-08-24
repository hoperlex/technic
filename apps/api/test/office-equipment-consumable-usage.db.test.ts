import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatServiceRequestNumber,
  moscowDateKeyOf,
  type OfficeEquipmentConsumableDetailDto,
  type OfficeEquipmentConsumableDto,
  type OfficeEquipmentConsumableUsageDto,
  type OfficeEquipmentConsumableUsageRowDto,
  type ServiceRequestDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Отчёт по расходу расходников за период и след списания в истории заявки (наброски
 * `docs/office-equipment-requests-rework-draft.md`, Р10; опрос В18; план переработки заявок, §7.3).
 *
 * ЗАЧЕМ БАЗА. Предмет отчёта — не форма ответа, а то, СОВПАДАЕТ ЛИ ОН СО СКЛАДОМ, и совпадение это
 * рождается только на живой цепочке: заявка закрывается, факт правится вниз, кладовщик пересчитывает
 * полку, — а числа обязаны сойтись после всей цепочки, а не после одного действия. На моках сошлись
 * бы моки.
 *
 * Что именно доказывается, и почему каждое — отдельно:
 *
 * - **расход считается по журналу, а не по строкам заявок.** Разница видна ровно после сторно:
 *   строка заявки после правки вниз знает только итог («выдано 1»), а журнал помнит обе половины
 *   («выдали 3, вернули 2»). Отчёт обязан показать обе и дать в расходе 1 — второй счётчик здесь и
 *   разошёлся бы с остатком;
 * - **ручная правка остатка в расход не идёт.** Она двигает тот же остаток, но отвечает на другой
 *   вопрос («пересчитали полку», «приняли поставку»), и, попав в отчёт, превратила бы приход в
 *   отрицательный расход;
 * - **итоги считаются по всему периоду**, а не по показанным строкам;
 * - **выгрузка идёт тем же отбором**: файл, собранный по другому периоду, — это спор двух чисел;
 * - **след в истории заявки**: «Списано со склада: … — 3 шт». Аудит движения писал и раньше, но в
 *   историю они не приезжали вовсе — действие не было названо в перечне событий.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/office-equipment-consumable-usage.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
/** Он же в написании кода номенклатуры: код хранится нормализованным, в верхнем регистре. */
const CODE_RUN = RUN.toUpperCase();
const CODE_PREFIX = 'ДUSG';
const EQUIPMENT_PREFIX = `USG-${RUN}-`;
const PASSWORD = 'db-test-password-123';

/** День закрытия работ — сегодня по Москве: сервер не принимает дату из будущего. */
const TODAY = moscowDateKeyOf(new Date());

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: у его роли весь словарь прав, включая `serviceRequests.execute`. */
  admin: { id: string; fullName: string; email: string; auth: Auth };
  objectId: string;
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

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url,
    headers: ctx.admin.auth,
    remoteAddress: nextAddress(),
    ...(payload ? { payload } : {}),
  });
}

// ── Данные ──

let codeNo = 0;
function nextCode(): string {
  codeNo += 1;
  return `${CODE_PREFIX}${CODE_RUN}${String(codeNo).padStart(3, '0')}`;
}

async function makeConsumable(
  name: string,
  quantity: number,
): Promise<OfficeEquipmentConsumableDto> {
  const res = await inject('POST', '/api/v1/office-equipment-consumables', {
    code: nextCode(),
    name: `${name} ${RUN} (шт)`,
    quantity,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as OfficeEquipmentConsumableDto;
}

let equipmentNo = 0;
/** Своя единица техники на заявку: по единице и виду незакрытая заявка бывает одна (В12). */
async function makeEquipment(): Promise<string> {
  equipmentNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', {
    equipmentTypeId: ctx.typeId,
    name: `МФУ расхода ${RUN}`,
    inventoryNumber: `${EQUIPMENT_PREFIX}${equipmentNo}`,
    objectId: ctx.objectId,
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function card(id: string): Promise<ServiceRequestDto> {
  const res = await inject('GET', `/api/v1/service-requests/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

/** Заявка на расходники, доведённая до «В работе»: заведение, назначение себя, «принять в работу». */
async function makeRequest(
  lines: { consumableId: string; requestedQuantity: number }[],
): Promise<ServiceRequestDto> {
  const equipmentId = await makeEquipment();
  const created = await inject('POST', '/api/v1/service-requests', {
    officeEquipmentId: equipmentId,
    kind: 'consumable',
    consumables: lines,
    description: 'Нужны картриджи',
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = (created.json() as { request: ServiceRequestDto }).request;

  const assigned = await inject('PUT', `/api/v1/service-requests/${request.id}/executors`, {
    userIds: [ctx.admin.id],
    serviceCounterpartyId: null,
    version: request.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  const started = await inject('PATCH', `/api/v1/service-requests/${request.id}/start`, {
    version: (assigned.json() as { request: ServiceRequestDto }).request.version,
  });
  expect(started.statusCode, started.body).toBe(200);
  return started.json() as ServiceRequestDto;
}

/** Закрытие работ: у расходников смета пуста, а факт выдачи приходит строками. */
async function complete(
  id: string,
  consumables: { id: string; issuedQuantity: number; issueNote?: string }[],
) {
  const current = await card(id);
  const res = await inject('PATCH', `/api/v1/service-requests/${id}/complete`, {
    completedOn: TODAY,
    items: [],
    consumables,
    version: current.version,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ServiceRequestDto;
}

function lineOf(request: ServiceRequestDto, consumableId: string) {
  const line = request.consumables.find((row) => row.consumableId === consumableId);
  if (!line) throw new Error('в заявке нет строки этой позиции');
  return line;
}

// ── Отчёт ──

async function usage(query: Record<string, string>): Promise<OfficeEquipmentConsumableUsageDto> {
  const qs = new URLSearchParams({ from: TODAY, to: TODAY, ...query }).toString();
  const res = await inject('GET', `/api/v1/office-equipment-consumables/usage-report?${qs}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as OfficeEquipmentConsumableUsageDto;
}

/** Строка отчёта по позиции: у каждого случая своя позиция, поэтому строка ровно одна. */
function rowOf(
  report: OfficeEquipmentConsumableUsageDto,
  consumableId: string,
): OfficeEquipmentConsumableUsageRowDto {
  const rows = report.rows.filter((row) => row.consumableId === consumableId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

interface HistoryEntry {
  kind: string;
  changes: { field: string; from: string | null; to: string | null }[];
}

async function historyOf(id: string): Promise<HistoryEntry[]> {
  const res = await inject('GET', `/api/v1/service-requests/${id}/history`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as HistoryEntry[];
}

describe.skipIf(!DB_URL)('расход расходников: отчёт и след в истории (живая схема)', () => {
  /** Что сценарий передаёт между шагами. */
  const state: {
    toner: OfficeEquipmentConsumableDto;
    drum: OfficeEquipmentConsumableDto;
    request: ServiceRequestDto;
  } = {
    toner: null as unknown as OfficeEquipmentConsumableDto,
    drum: null as unknown as OfficeEquipmentConsumableDto,
    request: null as unknown as ServiceRequestDto,
  };

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const email = `db-usg-admin-${RUN}@example.invalid`;
    const user = await db.execute<{ id: string; full_name: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${email}, 'Тестовый', 'Администратор', 'Расхода', ${await hashPassword(PASSWORD)},
              'admin'::role, true, now())
      RETURNING id, full_name`);
    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`USG-${RUN}`}, ${`Площадка расхода ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    if (!typeRow.rows[0])
      throw new Error('в базе нет типов оргтехники: миграция 0104 не применена');

    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    expect(login.statusCode, login.body).toBe(200);

    ctx = {
      app,
      db,
      closeDb,
      admin: {
        id: user.rows[0]!.id,
        fullName: user.rows[0]!.full_name,
        email,
        auth: { authorization: `Bearer ${login.json().accessToken}` },
      },
      objectId: objectRow.rows[0]!.id,
      typeId: typeRow.rows[0]!.id,
    };
  }, 180_000);

  afterAll(async () => {
    await ctx?.app.close();
    if (!ctx?.db) return;
    const мои = sql`SELECT id FROM office_equipment_consumables WHERE code LIKE ${`${CODE_PREFIX}${CODE_RUN}%`}`;
    const заявки = sql`SELECT id FROM service_requests WHERE office_equipment_id IN (
      SELECT id FROM office_equipment WHERE inventory_number LIKE ${`${EQUIPMENT_PREFIX}%`})`;
    /*
     * Строки журнала неудаляемы (триггер `…stock_immutable`), а расходник с движением не удаляется
     * `RESTRICT`ом. Круг размыкается временным гашением триггера — одной транзакцией (`ALTER TABLE`
     * транзакционен, и оборванный прогон откатывает гашение) и обратно `ENABLE ALWAYS`.
     */
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
      await tx.execute(sql`
        ALTER TABLE office_equipment_consumable_stock_entries
          DISABLE TRIGGER office_equipment_consumable_stock_immutable`);
      await tx.execute(sql`
        DELETE FROM office_equipment_consumable_stock_entries WHERE consumable_id IN (${мои})`);
      await tx.execute(sql`
        ALTER TABLE office_equipment_consumable_stock_entries
          ENABLE ALWAYS TRIGGER office_equipment_consumable_stock_immutable`);
    });
    await ctx.db.execute(
      sql`DELETE FROM audit_log WHERE entity_type = 'serviceRequest'
           AND entity_id IN (SELECT id::text FROM (${заявки}) t)`,
    );
    // Строки номенклатуры, исполнителей и историю уносит каскад самой заявки.
    await ctx.db.execute(sql`DELETE FROM service_requests WHERE id IN (${заявки})`);
    await ctx.db.execute(sql`DELETE FROM office_equipment_consumables WHERE id IN (${мои})`);
    await ctx.db.execute(
      sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`${EQUIPMENT_PREFIX}%`}`,
    );
    await ctx.db.execute(sql`
      DELETE FROM audit_log WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE ${`db-usg-%-${RUN}@example.invalid`})`);
    await ctx.db.execute(
      sql`DELETE FROM users WHERE email LIKE ${`db-usg-%-${RUN}@example.invalid`}`,
    );
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${`USG-${RUN}`}`);
    await ctx.closeDb();
  }, 120_000);

  it('выдача попадает в отчёт строкой «заявка — аппарат — позиция — кто»', async () => {
    state.toner = await makeConsumable('Тонер расхода', 10);
    state.drum = await makeConsumable('Барабан расхода', 4);
    state.request = await makeRequest([
      { consumableId: state.toner.id, requestedQuantity: 3 },
      { consumableId: state.drum.id, requestedQuantity: 1 },
    ]);

    await complete(state.request.id, [
      { id: lineOf(state.request, state.toner.id).id, issuedQuantity: 3 },
      { id: lineOf(state.request, state.drum.id).id, issuedQuantity: 1 },
    ]);

    const report = await usage({});
    const row = rowOf(report, state.toner.id);
    expect(row.displayNumber).toBe(formatServiceRequestNumber(state.request.num));
    expect(row.requestId).toBe(state.request.id);
    expect(row.code).toBe(state.toner.code);
    // Аппарат — тот, ради которого выдавали: на него отвечает вопрос «на какие аппараты» (В18).
    expect(row.equipmentInventoryNumber).toBe(`${EQUIPMENT_PREFIX}${equipmentNo}`);
    expect(row.actorName).toBe(ctx.admin.fullName);
    expect(row.issued).toBe(3);
    expect(row.returned).toBe(0);
    expect(row.quantity).toBe(3);
    // Каждая позиция — своя строка: заявка на четыре тонера цветного аппарата это одна заявка (В11).
    expect(rowOf(report, state.drum.id).quantity).toBe(1);
  });

  it('сторно показано обеими половинами, а расход равен разнице', async () => {
    const line = lineOf(await card(state.request.id), state.toner.id);
    const current = await card(state.request.id);
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.request.id}/consumables/issued`,
      {
        items: [{ id: line.id, issuedQuantity: 1, issueNote: 'два тонера вернули на склад' }],
        version: current.version,
      },
    );
    expect(res.statusCode, res.body).toBe(200);

    const row = rowOf(await usage({}), state.toner.id);
    /*
     * ЗДЕСЬ И ВИДНА РАЗНИЦА ИСТОЧНИКОВ. Строка заявки после правки знает только итог («выдано 1»);
     * отчёт, посчитанный по ней, показал бы 1 и умолчал бы о том, что со склада ушло три, а вернулось
     * два. Отчёт по журналу показывает обе половины — и сходится с остатком, который тоже сдвинулся
     * дважды.
     */
    expect(row.issued).toBe(3);
    expect(row.returned).toBe(2);
    expect(row.quantity).toBe(1);

    // Склад и отчёт сошлись: 10 − 3 + 2.
    const detail = await inject('GET', `/api/v1/office-equipment-consumables/${state.toner.id}`);
    const consumable = detail.json() as OfficeEquipmentConsumableDetailDto;
    expect(consumable.quantity).toBe(9);

    /*
     * ЛЕНТА ЖУРНАЛА НАЗЫВАЕТ ЗАЯВКУ (Р10). Номер собирает сервер — тем же
     * `formatServiceRequestNumber`, каким он пишет причину события: разойдись они, лента показала
     * бы «выдано по СО-1234» рядом с причиной «Выдано по заявке 1234». Портал по этому номеру
     * ставит ссылку, поэтому рядом обязан лежать и идентификатор заявки.
     */
    const number = formatServiceRequestNumber(state.request.num);
    const issue = consumable.stockEntries.find((entry) => entry.entryKind === 'issue');
    expect(issue).toBeDefined();
    expect(issue!.serviceRequestNumber).toBe(number);
    expect(issue!.serviceRequestId).toBe(state.request.id);
    expect(issue!.reason).toBe(`Выдано по заявке ${number}`);

    const back = consumable.stockEntries.find((entry) => entry.entryKind === 'return');
    expect(back!.serviceRequestNumber).toBe(number);

    // У заведения карточки заявки нет вовсе — ни ссылки, ни номера: это ручная правка.
    const manual = consumable.stockEntries.find((entry) => entry.entryKind === 'manual');
    expect(manual!.serviceRequestNumber).toBeNull();
    expect(manual!.serviceRequestId).toBeNull();
  });

  it('ручная правка остатка расходом не считается', async () => {
    const before = rowOf(await usage({}), state.toner.id);
    const res = await inject(
      'POST',
      `/api/v1/office-equipment-consumables/${state.toner.id}/stock`,
      { quantity: 20, expectedQuantity: 9, reason: 'приняли поставку' },
    );
    expect(res.statusCode, res.body).toBe(200);

    const report = await usage({});
    const after = rowOf(report, state.toner.id);
    // Приход двинул остаток, но расходом не стал: иначе поставка читалась бы как отрицательная
    // выдача, и «сколько ушло за месяц» отвечало бы отрицательным числом.
    expect(after).toEqual(before);
    expect(report.rows.every((row) => row.displayNumber.startsWith('СО-'))).toBe(true);
  });

  it('итоги считаются по всему периоду, а отбор по позиции сужает строки', async () => {
    const all = await usage({});
    const mine = all.rows.filter((row) => row.code.startsWith(CODE_PREFIX));
    // Итог по периоду — сумма по ВСЕМ строкам базы, а не по моим: база db-тестов общая. Поэтому
    // сверяется неравенство, а не равенство: мои строки в итог входят целиком.
    expect(all.totalIssued).toBeGreaterThanOrEqual(mine.reduce((sum, row) => sum + row.issued, 0));
    expect(all.totalReturned).toBeGreaterThanOrEqual(
      mine.reduce((sum, row) => sum + row.returned, 0),
    );

    const one = await usage({ consumableId: state.toner.id });
    expect(one.rows).toHaveLength(1);
    expect(one.rows[0]!.consumableId).toBe(state.toner.id);
    // Отбор сужает и итоги: они считаются тем же условием, что и строки.
    expect(one.totalIssued).toBe(3);
    expect(one.totalReturned).toBe(2);
  });

  it('период отсекает по календарным суткам Москвы, а неверный отвергается словами', async () => {
    const empty = await usage({ from: '2020-01-01', to: '2020-01-02' });
    expect(empty.rows).toHaveLength(0);
    expect(empty.totalIssued).toBe(0);
    expect(empty.totalReturned).toBe(0);

    // Сегодняшняя выдача попадает в период «сегодня — сегодня»: границы суток считает сервер по
    // Москве, и по UTC вечерняя выдача уехала бы в завтра.
    expect(rowOf(await usage({ from: TODAY, to: TODAY }), state.toner.id).issued).toBe(3);

    const qs = new URLSearchParams({ from: TODAY, to: '2020-01-01' }).toString();
    const res = await inject('GET', `/api/v1/office-equipment-consumables/usage-report?${qs}`);
    expect(res.statusCode, res.body).toBe(400);
  });

  it('выгрузка отдаёт книгу тем же отбором', async () => {
    const qs = new URLSearchParams({
      from: TODAY,
      to: TODAY,
      consumableId: state.toner.id,
    }).toString();
    const res = await inject('GET', `/api/v1/office-equipment-consumables/usage-report.xlsx?${qs}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    // Книга — это zip: первые два байта «PK». Проверяется именно это, а не длина: пустой ответ с
    // верным заголовком выглядел бы файлом и открывался бы ошибкой у человека.
    expect(res.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('история заявки называет списание и возврат словами', async () => {
    const entries = await historyOf(state.request.id);

    const completed = entries.find((e) => e.kind === 'completed');
    expect(completed).toBeDefined();
    // Списание при закрытии работ: аудит нёс движение и раньше, но история о нём молчала.
    expect(completed!.changes).toContainEqual({
      field: 'consumablesIssued',
      from: null,
      to: `${state.toner.name} — 3 шт`,
    });

    // Правка факта вниз — своё событие, а не «правка заявки»: с него со склада вернулись картриджи.
    const issued = entries.filter((e) => e.kind === 'consumablesIssued');
    expect(issued).toHaveLength(1);
    expect(issued[0]!.changes).toContainEqual({
      field: 'consumablesReturned',
      from: null,
      to: `${state.toner.name} — 2 шт`,
    });
  });
});
