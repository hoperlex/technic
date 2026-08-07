import type { CompleteServiceRequestInput, ServiceRequestItemDto } from '@technic/contracts';

/**
 * Факт закрытия по строке сметы (Р12). План и факт — разные величины: согласовали три ролика,
 * поставили два, тормозная площадка не понадобилась вовсе. Строка остаётся в смете, но
 * выполненной не считается — и гарантии на неё не появляется.
 */
export interface FactRow {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number;
  performed: boolean;
  /** Фактическое количество; больше согласованного не бывает — это удорожание (Р12). */
  actualQuantity: number | null;
  /** Дата гарантии из талона (`YYYY-MM-DD`); пусто — сервер посчитает её от даты выполнения. */
  warrantyUntil: string | null;
  warrantyMonths: number | null;
}

/** Умолчание закрытия — «сделали как договорились»: снимают отметки с того, что не понадобилось. */
export function factRowsFrom(items: readonly ServiceRequestItemDto[]): FactRow[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    performed: item.performed ?? true,
    actualQuantity: item.actualQuantity ?? item.quantity,
    warrantyUntil: item.warrantyUntil,
    warrantyMonths: item.warrantyMonths,
  }));
}

/** Сумма выполненного: невыполненная строка в итог не входит вовсе. */
export function factRowsAmount(rows: readonly FactRow[]): number {
  return rows.reduce(
    (sum, row) => (row.performed ? sum + (row.actualQuantity ?? 0) * row.unitPrice : sum),
    0,
  );
}

/**
 * Итог по акту: выполненное плюс корректировка. Считается на глазах и **не вводится руками** —
 * иначе сумма строк и итог разошлись бы молча, а спорить по акту пришлось бы с числом, которого
 * никто не проверял. Тем же порядком его считает сервер, здесь — только показ.
 */
export function factTotal(rows: readonly FactRow[], adjustment: number | null): number {
  return factRowsAmount(rows) + (adjustment ?? 0);
}

/**
 * Что мешает закрыть работы. Проверки повторяют серверные (`completeServiceRequestSchema` и
 * инвариант Р12) — не чтобы заменить их, а чтобы исполнитель узнал о промахе до нажатия.
 */
export function factIssue(
  rows: readonly FactRow[],
  adjustment: number | null,
  adjustmentReason: string,
  estimatedTotal: number | null,
): string | null {
  for (const row of rows) {
    if (!row.performed) continue;
    if (!row.actualQuantity || row.actualQuantity <= 0) {
      return `Укажите фактическое количество: ${row.name}`;
    }
    if (row.actualQuantity > row.quantity) {
      return `Факт больше согласованного (${row.name}) — это удорожание: переоткройте смету`;
    }
  }
  if (adjustment != null) {
    if (adjustment >= 0) return 'Скидка по акту — отрицательная сумма';
    if (!adjustmentReason.trim()) return 'Укажите причину скидки: без неё её не примут';
  }
  // Страховка инварианта, а не рабочая проверка: поднять цену или объём при закрытии нечем, и
  // если итог всё же вышел больше — на экране ошибка, которую сервер отклонит 422.
  if (estimatedTotal != null && factTotal(rows, adjustment) > estimatedTotal) {
    return 'Итог больше согласованной сметы — так закрыть нельзя, переоткройте смету';
  }
  return null;
}

/** Тело закрытия: отметки по строкам. Итога здесь нет намеренно — его считает сервер (Р12). */
export function factToPayload(rows: readonly FactRow[]): CompleteServiceRequestInput['items'] {
  return rows.map((row) => ({
    id: row.id,
    performed: row.performed,
    // У невыполненной строки фактического количества не бывает: она не поставлена вовсе.
    actualQuantity: row.performed ? row.actualQuantity : null,
    warrantyUntil: row.performed ? row.warrantyUntil : null,
  }));
}
