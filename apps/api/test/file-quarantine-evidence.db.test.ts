import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает. Сервису распознавания это
// особенно важно: он спрашивает `config.ticketOcr.enabled`, и флаг обязан быть выставлен до
// первого импорта конфига.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as WasteTicketsNs from '../src/services/waste-tickets';
import type { buildApp } from '../src/app';

/**
 * Карантин файла: ЧЕТЫРЕ ПУТИ, КОТОРЫМИ УНОСЯТ УЛИКУ (план
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Р6, п. 4).
 *
 * Соседний файл (`file-quarantine.db.test.ts`) доказывает, что карантин закрывает ДОСТУП: прямая
 * ссылка не отдаётся никому, включая автора загрузки. Этого мало. Доступ — только одна дверь к
 * содержимому, а у файла их пять, и четыре остальные не спрашивают про карантин ничего:
 *
 * | путь                                               | чем кончается без запрета                        |
 * | -------------------------------------------------- | ------------------------------------------------ |
 * | штатное снятие вложения (`scheduleFilesDeletion`)  | пометка `deleted` и снос объекта через 30 суток  |
 * | жёсткое удаление заявки (`hardDeleteFiles`)        | строка файла исчезает сразу, вместе с хешем      |
 * | уборка воркера (`cleanupUnlinkedFiles`, два места) | то же, но по возрасту и без участия человека     |
 * | подшивка в другую заявку (`assertFilesAttachable`) | имя запертого файла уезжает новой аудитории      |
 * | очередь распознавания (`enqueueTicketRecognition`) | скан повторно уходит ВНЕШНЕМУ распознавателю     |
 *
 * Первые три уносят предмет разбора целиком, причём первый — руками того, кто чаще всего и есть
 * виновник инцидента (улику снимает тот, кто её загрузил). Четвёртый расширяет аудиторию имени —
 * а имя файла само бывает персональными данными. Пятый необратим сильнее всех: переданное наружу
 * не отзывается ничем.
 *
 * ЗАЧЕМ БАЗА. Все пять запретов живут в SQL, а не в ветвлениях кода: три из них — условия в САМОМ
 * пишущем запросе (иначе между чтением и записью помещается постановка карантина), четвёртый стоит
 * под `FOR UPDATE`, пятый — строка в запросе связи воркера. Подмена здесь доказывала бы только то,
 * что в неё положили: вопрос стоит ровно обратный — удержит ли запертый файл НАСТОЯЩИЙ запрос,
 * которым ходят настоящие ручки.
 *
 * ОБРАТНАЯ СТОРОНА ПРОВЕРЯЕТСЯ ВСЮДУ. У каждого случая есть файл-близнец без карантина, и он обязан
 * пройти путь до конца: сняться, убраться, подшиться, уехать в распознавание. Без этой половины все
 * отказы выше одинаково хорошо объяснялись бы сломанной фикстурой — заявкой не того типа, не той
 * связью, не тем возрастом файла.
 *
 * ЗАПРОСЫ ВОРКЕРА БЕРУТСЯ ИЗ ЕГО ИСХОДНИКА ТЕКСТОМ. Импортировать `apps/worker/src/index.ts` нельзя
 * — последней строкой он запускает бесконечный цикл (`void loop()`), — а копия запроса в тесте
 * отвечала бы за себя, а не за воркер: удали условие в воркере, и копия осталась бы зелёной. Тот же
 * приём и по той же причине уже стоит в `file-linkage.db.test.ts`. У каждого запроса рядом идёт
 * «наивный» двойник — тот же текст без карантинного условия, — и он обязан ЗАБРАТЬ запертый файл:
 * так видно, что зелёный ответ дало условие, а не фикстура, в которой сносить было нечего.
 *
 * Запуск — как у остальных db-тестов:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test file-quarantine-evidence
 *
 * Без `TEST_DATABASE_URL` файл пропускается. Живого хранилища он не требует: карантин ставится
 * настоящей ручкой, а недосчитанный хеш — законное её состояние (план, Р6: «сначала доступ, потом
 * хеш»), и ни одно утверждение ниже на хеш не опирается.
 *
 * ГРАНИЦЫ. Доступ к содержимому, право разбора и журнал — `file-quarantine.db.test.ts`. Полнота
 * перечня связей и порядок условий уборки — `file-linkage.db.test.ts`. Сборщик вложений карточки
 * заявки оргтехники (имя карантинного файла в списке) живёт в чужом файле этой волны.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-quarantine-evidence-admin@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';
/** Метка своих заявок: база у db-тестов общая и переживает повторный запуск. */
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: карантин и пути уноса улики';
/**
 * Префикс ключей объектов: по нему уборка находит своё, включая оставленное падением.
 *
 * Метки НАМЕРЕННО не начинаются с `db-fq-`: этим префиксом помечает свои строки соседний
 * `file-quarantine.db.test.ts`, и его уборка сносит всё по `LIKE 'db-fq-%'`. База у db-тестов общая
 * и прогон идёт параллельно — совпади префиксы, сосед уносил бы учётку этого файла посреди его
 * подготовки (так и случилось при первом запуске: вход отвечал «неверный логин»).
 */
