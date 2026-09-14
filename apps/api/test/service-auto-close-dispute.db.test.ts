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
 * Автозакрытие и спор об освобождении от подписи (Р9 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, этап Э6).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ЧЕГО НЕТ В СОСЕДНЕМ ФАЙЛЕ. `service-request-auto-close.db.test.ts`
 * описывает отбор без спора: срок, бумагу, подпись, порог. Этот файл — про три новых состояния,
 * которых до Р9 не существовало вовсе: открытый спор, ожидание подписи с происхождением `dispute`
 * и порог окна приёмки, выставленный разрешением спора либо постспорной подписью. Цена ошибки
 * здесь выше обычной: портал закрывает заявку САМ, то есть подтверждает платёж по объёму работ, с
 * которым «Ведение» как раз и не согласилось, и человек об этом узнаёт из закрытой заявки.
 *
 * ЗАЧЕМ БАЗА. Все три правила — слагаемые одного условия отбора на SQL (`NO_OPEN_DISPUTE`,
 * `NO_DISPUTE_SIGNATURE_PENDING`, `DUE_AT`), и ошибка в них — не исключение, а тихо другая
 * выборка: `IS DISTINCT FROM`, заменённое на `<>`, выкинуло бы из отбора половину заявок и не
 * сказало бы ни слова. Проверять это на моках значило бы проверять собственное представление о
 * трёхзначной логике PostgreSQL.
 *
 * ПОЧЕМУ ФИКСТУРЫ — ПРЯМОЙ SQL, А НЕ ХОД ПО РУЧКАМ. Предмет проверки — даты: «сутки от разрешения»,
 * «сутки от подписи», «не берётся вовсе, сколько бы ни прошло». Провести заявку через спор ручками
 * можно (это делает `service-estimate-dispute.db.test.ts`), а состарить её на сутки — нет, и такой
 * тест всё равно доехал бы до прямого `UPDATE` дат. Разделение труда прямое: ручки и матрицу
 * исходов держит соседний файл, здесь — только отбор пачки, которому состояния подаются готовыми.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test service-auto-close-dispute
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const INTERNAL_TOKEN = `auto-close-dispute-${RUN}`;

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
  // Пачка заведомо шире сценария: вытеснение проверяет соседний файл, здесь оно только мешало бы
  // отличить «заявку не взяли по условию» от «заявке не хватило места».
  process.env.SERVICE_REQUEST_AUTO_CLOSE_BATCH = '50';
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
  return `10.45.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
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

async function statusOf(id: string): Promise<string> {
  const res = await ctx.db.execute<{ status: string }>(
    sql`SELECT status::text AS status FROM service_requests WHERE id = ${id}`,
  );
  return res.rows[0]!.status;
}

/** Единица техники под заявку: по одной единице незакрытая заявка бывает только одна (Р21). */
async function makeEquipment(tag: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id)
    VALUES (${ctx.typeId}, ${`МФУ ${tag} ${RUN}`}, ${`АЗС-${RUN}-${tag}`}, ${ctx.objectId})
    RETURNING id`);
  return res.rows[0]!.id;
}

interface MakeRequest {
  /** Исполнитель — сервисная компания: только такой заявке закрывающий документ обязателен (Н8). */
  service?: boolean;
}

/**
 * Заявка в «Решена», предъявленная 200 дней назад, с предъявленной ревизией № 1.
 *
 * ВОЗРАСТ ВСЮДУ ОДИН И ЗАВЕДОМО ОГРОМНЫЙ — и это не лень фикстуры, а условие проверки: по
 * `completed_at` и по бумаге каждая заявка файла созрела давно, значит каждый её простой объясняется
 * ровно тем, что проверяет случай, — спором, ожиданием подписи или порогом. Иначе «не закрылась»
 * читалось бы двусмысленно.
 *
 * Строка заявки и строка исполнителя заводятся **одной транзакцией**: инвариант «в рабочем статусе
 * у заявки есть исполнитель» держит отложенный constraint-триггер миграции `0178`, и он
 * срабатывает на `COMMIT`.
 */
