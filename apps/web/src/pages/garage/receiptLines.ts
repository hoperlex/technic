import {
  RECEIPT_MAX_AMOUNT,
  RECEIPT_MAX_QUANTITY,
  type AutoPartReceiptLineDto,
  type CreateReceiptBody,
} from '@technic/contracts';
import { errorFields } from '@shared/lib';

/**
 * Строки чека глазами формы (план `docs/auto-part-receipts-plan.md`, Р7—Р11): что набирают, во что
 * это превращается на отправке и как называется каждый отказ.
 *
 * Отдельным модулем от самого редактора: у файла бюджет длины (`apps/web/quality-budget.json`), а
 * растёт здесь именно редактор — раскладка ячеек, подсказки, поведение полей. Правила же строки
 * коротки и нужны обоим: и редактору, и форме, которая проверяет набранное перед отправкой.
 *
 * Своего представления денег и своего итога чека тут нет: `total` считает сервер (Р11), а сумма
 * ниже — предпросмотр на глазах у вводящего, и называется она так же в форме.
 */

/** Поля строки, у которых бывает отказ: по ним редактор красит ячейку и пишет причину. */
export type ReceiptLineField = 'vehicleId' | 'name' | 'quantity' | 'unit' | 'amount';

/** Отказы по строкам: ключ строки → поле → причина. Пусто — набранное годится. */
export type ReceiptLineErrors = Record<string, Partial<Record<ReceiptLineField, string>>>;

/**
 * Набираемая строка. Своя от `AutoPartReceiptLineDto`, и на то две причины:
 *
 * 1. **Ключ.** Строки уходят на сервер целиком и пересоздаются им (§6: `seq` задаёт порядок
 *    массива), поэтому идентификатора у набираемой строки нет вовсе — а React нужен ключ, чтобы
 *    вставка строки посередине не увела фокус в соседнюю ячейку.
 * 2. **Полувведённое состояние.** `InputNumber` отдаёт `null`, пока поле пусто, и подменять это
 *    нулём нельзя: «0» — законная сумма (акция, гарантия, Р9), а «не введено» — отказ. Различать
 *    их обязано само значение, а не догадка на отправке.
 */
export interface ReceiptLineRow {
  key: string;
  /** `null` — «не отнесено»: законное состояние строки, а не незаполненное поле (Р8). */
  vehicleId: string | null;
  name: string;
  quantity: number | null;
  unit: string;
  amount: number | null;
  note: string;
}

let sequence = 0;

