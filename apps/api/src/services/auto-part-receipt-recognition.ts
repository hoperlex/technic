import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import {
  can,
  mergeReceiptPages,
  moscowDateKeyOf,
  receiptDraftFrom,
  receiptRecognitionResponseSchema,
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
