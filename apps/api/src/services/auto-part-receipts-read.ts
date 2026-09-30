import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  vehicleLabel,
  type AttachedFileDto,
  type AutoPartApplicationDto,
  type AutoPartReceiptDeletionDto,
  type AutoPartReceiptDto,
  type AutoPartReceiptLineDto,
  type AutoPartReceiptListItemDto,
  type AutoPartReceiptListQuery,
  type AutoPartReceiptSummaryQuery,
  type AutoPartReceiptsSummaryDto,
  type AutoPartWarehouseListQuery,
  type AutoPartWarehouseLotDto,
  type ListResult,
  type VehiclePartsSpendDto,
  type VehiclePartsSpendQuery,
  type VehiclePartsSpendRowDto,
  type VehiclePartsSpendSnapshotDto,
  type VehicleOwnership,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  autoPartReceiptFiles,
  autoPartReceiptLines,
  autoPartReceipts,
  autoPartApplications,
  files,
  users,
  vehicleCategories,
  vehicleModels,
  vehicles,
  vehicleTypes,
} from '../db/schema';
import { err } from '../lib/errors';
import { orderByFrom, pageParams } from '../lib/pagination';
import { attachedFileView } from './file-view';

/**
 * Чтение чеков на автозапчасти (план `docs/auto-part-receipts-plan.md`, Р5, Р8—Р15; миграция
 * `0243`): лента, сводка над ней, карточка, суммы по машинам пакетом и окно «Запчасти машины».
 *
 * **Почему чтение отделено от ведения.** Читателей у раздела больше, чем писателей, и они разные:
 * лента и суммы открыты всякому, кому виден гараж (`garage.read`, Р5), а заводит и правит чеки
 * держатель `autoParts.manage`. Разведены они не ради размера файла, а ради одного правила: всё,
 * что здесь считается, считается ОДИНАКОВО для всех ответов — карточки, ленты, сводки, склада и
 * окна машины. Разойдись формула итога по обработчикам, «Сумма» над списком и итог в карточке
 * назвали бы разные числа, и спорить о том, какое из них правда, пришлось бы в каждом разговоре.
 *
 * Три утверждения, на которых держится весь модуль чтения:
 *
 * 1. **Итог — это `Σ amount` строк, и считает его сервер** (Р11). Колонки итога в таблице нет
 *    вовсе, поля «итог по бумаге» нет ни в одной схеме ввода; портал показывает пришедшее число, а
 *    не досчитывает своё.
 * 2. **Итогов два, потому что вопросов два** (Р8). `unassignedTotal` — часть чека, не отнесённая к
 *    машинам, и она не выводится из первого числа: строка без машины законна, и сумма по машинам
 *    меньше суммы чека не по ошибке, а по устройству.
 * 3. **Пометка на удаление не меняет ни одной цифры** (Р12). Помеченный чек стоит в ленте, входит
 *    в обе суммы и правится как прежде; `deletionMarked` — это ФИЛЬТР ленты (очередь
 *    администратора), а не признак «не считать».
 *
 * Деньги приходят из `numeric` строкой, и число из неё делает сервер: двух представлений денег в
 * ответах портала быть не должно (§6 плана). Складываются они там, где складывать умеет база —
 * `sum(...)::numeric(20,2)` у ленты, сводки и окна; в карточке, где строки и так прочитаны, сумма
 * считается в копейках целыми (см. `sumAmounts`), чтобы не платить лишним запросом и не получить
 * `1250.3000000000002` от сложения чисел с плавающей точкой.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читать умеют оба: карточку после мутации собирают ДО коммита, из той же транзакции. */
export type Reader = Tx | typeof db;

/**
 * Сколько машин называет колонка «Машины» до «и ещё N» (`vehiclesLabel`, §6). Две — ровно столько,
 * сколько показано образцом строки в контракте: колонка ленты узкая, а вопрос «чья это покупка»
 * решают по первому же номеру. Точное число живёт здесь, а не в портале, потому что и подпись
 * собирает сервер: собери её экран — правило «как называется машина» жило бы в каждом списке
 * заново.
 */
const VEHICLES_LABEL_LIMIT = 2;

const createdByUser = alias(users, 'receipt_created_by');
const updatedByUser = alias(users, 'receipt_updated_by');
const deletionByUser = alias(users, 'receipt_deletion_by');

/**
 * Строки чека под условием отбора — ОТДЕЛЬНЫМ псевдонимом (`EXISTS` фильтров ленты).
 *
 * Псевдоним не украшение: тот же запрос местами соединяет строки чека верхним уровнем (суммы
 * сводки), и одноимённая таблица внутри `EXISTS` читалась бы как ссылка на внешнюю — условие стало
 * бы тавтологией, отдающей полный список вместо отобранного. Один и тот же класс ошибки уже
 * стоил порталу молчаливой неправды в счётчиках оргтехники.
 */
const filterLines = alias(autoPartReceiptLines, 'receipt_filter_lines');

const HEAD_COLUMNS = {
  id: autoPartReceipts.id,
  purchasedOn: autoPartReceipts.purchasedOn,
  sellerName: autoPartReceipts.sellerName,
  documentNumber: autoPartReceipts.documentNumber,
  note: autoPartReceipts.note,
  version: autoPartReceipts.version,
  deletionRequestedAt: autoPartReceipts.deletionRequestedAt,
  deletionReason: autoPartReceipts.deletionReason,
  deletionRequestedByName: deletionByUser.fullName,
  createdAt: autoPartReceipts.createdAt,
  createdByName: createdByUser.fullName,
  updatedAt: autoPartReceipts.updatedAt,
  updatedByName: updatedByUser.fullName,
};

