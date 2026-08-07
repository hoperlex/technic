import type {
  ServiceEstimateItemInput,
  ServiceItemKind,
  ServiceRequestItemDto,
} from '@technic/contracts';

/**
 * Строка сметы в редакторе. Своя от DTO: у набираемой строки ещё нет идентификатора (смета
 * уходит на сервер целиком и пересоздаётся), зато нужен ключ для React, а количество и цена
 * живут «наполовину введёнными» — поле `InputNumber` отдаёт `null`, пока в нём пусто, и
 * подменять это нулём нельзя: «0» и «не введено» отличаются как раз тем, что второе — ошибка.
 */
export interface EstimateRow {
  key: string;
  kind: ServiceItemKind;
  name: string;
  quantity: number | null;
  unitPrice: number | null;
  /** Обещанный срок гарантии в месяцах; дату от него считает сервер при закрытии работ. */
  warrantyMonths: number | null;
}

let sequence = 0;

export function newEstimateRow(kind: ServiceItemKind): EstimateRow {
  sequence += 1;
  return {
    key: `row-${sequence}`,
    kind,
    name: '',
    // Количество почти всегда единица, цена — нет: подставленный ноль читался бы как «бесплатно».
    quantity: 1,
    unitPrice: null,
    warrantyMonths: null,
  };
}

/** Строки уже заведённой сметы: черновик ревизии, которую исполнитель дописывает. */
export function rowsFromItems(items: readonly ServiceRequestItemDto[]): EstimateRow[] {
  return items.map((item) => {
    sequence += 1;
    return {
      key: `item-${item.id}-${sequence}`,
      kind: item.kind,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      warrantyMonths: item.warrantyMonths,
    };
  });
}

/** Сумма строки: количество × цена. Считается на глазах — итог сметы виден до её отправки. */
export function rowAmount(row: EstimateRow): number {
  return (row.quantity ?? 0) * (row.unitPrice ?? 0);
}

export function rowsTotal(rows: readonly EstimateRow[]): number {
  return rows.reduce((sum, row) => sum + rowAmount(row), 0);
}

/**
 * Чего не хватает строкам. Одним сообщением, а не подсветкой каждого поля: строк в смете
 * немного, а список ошибок под кнопкой читается целиком.
 *
 * Проверки те же, что у схемы контрактов (`serviceEstimateItemSchema`): наименование от двух
 * символов, количество больше нуля, цена не отрицательна. Здесь они стоят, чтобы человек узнал
 * о пропуске до отправки, а не по 400 в ответ.
 */
export function estimateIssue(rows: readonly EstimateRow[]): string | null {
  if (rows.length === 0) return 'Добавьте хотя бы одну строку';
  for (const row of rows) {
    if (row.name.trim().length < 2) return 'У каждой строки должно быть наименование';
    if (!row.quantity || row.quantity <= 0) return 'Количество в каждой строке больше нуля';
    if (row.unitPrice == null || row.unitPrice < 0) return 'Укажите цену в каждой строке';
  }
  return null;
}

/** Тело `PUT /estimate`: состав целиком — смета документ, и по строке её не правят. */
export function rowsToPayload(rows: readonly EstimateRow[]): ServiceEstimateItemInput[] {
  return rows.map((row) => ({
    kind: row.kind,
    name: row.name.trim(),
    quantity: row.quantity ?? 1,
    unitPrice: row.unitPrice ?? 0,
    warrantyMonths: row.warrantyMonths,
  }));
}

/**
 * Изменился ли состав по сравнению с тем, что лежит на сервере. Не косметика: неизменённую смету
 * не нужно перезаписывать перед предъявлением — лишний `PUT` поднял бы версию заявки и отобрал
 * бы её у того, кто в этот момент смотрит карточку.
 */
export function rowsChanged(
  rows: readonly EstimateRow[],
  items: readonly ServiceRequestItemDto[],
): boolean {
  if (rows.length !== items.length) return true;
  return rows.some((row, i) => {
    const item = items[i]!;
    return (
      row.kind !== item.kind ||
      row.name.trim() !== item.name ||
      (row.quantity ?? 0) !== item.quantity ||
      (row.unitPrice ?? 0) !== item.unitPrice ||
      (row.warrantyMonths ?? null) !== item.warrantyMonths
    );
  });
}
