import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  type AutoPartReceiptDto,
  type CreateReceiptInput,
  type ReceiptDeletionMarkInput,
  type ReceiptLineInput,
  type UpdateReceiptInput,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import { db } from '../db/client';
import { autoPartReceiptFiles, autoPartReceiptLines, autoPartReceipts, files } from '../db/schema';
import { writeAuditTx } from '../lib/audit';
import { err } from '../lib/errors';
import { loadReceiptDto, loadVehicleBriefs } from './auto-part-receipts-read';
import { assertFilesAttachable, markFilesActive, scheduleFilesDeletion } from './request-files';

/**
 * Ведение чеков на автозапчасти (план `docs/auto-part-receipts-plan.md`, Р6, Р9—Р13, Р19, Р21;
 * миграция `0243`): заведение, правка целиком, пометка на удаление, её снятие и удаление.
 *
 * Модуль держится на пяти утверждениях, и каждое — ответ на конкретный способ соврать.
 *
 * 1. **Ни одной цифры не приходит снаружи** (Р9, Р11). С клиента приезжают только суммы строк;
 *    итог чека, «не отнесено» и цена за единицу считаются сервером на чтении, и полей под них нет
 *    ни в одной схеме ввода — `.strict()` отвечает на присланный `total` четырёхсотым с именем
 *    поля, а не молча его отбрасывает. Иначе две суммы разошлись бы в первый же день, и в каждом
 *    отчёте пришлось бы решать заново, какая из них правда.
 * 2. **Порядок строк задаёт массив, `seq` проставляет сервер** (§6). `index + 1` при записи —
 *    одно утверждение о порядке вместо двух: присланный клиентом `seq` пришлось бы сверять с
 *    порядком массива и решать, кто прав, а расходятся они на первой же вставленной посередине
 *    строке.
 * 3. **Своя техника проверяется здесь, а не подбором в форме** (Р21). Одним запросом на все
 *    машины чека, до записи: подбор — удобство, а `RESTRICT` внешнего ключа пропустил бы любую
 *    строку справочника, включая арендную. Отказ называет НОМЕР СТРОКИ и машину — машин в чеке
 *    несколько, и «неверная техника» без номера заставляет искать глазами.
 * 4. **Без скана чека не существует** (Р6). Требование живёт схемой (`fileIds` непустой и при
 *    заведении, и при правке), поэтому правка, снимающая последний скан, отбивается раньше
 *    обработчика — и мимо правила не пройдёт ни форма, ни прямой запрос к API. Отвязка сканов при
 *    удалении делается ЯВНО: положись здесь на каскад — строки связи ушли бы молча, а файл остался
 *    бы в хранилище сиротой, которую уборка заберёт без следа в журнале.
 * 5. **Версия у всех четырёх мутаций, аудит — у всех пяти** (Р12, Р19). Пометка и её снятие тоже
 *    поднимают версию: иначе снятие вслепую отвечало бы не на ту просьбу — на поставленную уже
 *    после того, как экран открыли. Аудит строгий (`writeAuditTx`): после удаления от денежного
 *    документа не остаётся ничего, кроме строки журнала, и потерянная запись означала бы бесследно
 *    исчезнувший чек.
 *
 * Чего здесь НЕТ и чего искать не надо: склада. Чек ничего не двигает и ни на что не ссылается,
 * второго права по эффекту у него нет вовсе (§7) — это и есть упрощение против замороженного
 * складского учёта.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Реквизиты шапки — общее у заведения и правки; строки и сканы у них тоже общие (Р12). */
type ReceiptFields = Omit<UpdateReceiptInput, 'version'>;

/**
 * Деньги в базу — строкой (`numeric(14,2)`).
 *
 * Число с плавающей точкой, отданное драйверу как есть, доехало бы до колонки своим двоичным
 * представлением; строка с двумя знаками — ровно то, что набрал человек. Кратность копейке держит
 * схема (`multipleOf(0.01)`), поэтому округления здесь не происходит.
 */
function amountToDb(amount: number): string {
  return amount.toFixed(2);
}

/**
 * Техника всех строк чека — своя (Р21). ОДИН запрос на весь чек, до записи.
 *
 * Два разных отказа, и оба называют строку: машины нет в справочнике (устаревшая вкладка или
 * подделанное тело) и машина арендная (законная строка справочника, о которой человеку надо
 * сказать словами). Путь поля — как у отказов схемы (`lines.2.vehicleId`, ADR 0094): форма
 * подсветит ту самую ячейку, а не покажет тост поверх таблицы.
 *
 * Статус машины не спрашивается вовсе: чек законно выписан на машину, которую позже вывели из
 * парка, и правка старого чека не должна упираться в то, что случилось после покупки.
 */
