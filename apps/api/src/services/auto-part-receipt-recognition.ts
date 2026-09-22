import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  can,
  mergeReceiptPages,
  moscowDateKeyOf,
  receiptDraftFrom,
  receiptRecognitionResponseSchema,
  type ReceiptRecognitionHealthDto,
  type ReceiptRecognitionStateDto,
  type ReceiptRecognitionStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  autoPartReceiptFiles,
  autoPartReceiptRecognitionAttempts,
  autoPartReceiptScanPages,
  autoPartReceipts,
  autoPartReceiptScans,
  files,
} from '../db/schema';
import { config } from '../config';
import { err } from '../lib/errors';
import { isoOf } from '../lib/raw-sql';
import { enqueueJob, JOB_RECOGNIZE_AUTO_PART_RECEIPT_FILE } from '../lib/jobs';
import type { Principal } from '../auth/principal';

/**
 * Чтение скана чека глазами API (план `docs/auto-part-receipt-ocr-plan.md`, Р4, Р5, Р12, Р13).
 *
 * Модуль отвечает на три вопроса и ни на один больше: можно ли этому человеку читать ЭТОТ файл,
 * что с чтением сейчас и что из прочитанного годится в форму.
 *
 * **Результат не материализуется в строки чека** (Р13). Разобранный ответ живёт в `raw` попытки и
 * отдаётся порталу черновиком; таблицы «распознанные строки, ожидающие подтверждения» здесь нет
 * вовсе — это была бы та самая очередь разбора, которой у чека не может быть: сверять прочитанное
 * не с чем, бумага сама первоисточник.
 *
 * **Черновик считает сервер, а не портал.** Правило «что годится для чека» одно
 * (`receiptDraftFrom` в контрактах), и второе, живущее в браузере, разошлось бы с первым ровно
 * там, где форма подставила бы то, что схема потом отобьёт.
 */

/**
 * Вправе ли принципал читать этот скан (Р5).
 *
 * Ветки ровно две, и обе повторяют уже действующее правило доступа к файлу (ADR 0021), а не
 * заводят новое:
 *
 * · файл **ещё не подшит** — распознаёт его загрузивший. Это то же, по чему он сейчас видит свой
 *   непривязанный файл: до сохранения формы файл ничей, кроме автора;
 * · файл **подшит к чеку** — распознаёт держатель `garage.read`, то есть всякий, кому виден сам
 *   чек. Ручки при этом стоят под `autoParts.manage`: читать состояние имеет смысл тому, кто
 *   правит чек.
 *
 * Карантин отбивается РАНЬШЕ обеих (ADR 0168): файл под запретом не читается никем и никогда.
 */
async function assertScanAccess(fileId: string, p: Principal): Promise<void> {
  const [file] = await db
    .select({
      uploadedBy: files.uploadedBy,
      quarantinedAt: files.quarantinedAt,
      status: files.status,
    })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);
  if (!file || file.status !== 'active') throw err.notFound('Файл не найден');
  if (file.quarantinedAt) throw err.forbidden('Файл изъят и недоступен');

  const [linked] = await db
    .select({ receiptId: autoPartReceiptFiles.receiptId })
    .from(autoPartReceiptFiles)
    .where(eq(autoPartReceiptFiles.fileId, fileId))
    .limit(1);
  if (linked) {
    if (!can(p, 'garage.read')) throw err.forbidden('Нет доступа к чеку');
    return;
  }
  if (file.uploadedBy !== p.id) {
    throw err.forbidden('Скан загружен другим пользователем');
  }
}

/**
 * Поставить задачу чтения.
 *
 * Повтор при живой задаче — не отказ, а тот же ответ: «читается». Иначе двойной клик по кнопке
 * заводил бы вторую задачу на тот же файл и вторую оплаченную попытку, а окно всё равно показало
 * бы одно состояние.
 */
export async function requestReceiptRecognition(
  fileId: string,
  p: Principal,
  opts: { forced?: boolean } = {},
): Promise<ReceiptRecognitionStateDto> {
  await assertScanAccess(fileId, p);
  if (!config.receiptOcr.enabled) {
    throw err.badRequest('Распознавание чеков сейчас выключено');
  }

  const [scan] = await db
    .select({ status: autoPartReceiptScans.status })
    .from(autoPartReceiptScans)
    .where(eq(autoPartReceiptScans.fileId, fileId))
    .limit(1);

  const alreadyRunning = scan?.status === 'pending';
  if (!alreadyRunning) {
    await db
      .insert(autoPartReceiptScans)
      .values({ fileId, status: 'pending', requestedBy: p.id })
      .onConflictDoUpdate({
        target: autoPartReceiptScans.fileId,
        set: {
          status: 'pending',
          errorClass: '',
          errorScope: '',
          error: '',
          processedPages: 0,
          requestedBy: p.id,
          updatedAt: new Date(),
        },
      });
    await enqueueJob(JOB_RECOGNIZE_AUTO_PART_RECEIPT_FILE, {
      fileId,
      forced: opts.forced === true,
    });
  }
  return loadReceiptRecognitionState(fileId, p);
}