async function makeRequest(tag: string, opts: MakeRequest = {}): Promise<string> {
  const equipmentId = await makeEquipment(tag);
  const id = await ctx.db.transaction(async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      INSERT INTO service_requests (kind, office_equipment_id, equipment_object_id, equipment_name,
                                    description, status, service_counterparty_id, completed_at,
                                    status_changed_at, estimate_revision, created_by)
      VALUES ('repair', ${equipmentId}, ${ctx.objectId}, ${`МФУ ${tag} ${RUN}`},
              ${`Спор и автозакрытие ${tag}`}, 'done'::service_request_status,
              ${opts.service ? ctx.serviceCounterpartyId : null},
              now() - '200 days'::interval, now() - '200 days'::interval, 1, ${ctx.adminId})
      RETURNING id`);
    const requestId = res.rows[0]!.id;
    // У заявки без контрагента исполнитель поимённый — иначе триггер не пустит её в «Решена».
    if (!opts.service) {
      await tx.execute(sql`
        INSERT INTO service_request_executors (request_id, user_id, assigned_by)
        VALUES (${requestId}, ${ctx.executorId}, ${ctx.adminId})`);
    }
    // Ревизия нужна не для красоты: спор ссылается на пару «заявка + ревизия» внешним ключом, и
    // без строки предъявления его вставка отбилась бы целостностью.
    await tx.execute(sql`
      INSERT INTO service_request_estimate_revisions (request_id, revision, format, state,
                                                      submitted_by, submitted_at, total_amount)
      VALUES (${requestId}, 1, 'items', 'active', ${ctx.adminId}, now() - '200 days'::interval,
              1000.00)`);
    return requestId;
  });
  if (opts.service) await attachAct(id);
  return id;
}

/** Закрывающий акт, подшитый в день предъявления работ: планка Н8 у сервисной заявки. */
async function attachAct(requestId: string): Promise<void> {
  const file = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
    VALUES ('test', ${`acd/${RUN}/${randomUUID()}`}, 'act.pdf', 'application/pdf', 1024,
            'pending', ${ctx.adminId})
    RETURNING id`);
  await ctx.db.execute(sql`
    INSERT INTO service_request_files (request_id, file_id, kind, attached_by, attached_at)
    VALUES (${requestId}, ${file.rows[0]!.id}, 'act', ${ctx.adminId},
            now() - '200 days'::interval)`);
}

/**
 * Освобождение применено: подпись под действующей ревизией стоит, но поставил её не человек
 * (`estimate_approval_source = 'auto'`) — ровно то состояние, которое и оспаривает «Ведение».
 * Автора у автоподписи нет и быть не может (`service_requests_estimate_approval_source_check`).
 */
async function applyExemption(requestId: string): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE service_requests
       SET approved_estimate_revision = 1, estimate_approved_at = now() - '200 days'::interval,
           estimate_approved_by = NULL, estimate_approval_source = 'auto'
     WHERE id = ${requestId}`);
}

/** Открытый спор: строка со состоянием `open` и заморозка заявки — как их ставит ручка. */
async function openDispute(requestId: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO service_request_estimate_disputes (request_id, revision, opened_by, opened_at,
                                                   reason, state)
    VALUES (${requestId}, 1, ${ctx.adminId}, now() - '7 days'::interval,
            'Подпись не собирали, а сумма нерыночная', 'open')`);
}

/** Разрешение спора: строка получает исход, время и автора. */
async function resolveDispute(
  requestId: string,
  outcome: 'keep' | 'require_signature',
  resolvedAgo: string,
): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE service_request_estimate_disputes
       SET state = 'resolved', outcome = ${outcome}, resolved_by = ${ctx.adminId},
           resolved_at = now() - ${resolvedAgo}::interval
     WHERE request_id = ${requestId} AND state = 'open'`);
}

/** Порог окна приёмки: столько времени назад, сколько просят. `null` — порога нет. */
async function setThreshold(requestId: string, ago: string | null): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE service_requests
       SET auto_close_not_before = ${ago === null ? null : sql`now() - ${ago}::interval`}
     WHERE id = ${requestId}`);
}