async function assertOwnVehicles(tx: Tx, lines: readonly ReceiptLineInput[]): Promise<void> {
  const ids = lines.flatMap((line) => (line.vehicleId === null ? [] : [line.vehicleId]));
  if (ids.length === 0) return;
  const briefs = await loadVehicleBriefs(tx, ids);
  for (const [index, line] of lines.entries()) {
    if (line.vehicleId === null) continue;
    const brief = briefs.get(line.vehicleId);
    const field = `lines.${index}.vehicleId`;
    if (!brief) {
      const message = `Строка ${index + 1}: техника не найдена`;
      throw err.badRequest(message, { [field]: message });
    }
    if (brief.ownership !== 'own') {
      const message = `Строка ${index + 1}: ${brief.label} — арендная техника`;
      throw err.badRequest(message, { [field]: message });
    }
  }
}

/**
 * Строки чека заново: снять все и записать присланные (Р12 — форма отдаёт чек целиком).
 *
 * Замена целиком, а не диффер, и это решение, а не упрощение: у строки чека нет ни собственной
 * истории, ни движений, ни ссылок извне — сопоставлять «ту же самую» строку не с чем и незачем,
 * а `seq` при вставке посередине сдвинулся бы всё равно у всех. Порядок «сначала снять, потом
 * записать» держит уникальность `(receipt_id, seq)`: она не отложенная, и перестановка двух
 * строк местами упала бы на первом же обновлении.
 *
 * На заведении снимать нечего, и лишний `DELETE` здесь стоит одного попадания в индекс — это
 * цена того, что правило «`seq` = порядок массива» записано в модуле ровно один раз.
 */
async function replaceLines(
  tx: Tx,
  receiptId: string,
  lines: readonly ReceiptLineInput[],
): Promise<void> {
  await tx.delete(autoPartReceiptLines).where(eq(autoPartReceiptLines.receiptId, receiptId));
  await tx.insert(autoPartReceiptLines).values(
    lines.map((line, index) => ({
      receiptId,
      // Порядок как в чеке: его задаёт массив формы, а не присланное клиентом число (§6).
      seq: index + 1,
      vehicleId: line.vehicleId,
      name: line.name,
      quantity: line.quantity,
      unit: line.unit,
      amount: amountToDb(line.amount),
      note: line.note,
    })),
  );
}

/**
 * Сканы чека: подшить новые, отвязать снятые — тем же контуром, что сканы акта ТО (`syncFiles` в
 * `services/vehicle-maintenance.ts`).
 *
 * Уже подшитое отсеивается первым: форма присылает `fileIds` целиком, и на второй отправке общая
 * проверка отвергла бы собственные же файлы чека как чужие. `requireActive` — `pending` это
 * незавершённая загрузка, и ссылка на объект, которого в хранилище может не быть вовсе, в
 * денежном документе недопустима.
 *
 * Снятый скан уходит на ОТЛОЖЕННОЕ удаление (+30 дней), как вложения во всех модулях: снятый по
 * ошибке скан чека обязан пережить эту ошибку.
 */
async function syncFiles(
  tx: Tx,
  receiptId: string,
  fileIds: readonly string[],
  actorUserId: string,
): Promise<{ added: string[]; removed: string[] }> {
  const wanted = new Set(fileIds);
  const current = await tx
    .select({ fileId: autoPartReceiptFiles.fileId })
    .from(autoPartReceiptFiles)
    .where(eq(autoPartReceiptFiles.receiptId, receiptId));
  const mine = new Set(current.map((row) => row.fileId));

  const fresh = [...wanted].filter((id) => !mine.has(id));
  if (fresh.length > 0) {
    await assertFilesAttachable(tx, fresh, actorUserId, { requireActive: true });
    await markFilesActive(tx, fresh);
    await tx.insert(autoPartReceiptFiles).values(fresh.map((fileId) => ({ receiptId, fileId })));
  }

  const dropped = [...mine].filter((id) => !wanted.has(id));
  if (dropped.length > 0) {
    await detachFiles(tx, receiptId, dropped);
  }
  return { added: fresh, removed: dropped };
}

/**
 * Отвязать сканы и отправить их на отложенное удаление. Общая половина у правки и у удаления
 * чека: там снимают часть, здесь — все, а правило «связь снимается явно, файл уезжает следом»
 * одно.
 */