/** Шапка с подписями. Правивший и пометивший — `leftJoin`, и пустая подпись у них законна. */
interface HeadRow {
  id: string;
  purchasedOn: string;
  sellerName: string;
  documentNumber: string;
  note: string;
  version: number;
  /** `null` — пометки нет; тогда пусты и подпись, и причина (обе пары `CHECK` таблицы). */
  deletionRequestedAt: Date | null;
  deletionReason: string;
  deletionRequestedByName: string | null;
  createdAt: Date;
  createdByName: string;
  updatedAt: Date;
  updatedByName: string | null;
}

/** Шапка чека с тремя подписями: кто внёс, кто правил, кто попросил удалить. */
function headQuery(reader: Reader) {
  return reader
    .select(HEAD_COLUMNS)
    .from(autoPartReceipts)
    .innerJoin(createdByUser, eq(createdByUser.id, autoPartReceipts.createdBy))
    .leftJoin(updatedByUser, eq(updatedByUser.id, autoPartReceipts.updatedBy))
    .leftJoin(deletionByUser, eq(deletionByUser.id, autoPartReceipts.deletionRequestedBy));
}

/**
 * Пометка одним состоянием либо `null` (Р12): «помечен, но неизвестно кем» у документа не бывает,
 * и в базе то же самое держат две пары `CHECK`. Портал по `null` решает, какую кнопку показать, —
 * поэтому три необязательных поля вместо состояния были бы не мелочью, а четвёртым сочетанием.
 */
function deletionOf(row: {
  deletionRequestedAt: Date | null;
  deletionRequestedByName: string | null;
  deletionReason: string;
}): AutoPartReceiptDeletionDto | null {
  if (row.deletionRequestedAt === null) return null;
  return {
    requestedAt: row.deletionRequestedAt.toISOString(),
    requestedByName: row.deletionRequestedByName ?? '',
    reason: row.deletionReason,
  };
}

/** `numeric` из Postgres приходит строкой; пустой агрегат — `null`, и это ноль, а не незнание. */
function money(value: string | null): number {
  return value === null ? 0 : Number(value);
}

/**
 * Сумма набора сумм — целыми копейками (Р11).
 *
 * Складывать `number` напрямую нельзя: `1250.35 + 0.1` в двоичной плавающей точке даёт хвост, и
 * итог карточки разошёлся бы с итогом ленты, который считает база, на копейку — то есть ровно тем
 * расхождением, ради устранения которого поля «итог по бумаге» и нет вовсе. Копейки целые: суммы
 * строк по схеме кратны копейке (`multipleOf(0.01)`), и потерь при переводе нет.
 */
function sumAmounts(amounts: readonly number[]): number {
  return amounts.reduce((acc, value) => acc + Math.round(value * 100), 0) / 100;
}

/**
 * Цена за единицу — производная (Р9): `amount / quantity`, округлённое до копейки СЕРВЕРОМ.
 *
 * Считается здесь, а не в портале, чтобы формула жила в одном месте: карточка чека, окно машины и
 * будущее распознавание показывали бы иначе три слегка разных числа. Деления на ноль не бывает —
 * количество строго положительно и по схеме, и по `CHECK` таблицы.
 *
 * **Делится копейками, а не рублями**, и это не педантизм: `1250.35 / 2` в двоичной плавающей точке
 * даёт `625.17499999999995`, и округление рублёвого частного возвращает `625.17` — копейку вниз от
 * арифметически верного `625.18`. Сумма же по схеме кратна копейке (`multipleOf(0.01)`), поэтому
 * целое число копеек получается точно, а делится и округляется уже оно. Тот же приём, что у
 * `sumAmounts` выше.
 */
function unitPriceOf(amount: number, quantity: number): number {
  return Math.round(Math.round(amount * 100) / quantity) / 100;
}

/** Машина глазами чека: как называется и своя ли она (Р21). */
export interface VehicleBrief {
  label: string;
  ownership: VehicleOwnership;
}

/**
 * Подписи машин набором — ОДНИМ запросом на все строки чека (Р21).
 *
 * Тем же ответом пользуются трое: строки карточки (`vehicleLabel`), колонка «Машины» ленты и
 * проверка собственности при записи. Запрос один и на проверку, и на подпись намеренно: отказ
 * «Строка 3: КамАЗ — арендная техника» обязан называть машину теми же словами, какими её называет
 * карточка, иначе человек будет искать в чеке не ту строку.
 *
 * Статус машины не спрашивается вовсе (Р21): чек законно выписан на машину, которую позже вывели
 * из парка, и правка старого чека не должна упираться в то, что случилось после покупки.
 */