const KEY_PREFIX = 'db-quarantine-evidence/';

/**
 * Исходники воркера читаются текстом, а не импортируются: `index.ts` последней строкой запускает
 * бесконечный цикл. Причина целиком — в шапке файла.
 */
const WORKER_SOURCE = new URL('../../worker/src/index.ts', import.meta.url);
const TICKET_JOB_SOURCE = new URL('../../worker/src/ticket-ocr/job.ts', import.meta.url);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  tickets: typeof WasteTicketsNs;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  adminId: string;
  objectId: string;
}

let ctx: Ctx;
let fileNo = 0;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // Хранилища у прогона нет, и оно не нужно: постановка карантина считает хеш ПОСЛЕ закрытия
  // доступа и недосчитанный оставляет пустым (Р6). Адрес намеренно заведомо мёртвый — отказ
  // приходит сразу, а не таймаутом.
  process.env.S3_ENDPOINT ??= 'http://127.0.0.1:9';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.MAIL_ENABLED = 'false';
  // Распознавание включено: выключенный модуль задач не ставит вовсе (Р29), и проверять про
  // карантин было бы нечего. Транспорт остаётся `stub` — наружу тест не ходит и ходить не должен.
  process.env.TICKET_OCR_ENABLED = 'true';
  process.env.AI_PROVIDER_MODE = 'stub';
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
 * Уборка своих строк — и ПЕРЕД прогоном тоже: упавшая подготовка оставляет мусор, а база общая.
 * Порядок задан внешними ключами: задачи, заявки (за ними каскадом связи файлов), файлы, журнал,
 * учётка и только в конце площадка — её держит `RESTRICT`.
 *
 * Карантинные файлы удаляются здесь обычным `DELETE`: запрет карантина живёт в коде приложения, и
 * уборка тестовых данных об него не спотыкается — иначе прогон не смог бы убрать за собой вовсе.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const admin = sql`(SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`;
  await db.execute(sql`
    DELETE FROM jobs
     WHERE (type = 'delete_s3_object' AND payload->>'objectKey' LIKE ${`${KEY_PREFIX}%`})
        OR (type = 'recognize_waste_ticket_file'
            AND payload->>'requestId' IN (
                  SELECT id::text FROM waste_requests WHERE created_by IN ${admin}))`);
  await db.execute(sql`DELETE FROM waste_requests WHERE created_by IN ${admin}`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${KEY_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN ${admin}`);
  await db.execute(sql`DELETE FROM users WHERE email = ${ADMIN_EMAIL}`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code = 'QEV-TEST'`);
}

// ── Фикстуры ──

/**
 * Заявка типа «вывоз металлолома»: у неё нет предмета вовсе (ADR 0067), поэтому правка не требует
 * ни типа мусора, ни объёма, ни тарифа — а талоны читаются у заявок любого типа (ADR 0150). Для
 * случая про карантин разница между типами несущественна, и самый простой тип убирает из фикстуры
 * половину справочников.
 */
async function newRequest(status: 'new' | 'done'): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType: 'metal_removal',
      deliveryAt: new Date(),
      status,
      createdBy: ctx.adminId,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      comment: MARK,
    })
    .returning({ id: ctx.schema.wasteRequests.id });
  return row!.id;
}

interface TestFile {
  id: string;
  objectKey: string;
}

/** Файл строкой в `files`. Возраст задаётся явно: оба прохода уборки отбирают по нему. */
async function newFile(
  options: { ageDays?: number; status?: 'pending' | 'active' } = {},
): Promise<TestFile> {
  fileNo += 1;
  const objectKey = `${KEY_PREFIX}${randomUUID()}`;
  const createdAt = new Date(Date.now() - (options.ageDays ?? 0) * 24 * 60 * 60 * 1000);
  const [row] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey,
      filename: `документ-${fileNo}.pdf`,
      contentType: 'application/pdf',
      size: 2048,
      status: options.status ?? 'active',
      uploadedBy: ctx.adminId,
      createdAt,
    })
    .returning({ id: ctx.schema.files.id });
  return { id: row!.id, objectKey };
}