async function detachFiles(
  tx: Tx,
  receiptId: string,
  fileIds: readonly string[],
): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const linked = await tx
    .select({ id: files.id, objectKey: files.objectKey })
    .from(autoPartReceiptFiles)
    .innerJoin(files, eq(files.id, autoPartReceiptFiles.fileId))
    .where(
      and(
        eq(autoPartReceiptFiles.receiptId, receiptId),
        inArray(autoPartReceiptFiles.fileId, [...fileIds]),
      ),
    );
  await tx
    .delete(autoPartReceiptFiles)
    .where(
      and(
        eq(autoPartReceiptFiles.receiptId, receiptId),
        inArray(autoPartReceiptFiles.fileId, [...fileIds]),
      ),
    );
  await scheduleFilesDeletion(tx, linked, false);
  return linked.map((row) => row.id);
}

/** Реквизиты шапки к записи. Пробелы срезала схема — здесь остаётся только состав полей. */
function headValues(input: ReceiptFields) {
  return {
    purchasedOn: input.purchasedOn,
    sellerName: input.sellerName,
    documentNumber: input.documentNumber,
    note: input.note,
  };
}

/** «Было → стало» по реквизитам: в журнал идут только изменившиеся поля. */
function fieldChanges(
  fields: ReadonlyArray<readonly [string, string | number, string | number]>,
): Array<{ field: string; from: string; to: string }> {
  return fields
    .filter(([, from, to]) => from !== to)
    .map(([field, from, to]) => ({ field, from: String(from), to: String(to) }));
}

/**
 * Чек под `FOR UPDATE` — первым шагом каждой пишущей транзакции.
 *
 * Блокируется сам чек, а не машина (в отличие от акта ТО): предмет здесь — документ целиком, и
 * встречаются писатели ровно на нём. Машина чеку не владелец: строки одного чека законно
 * относятся к разным машинам, а часть — ни к какой (Р8).
 */
async function lockReceipt(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: autoPartReceipts.id,
      purchasedOn: autoPartReceipts.purchasedOn,
      sellerName: autoPartReceipts.sellerName,
      documentNumber: autoPartReceipts.documentNumber,
      note: autoPartReceipts.note,
      version: autoPartReceipts.version,
      deletionRequestedAt: autoPartReceipts.deletionRequestedAt,
      deletionReason: autoPartReceipts.deletionReason,
    })
    .from(autoPartReceipts)
    .where(eq(autoPartReceipts.id, id))
    .for('update');
  if (!row) throw err.notFound('Чек не найден');
  return row;
}

/**
 * Итог и число строк для журнала — считает база.
 *
 * Сумма строкой, а не числом: `numeric` складывается точно, и в журнале обязано стоять ровно то
 * число, которое портал покажет в карточке, — аудит не место для второй формулы итога.
 */
async function totalsOf(tx: Tx, receiptId: string): Promise<{ total: string; lines: number }> {
  const [row] = await tx
    .select({
      total: sql<string>`coalesce(sum(${autoPartReceiptLines.amount}), 0)::numeric(20,2)::text`,
      lines: sql<string>`count(*)`,
    })
    .from(autoPartReceiptLines)
    .where(eq(autoPartReceiptLines.receiptId, receiptId));
  return { total: row!.total, lines: Number(row!.lines) };
}

/**
 * Завести чек: шапка, строки и сканы одним телом (Р12).
 *
 * Порядок шагов обязателен ровно в одном месте — собственность машин проверяется ДО записи (Р21).
 * Проверка не дублирует внешний ключ, а отвечает на другой вопрос: `RESTRICT` пропускает любую
 * строку справочника, включая арендную, а поймай он что-нибудь — человек прочитал бы имя
 * ограничения вместо номера строки, которую надо исправить.
 */
export async function createReceipt(
  input: CreateReceiptInput,
  actor: Principal,
): Promise<AutoPartReceiptDto> {
  return db.transaction(async (tx) => {
    await assertOwnVehicles(tx, input.lines);
    const [created] = await tx
      .insert(autoPartReceipts)
      .values({ ...headValues(input), createdBy: actor.id })
      .returning({ id: autoPartReceipts.id });
    const receiptId = created!.id;
    await replaceLines(tx, receiptId, input.lines);
    await syncFiles(tx, receiptId, input.fileIds, actor.id);
    const totals = await totalsOf(tx, receiptId);
    await writeAuditTx(tx, {
      actorUserId: actor.id,
      action: 'autoPartReceipt.create',
      entityType: 'autoPartReceipt',
      entityId: receiptId,
      metadata: {
        purchasedOn: input.purchasedOn,
        sellerName: input.sellerName,
        documentNumber: input.documentNumber,
        total: totals.total,
        lines: totals.lines,
        files: input.fileIds.length,
      },
    });
    return loadReceiptDto(tx, receiptId);
  });
}

