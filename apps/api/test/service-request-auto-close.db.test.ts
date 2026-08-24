import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Автозакрытие заявки оргтехники «Решена» → «Закрыта» (план
 * `docs/office-equipment-requests-rework-plan.md`, §7.3 и §8 тест 2; решение Н7 набросков).
 *
 * ЗАЧЕМ БАЗА. Проверять тут нечего, кроме одного SQL-запроса и того, что база разрешает им сделать.
 * Срок считается выражением на стороне PostgreSQL (`GREATEST`, `min(attached_at)`, `now()`), отбор
 * идёт `FOR UPDATE SKIP LOCKED`, а запись действия без человека держится на двух ограничениях
 * миграции `0176` — `service_requests_acceptance_source_check` и
 * `service_request_status_history_actor_check`. Ни одно из этих правил на моках не существует:
 * подменив базу, мы проверили бы собственное представление о ней.
 *
 * ПОЧЕМУ ФИКСТУРЫ ЗАВОДЯТСЯ ПРЯМЫМ SQL, А НЕ РУЧКАМИ ПОРТАЛА. Предмет проверки — **даты**: «за
 * минуту до суток», «ровно в сутки», «сутки от подшивки бумаги». Провести заявку по циклу ручками
 * можно, а состарить её на сутки — нет, и любой такой тест всё равно доехал бы до прямого `UPDATE`
 * дат. Заодно файл не зависит от переделки самих ручек, которая идёт в соседних волнах.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test service-request-auto-close
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const INTERNAL_TOKEN = `auto-close-${RUN}`;

/**
 * Размер пачки на время прогона — три штуки.
 *
 * Число выбрано не «поменьше», а под сценарий вытеснения: в нём ровно три законные заявки и одна
 * наследная — сервисная, в «Решена» и без бумаги. Возьми её отбор в пачку — и она, как самая
 * старая, встала бы первой, а одна из законных осталась бы открытой. С трёхместной пачкой это
 * видно сразу; с пачкой на полсотни — не видно вовсе.
 */
const BATCH = 3;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  adminId: string;
  executorId: string;
  serviceCounterpartyId: string;
  objectId: string;
  typeId: string;
}

let ctx: Ctx;

/** Что сценарий передаёт между шагами: наследная заявка живёт в двух `it` подряд. */
const state: { legacy: string } = { legacy: '' };

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
  // Внутренний контур: у автозакрытия нет человека, и дверь ему открывает общий секрет.
  process.env.INTERNAL_API_TOKEN = INTERNAL_TOKEN;
  process.env.SERVICE_REQUEST_AUTO_CLOSE_BATCH = String(BATCH);
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

/** Свой адрес на каждый вызов: общий ограничитель считает обращения с адреса. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.44.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

interface AutoCloseStats {
  taken: number;
  closed: number;
  skipped: number;
  failed: number;
}

/** Прогон автозакрытия — той же ручкой, которой его будит worker. */
async function autoClose(): Promise<AutoCloseStats> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/internal/service-requests/auto-close',
    headers: { 'x-internal-token': INTERNAL_TOKEN },
    remoteAddress: nextAddress(),
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AutoCloseStats;
}

interface RequestRow {
  status: string;
  acceptance_source: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  updated_by: string | null;
  version: number;
}

async function rowOf(id: string): Promise<RequestRow> {
  const res = await ctx.db.execute<RequestRow>(sql`
    SELECT status::text AS status, acceptance_source, accepted_by, accepted_at, updated_by, version
      FROM service_requests WHERE id = ${id}`);
  return res.rows[0]!;
}

async function statusOf(id: string): Promise<string> {
  return (await rowOf(id)).status;
}

async function historyOf(id: string) {
  const res = await ctx.db.execute<{
    from_status: string | null;
    to_status: string;
    changed_by: string | null;
    actor_source: string;
  }>(sql`
    SELECT from_status::text AS from_status, to_status::text AS to_status, changed_by, actor_source
      FROM service_request_status_history WHERE request_id = ${id} ORDER BY changed_at`);
  return res.rows;
}

