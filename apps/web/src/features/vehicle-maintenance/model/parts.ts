import type { AutoPartDto, MaintenanceBody, VehicleMaintenanceDto } from '@technic/contracts';

/**
 * Строки расхода автозапчастей в форме акта (план `docs/auto-parts-plan.md`, Р5, Р7, Р20, Р24).
 *
 * Расчёта склада здесь нет ни одного — его считает сервер под блокировкой, и второй формулы на
 * портале быть не должно. Здесь живёт то, что человек обязан увидеть **до** нажатия «Сохранить»:
 * разница «стало − было» словами, нехватка остатка и акт, выписанный раньше заведения позиции.
 * Складское движение необратимо (журнал неизменяем, Р3), и узнавать о нём из ленты постфактум
 * поздно.
 *
 * Отдельным модулем, а не внутри блока: те же три правила читает и предупреждение над блоком, и
 * подпись под ним, и проверка перед отправкой — три копии разошлись бы при первой правке.
 */

/** Строка формы: позиция ещё может быть не выбрана, количество — не набрано. */
export interface PartRow {
  /** Ключ строки формы, а не идентификатор чего-либо: строку заводят и убирают до сохранения. */
  key: string;
  autoPartId: string | null;
  quantity: number | null;
  note: string;
}

let sequence = 0;

export function newPartRow(): PartRow {
  sequence += 1;
  return { key: `part-${sequence}`, autoPartId: null, quantity: 1, note: '' };
}

/**
 * Строки правимого акта. Ключом берётся идентификатор строки акта: он переживает перерисовку, а
 * порядок строк задаёт сервер.
 */
export function rowsFromRecord(record: VehicleMaintenanceDto | null): PartRow[] {
  return (record?.parts ?? []).map((part) => ({
    key: part.id,
    autoPartId: part.autoPartId,
    quantity: part.quantity,
    note: part.note,
  }));
}

/**
 * Что было списано актом до правки: «сколько этой позиции уже стоит в акте». Из этого числа и
 * считается разница, а не из нуля: правка «было 3, стало 1» — это возврат двух штук, а не
 * списание одной (Р5).
 */
export function partsBefore(record: VehicleMaintenanceDto | null): Map<string, number> {
  return new Map((record?.parts ?? []).map((part) => [part.autoPartId, part.quantity]));
}

/** Набор строк для тела запроса. Пустые строки не отправляются — их отсеивает `partsIssue`. */
export function rowsToPayload(rows: readonly PartRow[]): NonNullable<MaintenanceBody['parts']> {
  return rows
    .filter((row) => row.autoPartId !== null && row.quantity !== null)
    .map((row) => ({
      autoPartId: row.autoPartId!,
      quantity: row.quantity!,
      note: row.note.trim(),
    }));
}

/**
 * Что мешает отправить набор — одним текстом, который показывают человеку.
 *
 * Пустая строка не отбрасывается молча: её завели нажатием «Добавить позицию», и тихо потерянная
 * строка читалась бы как «портал не списал деталь, которую я выбрал». Уборка строки — крестик, и
 * это единственный способ отказаться от неё.
 *
 * Дубль ловится здесь же, а не только схемой на сервере: пара «акт + позиция» уникальна, и из двух
 * строк по одной детали разницу нельзя посчитать однозначно (Р5).
 */
export function partsIssue(rows: readonly PartRow[]): string | null {
  if (rows.some((row) => row.autoPartId === null))
    return 'Выберите позицию в строке автозапчастей или уберите строку крестиком';
  if (rows.some((row) => row.quantity === null || row.quantity < 1))
    return 'Количество в строке автозапчастей — целое число не меньше единицы';
  const ids = rows.map((row) => row.autoPartId);
  if (new Set(ids).size !== ids.length)
    return 'Позиция указана в акте дважды — сложите количество в одну строку';
  return null;
}

/** Движение склада по одной позиции: было столько, станет столько. */
export interface PartMove {
  autoPartId: string;
  name: string;
  unit: string;
  from: number;
  to: number;
}