/**
 * Правка целиком — с версией (Р12).
 *
 * Сверка версии условием того же `UPDATE`, что и правит: отдельным `SELECT` она стерегла бы
 * прошлое. Реквизиты правятся ДО строк намеренно — разошедшаяся версия обязана отбить запрос
 * раньше, чем он перепишет строки чека.
 *
 * **Пометку на удаление правка не трогает вовсе** (Р12, §2.3): её полей в теле нет, и снимают её
 * отдельной ручкой — очередь администратора не должна опустошаться заодно с исправлением
 * опечатки. Помеченный чек при этом правится как обычный: пометка ничего не запрещает и ничего не
 * пересчитывает, она называет просьбу.
 */
export async function updateReceipt(
  id: string,
  input: ReceiptFields,
  version: number,
  actor: Principal,
): Promise<AutoPartReceiptDto> {
  return db.transaction(async (tx) => {
    const head = await lockReceipt(tx, id);
    await assertOwnVehicles(tx, input.lines);
    const before = await totalsOf(tx, id);

    const values = headValues(input);
    const [updated] = await tx
      .update(autoPartReceipts)
      .set({
        ...values,
        version: sql`${autoPartReceipts.version} + 1`,
        updatedBy: actor.id,
        updatedAt: new Date(),
      })
      .where(and(eq(autoPartReceipts.id, id), eq(autoPartReceipts.version, version)))
      .returning({ id: autoPartReceipts.id });
    if (!updated) throw err.conflict();

    await replaceLines(tx, id, input.lines);
    const scans = await syncFiles(tx, id, input.fileIds, actor.id);
    const after = await totalsOf(tx, id);

    await writeAuditTx(tx, {
      actorUserId: actor.id,
      action: 'autoPartReceipt.update',
      entityType: 'autoPartReceipt',
      entityId: id,
      metadata: {
        changes: fieldChanges([
          ['purchasedOn', head.purchasedOn, values.purchasedOn],
          ['sellerName', head.sellerName, values.sellerName],
          ['documentNumber', head.documentNumber, values.documentNumber],
          ['note', head.note, values.note],
          // Строки — такая же строка «было → стало», а не отдельный раздел: аудит читают сверху
          // вниз, и вынесенный итог пришлось бы искать глазами. Состав строк в журнал не пишется
          // целиком намеренно — в чеке их до сотни, а вопрос к журналу один: изменилась ли сумма.
          ['total', before.total, after.total],
          ['lines', before.lines, after.lines],
        ]),
        ...(scans.added.length > 0 || scans.removed.length > 0
          ? { files: { added: scans.added, removed: scans.removed } }
          : {}),
      },
    });
    return loadReceiptDto(tx, id);
  });
}

/**
 * Пометить чек к удалению — причина и версия (Р12).
 *
 * Пометка НИЧЕГО не прячет и ничего не пересчитывает: помеченный чек виден в ленте, входит в обе
 * суммы и правится как прежде. Она говорит одно — «этот чек предлагается удалить, вот почему», — и
 * ждёт администратора, у которого одного есть право удалять (Р4а).
 *
 * Версия поднимается, и это обязательно: снятие пометки спрашивает версию именно затем, чтобы не
 * снять просьбу, поставленную уже после того, как экран открыли. Не поднимай пометка версию —
 * отличить «эту просьбу я прочитал» от «пришла новая» было бы нечем.
 *
 * Повторная пометка отбивается 409, а не переписывает причину: держатель ведения видит у
 * помеченного чека кнопку «Снять пометку», а не «Пометить», и запрос на вторую пометку означает
 * либо устаревший экран, либо тело мимо формы. Молча заменить чужую причину своей — худший из
 * возможных исходов: администратор прочитал бы не ту просьбу, на которую отвечает.
 */
export async function markReceiptForDeletion(
  id: string,
  input: ReceiptDeletionMarkInput,
  actor: Principal,
): Promise<AutoPartReceiptDto> {
  return db.transaction(async (tx) => {
    const head = await lockReceipt(tx, id);
    if (head.deletionRequestedAt !== null) {
      throw err.conflict('Чек уже помечен к удалению — обновите карточку', {
        code: 'receipt_already_marked',
      });
    }
    const [marked] = await tx
      .update(autoPartReceipts)
      .set({
        deletionRequestedAt: new Date(),
        deletionRequestedBy: actor.id,
        deletionReason: input.reason,
        version: sql`${autoPartReceipts.version} + 1`,
      })
      .where(and(eq(autoPartReceipts.id, id), eq(autoPartReceipts.version, input.version)))
      .returning({ id: autoPartReceipts.id });
    if (!marked) throw err.conflict();

    await writeAuditTx(tx, {
      actorUserId: actor.id,
      action: 'autoPartReceipt.deletionMark',
      entityType: 'autoPartReceipt',
      entityId: id,
      // Причина — сам предмет события: по журналу читают разговор «предлагаю удалить, вот почему»
      // → «удалил» либо «отказал», и без неё от первой реплики не осталось бы ничего.
      metadata: { reason: input.reason, documentNumber: head.documentNumber },
    });
    return loadReceiptDto(tx, id);
  });
}