/** Строки одного чека, у которых тот же растр страницы, что у нашего скана (Р12). */
async function findDuplicateReceipt(
  fileId: string,
  shas: string[],
  p: Principal,
): Promise<ReceiptRecognitionStateDto['duplicate']> {
  if (shas.length === 0) return null;
  const [row] = await db
    .select({
      receiptId: autoPartReceipts.id,
      documentNumber: autoPartReceipts.documentNumber,
      purchasedOn: autoPartReceipts.purchasedOn,
    })
    .from(autoPartReceiptScanPages)
    .innerJoin(
      autoPartReceiptFiles,
      eq(autoPartReceiptFiles.fileId, autoPartReceiptScanPages.fileId),
    )
    .innerJoin(autoPartReceipts, eq(autoPartReceipts.id, autoPartReceiptFiles.receiptId))
    .where(
      and(
        inArray(autoPartReceiptScanPages.pageSha256, shas),
        ne(autoPartReceiptScanPages.fileId, fileId),
      ),
    )
    .orderBy(desc(autoPartReceipts.purchasedOn))
    .limit(1);
  if (!row) return null;
  return {
    receiptId: row.receiptId,
    documentNumber: row.documentNumber,
    purchasedOn: row.purchasedOn,
    // Карточку показываем ссылкой только тому, кто вправе её открыть: сообщение — такой же канал
    // утечки, как и ручка чтения.
    visible: can(p, 'garage.read'),
  };
}

/** Состояние чтения и черновик формы. */
export async function loadReceiptRecognitionState(
  fileId: string,
  p: Principal,
): Promise<ReceiptRecognitionStateDto> {
  await assertScanAccess(fileId, p);

  const [scan] = await db
    .select({
      status: autoPartReceiptScans.status,
      totalPages: autoPartReceiptScans.totalPages,
      processedPages: autoPartReceiptScans.processedPages,
      errorClass: autoPartReceiptScans.errorClass,
      errorScope: autoPartReceiptScans.errorScope,
      error: autoPartReceiptScans.error,
    })
    .from(autoPartReceiptScans)
    .where(eq(autoPartReceiptScans.fileId, fileId))
    .limit(1);

  const empty: ReceiptRecognitionStateDto = {
    fileId,
    status: 'idle',
    totalPages: 0,
    processedPages: 0,
    draft: null,
    errorClass: null,
    errorScope: null,
    message: '',
    duplicate: null,
  };
  if (!scan) return empty;

  const pages = await db
    .select({ pageSha256: autoPartReceiptScanPages.pageSha256 })
    .from(autoPartReceiptScanPages)
    .where(
      and(
        eq(autoPartReceiptScanPages.fileId, fileId),
        eq(autoPartReceiptScanPages.status, 'done'),
      ),
    )
    .orderBy(autoPartReceiptScanPages.pageNo);

  const shas = pages.map((row) => row.pageSha256);
  const draft = shas.length > 0 ? await draftOf(shas) : null;

  return {
    fileId,
    status: scan.status as ReceiptRecognitionStatus,
    totalPages: scan.totalPages,
    processedPages: scan.processedPages,
    draft,
    errorClass: scan.errorClass === '' ? null : scan.errorClass,
    errorScope: scan.errorScope === '' ? null : scan.errorScope,
    message: scan.error,
    duplicate: await findDuplicateReceipt(fileId, shas, p),
  };
}

/**
 * Черновик из последних успешных попыток по страницам.
 *
 * Берётся ПОСЛЕДНЯЯ успешная на хэш, а не первая: «распознать заново» заводит новую попытку с тем
 * же ключом (она помечена `forced`), и старый ответ после этого — история, а не результат.
 *
 * Ответ прогоняется через ту же схему, что и живой ответ модели: в `raw` лежит то, что писала
 * прошлая версия кода, и обещание формы — это схема, а не память о ней.
 */
async function draftOf(shas: string[]): Promise<ReceiptRecognitionStateDto['draft']> {
  const rows = await db
    .select({
      pageSha256: autoPartReceiptRecognitionAttempts.pageSha256,
      raw: autoPartReceiptRecognitionAttempts.raw,
      createdAt: autoPartReceiptRecognitionAttempts.createdAt,
    })
    .from(autoPartReceiptRecognitionAttempts)
    .where(
      and(
        inArray(autoPartReceiptRecognitionAttempts.pageSha256, shas),
        eq(autoPartReceiptRecognitionAttempts.status, 'done'),
      ),
    )
    .orderBy(desc(autoPartReceiptRecognitionAttempts.createdAt));

  const latest = new Map<string, unknown>();
  for (const row of rows) if (!latest.has(row.pageSha256)) latest.set(row.pageSha256, row.raw);

  const parsed = shas.flatMap((sha) => {
    const raw = latest.get(sha);
    if (raw === undefined) return [];
    const result = receiptRecognitionResponseSchema.safeParse(raw);
    return result.success ? [result.data] : [];
  });
  if (parsed.length === 0) return null;
  return receiptDraftFrom(mergeReceiptPages(parsed), moscowDateKeyOf(new Date()));
}