/**
 * Что станет с остатками после сохранения **всего акта** (Р5). Считается по разнице «стало − было»
 * ровно так же, как её посчитает сервер, и включает возвраты: строка, у которой количество
 * уменьшили, показывает «12 → 14», и это правда — деталь вернётся на склад.
 *
 * Позиции, карточка которой ещё не пришла, в итоге нет: показать «? → ?» хуже, чем не показать
 * ничего — человек прочитал бы прочерк как «движения не будет».
 */
export function partMoves(
  rows: readonly PartRow[],
  before: Map<string, number>,
  cards: Map<string, AutoPartDto>,
): PartMove[] {
  const wanted = new Map<string, number>();
  for (const row of rows) {
    if (row.autoPartId === null || row.quantity === null) continue;
    wanted.set(row.autoPartId, row.quantity);
  }
  const moves: PartMove[] = [];
  for (const id of new Set([...before.keys(), ...wanted.keys()])) {
    const delta = (wanted.get(id) ?? 0) - (before.get(id) ?? 0);
    const card = cards.get(id);
    if (delta === 0 || !card) continue;
    moves.push({
      autoPartId: id,
      name: card.name,
      unit: card.unit,
      from: card.quantity,
      to: card.quantity - delta,
    });
  }
  return moves;
}

/** «Фильтр масляный 12 → 11, масло моторное 24 → 16» — итог будущей записи словами. */
export function movesText(moves: readonly PartMove[]): string {
  return moves.map((m) => `${m.name} ${m.from} → ${m.to}`).join(', ');
}

/**
 * Сколько не хватает на складе под эту строку, или `null` — хватает.
 *
 * Считается по разнице, а не по количеству строки: «было 1, стало 6» берёт со склада пять, а не
 * шесть. Это предупреждение, а не запрет: остаток проверяется под блокировкой в момент записи, и
 * «проверенное формой» число к этому моменту уже устареет — отказ даёт сервер (Р7).
 */
export function rowShortage(
  row: PartRow,
  before: Map<string, number>,
  card: AutoPartDto | undefined,
): number | null {
  if (!card || row.autoPartId === null || row.quantity === null) return null;
  const delta = row.quantity - (before.get(row.autoPartId) ?? 0);
  return delta > card.quantity ? delta - card.quantity : null;
}

/**
 * Строка увеличивает списание по **погашенной** позиции — 409 сервера ещё до отправки (Р24).
 *
 * Правило считается по разнице, а не по наличию строки: у погашенной позиции количество можно
 * уменьшить и строку снять — это возврат на склад, и запрещать его незачем. Нельзя ровно одно:
 * списать по ней больше прежнего.
 */
export function rowRaisesInactive(
  row: PartRow,
  before: Map<string, number>,
  card: AutoPartDto | undefined,
): boolean {
  if (!card || card.isActive || row.autoPartId === null || row.quantity === null) return false;
  return row.quantity - (before.get(row.autoPartId) ?? 0) > 0;
}

/**
 * Позиции, заведённые позже даты акта (Р20). Открывающий остаток вводят числом «сколько лежит
 * сейчас», и в нём уже учтено всё, что установлено раньше, — значит строка в старом акте может
 * списать одну и ту же деталь дважды.
 *
 * Портал предупреждает, а не запрещает: заказчик прямо выбрал свободу ввода задним числом, и
 * запрет заставил бы механика вести часть расхода мимо портала.
 */
export function backdatedParts(
  rows: readonly PartRow[],
  performedOn: string | null,
  cards: Map<string, AutoPartDto>,
): AutoPartDto[] {
  if (!performedOn) return [];
  const seen = new Set<string>();
  const late: AutoPartDto[] = [];
  for (const row of rows) {
    if (row.autoPartId === null || seen.has(row.autoPartId)) continue;
    seen.add(row.autoPartId);
    const card = cards.get(row.autoPartId);
    // Дата заведения приходит меткой времени, дата акта — днём: сравниваются десять первых знаков,
    // то есть день с днём. Акт того же дня, что и заведение позиции, вопросов не вызывает.
    if (card && card.createdAt.slice(0, 10) > performedOn) late.push(card);
  }
  return late;
}