/**
 * Снять пометку — с версией в адресе (Р12): тела у DELETE нет.
 *
 * Отказ администратора удалять — такое же событие разговора, как и просьба, и в журнал он идёт
 * наравне с ней: по одному итогу «пометки нет» не восстановить, кто чего просил и чем кончилось.
 *
 * Снятие с непомеченного чека отбивается 409: снимать нечего, а поднятая версия означала бы
 * правку документа, которой не было.
 */
export async function clearReceiptDeletionMark(
  id: string,
  version: number,
  actor: Principal,
): Promise<AutoPartReceiptDto> {
  return db.transaction(async (tx) => {
    const head = await lockReceipt(tx, id);
    if (head.deletionRequestedAt === null) {
      throw err.conflict('Чек не помечен к удалению — обновите карточку', {
        code: 'receipt_not_marked',
      });
    }
    const [cleared] = await tx
      .update(autoPartReceipts)
      .set({
        deletionRequestedAt: null,
        deletionRequestedBy: null,
        // Пустая строка, а не `null`: пара `CHECK` требует пустой причины у непомеченного, и
        // второго представления «причины нет» в таблице не заводится.
        deletionReason: '',
        version: sql`${autoPartReceipts.version} + 1`,
      })
      .where(and(eq(autoPartReceipts.id, id), eq(autoPartReceipts.version, version)))
      .returning({ id: autoPartReceipts.id });
    if (!cleared) throw err.conflict();

    await writeAuditTx(tx, {
      actorUserId: actor.id,
      action: 'autoPartReceipt.deletionUnmark',
      entityType: 'autoPartReceipt',
      entityId: id,
      // Какую именно просьбу сняли — событие несёт её текстом: после снятия причины в самой
      // записи не остаётся (пара `CHECK` требует у непомеченного пустую), и без этого поля из
      // журнала было бы видно только «пометку сняли», а не на что ответили отказом.
      metadata: { reason: head.deletionReason, documentNumber: head.documentNumber },
    });
    return loadReceiptDto(tx, id);
  });
}

/**
 * Удалить чек насовсем — только держатель `autoParts.delete`, то есть администратор (Р4а).
 *
 * Строки уносит каскад: они часть документа, а не его история, и без чека не значат ничего. Сканы
 * отвязываются ЯВНО и уходят на отложенное удаление: каскад унёс бы строки связи молча, и файл
 * остался бы в хранилище сиротой — до уборки, которая заберёт его без следа в журнале.
 *
 * Метаданные события несут реквизиты удалённого чека — дату, продавца, номер и сумму (Р19): после
 * удаления в портале от него не остаётся больше НИЧЕГО, и запись журнала — единственное, чем
 * объясняется исчезнувший документ. Поэтому же аудит строгий: потерянная молча запись означала бы
 * бесследно исчезнувшие деньги.
 */
export async function deleteReceipt(id: string, version: number, actor: Principal): Promise<void> {
  await db.transaction(async (tx) => {
    const head = await lockReceipt(tx, id);
    // Реквизиты и итог читаются ДО удаления: после него взять их будет негде.
    const totals = await totalsOf(tx, id);
    const current = await tx
      .select({ fileId: autoPartReceiptFiles.fileId })
      .from(autoPartReceiptFiles)
      .where(eq(autoPartReceiptFiles.receiptId, id));
    const detached = await detachFiles(
      tx,
      id,
      current.map((row) => row.fileId),
    );

    const [removed] = await tx
      .delete(autoPartReceipts)
      .where(and(eq(autoPartReceipts.id, id), eq(autoPartReceipts.version, version)))
      .returning({ id: autoPartReceipts.id });
    if (!removed) throw err.conflict();

    await writeAuditTx(tx, {
      actorUserId: actor.id,
      action: 'autoPartReceipt.delete',
      entityType: 'autoPartReceipt',
      entityId: id,
      metadata: {
        purchasedOn: head.purchasedOn,
        sellerName: head.sellerName,
        documentNumber: head.documentNumber,
        total: totals.total,
        lines: totals.lines,
        files: detached,
      },
    });
  });
}