/**
 * Состояние подсистемы чтения (§11 плана) — тем же правилом, что баннер талонов, и по тем же
 * причинам, которые там стоили отдельного решения:
 *
 * · **выключенный модуль — своё состояние**, а не «работает»: задач он не заводит и попыток не
 *   делает, и доля отказов у него идеальная — ноль из нуля;
 * · **считаются только попытки, действительно ходившие в прокси** (`engine = 'proxy'`) и только
 *   отказы ПОДСИСТЕМЫ: один упёршийся в лимит файл не означает, что сервис не настроен;
 * · **терминальный отказ держит состояние до первого успеха** — 401 и 403 сами не пройдут, и
 *   обещать автоматическое восстановление там, где его нет, тот же обман, что и молчание;
 * · **порог с гистерезисом**: доля ≥ 50 % при не менее чем пяти попытках, и снимается тремя
 *   успехами подряд, иначе состояние мигало бы на каждой удачной повторной попытке;
 * · **нулевой трафик при живой очереди** — тоже нездоровье: попыток нет, и доля их не покажет
 *   никогда, потому что делить не на что.
 */
export async function loadReceiptRecognitionHealth(): Promise<ReceiptRecognitionHealthDto> {
  if (!config.receiptOcr.enabled) {
    return { state: 'disabled', since: null, code: '', attempts: 0, failed: 0, waiting: 0 };
  }

  const stats = await db.execute<{
    total: number;
    failed_subsystem: number;
    // Времена объявлены строками намеренно: `db.execute` возвращает то, что дал драйвер, и `Date`
    // здесь был бы обещанием, которого никто не держит.
    last_terminal_at: string | null;
    last_terminal_code: string | null;
    last_success_at: string | null;
    recent_statuses: string[];
  }>(sql`
    WITH win AS (
      SELECT status, error_class, error_scope, error_code, created_at
        FROM auto_part_receipt_recognition_attempts
       WHERE engine = 'proxy' AND created_at >= now() - interval '1 hour'
    )
    SELECT
      (SELECT count(*) FROM win)::int AS total,
      (SELECT count(*) FROM win WHERE status = 'failed' AND error_scope = 'subsystem')::int
        AS failed_subsystem,
      (SELECT max(created_at) FROM win
        WHERE status = 'failed' AND error_scope = 'subsystem' AND error_class = 'terminal')
        AS last_terminal_at,
      (SELECT error_code FROM win
        WHERE status = 'failed' AND error_scope = 'subsystem' AND error_class = 'terminal'
        ORDER BY created_at DESC LIMIT 1) AS last_terminal_code,
      (SELECT max(created_at) FROM win WHERE status = 'done') AS last_success_at,
      COALESCE((SELECT array_agg(status ORDER BY created_at DESC)
                  FROM (SELECT status, created_at FROM win ORDER BY created_at DESC LIMIT 3) t),
               ARRAY[]::text[]) AS recent_statuses`);

  const row = stats.rows[0];
  const total = Number(row?.total ?? 0);
  const failed = Number(row?.failed_subsystem ?? 0);
  const lastTerminalAt = isoOf(row?.last_terminal_at);
  const lastSuccessAt = isoOf(row?.last_success_at);
  const recent = row?.recent_statuses ?? [];

  const stuck = await db.execute<{ waiting: number; oldest: string | null }>(sql`
    SELECT count(*)::int AS waiting, min(created_at) AS oldest
      FROM jobs
     WHERE type = ${JOB_RECOGNIZE_AUTO_PART_RECEIPT_FILE}
       AND status IN ('pending', 'running')
       AND created_at < now() - interval '15 minutes'`);
  const waiting = Number(stuck.rows[0]?.waiting ?? 0);

  // Успех, случившийся ПОСЛЕ терминального отказа, доказывает, что сервис отвечает; более ранний
  // не доказывает ничего.
  // Сравнение ISO-строк — то же, что сравнение моментов: формат сортируем лексикографически.
  if (lastTerminalAt && (!lastSuccessAt || lastSuccessAt < lastTerminalAt)) {
    return {
      state: 'unconfigured',
      since: lastTerminalAt,
      code: row?.last_terminal_code ?? '',
      attempts: total,
      failed,
      waiting,
    };
  }

  const overThreshold = total >= 5 && failed / total >= 0.5;
  const recovered = recent.length >= 3 && recent.every((status) => status === 'done');
  if ((overThreshold && !recovered) || (total === 0 && waiting > 0)) {
    return {
      state: 'degraded',
      since: isoOf(stuck.rows[0]?.oldest) ?? lastSuccessAt,
      code: '',
      attempts: total,
      failed,
      waiting,
    };
  }

  return { state: 'ok', since: null, code: '', attempts: total, failed, waiting };
}