/** Скан талона: файл плюс связь `kind = 'ticket'` — распознавание держится именно на ней (Р11). */
async function newTicketFile(requestId: string): Promise<TestFile> {
  const file = await newFile();
  await ctx.db
    .insert(ctx.schema.requestFiles)
    .values({ requestId, fileId: file.id, kind: 'ticket' });
  return file;
}

/**
 * Постановка в карантин — НАСТОЯЩЕЙ ручкой, а не `UPDATE` в обход приложения: проверяется поведение
 * запертого файла, и запирать его надо тем же путём, которым это делает разбор инцидента. Право у
 * администратора от матрицы роли, поэтому отдельного набора здесь не нужно.
 */
async function quarantine(fileId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/files/${fileId}/quarantine`,
    headers: ctx.auth,
    payload: { reason: 'Приложен чужой документ с персональными данными — обращение прогона' },
  });
  expect(res.statusCode, `постановка в карантин: ${res.body}`).toBe(200);
}

async function requestVersion(requestId: string): Promise<number> {
  const res = await ctx.db.execute<{ version: number }>(
    sql`SELECT version FROM waste_requests WHERE id = ${requestId}`,
  );
  return res.rows[0]!.version;
}

/** Подшивка и снятие вложения — штатной правкой заявки, тем же путём, каким это делают люди. */
async function patchFiles(
  requestId: string,
  body: { addFileIds?: string[]; removeFileIds?: string[] },
) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/waste-requests/${requestId}`,
    headers: ctx.auth,
    payload: { ...body, version: await requestVersion(requestId) },
  });
}

async function attach(requestId: string, fileId: string): Promise<void> {
  const res = await patchFiles(requestId, { addFileIds: [fileId] });
  expect(res.statusCode, `подшивка вложения: ${res.body}`).toBe(200);
}

// ── Состояние файла, связей и очереди ──

async function fileState(
  fileId: string,
): Promise<{ status: string; deletedAt: Date | null; quarantinedAt: Date | null } | undefined> {
  const res = await ctx.db.execute<{
    status: string;
    deleted_at: Date | null;
    quarantined_at: Date | null;
  }>(sql`SELECT status, deleted_at, quarantined_at FROM files WHERE id = ${fileId}`);
  const row = res.rows[0];
  return row
    ? { status: row.status, deletedAt: row.deleted_at, quarantinedAt: row.quarantined_at }
    : undefined;
}

async function deletionJobs(objectKey: string): Promise<number> {
  const res = await ctx.db.execute<{ c: string }>(sql`
    SELECT count(*) AS c FROM jobs
     WHERE type = 'delete_s3_object' AND payload->>'objectKey' = ${objectKey}`);
  return Number(res.rows[0]!.c);
}

async function linkExists(requestId: string, fileId: string): Promise<boolean> {
  const res = await ctx.db.execute<{ c: string }>(sql`
    SELECT count(*) AS c FROM request_files
     WHERE request_id = ${requestId} AND file_id = ${fileId}`);
  return Number(res.rows[0]!.c) > 0;
}

async function recognitionJobs(requestId: string): Promise<string[]> {
  const res = await ctx.db.execute<{ file_id: string }>(sql`
    SELECT payload->>'fileId' AS file_id FROM jobs
     WHERE type = 'recognize_waste_ticket_file' AND payload->>'requestId' = ${requestId}
     ORDER BY created_at`);
  return res.rows.map((r) => r.file_id);
}

// ── Запросы воркера, взятые из его исходника ──

function sourceQuery(source: URL, re: RegExp, what: string): string {
  const text = readFileSync(source, 'utf8');
  const found = re.exec(text);
  if (!found?.[1]) throw new Error(`В исходнике воркера не найден ${what}`);
  return found[1];
}

/** Отбор кандидатов уборки. Размер батча там подставляется шаблоном — читается оттуда же. */
function cleanupCandidateQuery(): string {
  const text = readFileSync(WORKER_SOURCE, 'utf8');
  const batch = /const FILE_CLEANUP_BATCH = (\d+);/u.exec(text);
  if (!batch) throw new Error('В исходнике воркера не найден размер батча уборки');
  const query = sourceQuery(
    WORKER_SOURCE,
    /`(SELECT id FROM files\b[\s\S]*?FOR UPDATE SKIP LOCKED)`/u,
    'запрос отбора кандидатов уборки',
  );
  return query.replace('${FILE_CLEANUP_BATCH}', batch[1]!);
}