export async function loadVehicleBriefs(
  reader: Reader,
  vehicleIds: readonly string[],
): Promise<Map<string, VehicleBrief>> {
  const ids = [...new Set(vehicleIds)];
  if (ids.length === 0) return new Map();
  const rows = await reader
    .select({
      id: vehicles.id,
      ownership: vehicles.ownership,
      description: vehicles.description,
      registrationNumber: vehicles.registrationNumber,
      categoryName: vehicleCategories.name,
      typeName: vehicleTypes.name,
      modelName: vehicleModels.name,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .where(inArray(vehicles.id, ids));
  return new Map(
    rows.map((row) => [row.id, { label: vehicleLabel(row), ownership: row.ownership }]),
  );
}

/** Сканы чеков набором — именем, типом и размером, как сканы акта ТО. */
async function loadReceiptFiles(
  reader: Reader,
  receiptIds: readonly string[],
): Promise<Map<string, AttachedFileDto[]>> {
  const found = new Map<string, AttachedFileDto[]>();
  const ids = [...new Set(receiptIds)];
  if (ids.length === 0) return found;
  const rows = await reader
    .select({
      receiptId: autoPartReceiptFiles.receiptId,
      id: files.id,
      filename: files.filename,
      contentType: files.contentType,
      size: files.size,
      // Карантин читается вместе с именем: имя скрытого документа наружу не уходит, и решает это
      // общее правило (`attachedFileView`), а не этот сборщик (Р6, п. 4).
      quarantinedAt: files.quarantinedAt,
    })
    .from(autoPartReceiptFiles)
    .innerJoin(files, eq(files.id, autoPartReceiptFiles.fileId))
    .where(inArray(autoPartReceiptFiles.receiptId, ids))
    .orderBy(asc(autoPartReceiptFiles.addedAt));
  for (const row of rows) {
    const list = found.get(row.receiptId) ?? [];
    list.push(attachedFileView(row));
    found.set(row.receiptId, list);
  }
  return found;
}

/**
 * Строки чеков набором, порядком бумаги (`seq`, §6). Подписи машин добираются вторым запросом, а
 * не соединением из четырёх справочников на каждую строку: машин в чеке единицы, и повторять
 * ради них марку, категорию и модель на каждую позицию незачем.
 */
async function loadLines(
  reader: Reader,
  receiptIds: readonly string[],
): Promise<Map<string, AutoPartReceiptLineDto[]>> {
  const found = new Map<string, AutoPartReceiptLineDto[]>();
  const ids = [...new Set(receiptIds)];
  if (ids.length === 0) return found;
  const rows = await reader
    .select({
      id: autoPartReceiptLines.id,
      receiptId: autoPartReceiptLines.receiptId,
      seq: autoPartReceiptLines.seq,
      destination: autoPartReceiptLines.destination,
      vehicleId: autoPartReceiptLines.vehicleId,
      article: autoPartReceiptLines.article,
      name: autoPartReceiptLines.name,
      quantity: autoPartReceiptLines.quantity,
      unit: autoPartReceiptLines.unit,
      amount: autoPartReceiptLines.amount,
      note: autoPartReceiptLines.note,
    })
    .from(autoPartReceiptLines)
    .where(inArray(autoPartReceiptLines.receiptId, ids))
    .orderBy(asc(autoPartReceiptLines.receiptId), asc(autoPartReceiptLines.seq));

  const briefs = await loadVehicleBriefs(
    reader,
    rows.flatMap((row) => (row.vehicleId === null ? [] : [row.vehicleId])),
  );
  for (const row of rows) {
    const list = found.get(row.receiptId) ?? [];
    const amount = money(row.amount);
    list.push({
      id: row.id,
      seq: row.seq,
      destination: row.destination,
      vehicleId: row.vehicleId,
      // Пустая строка, а не `null`: подпись портал ПОКАЗЫВАЕТ, а решает по `vehicleId`, и второе
      // поле, по которому можно решать, разъехалось бы с первым (§6).
      vehicleLabel: row.vehicleId === null ? '' : (briefs.get(row.vehicleId)?.label ?? ''),
      article: row.article,
      name: row.name,
      quantity: row.quantity,
      unit: row.unit,
      amount,
      unitPrice: unitPriceOf(amount, row.quantity),
      note: row.note,
    });
    found.set(row.receiptId, list);
  }
  return found;
}

/**
 * Чек целиком: шапка, строки, сканы, все итоги и пометка (§6).
 *
 * Ответ один и тот же у карточки и у всех четырёх мутаций — правда о сохранённом чеке приходит
 * ответом сервера, а не досчитывается формой после сохранения.
 */
export async function loadReceiptDto(reader: Reader, id: string): Promise<AutoPartReceiptDto> {
  const [head] = await headQuery(reader).where(eq(autoPartReceipts.id, id));
  if (!head) throw err.notFound('Чек не найден');
  const lines = (await loadLines(reader, [id])).get(id) ?? [];
  const scans = (await loadReceiptFiles(reader, [id])).get(id) ?? [];
  return toReceiptDto(head, lines, scans);
}

function toReceiptDto(
  head: HeadRow,
  lines: readonly AutoPartReceiptLineDto[],
  scans: readonly AttachedFileDto[],
): AutoPartReceiptDto {
  return {
    id: head.id,
    purchasedOn: head.purchasedOn,
    sellerName: head.sellerName,
    documentNumber: head.documentNumber,
    note: head.note,
    lines: [...lines],
    files: [...scans],
    total: sumAmounts(lines.map((line) => line.amount)),
    unassignedTotal: sumAmounts(
      lines.filter((line) => line.destination === 'unassigned').map((line) => line.amount),
    ),
    warehouseTotal: sumAmounts(
      lines.filter((line) => line.destination === 'warehouse').map((line) => line.amount),
    ),
    deletion: deletionOf(head),
    version: head.version,
    createdAt: head.createdAt.toISOString(),
    createdByName: head.createdByName,
    updatedAt: head.updatedAt.toISOString(),
    // Пусто, пока чек не правили, — как `updatedByName` у акта ТО: подпись, а не решение.
    updatedByName: head.updatedByName ?? '',
  };
}

// ── Отбор ленты (§6): один и тот же у списка и у сводки ──

/**
 * Условия ленты. Сводка считает по ним же — иначе «Сумма» над отфильтрованным списком называла бы
 * чужое число, а объяснить разницу человеку было бы нечем.
 *
 * Период — по ДАТЕ ЧЕКА (Р13): хозяйственный вопрос «сколько потратили в августе» задаётся
 * бумагой, а не днём, когда её внесли в портал.
 *
 * Машина и поиск по наименованию — `EXISTS` по строкам, а не соединение: вторым соединением чек
 * размножился бы по числу подходящих строк, и `total` ленты считал бы позиции вместо документов.
 * Сам чек при этом остаётся ЦЕЛЫМ: фильтр по машине отвечает «в каких чеках она есть», а не
 * «показать только её строки» — на второй вопрос отвечает окно «Запчасти машины» (Р15).
 */
function receiptFilterWhere(q: AutoPartReceiptSummaryQuery): SQL | undefined {
  return and(
    q.from ? gte(autoPartReceipts.purchasedOn, q.from) : undefined,
    q.to ? lte(autoPartReceipts.purchasedOn, q.to) : undefined,
    q.vehicleId ? hasLineWith(eq(filterLines.vehicleId, q.vehicleId)) : undefined,
    // Три состояния, а не флаг (§6): параметра нет — не фильтровать, `true` — очередь
    // администратора, `false` — всё остальное. Помеченные из ленты не исчезают никогда (Р12).
    q.deletionMarked === undefined
      ? undefined
      : q.deletionMarked
        ? isNotNull(autoPartReceipts.deletionRequestedAt)
        : isNull(autoPartReceipts.deletionRequestedAt),
    q.search ? searchWhere(q.search) : undefined,
  );
}

function hasLineWith(condition: SQL): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(filterLines)
      .where(and(eq(filterLines.receiptId, autoPartReceipts.id), condition)),
  );
}

