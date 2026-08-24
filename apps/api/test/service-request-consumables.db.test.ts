import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatServiceRequestNumber,
  moscowDateKeyOf,
  type OfficeEquipmentConsumableDto,
  type ServiceRequestDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Заявка на расходники: строки, списание со склада и сторно (план
 * `docs/office-equipment-requests-rework-plan.md`, §7.3 и §8 тесты 5 и 6; решения Р1–Р8 набросков
 * `docs/office-equipment-requests-rework-draft.md`).
 *
 * ЗАЧЕМ БАЗА. Проверять здесь нечего, кроме того, что база разрешает сделать транзакции закрытия, а
 * разрешает она это четырьмя объектами схемы, которых на моках не существует:
 *
 * - ЦЕПОЧКА журнала (`BEFORE INSERT`, `0172`) сверяет ОБА конца события с карточкой — то есть
 *   диктует порядок «правка карточки, потом событие». Маршрут, написанный наоборот, на моках
 *   выглядел бы правильным;
 * - ПОКРЫТИЕ остатка (отложенный constraint-триггер, `0172`) ловит правку остатка без события;
 * - ДВА ТРИГГЕРА ИНВАРИАНТА выдачи (`0186`) ловят обе половины расхождения «строка заявки против
 *   журнала»: прямую правку `issued_quantity` мимо события и обратное — законное событие, не
 *   изменившее факт строки. Односторонняя проверка пропускала бы половину, и увидеть это можно
 *   только на живых триггерах;
 * - ПОРЯДОК ЗАХВАТА БЛОКИРОВОК — свойство ПАРЫ транзакций, а не одной. Файл маршрута показывает,
 *   что карточки берутся по возрастанию `consumable_id`, но не показывает, что этого достаточно:
 *   достаточность доказывается встречей двух закрытий на одних и тех же позициях.
 *
 * ПОЧЕМУ ПОРЯДОК СЛУЧАЕВ ЗНАЧИМ. Первая половина файла идёт шагами одного сценария: заявка
 * закрывается, возвращается на доработку, закрывается снова, факт правится вниз — и каждый шаг
 * проверяет, что склад сдвинулся ровно на разницу, а не на «сколько просили». Разложенные по
 * изолированным случаям, эти шаги перестали бы проверять главное — что склад и заявка сходятся
 * ПОСЛЕ цепочки действий, а не после одного.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/service-request-consumables.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
/** Он же в написании кода номенклатуры: код хранится нормализованным, в верхнем регистре. */
const CODE_RUN = RUN.toUpperCase();
const CODE_PREFIX = 'ДSRC';
const EQUIPMENT_PREFIX = `SRC-${RUN}-`;
const PASSWORD = 'db-test-password-123';

/** День закрытия работ — сегодня по Москве: сервер не принимает дату из будущего. */
const TODAY = moscowDateKeyOf(new Date());

/** Сколько соединение файла готово ждать чужую блокировку, прежде чем упасть текстом. */
const LOCK_TIMEOUT_MS = 8_000;
/** Сколько ждём, пока запрос встанет в очередь: барьер, а не пауза «на глазок». */
const QUEUE_TIMEOUT_MS = 20_000;

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: у его роли весь словарь прав, включая `serviceRequests.execute`. */
  admin: { id: string; email: string; auth: Auth };
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

/** Позиция номенклатуры с начальным остатком: первое событие журнала пишет сама ручка. */
async function makeConsumable(name: string, quantity: number): Promise<string> {
  const res = await inject('POST', '/api/v1/office-equipment-consumables', {
    code: nextCode(),
    name: `${name} ${RUN} (шт)`,
    quantity,
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as OfficeEquipmentConsumableDto).id;
}

let equipmentNo = 0;
/** Своя единица техники на заявку: по единице и виду незакрытая заявка бывает одна (В12). */
async function makeEquipment(): Promise<string> {
  equipmentNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment', {
    equipmentTypeId: ctx.typeId,
    name: `МФУ расходников ${RUN}`,
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

/**
 * Заявка на расходники, доведённая до «В работе»: заведение со строками, назначение поимённого
 * исполнителя и «принять в работу». Всё настоящими ручками — предмет файла в том числе и то, что
 * заведение принимает строки атомарно.
 */
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
  // Назначение отвечает заявкой и исходом письма исполнителям (Н13): сама заявка лежит в `request`.
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
  return inject('PATCH', `/api/v1/service-requests/${id}/complete`, {
    completedOn: TODAY,
    items: [],
    consumables,
    version: current.version,
  });
}

async function stockOf(consumableId: string): Promise<number> {
  const res = await ctx.db.execute<{ quantity: number }>(sql`
    SELECT quantity FROM office_equipment_consumables WHERE id = ${consumableId}`);
  return res.rows[0]!.quantity;
}

interface StockEntry {
  entry_kind: string;
  quantity_before: number;
  quantity_after: number;
  reason: string;
  service_request_id: string | null;
  service_request_consumable_id: string | null;
}

/** Журнал позиции с начала времён: первая строка — заведение карточки. */
async function entriesOf(consumableId: string): Promise<StockEntry[]> {
  const res = await ctx.db.execute<StockEntry>(sql`
    SELECT entry_kind, quantity_before, quantity_after, reason,
           service_request_id, service_request_consumable_id
      FROM office_equipment_consumable_stock_entries
     WHERE consumable_id = ${consumableId}
     ORDER BY seq`);
  return res.rows;
}

function lineOf(request: ServiceRequestDto, consumableId: string) {
  const line = request.consumables.find((row) => row.consumableId === consumableId);
  if (!line) throw new Error('в заявке нет строки этой позиции');
  return line;
}

function message(res: { body: string }): string {
  return (JSON.parse(res.body) as { message: string }).message;
}

// ── Соединения для случая порядка блокировок ──

async function openHolder(consumableId: string): Promise<{ client: pg.Client; pid: number }> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM office_equipment_consumables WHERE id = $1 FOR UPDATE', [
    consumableId,
  ]);
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return { client, pid: rows[0]!.pid };
}