function nextKey(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/**
 * Пустая строка чека. Количество — единица (в чеке так чаще всего и напечатано), единица — «шт»
 * (умолчание схемы, Р10), сумма пуста: подставленный ноль читался бы как «отдали даром».
 */
export function newReceiptLine(): ReceiptLineRow {
  return {
    key: nextKey('line'),
    vehicleId: null,
    name: '',
    quantity: 1,
    unit: 'шт',
    amount: null,
    note: '',
  };
}

/** Строки правимого чека: тот же набор, набранный когда-то. */
export function receiptLinesFromDto(lines: readonly AutoPartReceiptLineDto[]): ReceiptLineRow[] {
  return lines.map((line) => ({
    key: nextKey(`row-${line.id}`),
    vehicleId: line.vehicleId,
    name: line.name,
    quantity: line.quantity,
    unit: line.unit,
    amount: line.amount,
    note: line.note,
  }));
}

/**
 * Итог формы — **предпросмотр**, а не сумма чека (Р11). Считается на глазах при вводе, потому что
 * сверяют с бумагой именно его; сохранённой правдой становится `total` из ответа сервера.
 *
 * Округление до копейки здесь обязательно: сложение чисел с плавающей точкой даёт «3 512,199999»,
 * и предпросмотр расходился бы с ответом сервера на глаз, ничего при этом не значив.
 */
export function receiptLinesTotal(rows: readonly ReceiptLineRow[]): number {
  return Math.round(rows.reduce((sum, row) => sum + (row.amount ?? 0) * 100, 0)) / 100;
}

/** Строки в тело запроса: порядок задаёт массив, `seq` проставит сервер (§6). */
export function receiptLinesPayload(rows: readonly ReceiptLineRow[]): CreateReceiptBody['lines'] {
  return rows.map((row) => ({
    vehicleId: row.vehicleId,
    name: row.name.trim(),
    // Пустое количество и пустая сумма сюда не доходят: их отбивает проверка ниже, до отправки.
    quantity: row.quantity ?? 0,
    unit: row.unit.trim(),
    amount: row.amount ?? 0,
    note: row.note.trim(),
  }));
}

/**
 * Кратна ли сумма копейке. Сравнение с допуском, а не `% 0.01`: у двоичной дроби `1250.35 * 100`
 * это `125034.99999999999`, и точная проверка отбивала бы законную сумму.
 */
function isKopecks(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

/**
 * Отказы набранных строк — теми же словами, что у схемы (§6, ADR 0094): человек читает поле, а не
 * код ошибки, и второй формулировки того же правила в портале быть не должно.
 *
 * Проверка целого стоит здесь, а не решается округлением поля: `precision={0}` молча превратил бы
 * «2,5» в «3» — то есть переписал бы чек за механика (Р10). Поле отказывается принимать
 * разделитель, а прилетевшее вставкой дробное получает отказ словами.
 */
export function validateReceiptLines(rows: readonly ReceiptLineRow[]): ReceiptLineErrors {
  const errors: ReceiptLineErrors = {};
  for (const row of rows) {
    const issues: Partial<Record<ReceiptLineField, string>> = {};
    if (!row.name.trim()) issues.name = 'Укажите наименование';
    if (!row.unit.trim()) issues.unit = 'Укажите единицу';
    if (row.quantity === null) issues.quantity = 'Укажите количество';
    else if (!Number.isInteger(row.quantity)) issues.quantity = 'Количество — целое число';
    else if (row.quantity < 1) issues.quantity = 'Количество — не меньше единицы';
    else if (row.quantity > RECEIPT_MAX_QUANTITY)
      issues.quantity = 'Проверьте количество: слишком большое число';
    if (row.amount === null) issues.amount = 'Укажите сумму';
    else if (row.amount < 0) issues.amount = 'Сумма не может быть отрицательной';
    else if (row.amount > RECEIPT_MAX_AMOUNT) issues.amount = 'Слишком большая сумма';
    else if (!isKopecks(row.amount)) issues.amount = 'Не более 2 знаков после запятой';
    if (Object.keys(issues).length > 0) errors[row.key] = issues;
  }
  return errors;
}

/** Есть ли хоть один отказ по строкам: по нему форма решает, отправлять ли. */
export function hasLineErrors(errors: ReceiptLineErrors): boolean {
  return Object.keys(errors).length > 0;
}

const LINE_FIELDS: readonly ReceiptLineField[] = [
  'vehicleId',
  'name',
  'quantity',
  'unit',
  'amount',
];

/**
 * Отказы сервера — на те же ячейки (§7): пути вида `lines.2.vehicleId` он присылает намеренно,
 * чтобы форма подсветила ту самую строку, а не показала тост поверх таблицы. Так приходит и
 * единственная проверка, которой у формы быть не может: собственная это техника или арендная
 * (Р21) — справочник ownership'ов формы не спрашивает, решает сервер.
 *
 * Номер строки берётся из пути и переводится в ключ по тому же массиву, который уходил на сервер:
 * порядок строк — одно утверждение, и оно задаётся массивом.
 */
export function receiptLineErrorsFromApi(
  error: unknown,
  rows: readonly ReceiptLineRow[],
): ReceiptLineErrors {
  const fields = errorFields(error);
  if (!fields) return {};
  const errors: ReceiptLineErrors = {};
  for (const [path, message] of Object.entries(fields)) {
    const [prefix, index, field] = path.split('.');
    if (prefix !== 'lines' || index === undefined || field === undefined) continue;
    const row = rows[Number(index)];
    if (!row || !LINE_FIELDS.includes(field as ReceiptLineField)) continue;
    errors[row.key] = { ...errors[row.key], [field as ReceiptLineField]: message };
  }
  return errors;
}