/**
 * Поиск — четыре места, где ищут одну и ту же покупку (§6): продавец, номер чека, наименование
 * строки и её артикул. Наименование обязательно в этом наборе: чек ищут по тому, что купили, чаще,
 * чем по магазину, — а «фильтр масляный» живёт только в строках.
 *
 * Артикул добавлен вместе с самим полем (план `docs/auto-part-receipt-ocr-plan.md`, Р2а) и не для
 * полноты: написание наименования у двух продавцов не совпадёт («Шланг d=18x27мм маслобензостойкий»
 * и «Шланг 18х27 МБС»), а артикул совпадёт — и «когда мы последний раз брали ШМБС-18х27» отвечается
 * только им. Без этой строки поле было бы видно и бесполезно.
 */
function searchWhere(term: string): SQL | undefined {
  const like = `%${term}%`;
  // Оба поля строки проверяются ОДНИМ подзапросом: два `EXISTS` рядом спрашивали бы таблицу строк
  // дважды об одном и том же чеке. `or` объявлен возвращающим `SQL | undefined` (пустой список
  // аргументов), и здесь он непуст — но проверка стоит, чтобы это утверждал компилятор, а не
  // комментарий.
  const inLine = or(ilike(filterLines.name, like), ilike(filterLines.article, like));
  return or(
    ilike(autoPartReceipts.sellerName, like),
    ilike(autoPartReceipts.documentNumber, like),
    inLine ? hasLineWith(inLine) : undefined,
  );
}

/**
 * Поля сортировки — только реквизиты шапки (`AUTO_PART_RECEIPT_SORT_FIELDS`). Итога среди них нет
 * намеренно: он складывается из строк, и «самые дорогие чеки» — вопрос к отчёту, которого этот
 * выпуск не заводит.
 */
const sortColumns = {
  purchasedOn: autoPartReceipts.purchasedOn,
  sellerName: autoPartReceipts.sellerName,
  documentNumber: autoPartReceipts.documentNumber,
  createdAt: autoPartReceipts.createdAt,
};

/** Итоги строк по чекам страницы: сколько строк и на какую сумму. */
async function loadLineTotals(
  receiptIds: readonly string[],
): Promise<Map<string, { linesCount: number; total: number }>> {
  const found = new Map<string, { linesCount: number; total: number }>();
  if (receiptIds.length === 0) return found;
  const rows = await db
    .select({
      receiptId: autoPartReceiptLines.receiptId,
      linesCount: count(),
      // `::numeric(20,2)` — ради двух знаков ВСЕГДА: без приведения пустая группа отдала бы «0»
      // там, где соседняя отдаёт «9600.00». Ширина с запасом от колонки: сумма сотни строк в
      // `numeric(14,2)` помещается, а приведение к её точности упало бы переполнением зря.
      total: sql<string>`coalesce(sum(${autoPartReceiptLines.amount}), 0)::numeric(20,2)::text`,
    })
    .from(autoPartReceiptLines)
    .where(inArray(autoPartReceiptLines.receiptId, [...receiptIds]))
    .groupBy(autoPartReceiptLines.receiptId);
  for (const row of rows) {
    found.set(row.receiptId, { linesCount: Number(row.linesCount), total: money(row.total) });
  }
  return found;
}