/** Подтверждение под блокировкой — ВТОРОЙ запрос уборки, который и сносит. */
function cleanupConfirmQuery(): string {
  return sourceQuery(
    WORKER_SOURCE,
    /`(SELECT id, object_key FROM files\b[\s\S]*?)`/u,
    'запрос подтверждения уборки под блокировкой',
  );
}

/** Связь файла с заявкой в задаче распознавания: все три её проверки идут этим запросом. */
function ticketLinkQuery(): string {
  return sourceQuery(
    TICKET_JOB_SOURCE,
    /const LINK_SQL = `([\s\S]*?)`;/u,
    'запрос связи задачи распознавания',
  );
}

/**
 * Тот же запрос без карантинного условия — «наивный» двойник. Нужен не для красоты: без него
 * зелёный ответ настоящего запроса одинаково хорошо объяснялся бы тем, что сносить было нечего.
 * Отсутствие условия в тексте — тоже поломка, и она обязана быть видна сразу.
 */
function withoutQuarantineGuard(query: string): string {
  const naive = query.replace(/\s*AND\s+(?:f\.)?quarantined_at IS NULL/gu, '');
  expect(naive, 'карантинного условия нет в самом запросе').not.toBe(query);
  return naive;
}

/**
 * Запросы воркера идут своим соединением и с теми же параметрами, что у него: подставить их
 * литералами значило бы переписать запрос, а проверяется он как есть. `FOR UPDATE SKIP LOCKED`
 * без явной транзакции — один оператор, блокировка снимается сразу за ним.
 */
async function runOnWorkerConnection<T extends Record<string, unknown>>(
  query: string,
  params: unknown[],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: DB_URL! });
  await client.connect();
  try {
    const res = await client.query<T>(query, params);
    return res.rows;
  } finally {
    await client.end();
  }
}

