import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestType } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает. Сервису распознавания это
// особенно важно: он спрашивает `config.ticketOcr.enabled`, и значение флага обязано быть
// выставлено до первого импорта конфига.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as WasteTicketsNs from '../src/services/waste-tickets';
import type { buildApp } from '../src/app';

/**
 * Стык заявки на вывоз с распознаванием талонов: постановка задач при закрытии и уборка при
 * откате (ADR 0114; план `docs/waste-ticket-ocr-plan.md`, Р11, Р12, Р22).
 *
 * Зачем база. Оба утверждения теста — про поведение НАСТОЯЩЕЙ схемы, а не кода уборки:
 *
 * - у талона составной внешний ключ на страницу с `ON DELETE SET NULL (page_id)`, то есть удаление
 *   страниц талон не уносит, а лишь обнуляет ссылку. На подменах этого не видно вовсе: подмена
 *   удалит ровно то, что ей велели, — а вопрос стоит обратный, останется ли что-то висеть на
 *   заявке после уборки;
 * - попытки распознавания обязаны ПЕРЕЖИТЬ откат. Заявки в их ключе нет вовсе (`page_sha256` +
 *   движок + модель + версии, Р12), и они служат кэшем: повторное закрытие тем же листом — самый
 *   частый исход отката — не должно стоить ни копейки. Проверить это можно только на живых
 *   каскадах: снести попытку могла бы не строка кода, а `ON DELETE CASCADE`, которого никто не
 *   заметил.
 *
 * Запуск — как у остальных db-тестов:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test waste-ticket-reset
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 *
 * Сканов в фикстурах нет и быть не может: репозиторий публичный, а талон — бумага с адресом
 * площадки. Здесь распознанное заведено прямой вставкой, движок `stub`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-waste-ticket-reset-admin@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';
/** Метка своих заявок: база у db-тестов общая и переживает повторный запуск. */
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: уборка распознанного';
/** Общий префикс ключей объектов — по нему же идёт уборка файлов. */
const KEY_PREFIX = 'db-waste-ticket-reset/';
/**
 * Префикс хэшей страниц. Попытки не привязаны ни к заявке, ни к файлу — в этом весь смысл их
 * существования (Р12), — поэтому убрать за собой их можно только по метке в самом ключе.
 * Шестнадцатеричный: колонка проверяется `CHECK`'ом на `^[0-9a-f]{64}$`.
 */