/** Скрепка ленты: сколько сканов у чека (их всегда хотя бы один, Р6 — поэтому число, а не флаг). */
async function loadFileCounts(receiptIds: readonly string[]): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  if (receiptIds.length === 0) return found;
  const rows = await db
    .select({ receiptId: autoPartReceiptFiles.receiptId, filesCount: count() })
    .from(autoPartReceiptFiles)
    .where(inArray(autoPartReceiptFiles.receiptId, [...receiptIds]))
    .groupBy(autoPartReceiptFiles.receiptId);
  for (const row of rows) found.set(row.receiptId, Number(row.filesCount));
  return found;
}

/**
 * Колонка «Машины» ленты: «Е646СК799, В120АА77 и ещё 3» (§6).
 *
 * Подпись собирает сервер, а не экран: правило «как называется машина» одно на портал, и собери
 * его список сам — окно чека и колонка гаража называли бы одну машину по-разному. Порядок — по
 * `seq`, то есть как в бумаге: первой названа та машина, что стоит первой строкой чека.
 */
async function loadVehiclesLabels(receiptIds: readonly string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (receiptIds.length === 0) return labels;
  const rows = await db
    .select({
      receiptId: autoPartReceiptLines.receiptId,
      vehicleId: autoPartReceiptLines.vehicleId,
    })
    .from(autoPartReceiptLines)
    .where(
      and(
        inArray(autoPartReceiptLines.receiptId, [...receiptIds]),
        isNotNull(autoPartReceiptLines.vehicleId),
      ),
    )
    .orderBy(asc(autoPartReceiptLines.receiptId), asc(autoPartReceiptLines.seq));

  const briefs = await loadVehicleBriefs(
    db,
    rows.flatMap((row) => (row.vehicleId === null ? [] : [row.vehicleId])),
  );
  const byReceipt = new Map<string, string[]>();
  for (const row of rows) {
    if (row.vehicleId === null) continue;
    const list = byReceipt.get(row.receiptId) ?? [];
    // Две строки на одну машину — обычное дело (Р7), а колонка называет машины, а не позиции.
    const label = briefs.get(row.vehicleId)?.label ?? '';
    if (label && !list.includes(label)) list.push(label);
    byReceipt.set(row.receiptId, list);
  }
  for (const [receiptId, list] of byReceipt) {
    const shown = list.slice(0, VEHICLES_LABEL_LIMIT).join(', ');
    const rest = list.length - VEHICLES_LABEL_LIMIT;
    labels.set(receiptId, rest > 0 ? `${shown} и ещё ${rest}` : shown);
  }
  return labels;
}

/**
 * Лента чеков страницами (§7).
 *
 * Порядок доводится до полного тремя колонками (индекс `auto_part_receipts_feed_idx`): две покупки
 * одного дня ключом даты неразличимы, и без `created_at` с `id` часть чеков задваивалась бы между
 * страницами, а часть пропадала.
 */
export async function listReceipts(
  q: AutoPartReceiptListQuery,
): Promise<ListResult<AutoPartReceiptListItemDto>> {
  const where = receiptFilterWhere(q);
  const page = pageParams(q);
  const rows = await headQuery(db)
    .where(where)
    .orderBy(
      orderByFrom(sortColumns, q.sortBy, q.sortOrder, 'purchasedOn'),
      desc(autoPartReceipts.createdAt),
      desc(autoPartReceipts.id),
    )
    .limit(page.limit)
    .offset(page.offset);
  const [totalRow] = await db.select({ c: count() }).from(autoPartReceipts).where(where);

  const ids = rows.map((row) => row.id);
  const totals = await loadLineTotals(ids);
  const fileCounts = await loadFileCounts(ids);
  const vehiclesLabels = await loadVehiclesLabels(ids);

  return {
    items: rows.map((row) => ({
      id: row.id,
      purchasedOn: row.purchasedOn,
      sellerName: row.sellerName,
      documentNumber: row.documentNumber,
      linesCount: totals.get(row.id)?.linesCount ?? 0,
      total: totals.get(row.id)?.total ?? 0,
      vehiclesLabel: vehiclesLabels.get(row.id) ?? '',
      filesCount: fileCounts.get(row.id) ?? 0,
      deletion: deletionOf(row),
    })),
    total: Number(totalRow!.c),
    page: page.page,
    pageSize: page.pageSize,
  };
}

/**
 * Сводка вкладки: пять чисел под фильтрами ленты (§7, §8).
 *
 * Считается по ТЕМ ЖЕ условиям, что и лента: сводка отвечает про то, что видно. Помеченные к
 * удалению в суммы входят наравне со всеми (Р12) — пометка это просьба, а не изъятие документа из
 * учёта; отдельным числом показано, сколько таких просьб ждёт администратора.
 *
 * Двумя запросами, а не одним: счёт документов и сумма их строк — величины разной кратности, и
 * посчитанные одним соединением дали бы либо задвоенный счёт чеков, либо сумму по одной строке.
 */