/** Единица техники под заявку: по одной единице незакрытая заявка бывает только одна (Р21). */
async function makeEquipment(tag: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id)
    VALUES (${ctx.typeId}, ${`МФУ ${tag} ${RUN}`}, ${`АЗ-${RUN}-${tag}`}, ${ctx.objectId})
    RETURNING id`);
  return res.rows[0]!.id;
}

interface MakeRequest {
  /** Сколько назад заявка ушла в «Решена»: интервал PostgreSQL, например `'25 hours'`. */
  completedAgo: string;
  /** Исполнитель — сервисная компания: только такой заявке закрывающий документ обязателен (Н8). */
  service?: boolean;
  kind?: 'repair' | 'consumable';
  /** Отложенная: статус `on_hold`, а вернуться ей есть куда — в «Решена». */
  held?: boolean;
}

/**
 * Заявка в «Решена» с заданным возрастом.
 *
 * Строка заявки и строка исполнителя заводятся **одной транзакцией**: инвариант «в рабочем статусе
 * у заявки есть исполнитель» держит отложенный constraint-триггер миграции `0178`, и он
 * срабатывает на `COMMIT`. Вставь их порознь — первый же `COMMIT` без исполнителя отбился бы.
 */
async function makeRequest(tag: string, opts: MakeRequest): Promise<string> {
  const equipmentId = await makeEquipment(tag);
  const kind = opts.kind ?? 'repair';
  const status = opts.held ? 'on_hold' : 'done';
  return ctx.db.transaction(async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      INSERT INTO service_requests (kind, office_equipment_id, equipment_object_id, equipment_name,
                                    description, status, held_from_status, hold_reason,
                                    service_counterparty_id, completed_at, status_changed_at,
                                    created_by)
      VALUES (${kind}, ${equipmentId}, ${ctx.objectId}, ${`МФУ ${tag} ${RUN}`},
              ${`Автозакрытие ${tag}`}, ${status}::service_request_status,
              ${opts.held ? sql`'done'::service_request_status` : null},
              ${opts.held ? 'Ждём запчасть' : ''},
              ${opts.service ? ctx.serviceCounterpartyId : null},
              now() - ${opts.completedAgo}::interval,
              now() - ${opts.completedAgo}::interval,
              ${ctx.adminId})
      RETURNING id`);
    const id = res.rows[0]!.id;
    // У заявки без контрагента исполнитель поимённый — иначе триггер не пустит её в «Решена».
    if (!opts.service) {
      await tx.execute(sql`
        INSERT INTO service_request_executors (request_id, user_id, assigned_by)
        VALUES (${id}, ${ctx.executorId}, ${ctx.adminId})`);
    }
    return id;
  });
}

/** Закрывающий документ, подшитый заданное время назад. */
async function attachDocument(
  requestId: string,
  kind: 'act' | 'invoice' | 'warranty_card',
  attachedAgo: string,
): Promise<void> {
  const file = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`ac/${RUN}/${randomUUID()}`}, ${`${kind}.pdf`}, 'application/pdf', 1024,
            'pending', ${ctx.adminId})
    RETURNING id`);
  await ctx.db.execute(sql`
    INSERT INTO service_request_files (request_id, file_id, kind, attached_by, attached_at)
    VALUES (${requestId}, ${file.rows[0]!.id}, ${kind}, ${ctx.adminId},
            now() - ${attachedAgo}::interval)`);
}

/** Состарить заявку: заново поставить дату предъявления работ. */
async function setCompletedAgo(requestId: string, ago: string): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE service_requests SET completed_at = now() - ${ago}::interval
     WHERE id = ${requestId}`);
}