/** Соединение-наблюдатель: только опрос очередей, ни одной блокировки за собой. */
async function openProbe(): Promise<pg.Client> {
  const probe = new pg.Client({ connectionString: DB_URL });
  await probe.connect();
  return probe;
}

/**
 * Запросы, вставшие в очередь за этим бэкендом. Ждём появления, а не спим наугад.
 *
 * Наблюдатель — ОТДЕЛЬНОЕ соединение и обязательно вне транзакции: снимок `pg_stat_activity`
 * кешируется на всю транзакцию читателя, и опрос изнутри держателя блокировки возвращал бы текст
 * запроса, снятый первым же чтением.
 */
async function queuedBehind(probe: pg.Client, pid: number, count: number): Promise<string[]> {
  const deadline = Date.now() + QUEUE_TIMEOUT_MS;
  for (;;) {
    /*
     * Очередь считается ТРАНЗИТИВНО, и это не педантизм. `pg_blocking_pids` на блокировке строки
     * называет ближайшего держателя: второе закрытие, вставшее за первым в очереди за той же
     * карточкой, показывает блокирующим ПЕРВОЕ, а не держателя. Прямой опрос увидел бы одного
     * ожидающего вместо двух и объявил бы порядок потерянным на верном коде.
     */
    const { rows } = await probe.query<{ query: string }>(
      `WITH RECURSIVE chain AS (
         SELECT pid FROM pg_stat_activity WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a
           JOIN chain c ON c.pid = ANY(pg_blocking_pids(a.pid))
          WHERE a.pid <> $1
       )
       SELECT a.query FROM pg_stat_activity a JOIN chain USING (pid)`,
      [pid],
    );
    if (rows.length >= count) return rows.map((row) => row.query);
    if (Date.now() > deadline) {
      throw new Error(
        `за карточкой склада ждут ${rows.length} запроса вместо ${count}: значит закрытие берёт не её и не первой — порядок захвата потерян`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Транзакция, которая обязана пройти вся и упереться в отложенный триггер НА КОММИТЕ. Возвращает
 * текст отказа.
 *
 * Своим соединением `pg`, а не через drizzle: обёртка транзакции подменяет ошибку коммита своим
 * «Failed query: commit», и текст, ради которого случай и написан, до теста не доезжает. Заодно
 * видно, что все шаги внутри прошли, — а это и есть «отложенный»: немедленная проверка отбила бы
 * первый же из них.
 */
async function refusedOnCommit(
  statements: { text: string; values: unknown[] }[],
): Promise<string> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const statement of statements) {
      await client.query(statement.text, statement.values);
    }
    try {
      await client.query('COMMIT');
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error('транзакция прошла, хотя обязана была упереться в отложенный триггер');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

/**
 * Идентификатор строки заявки, заданный руками. Порядок задаёт первая группа, уникальность в общей
 * базе — суффикс прогона в узле: сцена случая 6 держится на том, что порядок `id` строк обратен
 * порядку `consumable_id`, а случайные `uuid` такого не гарантируют.
 */
function lineId(rank: number): string {
  return `${String(rank).repeat(8)}-0000-4000-8000-${RUN}0000`;
}

/** Заменить строки заявки на строки с заданными идентификаторами. Движения по ним ещё нет. */
async function relineRequest(
  requestId: string,
  lines: { id: string; consumableId: string; requestedQuantity: number }[],
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM service_request_consumables WHERE request_id = ${requestId}`);
    for (const line of lines) {
      await tx.execute(sql`
        INSERT INTO service_request_consumables (id, request_id, consumable_id, requested_quantity)
        VALUES (${line.id}, ${requestId}, ${line.consumableId}, ${line.requestedQuantity})`);
    }
  });
}

describe.skipIf(!DB_URL)('заявка на расходники: строки, списание и сторно (живая схема)', () => {
  /** Что сценарий передаёт между шагами. */
  const state: {
    toner: string;
    scarce: string;
    over: string;
    main: ServiceRequestDto;
    overRequest: ServiceRequestDto;
    scarceRequest: ServiceRequestDto;
    low: string;
    high: string;
    raceA: string;
    raceB: string;
  } = {
    toner: '',
    scarce: '',
    over: '',
    main: null as unknown as ServiceRequestDto,
    overRequest: null as unknown as ServiceRequestDto,
    scarceRequest: null as unknown as ServiceRequestDto,
    low: '',
    high: '',
    raceA: '',
    raceB: '',
  };

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const email = `db-src-admin-${RUN}@example.invalid`;
    const user = await db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${email}, 'Тестовый', 'Администратор', 'Расходников', ${await hashPassword(PASSWORD)},
              'admin'::role, true, now())
      RETURNING id`);
    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`SRC-${RUN}`}, ${`Площадка расходников ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    if (!typeRow.rows[0]) throw new Error('в базе нет типов оргтехники: миграция 0104 не применена');

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
     * Строки журнала неудаляемы (триггер `…stock_immutable`, Р11 плана расходников), а расходник с
     * движением не удаляется `RESTRICT`ом. Круг размыкается только временным гашением триггера — и
     * обставлено оно так же, как в `office-equipment-consumables.db.test.ts`: одной транзакцией
     * (`ALTER TABLE` транзакционен, и оборванный прогон откатывает гашение) и обратно `ENABLE
     * ALWAYS`, а не `ENABLE`.
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
      DELETE FROM office_equipment_models m
       WHERE m.name LIKE ${`% ${RUN}`}
         AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
    await ctx.db.execute(sql`
      DELETE FROM audit_log WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE ${`db-src-%-${RUN}@example.invalid`})`);
    await ctx.db.execute(
      sql`DELETE FROM users WHERE email LIKE ${`db-src-%-${RUN}@example.invalid`}`,
    );
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${`SRC-${RUN}`}`);
    await ctx.closeDb();
  }, 120_000);

  // ── Тест 5: списание ──

  it('строки приезжают заведением и видны в карточке', async () => {
    state.toner = await makeConsumable('Тонер основной', 10);
    state.main = await makeRequest([{ consumableId: state.toner, requestedQuantity: 2 }]);

    expect(state.main.kind).toBe('consumable');
    const line = lineOf(state.main, state.toner);
    expect(line.requestedQuantity).toBe(2);
    // Три состояния факта различимы, и «работу не закрывали» — это `null`, а не ноль (В9б).
    expect(line.issuedQuantity).toBeNull();
    expect(line.issueNote).toBe('');
    // Строки номенклатуры у ремонта не бывает — и наоборот: сметы у расходников нет.
    expect(state.main.items).toEqual([]);
  });

  it('обычная выдача ровно запрошенного проходит и пишет событие с серверной причиной', async () => {
    const line = lineOf(state.main, state.toner);
    // `issueNote` не передаётся вовсе: совпал факт с заявкой — объяснять нечего, и `CHECK` причины
    // журнала при этом не падает, потому что причину события пишет сервер, а не человек.
    const res = await complete(state.main.id, [{ id: line.id, issuedQuantity: 2 }]);
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json() as ServiceRequestDto;
    expect(after.status).toBe('done');
    expect(lineOf(after, state.toner).issuedQuantity).toBe(2);
    expect(lineOf(after, state.toner).issueNote).toBe('');
    // Итога по акту у расходников нет: платить не за что.
    expect(after.completion?.totalAmount).toBeNull();

    expect(await stockOf(state.toner)).toBe(8);
    const entries = await entriesOf(state.toner);
    expect(entries).toHaveLength(2);
    const issue = entries[1]!;
    expect(issue.entry_kind).toBe('issue');
    expect(issue.quantity_before).toBe(10);
    expect(issue.quantity_after).toBe(8);
    expect(issue.reason).toBe(`Выдано по заявке ${formatServiceRequestNumber(after.num)}`);
    expect(issue.service_request_id).toBe(after.id);
    expect(issue.service_request_consumable_id).toBe(line.id);
  });

  it('причина расхождения обязательна во всех трёх случаях — больше, меньше и ноль', async () => {
    state.over = await makeConsumable('Тонер сверх заявки', 10);
    state.overRequest = await makeRequest([{ consumableId: state.over, requestedQuantity: 2 }]);
    const line = lineOf(state.overRequest, state.over);

    /*
     * Умолчание «сколько просили» подставляет ФОРМА, а не сервер (контракт
     * `completeServiceRequestSchema`): списывать со склада по молчанию клиента он не должен, и
     * закрытие без отметки по строке — отказ, а не тихая выдача запрошенного.
     */
    const silent = await complete(state.overRequest.id, []);
    expect(silent.statusCode, silent.body).toBe(422);
    expect(message(silent)).toContain('нет отметки о выдаче');

    const more = await complete(state.overRequest.id, [{ id: line.id, issuedQuantity: 3 }]);
    expect(more.statusCode, more.body).toBe(422);
    expect(message(more)).toContain('больше, чем просили');

    const less = await complete(state.overRequest.id, [{ id: line.id, issuedQuantity: 1 }]);
    expect(less.statusCode, less.body).toBe(422);
    expect(message(less)).toContain('меньше, чем просили');

    const none = await complete(state.overRequest.id, [{ id: line.id, issuedQuantity: 0 }]);
    expect(none.statusCode, none.body).toBe(422);
    expect(message(none)).toContain('ничего не выдали');

    // Ни один отказ склада не двинул и заявку не закрыл: транзакция откатилась целиком.
    expect(await stockOf(state.over)).toBe(10);
    expect((await card(state.overRequest.id)).status).toBe('in_work');
    expect(await entriesOf(state.over)).toHaveLength(1);
  });

  it('выдача сверх заявки с причиной проходит, и причина дописывается к событию через двоеточие', async () => {
    const line = lineOf(state.overRequest, state.over);
    const res = await complete(state.overRequest.id, [
      { id: line.id, issuedQuantity: 3, issueNote: 'привезли три вместо двух' },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json() as ServiceRequestDto;
    expect(lineOf(after, state.over).issuedQuantity).toBe(3);
    expect(lineOf(after, state.over).issueNote).toBe('привезли три вместо двух');

    expect(await stockOf(state.over)).toBe(7);
    const entries = await entriesOf(state.over);
    expect(entries[1]!.reason).toBe(
      `Выдано по заявке ${formatServiceRequestNumber(after.num)}: привезли три вместо двух`,
    );
  });

  it('состав правится, пока по заявке не было выдачи', async () => {
    const spare = await makeConsumable('Тонер запасной', 5);
    const equipmentId = await makeEquipment();
    const created = await inject('POST', '/api/v1/service-requests', {
      officeEquipmentId: equipmentId,
      kind: 'consumable',
      consumables: [{ consumableId: state.over, requestedQuantity: 1 }],
      description: 'Нужны картриджи',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
    });
    expect(created.statusCode, created.body).toBe(201);
    const fresh = (created.json() as { request: ServiceRequestDto }).request;

    const replaced = await inject('PUT', `/api/v1/service-requests/${fresh.id}/consumables`, {
      items: [
        { consumableId: state.over, requestedQuantity: 3 },
        { consumableId: spare, requestedQuantity: 1 },
      ],
      version: fresh.version,
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const after = replaced.json() as ServiceRequestDto;
    expect(after.consumables).toHaveLength(2);
    expect(lineOf(after, state.over).requestedQuantity).toBe(3);

    // А по заявке, где выдача уже отмечена, состав не меняют вовсе: это уже не список пожеланий, а
    // основание записи на складе.
    const closed = await card(state.overRequest.id);
    const refused = await inject(
      'PUT',
      `/api/v1/service-requests/${state.overRequest.id}/consumables`,
      {
        items: [{ consumableId: state.over, requestedQuantity: 1 }],
        version: closed.version,
      },
    );
    expect(refused.statusCode, refused.body).toBe(409);
    expect(message(refused)).toContain('уже отмечена выдача');
  });

  it('не хватает остатка — отказ 422, а не минус', async () => {
    state.scarce = await makeConsumable('Тонер дефицитный', 1);
    state.scarceRequest = await makeRequest([{ consumableId: state.scarce, requestedQuantity: 2 }]);
    const line = lineOf(state.scarceRequest, state.scarce);

    const res = await complete(state.scarceRequest.id, [{ id: line.id, issuedQuantity: 2 }]);
    expect(res.statusCode, res.body).toBe(422);
    // Текст называет позицию, остаток и выдачу: у человека два законных выхода, и оба в нём.
    expect(message(res)).toContain('на складе 1, выдаётся 2');
    expect(message(res)).toContain('пополните остаток');
    expect(await stockOf(state.scarce)).toBe(1);
    expect((await card(state.scarceRequest.id)).status).toBe('in_work');

    // Второй выход: исполнитель ставит факт по месту — с причиной, потому что факт разошёлся.
    const fixed = await complete(state.scarceRequest.id, [
      { id: line.id, issuedQuantity: 1, issueNote: 'на складе был один' },
    ]);
    expect(fixed.statusCode, fixed.body).toBe(200);
    expect(await stockOf(state.scarce)).toBe(0);
  });

  it('возврат заявки на доработку склада не касается, а повторное закрытие списывает только разницу', async () => {
    const before = await entriesOf(state.toner);
    const current = await card(state.main.id);
    const rework = await inject('PATCH', `/api/v1/service-requests/${state.main.id}/rework`, {
      reason: 'привезли не тот картридж',
      version: current.version,
    });
    expect(rework.statusCode, rework.body).toBe(200);
    expect((rework.json() as ServiceRequestDto).status).toBe('in_work');

    // Тонер стоит там, где его поставили: сторно записало бы на склад штуки, которых на полке нет.
    expect(await stockOf(state.toner)).toBe(8);
    expect(await entriesOf(state.toner)).toHaveLength(before.length);
    // Факт выдачи возврат тоже не стирает — иначе повторное закрытие списало бы всё второй раз.
    expect(lineOf(await card(state.main.id), state.toner).issuedQuantity).toBe(2);

    const line = lineOf(state.main, state.toner);
    const again = await complete(state.main.id, [{ id: line.id, issuedQuantity: 2 }]);
    expect(again.statusCode, again.body).toBe(200);
    expect(await stockOf(state.toner)).toBe(8);
    expect(await entriesOf(state.toner)).toHaveLength(before.length);
  });

  it('правка факта вниз пишет `return` на разницу', async () => {
    const line = lineOf(state.main, state.toner);
    const current = await card(state.main.id);
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/consumables/issued`,
      {
        items: [{ id: line.id, issuedQuantity: 0, issueNote: 'картриджи вернули на склад' }],
        version: current.version,
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json() as ServiceRequestDto;
    // Статус правка не двигает: склад двигает изменение факта, а не переход (Р6).
    expect(after.status).toBe('done');
    expect(lineOf(after, state.toner).issuedQuantity).toBe(0);

    expect(await stockOf(state.toner)).toBe(10);
    const entries = await entriesOf(state.toner);
    expect(entries).toHaveLength(3);
    const back = entries[2]!;
    expect(back.entry_kind).toBe('return');
    expect(back.quantity_before).toBe(8);
    expect(back.quantity_after).toBe(10);
    expect(back.reason).toBe(
      `Возврат по заявке ${formatServiceRequestNumber(after.num)}: картриджи вернули на склад`,
    );
  });

  it('прямой `UPDATE issued_quantity` мимо события отбивается отложенным триггером', async () => {
    const line = lineOf(state.main, state.toner);
    const refusal = await refusedOnCommit([
      { text: 'UPDATE service_request_consumables SET issued_quantity = 5 WHERE id = $1', values: [line.id] },
    ]);
    expect(refusal).toMatch(/журнал остатка отдаёт по ней/u);
    // Строка осталась какой была: отказ пришёл на коммите, и вся транзакция откатилась.
    expect(lineOf(await card(state.main.id), state.toner).issuedQuantity).toBe(0);
  });

  it('законное событие, не изменившее факт строки, отбивается вторым триггером той же пары', async () => {
    const line = lineOf(state.main, state.toner);
    const before = await stockOf(state.toner);
    /*
     * Транзакция сама по себе безупречна: карточка правится перед событием, «было» и «стало»
     * сходятся с цепочкой (`0172`), направление совпадает с видом. Не сходится единственное — факт
     * строки заявки, которого она не тронула. Триггер СТРОКИ в такой транзакции не сработал бы
     * вовсе: строку никто не трогал, — и ловит её вторая сторона пары, триггер на журнале.
     */
    const refusal = await refusedOnCommit([
      {
        text: 'UPDATE office_equipment_consumables SET quantity = $2 WHERE id = $1',
        values: [state.toner, before - 1],
      },
      {
        text: `INSERT INTO office_equipment_consumable_stock_entries
                      (consumable_id, entry_kind, service_request_id, service_request_consumable_id,
                       quantity_before, quantity_after, reason, changed_by)
               VALUES ($1, 'issue', $2, $3, $4, $5, 'Выдано мимо заявки', $6)`,
        values: [state.toner, state.main.id, line.id, before, before - 1, ctx.admin.id],
      },
    ]);
    expect(refusal).toMatch(/журнал остатка отдаёт по ней/u);
    expect(await stockOf(state.toner)).toBe(before);
  });

  it('после «Закрыта» факт выдачи не правит никто', async () => {
    const current = await card(state.main.id);
    const accepted = await inject('PATCH', `/api/v1/service-requests/${state.main.id}/accept`, {
      version: current.version,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((accepted.json() as ServiceRequestDto).status).toBe('accepted');

    const line = lineOf(state.main, state.toner);
    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${state.main.id}/consumables/issued`,
      {
        items: [{ id: line.id, issuedQuantity: 1, issueNote: 'передумали' }],
        version: (accepted.json() as ServiceRequestDto).version,
      },
    );
    expect(res.statusCode, res.body).toBe(422);
    expect(message(res)).toContain('остаток правят вручную');
    expect(await stockOf(state.toner)).toBe(10);
  });

  // ── Тест 6: порядок захвата блокировок ──

  it('сцена: две заявки на одних позициях, порядок строк обратен порядку позиций', async () => {
    const first = await makeConsumable('Тонер гоночный A', 50);
    const second = await makeConsumable('Тонер гоночный B', 50);
    // Какой из двух `uuid` меньше, заранее неизвестно: порядок задаёт база, а не порядок заведения.
    [state.low, state.high] = [first, second].sort();

    const a = await makeRequest([
      { consumableId: state.low, requestedQuantity: 1 },
      { consumableId: state.high, requestedQuantity: 1 },
    ]);
    const b = await makeRequest([
      { consumableId: state.low, requestedQuantity: 1 },
      { consumableId: state.high, requestedQuantity: 1 },
    ]);
    state.raceA = a.id;
    state.raceB = b.id;

    // У заявки A порядок строк совпадает с порядком позиций, у заявки B — обратен ему. Сортируй
    // маршрут строки заявки — и две заявки брали бы одни и те же карточки встречно.
    await relineRequest(a.id, [
      { id: lineId(1), consumableId: state.low, requestedQuantity: 1 },
      { id: lineId(2), consumableId: state.high, requestedQuantity: 1 },
    ]);
    await relineRequest(b.id, [
      { id: lineId(3), consumableId: state.high, requestedQuantity: 1 },
      { id: lineId(4), consumableId: state.low, requestedQuantity: 1 },
    ]);
  });

  it('два одновременных закрытия разных заявок с одними позициями не дают 40P01', async () => {
    const holder = await openHolder(state.low);
    const probe = await openProbe();
    try {
      // Обе двери не ждутся здесь намеренно: они обязаны встать в очередь, и очередь — предмет
      // проверки. Обе — за МЛАДШЕЙ позицией: её берут первой обе заявки, как бы ни лежали их
      // собственные строки.
      const aInFlight = complete(state.raceA, [
        { id: lineId(1), issuedQuantity: 1 },
        { id: lineId(2), issuedQuantity: 1 },
      ]);
      const bInFlight = complete(state.raceB, [
        { id: lineId(3), issuedQuantity: 1 },
        { id: lineId(4), issuedQuantity: 1 },
      ]);
      const blocked = await queuedBehind(probe, holder.pid, 2);
      for (const query of blocked) {
        expect(query).toMatch(/office_equipment_consumables/u);
        expect(query.toLowerCase()).toContain('for update');
      }

      await holder.client.query('COMMIT');
      const [a, b] = await Promise.all([aInFlight, bInFlight]);
      expect(a.statusCode, a.body).toBe(200);
      expect(b.statusCode, b.body).toBe(200);
    } finally {
      await holder.client.query('ROLLBACK').catch(() => undefined);
      await holder.client.end();
      await probe.end();
    }

    // Каждая заявка списала по штуке каждой позиции: закрытия прошли целиком, а не наполовину.
    expect(await stockOf(state.low)).toBe(48);
    expect(await stockOf(state.high)).toBe(48);
  }, 60_000);

  /**
   * Контрольный клинч: тот же сюжет с сортировкой ПО СТРОКЕ ЗАЯВКИ, изображённой сырым SQL. Он
   * обязан кончиться `40P01` — без этого случая предыдущий ничего не стоит: тест, в котором клинч
   * невозможен в принципе, зелен и на сломанном коде.
   */
  it('встречный порядок «по строке заявки» даёт клинч — тем и доказан предыдущий случай', async () => {
    const a = new pg.Client({ connectionString: DB_URL });
    const b = new pg.Client({ connectionString: DB_URL });
    await a.connect();
    await b.connect();
    const probe = await openProbe();
    try {
      // Предел ожидания больше `deadlock_timeout` (по умолчанию секунда): иначе первым сработал бы
      // он, и вместо клинча тест увидел бы обычный таймаут.
      await a.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
      await b.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
      await a.query('BEGIN');
      await b.query('BEGIN');

      // Заявка A по своим строкам идёт «младшая позиция, потом старшая», заявка B — наоборот.
      await a.query('SELECT 1 FROM office_equipment_consumables WHERE id = $1 FOR UPDATE', [
        state.low,
      ]);
      await b.query('SELECT 1 FROM office_equipment_consumables WHERE id = $1 FOR UPDATE', [
        state.high,
      ]);

      const {
        rows: [me],
      } = await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const aWaits = a.query('SELECT 1 FROM office_equipment_consumables WHERE id = $1 FOR UPDATE', [
        state.high,
      ]);
      await queuedBehind(probe, me!.pid, 1);
      const bWaits = b.query('SELECT 1 FROM office_equipment_consumables WHERE id = $1 FOR UPDATE', [
        state.low,
      ]);

      const outcome = await Promise.allSettled([aWaits, bWaits]);
      const codes = outcome
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason as { code?: string }).code);
      expect(codes).toContain('40P01');
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      await a.end();
      await b.end();
      await probe.end();
    }
  }, 60_000);

  // ── Тест 13 плана: составной ключ журнала ──

  /**
   * Ключ `office_equipment_consumable_stock_row_fk` берёт ТРОЙКУ «строка + заявка + позиция», и
   * проверяется здесь ровно то, ради чего он составной: одноколоночный ключ на строку заявки
   * пропустил бы событие, которое ссылается на строку ЧУЖОЙ заявки или на строку ДРУГОГО
   * расходника, — обе ссылки по отдельности были бы целы, а вместе означали бы неправду.
   *
   * Строки событий вставляются прямым SQL: маршрут такую пару собрать не может в принципе, а
   * проверяется свойство схемы, а не маршрута. Отсюда же и порядок «правка карточки → событие» —
   * его требует цепочка журнала (`0172`), и без него отказ пришёл бы не от того ограничения.
   */
  it('событие списания не привязать ни к строке чужой заявки, ни к строке другого расходника', async () => {
    const первый = await makeConsumable('Тонер ключевой A', 10);
    const второй = await makeConsumable('Тонер ключевой B', 10);
    const своя = await makeRequest([{ consumableId: первый, requestedQuantity: 1 }]);
    const чужая = await makeRequest([
      { consumableId: первый, requestedQuantity: 1 },
      { consumableId: второй, requestedQuantity: 1 },
    ]);

    const { pgErrorOf } = await import('../src/lib/pg-error');
    const отказ = async (
      run: Promise<unknown>,
    ): Promise<{ code?: string; constraint?: string }> => {
      try {
        await run;
      } catch (e) {
        return pgErrorOf(e) ?? {};
      }
      throw new Error('база приняла событие, которого не должно быть');
    };

    // (а) Строка есть, заявка есть, но строка принадлежит ДРУГОЙ заявке. Одноколоночный ключ
    // такую вставку пропустил бы: сама строка существует.
    const чужаяСтрока = lineOf(чужая, первый);
    const поЧужойСтроке = await отказ(
      ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE office_equipment_consumables SET quantity = 9 WHERE id = ${первый}`,
        );
        await tx.execute(sql`
          INSERT INTO office_equipment_consumable_stock_entries
            (consumable_id, entry_kind, service_request_id, service_request_consumable_id,
             quantity_before, quantity_after, reason, changed_by)
          VALUES (${первый}, 'issue', ${своя.id}, ${чужаяСтрока.id}, 10, 9,
                  'выдано по строке чужой заявки', ${ctx.admin.id})`);
      }),
    );
    expect(поЧужойСтроке.code).toBe('23503');
    expect(поЧужойСтроке.constraint).toBe('office_equipment_consumable_stock_row_fk');

    // (б) Строка своя и заявка своя, но позиция в событии — ДРУГАЯ. Третья колонка тройки.
    const свояСтрока = lineOf(своя, первый);
    const поДругойПозиции = await отказ(
      ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE office_equipment_consumables SET quantity = 9 WHERE id = ${второй}`,
        );
        await tx.execute(sql`
          INSERT INTO office_equipment_consumable_stock_entries
            (consumable_id, entry_kind, service_request_id, service_request_consumable_id,
             quantity_before, quantity_after, reason, changed_by)
          VALUES (${второй}, 'issue', ${своя.id}, ${свояСтрока.id}, 10, 9,
                  'списано не с той позиции', ${ctx.admin.id})`);
      }),
    );
    expect(поДругойПозиции.code).toBe('23503');
    expect(поДругойПозиции.constraint).toBe('office_equipment_consumable_stock_row_fk');

    // Ни одна отбитая вставка склада не сдвинула: отказ приходит на коммите, и правка карточки
    // откатывается вместе с ним.
    expect(await stockOf(первый)).toBe(10);
    expect(await stockOf(второй)).toBe(10);

    // (в) Ручная правка остатка — ссылки на заявку обе пусты — проходит. Это и есть `MATCH SIMPLE`
    // (умолчание, и переписывать его нельзя): ключ пропускает строку, где хоть одна колонка тройки
    // пуста. С `MATCH FULL` первая же корректировка кладовщика упёрлась бы в этот ключ.
    const правка = await inject('POST', `/api/v1/office-equipment-consumables/${первый}/stock`, {
      quantity: 12,
      expectedQuantity: 10,
      reason: 'привезли две пачки',
    });
    expect(правка.statusCode, правка.body).toBe(200);
    expect(await stockOf(первый)).toBe(12);
    const последнее = (await entriesOf(первый)).at(-1)!;
    expect(последнее.entry_kind).toBe('manual');
    expect(последнее.service_request_id).toBeNull();
    expect(последнее.service_request_consumable_id).toBeNull();
  }, 60_000);

  // ── Границы вида и статуса: что смежные ручки НЕ делают с заявкой на расходники ──

  /**
   * Обе группы ниже закрывают дыры, найденные сверкой после реализации выпуска 3, и обе — про одно:
   * ручка спрашивала меньше, чем требует матрица §6.2, а портал знал больше сервера. Портальное
   * знание защитой не является: 422 отдаёт сервер, к нему ходят и мимо портала.
   */

  it('смета по заявке на расходники отбита во всех пяти дверях сметного круга', async () => {
    const consumable = await makeConsumable('Тонер стражевой', 10);
    const request = await makeRequest([{ consumableId: consumable, requestedQuantity: 1 }]);
    const base = `/api/v1/service-requests/${request.id}`;

    // Достижимы снаружи только эти две: остальные три требуют «Смету на согласовании», куда без
    // предъявления не попасть. Проверяются всё равно все — страж не должен зависеть от того, что
    // соседняя дверь заперта.
    const doors: [string, string, object][] = [
      ['PUT', `${base}/estimate`, { items: [], version: request.version }],
      ['PATCH', `${base}/estimate/submit`, { warrantyRepair: false, version: request.version }],
      ['PATCH', `${base}/estimate/approval`, { approved: true, version: request.version }],
      ['PATCH', `${base}/estimate/reopen`, { reason: 'вернуть в правку', version: request.version }],
      ['PATCH', `${base}/it-approval`, { approved: true, version: request.version }],
    ];
    for (const [method, url, body] of doors) {
      const res = await inject(method, url, body);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(422);
      expect(message(res), `${method} ${url}`).toContain('Заявка на расходники сметы не имеет');
    }

    // Заявка после всех попыток там же, где была, и склад не тронут.
    expect((await card(request.id)).status).toBe('in_work');
    expect(await stockOf(consumable)).toBe(10);
  });

  it('выдача не отмечается до начала работ — ни в «Новой», ни в «Назначена»', async () => {
    const consumable = await makeConsumable('Тонер дозаказный', 10);
    const equipmentId = await makeEquipment();
    const created = await inject('POST', '/api/v1/service-requests', {
      officeEquipmentId: equipmentId,
      kind: 'consumable',
      consumables: [{ consumableId: consumable, requestedQuantity: 2 }],
      description: 'Нужны картриджи',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
    });
    expect(created.statusCode, created.body).toBe(201);
    const request = (created.json() as { request: ServiceRequestDto }).request;
    const line = lineOf(request, consumable);
    const issued = (version: number) =>
      inject('PATCH', `/api/v1/service-requests/${request.id}/consumables/issued`, {
        items: [{ id: line.id, issuedQuantity: 2 }],
        version,
      });

    // «Новая»: исполнителей нет вовсе, и ход держателя `serviceRequests.status` в назначении не
    // нуждается — прежняя проверка «лишь бы не закрыта» списала бы со склада по заявке, которую
    // ещё никто не взял.
    const inNew = await issued(request.version);
    expect(inNew.statusCode, inNew.body).toBe(422);
    expect(message(inNew)).toContain('Выдачу отмечают в статусах');
    expect(await stockOf(consumable)).toBe(10);

    const assigned = await inject('PUT', `/api/v1/service-requests/${request.id}/executors`, {
      userIds: [ctx.admin.id],
      serviceCounterpartyId: null,
      version: request.version,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const assignedVersion = (assigned.json() as { request: ServiceRequestDto }).request.version;

    // «Назначена»: исполнитель уже есть — то есть отсекает именно статус, а не отсутствие прав.
    const inAssigned = await issued(assignedVersion);
    expect(inAssigned.statusCode, inAssigned.body).toBe(422);
    expect(message(inAssigned)).toContain('Выдачу отмечают в статусах');
    expect(await stockOf(consumable)).toBe(10);

    // А из «В работе» тот же вызов проходит: запирает статус, и только он.
    const started = await inject('PATCH', `/api/v1/service-requests/${request.id}/start`, {
      version: assignedVersion,
    });
    expect(started.statusCode, started.body).toBe(200);
    const ok = await issued((started.json() as ServiceRequestDto).version);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await stockOf(consumable)).toBe(8);
  });

  it('у отложенной заявки выдача не правится — как и её состав (Р110)', async () => {
    const consumable = await makeConsumable('Тонер отложенный', 10);
    const request = await makeRequest([{ consumableId: consumable, requestedQuantity: 3 }]);
    const line = lineOf(request, consumable);

    const held = await inject('PATCH', `/api/v1/service-requests/${request.id}/hold`, {
      reason: 'ждём поставку',
      version: request.version,
    });
    expect(held.statusCode, held.body).toBe(200);
    expect((held.json() as ServiceRequestDto).status).toBe('on_hold');

    const res = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/consumables/issued`,
      {
        items: [{ id: line.id, issuedQuantity: 3 }],
        version: (held.json() as ServiceRequestDto).version,
      },
    );
    expect(res.statusCode, res.body).toBe(422);
    expect(message(res)).toContain('Выдачу отмечают в статусах');
    expect(await stockOf(consumable)).toBe(10);

    // Возобновление возвращает право на ход: заперта была заморозка, а не заявка.
    const resumed = await inject('PATCH', `/api/v1/service-requests/${request.id}/resume`, {
      version: (await card(request.id)).version,
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    const after = await inject(
      'PATCH',
      `/api/v1/service-requests/${request.id}/consumables/issued`,
      {
        items: [{ id: line.id, issuedQuantity: 3 }],
        version: (resumed.json() as ServiceRequestDto).version,
      },
    );
    expect(after.statusCode, after.body).toBe(200);
    expect(await stockOf(consumable)).toBe(7);
    // Шесть обращений подряд: умолчания в 5 с этому случаю не хватает на загруженной машине.
  }, 30_000);
});