export async function loadReceiptsSummary(
  q: AutoPartReceiptSummaryQuery,
): Promise<AutoPartReceiptsSummaryDto> {
  const where = receiptFilterWhere(q);
  const [heads] = await db
    .select({
      receiptsCount: count(),
      deletionMarkedCount: sql<string>`count(*) FILTER (
        WHERE ${autoPartReceipts.deletionRequestedAt} IS NOT NULL)`,
    })
    .from(autoPartReceipts)
    .where(where);
  const [sums] = await db
    .select({
      total: sql<string>`coalesce(sum(${autoPartReceiptLines.amount}), 0)::numeric(20,2)::text`,
      unassignedTotal: sql<string>`coalesce(sum(${autoPartReceiptLines.amount}) FILTER (
        WHERE ${autoPartReceiptLines.destination} = 'unassigned'), 0)::numeric(20,2)::text`,
      warehouseTotal: sql<string>`coalesce(sum(${autoPartReceiptLines.amount}) FILTER (
        WHERE ${autoPartReceiptLines.destination} = 'warehouse'), 0)::numeric(20,2)::text`,
    })
    .from(autoPartReceiptLines)
    .innerJoin(autoPartReceipts, eq(autoPartReceipts.id, autoPartReceiptLines.receiptId))
    .where(where);
  return {
    receiptsCount: Number(heads!.receiptsCount),
    total: money(sums!.total),
    unassignedTotal: money(sums!.unassignedTotal),
    warehouseTotal: money(sums!.warehouseTotal),
    deletionMarkedCount: Number(heads!.deletionMarkedCount),
  };
}

/** A single application after write, with the same ready vehicle label used by every receipt. */
export async function loadApplicationDto(
  reader: Reader,
  id: string,
): Promise<AutoPartApplicationDto> {
  const [row] = await reader
    .select({
      id: autoPartApplications.id,
      lineId: autoPartApplications.receiptLineId,
      vehicleId: autoPartApplications.vehicleId,
      appliedOn: autoPartApplications.appliedOn,
      quantity: autoPartApplications.quantity,
      amount: autoPartApplications.amount,
      documentNumber: autoPartApplications.documentNumber,
      note: autoPartApplications.note,
      createdAt: autoPartApplications.createdAt,
      createdByName: users.fullName,
    })
    .from(autoPartApplications)
    .innerJoin(users, eq(users.id, autoPartApplications.createdBy))
    .where(eq(autoPartApplications.id, id));
  if (!row) throw err.notFound('Документ применения не найден');
  const vehicle = (await loadVehicleBriefs(reader, [row.vehicleId])).get(row.vehicleId);
  return {
    id: row.id,
    lineId: row.lineId,
    vehicleId: row.vehicleId,
    vehicleLabel: vehicle?.label ?? '',
    appliedOn: row.appliedOn,
    quantity: row.quantity,
    amount: money(row.amount),
    documentNumber: row.documentNumber,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdByName,
  };
}

const appliedQuantityExpr = sql<string>`coalesce((
  SELECT sum(a.quantity) FROM auto_part_applications a
  WHERE a.receipt_line_id = ${autoPartReceiptLines.id}
), 0)::text`;
const appliedAmountExpr = sql<string>`coalesce((
  SELECT sum(a.amount) FROM auto_part_applications a
  WHERE a.receipt_line_id = ${autoPartReceiptLines.id}
), 0)::numeric(20,2)::text`;

/** Receipt-backed warehouse lots. Remaining quantity and amount are always derived from documents. */
export async function listWarehouseLots(
  q: AutoPartWarehouseListQuery,
): Promise<ListResult<AutoPartWarehouseLotDto>> {
  const search = q.search ? `%${q.search}%` : undefined;
  const where = and(
    eq(autoPartReceiptLines.destination, 'warehouse'),
    q.inStock
      ? sql`${autoPartReceiptLines.quantity} > (${appliedQuantityExpr})::integer`
      : undefined,
    search
      ? or(
          ilike(autoPartReceiptLines.name, search),
          ilike(autoPartReceiptLines.article, search),
          ilike(autoPartReceipts.documentNumber, search),
          ilike(autoPartReceipts.sellerName, search),
        )
      : undefined,
  );
  const page = pageParams(q);
  const sort =
    q.sortBy === 'name'
      ? q.sortOrder === 'asc'
        ? asc(autoPartReceiptLines.name)
        : desc(autoPartReceiptLines.name)
      : q.sortOrder === 'asc'
        ? asc(autoPartReceipts.purchasedOn)
        : desc(autoPartReceipts.purchasedOn);
  const rows = await db
    .select({
      lineId: autoPartReceiptLines.id,
      receiptId: autoPartReceipts.id,
      purchasedOn: autoPartReceipts.purchasedOn,
      sellerName: autoPartReceipts.sellerName,
      receiptDocumentNumber: autoPartReceipts.documentNumber,
      article: autoPartReceiptLines.article,
      name: autoPartReceiptLines.name,
      unit: autoPartReceiptLines.unit,
      quantity: autoPartReceiptLines.quantity,
      appliedQuantity: appliedQuantityExpr,
      amount: autoPartReceiptLines.amount,
      appliedAmount: appliedAmountExpr,
    })
    .from(autoPartReceiptLines)
    .innerJoin(autoPartReceipts, eq(autoPartReceipts.id, autoPartReceiptLines.receiptId))
    .where(where)
    .orderBy(sort, desc(autoPartReceiptLines.createdAt), desc(autoPartReceiptLines.id))
    .limit(page.limit)
    .offset(page.offset);
  const [totalRow] = await db
    .select({ c: count() })
    .from(autoPartReceiptLines)
    .innerJoin(autoPartReceipts, eq(autoPartReceipts.id, autoPartReceiptLines.receiptId))
    .where(where);
  return {
    items: rows.map((row) => {
      const amount = money(row.amount);
      const appliedAmount = money(row.appliedAmount);
      const appliedQuantity = Number(row.appliedQuantity);
      return {
        ...row,
        amount,
        appliedAmount,
        appliedQuantity,
        remainingQuantity: row.quantity - appliedQuantity,
        remainingAmount: Math.round((amount - appliedAmount) * 100) / 100,
      };
    }),
    total: Number(totalRow!.c),
    page: page.page,
    pageSize: page.pageSize,
  };
}