describe.skipIf(!DB_URL)('карантин: пути уноса улики (Р6, п. 4)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const tickets = await import('../src/services/waste-tickets');
    // Сперва уборка: упавший прогон оставляет учётку и площадку, а имена у них те же.
    await cleanup(db);

    const { hashPassword } = await import('../src/auth/password');
    const [admin] = await db
      .insert(schema.users)
      .values({
        email: ADMIN_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: 'Карантина',
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });

    // Площадка СВОЯ, а не «первая попавшаяся»: чужую у соседнего файла уносит его `afterAll`
    // посреди прогона — так уже падала пара db-тестов.
    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: 'QEV-TEST',
        name: 'Тестовая площадка карантина',
        address: 'г Москва, ул Тестовая, д 1',
      })
      .returning({ id: schema.constructionObjects.id });

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    ctx = {
      app,
      db,
      schema,
      tickets,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken as string}` },
      adminId: admin!.id,
      objectId: object!.id,
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // 1. Штатное снятие вложения: связь снимается, файл остаётся
  // ──────────────────────────────────────────────────────────────────────────────────────────

  describe('снятие вложения (scheduleFilesDeletion)', () => {
    it('карантинный файл не помечается удалённым и не получает задачу на снос объекта', async () => {
      const requestId = await newRequest('new');
      const locked = await newFile();
      const plain = await newFile();
      await attach(requestId, locked.id);
      await attach(requestId, plain.id);
      await quarantine(locked.id);

      const res = await patchFiles(requestId, { removeFileIds: [locked.id, plain.id] });
      expect(res.statusCode, res.body).toBe(200);

      /*
       * Снятие СОСТОЯЛОСЬ — связи нет у обоих. Это не придирка к фикстуре: запрет, отбивающий саму
       * правку заявки, был бы другим решением (и плохим: карточку с чужим паспортом нельзя было бы
       * привести в порядок). Запертый файл перестаёт быть вложением и остаётся предметом разбора.
       */
      expect(await linkExists(requestId, locked.id)).toBe(false);
      expect(await linkExists(requestId, plain.id)).toBe(false);

      expect(await fileState(locked.id)).toMatchObject({ status: 'active', deletedAt: null });
      expect((await fileState(locked.id))?.quarantinedAt).not.toBeNull();
      // Задачи на снос объекта нет вовсе: она и уносит содержимое вместе с хешем — через тридцать
      // суток, когда разбор ещё идёт.
      expect(await deletionJobs(locked.objectKey)).toBe(0);

      // Обратная сторона: обычный сосед снялся ровно как прежде.
      expect(await fileState(plain.id)).toMatchObject({ status: 'deleted' });
      expect((await fileState(plain.id))?.deletedAt).not.toBeNull();
      expect(await deletionJobs(plain.objectKey)).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // 2. Жёсткое удаление заявки: строка файла исчезает сразу — но не карантинная
  // ──────────────────────────────────────────────────────────────────────────────────────────

  describe('жёсткое удаление заявки (hardDeleteFiles)', () => {
    it('карантинный файл переживает удаление «Новой» заявки, обычный уходит', async () => {
      const requestId = await newRequest('new');
      const locked = await newFile();
      const plain = await newFile();
      await attach(requestId, locked.id);
      await attach(requestId, plain.id);
      await quarantine(locked.id);

      const res = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/waste-requests/${requestId}`,
        headers: ctx.auth,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().mode).toBe('hard');

      /*
       * Здесь отсрочки нет вовсе: `hardDeleteFiles` удаляет СТРОКУ, а с ней ушли бы и хеш, и
       * единственный способ сослаться на предмет разбора из журнала. Запертый файл остаётся
       * ничейной строкой — это и есть выбранная в Р6 цена разбора.
       */
      expect(await fileState(locked.id)).toMatchObject({ status: 'active', deletedAt: null });
      expect(await deletionJobs(locked.objectKey)).toBe(0);

      // Обратная сторона: обычный файл удалён строкой и получил немедленную задачу на снос.
      expect(await fileState(plain.id)).toBeUndefined();
      expect(await deletionJobs(plain.objectKey)).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // 3. Уборка воркера: ОБА запроса
  // ──────────────────────────────────────────────────────────────────────────────────────────

  describe('уборка воркера (cleanupUnlinkedFiles)', () => {
    /**
     * Проходов уборки два, и оба проверяются: брошенная загрузка (`pending`, сутки) и завершённая
     * без единой связи (`active`, семь дней). Карантинный файл подходит им обоим идеально — связей
     * нет (их снял штатный путь выше), статус прежний, возраст набегает сам, — и снесло бы его не
     * решение человека, а календарь.
     */
    const passes = [
      { status: 'pending' as const, age: '24 hours', ageDays: 2, label: 'незавершённые загрузки' },
      { status: 'active' as const, age: '7 days', ageDays: 8, label: 'брошенные без связей' },
    ];

    for (const pass of passes) {
      it(`не берёт карантинный файл ни отбором, ни подтверждением: ${pass.label}`, async () => {
        const locked = await newFile({ ageDays: pass.ageDays, status: pass.status });
        const plain = await newFile({ ageDays: pass.ageDays, status: pass.status });
        await quarantine(locked.id);

        // Оба файла ничейные и старые — для уборки они отличаются ровно карантином.
        const candidates = await runOnWorkerConnection<{ id: string }>(cleanupCandidateQuery(), [
          pass.status,
          pass.age,
        ]);
        expect(candidates.map((r) => r.id)).toContain(plain.id);
        expect(candidates.map((r) => r.id)).not.toContain(locked.id);

        /*
         * ВТОРОЙ запрос — отдельным утверждением. Поправь только отбор, и карантин, поставленный
         * между двумя запросами, всё равно был бы снесён подтверждением: строки к этому моменту уже
         * заблокированы, и решение о сносе принимает именно он.
         */
        const confirmed = await runOnWorkerConnection<{ id: string }>(cleanupConfirmQuery(), [
          [locked.id, plain.id],
          pass.status,
        ]);
        expect(confirmed.map((r) => r.id)).toContain(plain.id);
        expect(confirmed.map((r) => r.id)).not.toContain(locked.id);

        // И ловушка настоящая: без карантинного условия оба запроса забирают запертый файл.
        const naiveCandidates = await runOnWorkerConnection<{ id: string }>(
          withoutQuarantineGuard(cleanupCandidateQuery()),
          [pass.status, pass.age],
        );
        expect(naiveCandidates.map((r) => r.id)).toContain(locked.id);
        const naiveConfirmed = await runOnWorkerConnection<{ id: string }>(
          withoutQuarantineGuard(cleanupConfirmQuery()),
          [[locked.id, plain.id], pass.status],
        );
        expect(naiveConfirmed.map((r) => r.id)).toContain(locked.id);
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // 4. Подшивка в другую заявку: расширение аудитории имени
  // ──────────────────────────────────────────────────────────────────────────────────────────

  describe('подшивка (assertFilesAttachable)', () => {
    it('карантинный файл не подшивается в другую заявку — 422, обычный подшивается', async () => {
      const first = await newRequest('new');
      const second = await newRequest('new');
      const locked = await newFile();
      await attach(first, locked.id);
      await quarantine(locked.id);
      // Связь снимается штатно — файл становится ничейным, то есть пригодным к подшивке по всем
      // прежним правилам: единственное, что его держит, и есть карантин.
      const detached = await patchFiles(first, { removeFileIds: [locked.id] });
      expect(detached.statusCode, detached.body).toBe(200);

      const res = await patchFiles(second, { addFileIds: [locked.id] });
      expect(res.statusCode, res.body).toBe(422);
      expect((res.json() as { message?: string }).message).toContain('карантине');
      // И подшивки действительно не случилось: отказ в середине транзакции обязан откатить связь.
      expect(await linkExists(second, locked.id)).toBe(false);

      // Обратная сторона: обычный ничейный файл подшивается в ту же заявку.
      const plain = await newFile();
      await attach(second, plain.id);
      expect(await linkExists(second, plain.id)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────
  // 5. Очередь распознавания: скан наружу
  // ──────────────────────────────────────────────────────────────────────────────────────────

  describe('распознавание талонов (enqueueTicketRecognition и задача воркера)', () => {
    it('задача не ставится по карантинному талону, а обычный в очередь уходит', async () => {
      const requestId = await newRequest('done');
      const locked = await newTicketFile(requestId);
      const plain = await newTicketFile(requestId);
      await quarantine(locked.id);

      // Постановка так, как её делает закрытие заявки: пачкой по файлам этого закрытия.
      await ctx.db.transaction(async (tx) => {
        await ctx.tickets.enqueueTicketRecognition(tx, requestId, [locked.id, plain.id]);
      });

      // Запертый лист пропущен, остальные прочитаны: карантин одного талона не блокирует закрытие
      // заявки целиком — оно и не должно становиться заложником инцидента.
      expect(await recognitionJobs(requestId)).toEqual([plain.id]);
    });

    it('кнопка «Перераспознать» по карантинному талону отвечает отказом, а не молчанием', async () => {
      const requestId = await newRequest('done');
      const locked = await newTicketFile(requestId);
      await quarantine(locked.id);

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/waste-requests/${requestId}/ticket-files/${locked.id}/recognize`,
        headers: ctx.auth,
      });

      /*
       * Именно отказ, а не тихий пропуск: человек нажал кнопку по названному файлу и ждёт
       * результата. Ответ «отправлено на распознавание», не отправивший ничего, — та же ложь, из-за
       * которой рядом стоит отказ по выключенному модулю.
       */
      expect(res.statusCode, res.body).toBe(422);
      expect((res.json() as { message?: string }).message).toContain('карантине');
      expect(await recognitionJobs(requestId)).toEqual([]);
    });

    it('задача, поставленная до карантина, не находит файла и не скачивает его', async () => {
      const requestId = await newRequest('done');
      const locked = await newTicketFile(requestId);
      const plain = await newTicketFile(requestId);

      // Порядок здесь — суть случая: задача ставится РАНЬШЕ карантина и уже лежит в очереди.
      await ctx.db.transaction(async (tx) => {
        await ctx.tickets.enqueueTicketRecognition(tx, requestId, [locked.id, plain.id]);
      });
      expect(await recognitionJobs(requestId)).toEqual([locked.id, plain.id]);
      await quarantine(locked.id);

      /*
       * Задача читает связь этим запросом трижды, и первый раз — ДО скачивания объекта (T0):
       * пустой ответ она понимает как «работать не над чем» и становится no-op. Поэтому запрет
       * стоит в запросе связи, а не у точки скачивания, — одной строкой на все три проверки.
       */
      const lockedLink = await runOnWorkerConnection(ticketLinkQuery(), [requestId, locked.id]);
      expect(lockedLink).toHaveLength(0);

      // Обратная сторона: обычный талон той же заявки задача по-прежнему находит и обработает.
      const plainLink = await runOnWorkerConnection(ticketLinkQuery(), [requestId, plain.id]);
      expect(plainLink).toHaveLength(1);

      // И ловушка настоящая: без карантинного условия задача нашла бы связь и ушла скачивать скан.
      const naive = await runOnWorkerConnection(withoutQuarantineGuard(ticketLinkQuery()), [
        requestId,
        locked.id,
      ]);
      expect(naive).toHaveLength(1);
    });
  });
});