const SHA_PREFIX = 'dbfeed';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof WasteTicketsNs;
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
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  // Распознавание включено: выключенным модуль задач не ставит вовсе (Р29), и проверять было бы
  // нечего. Транспорт при этом остаётся `stub` — наружу тест не ходит и ходить не должен.
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
 * Уборка своих данных. Заявки уносят каскадом связи файлов, файловые строки, страницы, талоны и
 * принятия; попытки и задачи очереди на заявку не ссылаются — их приходится убирать по метке.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const admin = sql`(SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`;
  // Наблюдения переживают заявку и файл намеренно, поэтому метка страницы — единственный надёжный
  // способ убрать и следы уже полностью удалённой заявки прошлого прогона.
  await db.execute(sql`
    DELETE FROM waste_ticket_field_events
     WHERE observation_id IN (
       SELECT id FROM waste_ticket_field_events WHERE page_sha256 LIKE ${`${SHA_PREFIX}%`})`);
  await db.execute(
    sql`DELETE FROM waste_ticket_field_events WHERE page_sha256 LIKE ${`${SHA_PREFIX}%`}`,
  );
  await db.execute(sql`
    DELETE FROM jobs
     WHERE type = 'recognize_waste_ticket_file'
       AND payload->>'requestId' IN (
             SELECT id::text FROM waste_requests WHERE created_by IN ${admin})`);
  await db.execute(sql`
    DELETE FROM jobs
     WHERE type = 'delete_s3_object'
       AND payload->>'objectKey' LIKE ${`${KEY_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM waste_requests WHERE created_by IN ${admin}`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${KEY_PREFIX}%`}`);
  await db.execute(
    sql`DELETE FROM waste_ticket_recognition_attempts WHERE page_sha256 LIKE ${`${SHA_PREFIX}%`}`,
  );
  await db.execute(sql`DELETE FROM users WHERE email = ${ADMIN_EMAIL}`);
}

async function seedAdmin(db: typeof AppDb, schema: typeof SchemaNs): Promise<string> {
  const { hashPassword } = await import('../src/auth/password');
  const [created] = await db
    .insert(schema.users)
    .values({
      email: ADMIN_EMAIL,
      lastName: 'Тестовый',
      firstName: 'Администратор',
      middleName: 'Талонов',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/**
 * Выполненная заявка. Тип — параметром и по умолчанию вывоз мусора: талоны читаются у заявок
 * всех типов (ADR 0150), и разница между ними осталась только в том, что сверять у бумаги.
 */
async function newRequest(requestType: RequestType = 'waste_removal') {
  const [row] = await ctx.db
    .insert(ctx.schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType,
      deliveryAt: new Date(),
      status: 'done',
      createdBy: ctx.adminId,
      comment: MARK,
    })
    .returning({ id: ctx.schema.wasteRequests.id });
  return row!.id;
}

/** Скан талона: файл плюс живая связь с заявкой — распознавание держится именно на ней (Р11). */
async function newTicketFile(requestId: string): Promise<string> {
  fileNo += 1;
  const [file] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey: `${KEY_PREFIX}${randomUUID()}`,
      filename: `талон-${fileNo}.pdf`,
      contentType: 'application/pdf',
      size: 1024,
      status: 'active',
      uploadedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.files.id });
  await ctx.db
    .insert(ctx.schema.requestFiles)
    .values({ requestId, fileId: file!.id, kind: 'ticket' });
  return file!.id;
}

/** 64 шестнадцатеричных знака с меткой прогона в начале. */
function pageSha(): string {
  return `${SHA_PREFIX}${randomUUID().replace(/-/g, '')}`.padEnd(64, '0').slice(0, 64);
}

interface Recognized {
  fileId: string;
  pageId: string;
  attemptId: string;
  ticketId: string;
  observationId: string;
}

/**
 * Разобранный талон целиком: файловая строка обработки, страница, попытка распознавания, сам талон
 * со ссылкой на попытку и принятое расхождение по заявке. Ровно то, что откат обязан разобрать —
 * и ровно та ссылка талона на попытку, из-за которой уборка могла бы утащить кэш за собой.
 */
async function seedRecognized(requestId: string): Promise<Recognized> {
  const fileId = await newTicketFile(requestId);
  const sha = pageSha();
  await ctx.db.insert(ctx.schema.wasteTicketFiles).values({
    fileId,
    requestId,
    status: 'done',
    totalPages: 1,
    processedPages: 1,
  });
  const [page] = await ctx.db
    .insert(ctx.schema.wasteTicketPages)
    .values({ requestId, fileId, pageNo: 1, pageSha256: sha, status: 'done', ticketsFound: 1 })
    .returning({ id: ctx.schema.wasteTicketPages.id });
  const [attempt] = await ctx.db
    .insert(ctx.schema.wasteTicketRecognitionAttempts)
    .values({
      pageSha256: sha,
      engine: 'stub',
      model: 'stub',
      promptVersion: 1,
      preprocessingVersion: 1,
      status: 'done',
      raw: { tickets: [] },
    })
    .returning({ id: ctx.schema.wasteTicketRecognitionAttempts.id });
  const [ticket] = await ctx.db
    .insert(ctx.schema.wasteTickets)
    .values({
      requestId,
      pageId: page!.id,
      seq: 1,
      primaryAttemptId: attempt!.id,
      numberRaw: '№ 000123',
      numberKey: '000123',
      numberFuzzy: '000123',
      issuedOn: '2026-08-20',
      volumeM3: '8.000',
      origin: 'ocr',
      status: 'unconfirmed',
    })
    .returning({ id: ctx.schema.wasteTickets.id });
  // Построчное принятие: предмет — сам талон (`subjectKey` = его id). Заявочные принятия несут
  // пустую строку и заводятся в тесте отдельно — уборка обязана уносить оба вида.
  await ctx.db.insert(ctx.schema.wasteTicketCheckResolutions).values({
    requestId,
    checkCode: 'duplicate_number',
    subjectKey: ticket!.id,
    inputFingerprint: pageSha(),
    acceptedBy: ctx.adminId,
    comment: 'Повтор номера принят: талон перевыставлен перевозчиком',
  });
  const [observation] = await ctx.db
    .insert(ctx.schema.wasteTicketFieldEvents)
    .values({
      ticketId: ticket!.id,
      requestId,
      pageSha256: sha,
      event: 'recognized',
      field: 'volumeM3',
      newValue: '8',
      readState: 'read',
      model: 'stub',
      modelReported: 'stub',
      fileId,
      pageNo: 1,
      collectionVersion: 2,
    })
    .returning({ id: ctx.schema.wasteTicketFieldEvents.id });
  return {
    fileId,
    pageId: page!.id,
    attemptId: attempt!.id,
    ticketId: ticket!.id,
    observationId: observation!.id,
  };
}

/** Что осталось у заявки после уборки — одним запросом на каждую таблицу контура. */
async function countsOf(requestId: string) {
  const row = await ctx.db.execute<{
    tickets: string;
    pages: string;
    files: string;
    resolutions: string;
    links: string;
  }>(sql`
    SELECT (SELECT count(*) FROM waste_tickets WHERE request_id = ${requestId}) AS tickets,
           (SELECT count(*) FROM waste_ticket_pages WHERE request_id = ${requestId}) AS pages,
           (SELECT count(*) FROM waste_ticket_files WHERE request_id = ${requestId}) AS files,
           (SELECT count(*) FROM waste_ticket_check_resolutions
             WHERE request_id = ${requestId}) AS resolutions,
           (SELECT count(*) FROM request_files
             WHERE request_id = ${requestId} AND kind = 'ticket') AS links`);
  const r = row.rows[0]!;
  return {
    tickets: Number(r.tickets),
    pages: Number(r.pages),
    files: Number(r.files),
    resolutions: Number(r.resolutions),
    links: Number(r.links),
  };
}

async function attemptExists(attemptId: string): Promise<boolean> {
  const res = await ctx.db.execute<{ c: string }>(
    sql`SELECT count(*) AS c FROM waste_ticket_recognition_attempts WHERE id = ${attemptId}`,
  );
  return Number(res.rows[0]!.c) === 1;
}

async function jobsOf(requestId: string) {
  const res = await ctx.db.execute<{ file_id: string; type: string; payload: unknown }>(sql`
    SELECT payload->>'fileId' AS file_id, type, payload FROM jobs
     WHERE type = 'recognize_waste_ticket_file' AND payload->>'requestId' = ${requestId}
     ORDER BY created_at`);
  return res.rows;
}

async function requestVersion(requestId: string): Promise<number> {
  const res = await ctx.db.execute<{ version: number }>(
    sql`SELECT version FROM waste_requests WHERE id = ${requestId}`,
  );
  return res.rows[0]!.version;
}

/** Настоящий откат `done → confirmed → new`; работу стирает второй переход. */
async function rollbackToNew(requestId: string): Promise<void> {
  for (const status of ['confirmed', 'new'] as const) {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/waste-requests/${requestId}/status`,
      headers: ctx.auth,
      payload: {
        status,
        version: await requestVersion(requestId),
        comment: 'Закрыли не ту заявку',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
}

async function observationState(observationId: string) {
  const res = await ctx.db.execute<{
    file_id: string | null;
    request_id: string | null;
    ticket_id: string | null;
  }>(sql`
    SELECT file_id, request_id, ticket_id
      FROM waste_ticket_field_events
     WHERE id = ${observationId}`);
  return res.rows[0];
}

async function fileState(fileId: string) {
  const res = await ctx.db.execute<{ status: string; deleted_at: Date | null; object_key: string }>(
    sql`SELECT status, deleted_at, object_key FROM files WHERE id = ${fileId}`,
  );
  return res.rows[0];
}

async function deletionJobs(objectKey: string) {
  const res = await ctx.db.execute<{ id: string }>(sql`
    SELECT id FROM jobs
     WHERE type = 'delete_s3_object' AND payload->>'objectKey' = ${objectKey}`);
  return res.rows;
}

describe.skipIf(!DB_URL)('заявка на вывоз ↔ распознавание талонов (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const service = await import('../src/services/waste-tickets');
    await cleanup(db);

    const adminId = await seedAdmin(db, schema);
    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY id LIMIT 1`,
    );
    if (!objects.rows[0]) throw new Error('В базе нет действующего объекта');

    ctx = {
      app,
      db,
      schema,
      service,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken as string}` },
      adminId,
      objectId: objects.rows[0].id,
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  describe('скан наблюдения при откате и полном удалении заявки (Э1)', () => {
    it('откат сохраняет активный файл и не ставит задание удаления', async () => {
      const requestId = await newRequest();
      const recognized = await seedRecognized(requestId);
      const before = await fileState(recognized.fileId);

      await rollbackToNew(requestId);

      expect(await observationState(recognized.observationId)).toEqual({
        file_id: recognized.fileId,
        request_id: requestId,
        ticket_id: null,
      });
      expect(await fileState(recognized.fileId)).toMatchObject({
        status: 'active',
        deleted_at: null,
      });
      expect(await deletionJobs(before!.object_key)).toHaveLength(0);
    });

    it('hard-delete «Новой» после отката удаляет и скан, найденный только через аудит', async () => {
      const requestId = await newRequest();
      const recognized = await seedRecognized(requestId);
      const before = await fileState(recognized.fileId);
      await rollbackToNew(requestId);

      const removed = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/waste-requests/${requestId}`,
        headers: ctx.auth,
      });

      expect(removed.statusCode, removed.body).toBe(200);
      expect(removed.json().mode).toBe('hard');
      expect(await observationState(recognized.observationId)).toEqual({
        file_id: null,
        request_id: null,
        ticket_id: null,
      });
      expect(await fileState(recognized.fileId)).toBeUndefined();
      expect(await deletionJobs(before!.object_key)).toHaveLength(1);
    });

    it('purge архивной заявки удаляет скан, но сохраняет наблюдение', async () => {
      const requestId = await newRequest();
      const recognized = await seedRecognized(requestId);
      const before = await fileState(recognized.fileId);
      const archived = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/waste-requests/${requestId}`,
        headers: ctx.auth,
      });
      expect(archived.statusCode, archived.body).toBe(200);
      expect(archived.json().mode).toBe('soft');

      const purged = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/waste-requests/${requestId}/purge`,
        headers: ctx.auth,
      });

      expect(purged.statusCode, purged.body).toBe(200);
      expect(await observationState(recognized.observationId)).toEqual({
        file_id: null,
        request_id: null,
        ticket_id: null,
      });
      expect(await fileState(recognized.fileId)).toBeUndefined();
      expect(await deletionJobs(before!.object_key)).toHaveLength(1);
    });
  });

  describe('откат «В работе» → «Новая»: уборка распознанного (Р22)', () => {
    it('уносит талоны, страницы, файловые строки и принятия расхождений', async () => {
      const requestId = await newRequest();
      await seedRecognized(requestId);
      await seedRecognized(requestId);
      // Заявочное принятие рядом с построчными: у него пустой предмет, и уборка обязана уносить
      // оба вида — «принимаю расхождение по объёму» относится к закрытию целиком (Р21).
      await ctx.db.insert(ctx.schema.wasteTicketCheckResolutions).values({
        requestId,
        checkCode: 'volume_mismatch',
        subjectKey: '',
        inputFingerprint: pageSha(),
        acceptedBy: ctx.adminId,
        comment: 'Расхождение принято: перегруз согласован с площадкой',
      });
      expect(await countsOf(requestId)).toMatchObject({
        tickets: 2,
        pages: 2,
        files: 2,
        resolutions: 3,
      });

      await ctx.db.transaction(async (tx) => {
        await ctx.service.purgeRequestRecognition(tx, requestId);
      });

      const after = await countsOf(requestId);
      expect(after.tickets).toBe(0);
      expect(after.pages).toBe(0);
      expect(after.files).toBe(0);
      expect(after.resolutions).toBe(0);
      // Сами связи талонов уборка не рвёт: их отвязывает маршрут отдельным движением, и файл
      // уходит в отложенное удаление общим порядком — месяц скан ещё можно достать, если откат
      // был ошибкой (ADR 0024).
      expect(after.links).toBe(2);
    });

    it('оставляет попытки распознавания: они кэш содержимого, а не имущество заявки (Р12)', async () => {
      const requestId = await newRequest();
      const { attemptId, ticketId } = await seedRecognized(requestId);

      await ctx.db.transaction(async (tx) => {
        await ctx.service.purgeRequestRecognition(tx, requestId);
      });

      // Талона нет, а попытка, на которую он ссылался, жива: повторное закрытие тем же листом
      // попадёт в кэш и не оплатит второй вызов модели.
      const tickets = await ctx.db.execute<{ c: string }>(
        sql`SELECT count(*) AS c FROM waste_tickets WHERE id = ${ticketId}`,
      );
      expect(Number(tickets.rows[0]!.c)).toBe(0);
      expect(await attemptExists(attemptId)).toBe(true);
    });

    it('не задевает соседнюю заявку', async () => {
      const mine = await newRequest();
      const other = await newRequest();
      await seedRecognized(mine);
      const kept = await seedRecognized(other);

      await ctx.db.transaction(async (tx) => {
        await ctx.service.purgeRequestRecognition(tx, mine);
      });

      expect(await countsOf(mine)).toMatchObject({ tickets: 0, pages: 0, files: 0 });
      expect(await countsOf(other)).toMatchObject({
        tickets: 1,
        pages: 1,
        files: 1,
        resolutions: 1,
      });
      expect(await attemptExists(kept.attemptId)).toBe(true);
    });
  });

  describe('закрытие заявки: постановка задач (Р11)', () => {
    it('ставит по задаче на каждый приложенный файл, без версии заявки в нагрузке', async () => {
      const requestId = await newRequest();
      const first = await newTicketFile(requestId);
      const second = await newTicketFile(requestId);

      await ctx.db.transaction(async (tx) => {
        await ctx.service.enqueueTicketRecognition(tx, requestId, [first, second]);
      });

      const rows = await jobsOf(requestId);
      expect(rows.map((r) => r.file_id).sort()).toEqual([first, second].sort());
      // Нагрузка — ровно два ключа. Версия заявки в ней запрещена (Р11): правку выполненной
      // заявки закрывают только ролям площадки, и она поднимает `version` — сверка по версии
      // молча отменяла бы распознавание из-за смены комментария.
      for (const row of rows) {
        expect(Object.keys(row.payload as Record<string, unknown>).sort()).toEqual([
          'fileId',
          'requestId',
        ]);
      }
    });

    it('откатывается вместе с закрытием: задача без своей заявки не остаётся', async () => {
      const requestId = await newRequest();
      const fileId = await newTicketFile(requestId);

      await expect(
        ctx.db.transaction(async (tx) => {
          await ctx.service.enqueueTicketRecognition(tx, requestId, [fileId]);
          throw new Error('закрытие не удалось');
        }),
      ).rejects.toThrow('закрытие не удалось');

      // Ради этого `enqueueJob` и получает `tx`: записанная отдельным соединением задача пережила
      // бы откат транзакции и отправила бы воркер искать талон, которого никто не приложил.
      expect(await jobsOf(requestId)).toHaveLength(0);
    });

    // Тип заявки бумагу больше не отбирает (ADR 0150). Прежде здесь стоял обратный тест —
    // «металлолому задач не ставим»: довод был про сверку объёма, которой у весовой квитанции
    // нет. Довод верен и сегодня, но отвечает не на тот вопрос: номер талона уникален у
    // перевозчика (Р17), а день вывоза сверяется (Р19) независимо от того, чем меряли вывезенное,
    // — и повторно предъявленную бумагу металлолома до этого не замечал никто.
    it.each([
      'metal_removal',
      'container_install',
      'container_replace',
      'container_removal',
    ] as const)(
      'ставит задачу и на закрытие типа %s: тип бумагу не отбирает (ADR 0150)',
      async (requestType) => {
        const requestId = await newRequest(requestType);
        const fileId = await newTicketFile(requestId);

        await ctx.db.transaction(async (tx) => {
          await ctx.service.enqueueTicketRecognition(tx, requestId, [fileId]);
        });

        const rows = await jobsOf(requestId);
        expect(rows.map((r) => r.file_id)).toEqual([fileId]);
      },
    );

    it('пустой список файлов задач не порождает', async () => {
      const requestId = await newRequest();
      await ctx.db.transaction(async (tx) => {
        await ctx.service.enqueueTicketRecognition(tx, requestId, []);
      });
      expect(await jobsOf(requestId)).toHaveLength(0);
    });
  });
});