/**
 * Суммы по машинам пакетом — колонка «Запчасти, ₽» видимой страницы гаража (Р14).
 *
 * Приём целиком из колонки «ТО»: одна ручка на страницу, а не запрос из строки. И то же правило
 * дня — в сумму идут чеки НЕ ПОЗЖЕ дня среза: срез марта, показавший августовскую покупку,
 * отвечал бы не на тот вопрос, который задали календарём наверху.
 *
 * Машина без чеков из ответа просто выпадает: колонка рисует прочерк, а не «0 ₽» — ноль был бы
 * утверждением «на машину не тратили», а это другое знание (§6).
 */
export async function loadVehiclePartsSnapshot(
  vehicleIds: readonly string[],
  to: string,
): Promise<Map<string, VehiclePartsSpendSnapshotDto>> {
  const found = new Map<string, VehiclePartsSpendSnapshotDto>();
  const ids = [...new Set(vehicleIds)];
  if (ids.length === 0) return found;
  const rows = await db
    .select({
      vehicleId: autoPartReceiptLines.vehicleId,
      total: sql<string>`coalesce(sum(${autoPartReceiptLines.amount}), 0)::numeric(20,2)::text`,
      receiptIds: sql<string[]>`array_agg(DISTINCT ${autoPartReceipts.id})`,
      lastPurchasedOn: sql<string | null>`max(${autoPartReceipts.purchasedOn})`,
    })
    .from(autoPartReceiptLines)
    .innerJoin(autoPartReceipts, eq(autoPartReceipts.id, autoPartReceiptLines.receiptId))
    .where(and(inArray(autoPartReceiptLines.vehicleId, ids), lte(autoPartReceipts.purchasedOn, to)))
    .groupBy(autoPartReceiptLines.vehicleId);
  const receiptIdsByVehicle = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.vehicleId === null) continue;
    const receiptIds = new Set(row.receiptIds);
    receiptIdsByVehicle.set(row.vehicleId, receiptIds);
    found.set(row.vehicleId, {
      vehicleId: row.vehicleId,
      total: money(row.total),
      receiptsCount: receiptIds.size,
      lastPurchasedOn: row.lastPurchasedOn,
    });
  }

  const applications = await db
    .select({
      vehicleId: autoPartApplications.vehicleId,
      total: sql<string>`coalesce(sum(${autoPartApplications.amount}), 0)::numeric(20,2)::text`,
      receiptIds: sql<string[]>`array_agg(DISTINCT ${autoPartReceiptLines.receiptId})`,
      lastPurchasedOn: sql<string | null>`max(${autoPartApplications.appliedOn})`,
    })
    .from(autoPartApplications)
    .innerJoin(
      autoPartReceiptLines,
      eq(autoPartReceiptLines.id, autoPartApplications.receiptLineId),
    )
    .where(
      and(inArray(autoPartApplications.vehicleId, ids), lte(autoPartApplications.appliedOn, to)),
    )
    .groupBy(autoPartApplications.vehicleId);
  for (const row of applications) {
    const before = found.get(row.vehicleId);
    const receiptIds = receiptIdsByVehicle.get(row.vehicleId) ?? new Set<string>();
    for (const receiptId of row.receiptIds) receiptIds.add(receiptId);
    receiptIdsByVehicle.set(row.vehicleId, receiptIds);
    found.set(row.vehicleId, {
      vehicleId: row.vehicleId,
      total: Math.round(((before?.total ?? 0) + money(row.total)) * 100) / 100,
      // One receipt can contribute both directly and through stock; count it only once.
      receiptsCount: receiptIds.size,
      lastPurchasedOn:
        !before?.lastPurchasedOn ||
        (row.lastPurchasedOn !== null && row.lastPurchasedOn > before.lastPurchasedOn)
          ? row.lastPurchasedOn
          : before.lastPurchasedOn,
    });
  }
  return found;
}

/**
 * Окно «Запчасти машины» — один ответ на «что купили этой машине» (Р15).
 *
 * `null` означает ровно одно: такой машины в справочнике нет. Машина без единой покупки — законный
 * ответ с пустым перечнем и нулями: «чеков не заводили» и «машины не существует» это разные вещи,
 * и портал обязан их различать.
 *
 * Итога два и приходят они одним ответом (§6): блок карточки машины показывает «За период: N ₽ ·
 * Всего: M ₽», и вторым запросом эти две цифры стали бы парой снимков, снятых в разные моменты, а
 * на экране они стоят рядом и читаются как одно утверждение.
 */