describe.skipIf(!DB_URL)('автозакрытие и спор об освобождении (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { buildApp } = await import('../src/app');

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`ACD-${RUN}`}, ${`Площадка спора ${RUN}`}, 'г Москва, ул Тестовая, д 2')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    async function makeUser(tag: string, role: string): Promise<string> {
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${`db-acd-${tag}-${RUN}@example.invalid`}, 'Тестовый', 'Пользователь', ${tag},
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
      VALUES ('service', ${`Сервис спора ${RUN}`},
              ${`78${RUN.replace(/\D/gu, '0').padEnd(8, '0').slice(0, 8)}`})
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
        SELECT id FROM office_equipment WHERE inventory_number LIKE ${`АЗС-${RUN}-%`})`;
      await ctx.db.execute(
        sql`DELETE FROM audit_log WHERE entity_type = 'serviceRequest'
             AND entity_id IN (SELECT id::text FROM (${requests}) t)`,
      );
      await ctx.db.execute(
        sql`DELETE FROM service_request_status_history WHERE request_id IN (${requests})`,
      );
      // Споры, ревизии, исполнителей и подшитые документы уносит каскад самой заявки.
      await ctx.db.execute(sql`DELETE FROM service_requests WHERE id IN (${requests})`);
      await ctx.db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`acd/${RUN}/%`}`);
      await ctx.db.execute(
        sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`АЗС-${RUN}-%`}`,
      );
      // Модель заводится вставкой карточки (миграция `0171`) и за карточкой не уходит.
      await ctx.db.execute(sql`
        DELETE FROM office_equipment_models m
         WHERE m.name LIKE ${`% ${RUN}`}
           AND NOT EXISTS (SELECT 1 FROM office_equipment e WHERE e.model_id = m.id)`);
      await ctx.db.execute(sql`DELETE FROM counterparties WHERE name = ${`Сервис спора ${RUN}`}`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-acd-%-${RUN}@example.invalid`}`,
      );
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code = ${`ACD-${RUN}`}`);
      await ctx.closeDb();
    }
  });

  /**
   * Заявка стоит в «Решена» со спором на руках. Механика спора уводит её в «Отложена», и по статусу
   * отбор её не увидел бы, — но правило держится на самом споре: статус правят администратором,
   * возвращают пачкой, а запреты в ручках теряются при следующей переделке цикла. Состояние собрано
   * прямым SQL именно потому, что ручками до него не дойти: это проверка запасного рубежа.
   */
  it('открытый спор держит заявку, даже если она стоит в «Решена» и созрела по всем срокам', async () => {
    const disputed = await makeRequest('open-dispute', { service: true });
    await applyExemption(disputed);
    await openDispute(disputed);

    // Контроль соседа: та же заявка без спора закрывается — значит простой объясняется спором, а
    // не фикстурой, в которой чего-то не хватает.
    const plain = await makeRequest('open-control', { service: true });
    await applyExemption(plain);

    await autoClose();

    expect(await statusOf(disputed)).toBe('done');
    expect(await statusOf(plain)).toBe('accepted');
  });

  /**
   * Исход «оставить освобождение»: заявка возвращается в «Решена», подпись остаётся автоматической,
   * но окно на возражение открывается ЗАНОВО — от момента разрешения. Без порога заявка,
   * простоявшая в споре неделю, закрылась бы в ту же минуту, в которую спор и разобрали: ответить на
   * решение не успел бы никто.
   */
  it('исход «оставить освобождение»: сутки идут от разрешения спора, а не от закрытия работ', async () => {
    const id = await makeRequest('keep', { service: true });
    await applyExemption(id);
    await openDispute(id);
    // Спор разрешён только что — порог поставлен тем же мгновением, что и исход.
    await resolveDispute(id, 'keep', '0 minutes');
    await setThreshold(id, '0 minutes');

    await autoClose();
    expect(await statusOf(id)).toBe('done');

    // За минуту до суток заявка всё ещё стоит: граница проверяется с той же стороны, что и у
    // обычного срока.
    await setThreshold(id, '23 hours 59 minutes');
    await autoClose();
    expect(await statusOf(id)).toBe('done');

    await setThreshold(id, '25 hours');
    await autoClose();
    expect(await statusOf(id)).toBe('accepted');
  });

  /**
   * Исход «нужна подпись»: автоподпись снята, ожидание открыто с происхождением `dispute`, порога
   * нет — его поставит сама подпись. До неё заявка не берётся ВООБЩЕ, и это запрет по состоянию, а
   * не сдвиг срока: сколько бы времени ни прошло и что бы ни стояло в пороге, без подписи заявка
   * остаётся в «Решена».
   */
  it('исход «нужна подпись»: до подписи не берётся вовсе, после подписи сутки идут от подписи', async () => {
    const id = await makeRequest('require-sign', { service: true });
    await applyExemption(id);
    await openDispute(id);
    await resolveDispute(id, 'require_signature', '7 days');
    // Снимок подписи погашен целиком, ожидание открыто по текущей ревизии — как это делает ручка
    // разрешения спора.
    await ctx.db.execute(sql`
      UPDATE service_requests
         SET approved_estimate_revision = NULL, estimate_approved_at = NULL,
             estimate_approved_by = NULL, estimate_approval_source = NULL,
             estimate_pending_revision = 1, estimate_pending_source = 'dispute'
       WHERE id = ${id}`);

    await autoClose();
    expect(await statusOf(id)).toBe('done');

    // Порог в далёком прошлом ничего не меняет: «ждём подпись» — не «ещё рано». Случай собран
    // нарочно негодным состоянием (ручки такого не ставят), чтобы запрет не держался на одном лишь
    // пустом пороге.
    await setThreshold(id, '30 days');
    await autoClose();
    expect(await statusOf(id)).toBe('done');

    // Подпись поставлена человеком: ожидание погашено, порог пришёл вместе с ней.
    await ctx.db.execute(sql`
      UPDATE service_requests
         SET approved_estimate_revision = 1, estimate_approved_at = now(),
             estimate_approved_by = ${ctx.adminId}, estimate_approval_source = 'human',
             estimate_pending_revision = NULL, estimate_pending_source = NULL,
             auto_close_not_before = now()
       WHERE id = ${id}`);

    await autoClose();
    // Сутки считаются от подписи, а не от разрешения спора: разреши мы отсчёт от разбора, заявка
    // закрылась бы в ту же минуту, в которую её подписали.
    expect(await statusOf(id)).toBe('done');

    await setThreshold(id, '25 hours');
    await autoClose();
    expect(await statusOf(id)).toBe('accepted');
  });

  /**
   * Ожидание с происхождением `dispute` запирает и заявку, которой закрывающий документ не нужен
   * (инхаус-ремонт без контрагента). Случай отдельный потому, что соседнее слагаемое
   * `ESTIMATE_SIGNED` такую заявку не спрашивает вовсе: убери запрет по происхождению — и дыра
   * откроется ровно здесь, у заявок без бумаги.
   *
   * Рядом — ловушка `NULL`: обычное ожидание приходит без происхождения (`NULL` читается как
   * `submit`), и напиши условие неравенством вместо `IS DISTINCT FROM`, отбор ответил бы `NULL` и
   * молча перестал закрывать такие заявки. Поэтому контроль здесь не «заявка без ожидания», а
   * именно «заявка с обычным ожиданием».
   */
  it('постспорное ожидание запирает заявку без документа, а обычное ожидание — нет', async () => {
    const afterDispute = await makeRequest('inhouse-dispute');
    await ctx.db.execute(sql`
      UPDATE service_requests
         SET estimate_pending_revision = 1, estimate_pending_source = 'dispute'
       WHERE id = ${afterDispute}`);

    const ordinary = await makeRequest('inhouse-submit');
    await ctx.db.execute(sql`
      UPDATE service_requests SET estimate_pending_revision = 1, estimate_pending_source = NULL
       WHERE id = ${ordinary}`);

    await autoClose();

    expect(await statusOf(afterDispute)).toBe('done');
    // Поведение заявок без спора обязано остаться ровно прежним — до волны такая закрывалась.
    expect(await statusOf(ordinary)).toBe('accepted');
  });

  /**
   * Разрешённый спор заявку больше не держит: запрет стоит на состоянии `open`, а не на самом факте
   * спора. Иначе одна попытка оспорить освобождение заперла бы заявку навсегда, и закрывать её
   * пришлось бы руками — то есть спор, разрешённый в пользу сервиса, наказывал бы сервис.
   */
  it('спор, разрешённый в пользу освобождения, закрытию больше не мешает', async () => {
    const id = await makeRequest('resolved', { service: true });
    await applyExemption(id);
    await openDispute(id);
    await resolveDispute(id, 'keep', '25 hours');
    await setThreshold(id, '25 hours');

    await autoClose();
    expect(await statusOf(id)).toBe('accepted');
  });

  /**
   * Заявка, никогда не знавшая спора, закрывается ровно как до волны: пустой порог, пустое
   * происхождение ожидания, ни одной строки спора. Случай нужен именно в этом файле: два новых
   * слагаемых отбора добавлены к общему условию, и «ничего не сломалось» проверяется там же, где
   * добавлено.
   */
  it('заявка без спора закрывается как прежде', async () => {
    const service = await makeRequest('plain-service', { service: true });
    await applyExemption(service);
    const inhouse = await makeRequest('plain-inhouse');

    await autoClose();

    expect(await statusOf(service)).toBe('accepted');
    expect(await statusOf(inhouse)).toBe('accepted');
  });
});