/** Состарить бумагу: подшивка «сутки назад» вместо «только что». */
async function setAttachedAgo(requestId: string, ago: string): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE service_request_files SET attached_at = now() - ${ago}::interval
     WHERE request_id = ${requestId}`);
}

describe.skipIf(!DB_URL)('автозакрытие заявок оргтехники (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { buildApp } = await import('../src/app');

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`AC-${RUN}`}, ${`Площадка автозакрытия ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    async function makeUser(tag: string, role: string): Promise<string> {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${`db-ac-${tag}-${RUN}@example.invalid`}, 'Тестовый', 'Пользователь', ${tag},
                'x', ${role}::role, true, now())
        RETURNING id`);
      return row.rows[0]!.id;
    }

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    // ИНН здесь произвольный, но валидный по формату: контрольную сумму проверяет форма, а не база.
    const counterparty = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('service', ${`Сервис автозакрытия ${RUN}`}, ${`77${RUN.replace(/\D/gu, '0').padEnd(8, '0').slice(0, 8)}`})
      RETURNING id`);

    ctx = {
      app: await buildApp(),
      db,
      closeDb,
      adminId: await makeUser('admin', 'admin'),
      executorId: await makeUser('exec', 'shtab'),
      serviceCounterpartyId: counterparty.rows[0]!.id,
      objectId,
      typeId: typeRow.rows[0]!.id,
    };
  }, 120_000);

  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      const requests = sql`SELECT id FROM service_requests WHERE office_equipment_id IN (
        SELECT id FROM office_equipment WHERE inventory_number LIKE ${`АЗ-${RUN}-%`})`;
      await ctx.db.execute(
        sql`DELETE FROM audit_log WHERE entity_type = 'serviceRequest'
             AND entity_id IN (SELECT id::text FROM (${requests}) t)`,
      );
      await ctx.db.execute(
        sql`DELETE FROM service_request_status_history WHERE request_id IN (${requests})`,
      );
      // Строки исполнителей и подшитых документов уносит каскад самой заявки.
      await ctx.db.execute(sql`DELETE FROM service_requests WHERE id IN (${requests})`);
      await ctx.db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`ac/${RUN}/%`}`);
      await ctx.db.execute(
        sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`АЗ-${RUN}-%`}`,
      );
      // Модель заводится вставкой карточки (миграция `0171`) и за карточкой не уходит.
      await ctx.db.execute(sql`
        DELETE FROM office_equipment_models m
         WHERE m.name LIKE ${`% ${RUN}`}
           AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
      await ctx.db.execute(
        sql`DELETE FROM counterparties WHERE name = ${`Сервис автозакрытия ${RUN}`}`,
      );
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-ac-%-${RUN}@example.invalid`}`,
      );
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${`AC-${RUN}`}`);
      await ctx.closeDb();
    }
  });

  it('без внутреннего секрета дверь закрыта', async () => {
    // Ручка живёт во внутреннем контуре: наружу префикс `/internal` не проксируется, а изнутри её
    // открывает общий секрет. Заодно проверяется форма запроса, которой ходит worker, — `POST` без
    // тела и без `content-type`.
    const anon = await ctx.app.inject({
      method: 'POST',
      url: '/internal/service-requests/auto-close',
      remoteAddress: nextAddress(),
    });
    expect(anon.statusCode).toBe(401);

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/internal/service-requests/auto-close',
      headers: { 'x-internal-token': 'не тот секрет' },
      remoteAddress: nextAddress(),
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('сутки в «Решена» — заявка закрыта порталом, в истории строка без автора', async () => {
    const id = await makeRequest('plain', { completedAgo: '25 hours' });
    const before = await rowOf(id);

    const stats = await autoClose();
    expect(stats.closed).toBeGreaterThanOrEqual(1);
    expect(stats.failed).toBe(0);

    const after = await rowOf(id);
    expect(after.status).toBe('accepted');
    // «Автоматически, но кем-то» — состояние, которое никто не объяснит: источник `auto`, автор пуст.
    expect(after.acceptance_source).toBe('auto');
    expect(after.accepted_by).toBeNull();
    expect(after.accepted_at).not.toBeNull();
    // Закрытие записано на портал, а не на того, кто последним правил заявку.
    expect(after.updated_by).toBeNull();
    expect(after.version).toBe(before.version + 1);

    const history = await historyOf(id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      from_status: 'done',
      to_status: 'accepted',
      changed_by: null,
      actor_source: 'system',
    });

    // Второй прогон заявку уже не видит: она не в «Решена». Строка истории остаётся одна — иначе
    // лента показывала бы закрытие каждые пять минут.
    await autoClose();
    expect(await historyOf(id)).toHaveLength(1);
  });

  it('за минуту до суток заявка стоит, ровно в сутки — закрывается', async () => {
    const id = await makeRequest('edge', { completedAgo: '23 hours 59 minutes' });
    await autoClose();
    expect(await statusOf(id)).toBe('done');

    await setCompletedAgo(id, '24 hours');
    await autoClose();
    expect(await statusOf(id)).toBe('accepted');
  });

  it('возврат на доработку и повторная «Решена» отсчитывают сутки заново', async () => {
    const id = await makeRequest('rework', { completedAgo: '3 days' });
    // Заявку возвращали на доработку и предъявили заново: история помнит оба круга, а срок считает
    // последнее предъявление — окно на возражение открывается после него.
    await ctx.db.execute(sql`
      INSERT INTO service_request_status_history (request_id, from_status, to_status, changed_by,
                                                  changed_at)
      VALUES (${id}, 'in_work', 'done', ${ctx.adminId}, now() - interval '3 days'),
             (${id}, 'done', 'in_work', ${ctx.adminId}, now() - interval '2 days'),
             (${id}, 'in_work', 'done', ${ctx.adminId}, now() - interval '1 minute')`);
    await setCompletedAgo(id, '1 minute');

    await autoClose();
    expect(await statusOf(id)).toBe('done');

    await setCompletedAgo(id, '25 hours');
    await autoClose();
    expect(await statusOf(id)).toBe('accepted');
  });

  /**
   * Наследие выпуска 0: до него планка закрывающего документа стояла только на приёмке, и внешний
   * ремонт мог уехать в «Решена» без бумаги. Такая заявка обязана отсекаться **условием отбора**, а
   * не проверкой после выборки: она старше всех и, попав в пачку, вытесняла бы законные заявки
   * каждый прогон.
   */
  it('заявка сервиса без документа не попадает в пачку и не вытесняет законные', async () => {
    const legacy = await makeRequest('legacy', { completedAgo: '200 days', service: true });
    const legit = [
      await makeRequest('queue1', { completedAgo: '30 days' }),
      await makeRequest('queue2', { completedAgo: '29 days' }),
      await makeRequest('queue3', { completedAgo: '28 days' }),
    ];

    const stats = await autoClose();
    // Пачка на три места и три законные заявки: наследная в отбор не вошла вовсе.
    expect(stats.taken).toBe(BATCH);
    expect(stats.closed).toBe(BATCH);
    for (const id of legit) expect(await statusOf(id)).toBe('accepted');
    expect(await statusOf(legacy)).toBe('done');

    // Дальше эта же заявка продолжает историю: ей подшивают акт.
    state.legacy = legacy;
  });

  it('подшитый акт закрывает наследие через сутки от подшивки, а не в ту же секунду', async () => {
    const id = state.legacy;
    await attachDocument(id, 'act', '1 minute');
    await autoClose();
    // Сутки на возражение отсчитываются от бумаги: раньше её заказчик и не видел, что предъявили.
    expect(await statusOf(id)).toBe('done');

    await setAttachedAgo(id, '25 hours');
    await autoClose();
    expect(await statusOf(id)).toBe('accepted');
  });

  it('второй документ срок не двигает — отсчёт остаётся на первом', async () => {
    const id = await makeRequest('second-doc', { completedAgo: '200 days', service: true });
    await attachDocument(id, 'act', '25 hours');
    // Доплатный счёт пришёл только что. Считай портал по последнему документу — заявка ждала бы
    // ещё сутки, и так после каждой досланной бумаги.
    await attachDocument(id, 'invoice', '0 minutes');

    await autoClose();
    expect(await statusOf(id)).toBe('accepted');
  });

  it('заявке без обязательного документа приложенный счёт закрытие не отодвигает', async () => {
    // Инхаус-ремонт и расходники: бумага им не требуется вовсе, но подшить её никто не мешает.
    const inhouse = await makeRequest('inhouse', { completedAgo: '25 hours' });
    const consumable = await makeRequest('consumable', {
      completedAgo: '25 hours',
      kind: 'consumable',
    });
    await attachDocument(inhouse, 'invoice', '0 minutes');
    await attachDocument(consumable, 'invoice', '0 minutes');

    await autoClose();
    expect(await statusOf(inhouse)).toBe('accepted');
    expect(await statusOf(consumable)).toBe('accepted');
  });

  /**
   * Тест 2а плана: **гарантийный талон как единственный документ**. Планка Н8 требует у сервисного
   * ремонта «закрывающий документ», и талон — один из трёх, которые ею считаются (акт, счёт,
   * талон). Случай нужен отдельно от двух соседних именно потому, что талон — самый неочевидный из
   * трёх: гарантийный ремонт денег не стоит, счёта и акта по нему может не быть вовсе, и заявка,
   * закрытая по гарантии, оставалась бы висеть в «Решена» вечно, если бы отбор считал закрывающими
   * только бумаги с суммой.
   *
   * Проверяется вся цепочка разом: талон подшит, отбор заявку ВИДИТ (в пачку она попала), сутки от
   * предъявления работ прошли — заявка закрыта автоматически.
   */
  it('гарантийный талон закрывающим считается: заявка по гарантии закрывается сама', async () => {
    const id = await makeRequest('warranty', { completedAgo: '25 hours', service: true });
    await attachDocument(id, 'warranty_card', '25 hours');

    // Контроль: до подшивки такая же заявка сервиса в пачку не попадала бы вовсе — это соседний
    // случай файла. Здесь важно обратное: с талоном она в пачке есть.
    const stats = await autoClose();
    expect(stats.closed).toBeGreaterThan(0);
    expect(await statusOf(id)).toBe('accepted');
    // Закрыла система, а не человек: у строки истории нет автора, источник приёмки — `auto`.
    const row = await rowOf(id);
    expect(row.acceptance_source).toBe('auto');
    expect(row.accepted_by).toBeNull();
  });

  it('отложенная заявка не закрывается', async () => {
    // Всё, кроме статуса, у неё созрело: сервисный ремонт с актом, предъявленный двести дней назад.
    const id = await makeRequest('held', { completedAgo: '200 days', service: true, held: true });
    await attachDocument(id, 'act', '200 days');

    await autoClose();
    expect(await statusOf(id)).toBe('on_hold');
  });
});