export async function loadVehiclePartsSpend(
  vehicleId: string,
  q: VehiclePartsSpendQuery,
): Promise<VehiclePartsSpendDto | null> {
  const brief = (await loadVehicleBriefs(db, [vehicleId])).get(vehicleId);
  if (!brief) return null;

  const period = and(
    q.from ? gte(autoPartReceipts.purchasedOn, q.from) : undefined,
    q.to ? lte(autoPartReceipts.purchasedOn, q.to) : undefined,
  );
  const mine = eq(autoPartReceiptLines.vehicleId, vehicleId);

  // Оба итога одним проходом: `FILTER` считает период, обычная сумма — всё время. Второй запрос
  // дал бы те же два числа, но снятые в разные моменты.
  const [directTotals] = await db
    .select({
      total: sql<string>`coalesce(sum(${autoPartReceiptLines.amount})
        FILTER (WHERE ${period ?? sql`true`}), 0)::numeric(20,2)::text`,
      totalAllTime: sql<string>`coalesce(sum(${autoPartReceiptLines.amount}), 0)::numeric(20,2)::text`,
    })
    .from(autoPartReceiptLines)
    .innerJoin(autoPartReceipts, eq(autoPartReceipts.id, autoPartReceiptLines.receiptId))
    .where(mine);

  const applicationPeriod = and(
    q.from ? gte(autoPartApplications.appliedOn, q.from) : undefined,
    q.to ? lte(autoPartApplications.appliedOn, q.to) : undefined,
  );
  const [applicationTotals] = await db
    .select({
      total: sql<string>`coalesce(sum(${autoPartApplications.amount})
        FILTER (WHERE ${applicationPeriod ?? sql`true`}), 0)::numeric(20,2)::text`,
      totalAllTime: sql<string>`coalesce(sum(${autoPartApplications.amount}), 0)::numeric(20,2)::text`,
    })
    .from(autoPartApplications)
    .where(eq(autoPartApplications.vehicleId, vehicleId));

  const directRows = await db
    .select({
      receiptId: autoPartReceipts.id,
      purchasedOn: autoPartReceipts.purchasedOn,
      sellerName: autoPartReceipts.sellerName,
      documentNumber: autoPartReceipts.documentNumber,
      createdAt: autoPartReceipts.createdAt,
      lineId: autoPartReceiptLines.id,
      seq: autoPartReceiptLines.seq,
      article: autoPartReceiptLines.article,
      name: autoPartReceiptLines.name,
      quantity: autoPartReceiptLines.quantity,
      unit: autoPartReceiptLines.unit,
      amount: autoPartReceiptLines.amount,
    })
    .from(autoPartReceiptLines)
    .innerJoin(autoPartReceipts, eq(autoPartReceipts.id, autoPartReceiptLines.receiptId))
    .where(and(mine, period))
    // Порядок ленты — свежая покупка сверху, — и внутри чека порядок бумаги: строки одного чека
    // человек читает так же, как в карточке.
    .orderBy(
      desc(autoPartReceipts.purchasedOn),
      desc(autoPartReceipts.createdAt),
      desc(autoPartReceipts.id),
      asc(autoPartReceiptLines.seq),
    );

  const items: VehiclePartsSpendRowDto[] = directRows.map((row) => ({
    receiptId: row.receiptId,
    purchasedOn: row.purchasedOn,
    sellerName: row.sellerName,
    documentNumber: row.documentNumber,
    lineId: row.lineId,
    article: row.article,
    name: row.name,
    quantity: row.quantity,
    unit: row.unit,
    amount: money(row.amount),
  }));

  const applicationRows = await db
    .select({
      applicationId: autoPartApplications.id,
      receiptId: autoPartReceipts.id,
      appliedOn: autoPartApplications.appliedOn,
      sellerName: autoPartReceipts.sellerName,
      receiptDocumentNumber: autoPartReceipts.documentNumber,
      applicationDocumentNumber: autoPartApplications.documentNumber,
      createdAt: autoPartApplications.createdAt,
      article: autoPartReceiptLines.article,
      name: autoPartReceiptLines.name,
      quantity: autoPartApplications.quantity,
      unit: autoPartReceiptLines.unit,
      amount: autoPartApplications.amount,
    })
    .from(autoPartApplications)
    .innerJoin(
      autoPartReceiptLines,
      eq(autoPartReceiptLines.id, autoPartApplications.receiptLineId),
    )
    .innerJoin(autoPartReceipts, eq(autoPartReceipts.id, autoPartReceiptLines.receiptId))
    .where(and(eq(autoPartApplications.vehicleId, vehicleId), applicationPeriod))
    .orderBy(
      desc(autoPartApplications.appliedOn),
      desc(autoPartApplications.createdAt),
      desc(autoPartApplications.id),
    );
  for (const row of applicationRows) {
    items.push({
      receiptId: row.receiptId,
      purchasedOn: row.appliedOn,
      sellerName: `Со склада · ${row.sellerName || `чек № ${row.receiptDocumentNumber}`}`,
      documentNumber: row.applicationDocumentNumber,
      lineId: row.applicationId,
      article: row.article,
      name: row.name,
      quantity: row.quantity,
      unit: row.unit,
      amount: money(row.amount),
    });
  }
  items.sort((a, b) => b.purchasedOn.localeCompare(a.purchasedOn));

  return {
    vehicleId,
    vehicleLabel: brief.label,
    total: Math.round((money(directTotals!.total) + money(applicationTotals!.total)) * 100) / 100,
    totalAllTime:
      Math.round(
        (money(directTotals!.totalAllTime) + money(applicationTotals!.totalAllTime)) * 100,
      ) / 100,
    rows: items,
  };
}
