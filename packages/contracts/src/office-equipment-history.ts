import { z } from 'zod';
import { dateOnlySchema } from './common';
import type { OfficeEquipmentObjectRefDto, OfficeEquipmentState } from './office-equipment';
import type { RequestChangeDto } from './request-history';
import type { ServiceRequestStatus } from './service-requests';

// ── История единицы оргтехники одной лентой (план `office-equipment-mail-and-history-plan.md`,
//    Р75–Р79, Р81) ──
//
// До этого лента приходила двумя массивами — перемещения и заявки, — и портал сшивал их сам. Двух
// массивов хватало ровно до вопроса «а когда сменили отдел-владельца» и «до какого числа была
// гарантия на прошлый ремонт»: этих событий в ленте не было вовсе, а добавить их значило бы завести
// третий и четвёртый массив и сшивать четыре.
//
// Поэтому здесь один поток событий с курсором. Событие — размеченное объединение: у каждого вида
// свои поля, а общие (дата, кто, чем разграничивается порядок) — снаружи.

/**
 * Виды событий ленты. Порядок в перечне — не про сортировку: за неё отвечает `historySortRank`.
 *
 * `warranty` и `card_lifecycle` появились вместе с шестью источниками: гарантия отвечает на
 * «до какого числа обещали», жизненный цикл — на «откуда единица взялась». Без последнего лента
 * начинается с середины: первое перемещение без ответа, кто и когда завёл карточку.
 */
export const EQUIPMENT_HISTORY_KINDS = [
  'card_lifecycle',
  'movement',
  'service_request',
  'service_step',
  'card_change',
  'warranty',
] as const;
export type EquipmentHistoryKind = (typeof EQUIPMENT_HISTORY_KINDS)[number];

export const equipmentHistoryKindLabels: Record<EquipmentHistoryKind, string> = {
  card_lifecycle: 'Карточка',
  movement: 'Перемещение',
  service_request: 'Обслуживание',
  service_step: 'Ход заявки',
  card_change: 'Правка карточки',
  warranty: 'Гарантия',
};

export const equipmentHistoryKindColors: Record<EquipmentHistoryKind, string> = {
  card_lifecycle: 'default',
  movement: 'blue',
  service_request: 'geekblue',
  service_step: 'cyan',
  card_change: 'gold',
  warranty: 'purple',
};

/**
 * Порядок видов внутри одного дня. У половины источников времени нет вовсе (перемещение
 * происходит датой, истечение гарантии — тоже), и без фиксированного номера события одного дня
 * вставали бы в случайном порядке — при каждой выборке в новом.
 *
 * Смысл порядка: сначала то, что случилось с самой единицей (завели, перевезли), потом работа с
 * ней (заявка и её шаги), потом бумажные следствия (правка карточки, гарантия).
 */
export const historySortRank: Record<EquipmentHistoryKind, number> = {
  card_lifecycle: 1,
  movement: 2,
  service_request: 3,
  service_step: 4,
  card_change: 5,
  warranty: 6,
};

/** Общая часть любого события: чем оно датировано, кем сделано и чем разграничен порядок. */
interface EquipmentHistoryBase {
  /**
   * Идентификатор источника: строка журнала перемещений, заявка, запись аудита. У вычисляемых
   * событий (истечение гарантии) своей строки нет — там он совпадает с `sortId`.
   */
  id: string;
  /**
   * Ключ порядка: текст с пространством имён у **всех** видов (`movement:<uuid>`,
   * `warranty-expired:<источник>:<uuid>`). Отдельно от `id`, потому что часть событий вычисляется и
   * uuid у них нет; в SQL сравнивается тот же текстовый ключ, иначе выборка и слияние упорядочат
   * страницу по-разному.
   */
  sortId: string;
  /** Когда событие произошло — **день**: у перемещения и гарантии времени не бывает. */
  occurredOn: string;
  /** Когда его записали. У вычисляемых событий — полночь `occurredOn` в UTC (см. Р79). */
  recordedAt: string;
  /** Кто сделал; `null` — событие вычислено, а не сделано человеком. */
  actorName: string | null;
}

export interface EquipmentCardLifecycleEvent extends EquipmentHistoryBase {
  kind: 'card_lifecycle';
  action: 'created' | 'archived' | 'restored';
}

export interface EquipmentMovementEvent extends EquipmentHistoryBase {
  kind: 'movement';
  fromObject: OfficeEquipmentObjectRefDto;
  toObject: OfficeEquipmentObjectRefDto;
  fromLocation: string;
  toLocation: string;
  fromState: OfficeEquipmentState;
  toState: OfficeEquipmentState;
  toDepartmentName: string | null;
  reason: string;
  comment: string;
  serviceRequestId: string | null;
  serviceRequestNum: number | null;
}

export interface EquipmentServiceRequestEvent extends EquipmentHistoryBase {
  kind: 'service_request';
  requestId: string;
  displayNumber: string;
  status: ServiceRequestStatus;
  serviceName: string | null;
  totalAmount: number | null;
  description: string;
}

/** Ключевые шаги заявки: полный ход остаётся в её карточке (Р78). */
export interface EquipmentServiceStepEvent extends EquipmentHistoryBase {
  kind: 'service_step';
  requestId: string;
  displayNumber: string;
  toStatus: ServiceRequestStatus;
  comment: string;
}

export interface EquipmentCardChangeEvent extends EquipmentHistoryBase {
  kind: 'card_change';
  changes: RequestChangeDto[];
}

/**
 * Гарантия. Источников два: срок поставщика живёт в карточке и меняется её правкой, гарантия на
 * ремонт — снимком в аудите заявки (её собственное поле перезаписывается закрытием и обнуляется
 * возвратом на доработку, восстановить прошлое из него нельзя).
 */
export interface EquipmentWarrantyEvent extends EquipmentHistoryBase {
  kind: 'warranty';
  source: 'equipment' | 'item';
  action: 'set' | 'moved' | 'cleared' | 'expired';
  /** Что именно покрыто: модель у гарантии поставщика, название позиции — у ремонтной. */
  subject: string;
  from: string | null;
  until: string | null;
  requestId: string | null;
  displayNumber: string | null;
}

export type EquipmentHistoryEventDto =
  | EquipmentCardLifecycleEvent
  | EquipmentMovementEvent
  | EquipmentServiceRequestEvent
  | EquipmentServiceStepEvent
  | EquipmentCardChangeEvent
  | EquipmentWarrantyEvent;

/** Сколько событий отдаёт страница и сколько их бывает в ответе максимум (Р79). */
export const EQUIPMENT_HISTORY_PAGE_SIZE = 50;
export const EQUIPMENT_HISTORY_MAX_PAGE_SIZE = 200;

/**
 * Курсор ленты: кортеж `(occurredOn, sortRank, recordedAt, sortId)`. Разбирается схемой, а не
 * доверием: кривой или чужой курсор — 422 с текстом, а не 500 и не молчаливая первая страница.
 */
export const equipmentHistoryCursorSchema = z.object({
  occurredOn: dateOnlySchema,
  sortRank: z.number().int().min(1).max(99),
  recordedAt: z.string().datetime(),
  sortId: z.string().min(3).max(200),
});
export type EquipmentHistoryCursor = z.infer<typeof equipmentHistoryCursorSchema>;

/**
 * Курсор — четыре поля через `~`, а не base64: контракты живут и в браузере, и в сервере, а
 * `btoa`/`Buffer` есть только в одном из двух. Кодировать было бы нечего скрывать — в курсоре нет
 * ничего, кроме порядка, — зато читаемая строка видна глазами в логе и в адресной строке, когда
 * разбираются, почему страница вернула не то.
 *
 * Разделитель `~` не встречается ни в дате, ни во времени, ни в ключах порядка (латиница, цифры,
 * дефис, двоеточие).
 */
const CURSOR_SEPARATOR = '~';

export function encodeEquipmentHistoryCursor(cursor: EquipmentHistoryCursor): string {
  return [cursor.occurredOn, cursor.sortRank, cursor.recordedAt, cursor.sortId].join(
    CURSOR_SEPARATOR,
  );
}

/** Возвращает `null` на любом мусоре: разбирать его дальше нечего, ответ решает вызывающий. */
export function decodeEquipmentHistoryCursor(raw: string): EquipmentHistoryCursor | null {
  const parts = raw.split(CURSOR_SEPARATOR);
  if (parts.length !== 4) return null;
  const parsed = equipmentHistoryCursorSchema.safeParse({
    occurredOn: parts[0],
    sortRank: Number(parts[1]),
    recordedAt: parts[2],
    sortId: parts[3],
  });
  return parsed.success ? parsed.data : null;
}

export const equipmentHistoryQuerySchema = z.object({
  cursor: z.string().max(400).optional(),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(EQUIPMENT_HISTORY_MAX_PAGE_SIZE)
    .optional()
    .default(EQUIPMENT_HISTORY_PAGE_SIZE),
});
export type EquipmentHistoryQuery = z.infer<typeof equipmentHistoryQuerySchema>;

export interface EquipmentHistoryPageDto {
  items: EquipmentHistoryEventDto[];
  /** Курсор следующей страницы; `null` — дальше ничего нет. */
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * Отдана ли ремонтная часть. `false` означает «не положено видеть» (у смотрящего нет
   * `serviceRequests.read`), а не «ремонтов не было»: портал в этом случае не рисует и подпись
   * про обслуживание, чтобы пустая лента не читалась как «с техникой ничего не делали».
   */
  serviceVisible: boolean;
}

/** Строгий порядок ленты: даты по убыванию, вид и ключ — по возрастанию (Р79). */
export function compareEquipmentHistory(
  a: Pick<EquipmentHistoryEventDto, 'kind' | 'occurredOn' | 'recordedAt' | 'sortId'>,
  b: Pick<EquipmentHistoryEventDto, 'kind' | 'occurredOn' | 'recordedAt' | 'sortId'>,
): number {
  if (a.occurredOn !== b.occurredOn) return a.occurredOn < b.occurredOn ? 1 : -1;
  const rank = historySortRank[a.kind] - historySortRank[b.kind];
  if (rank !== 0) return rank;
  if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? 1 : -1;
  return a.sortId < b.sortId ? -1 : a.sortId > b.sortId ? 1 : 0;
}

/** Событие строго «после» курсора в смысле того же порядка. */
export function isAfterEquipmentHistoryCursor(
  event: Pick<EquipmentHistoryEventDto, 'kind' | 'occurredOn' | 'recordedAt' | 'sortId'>,
  cursor: EquipmentHistoryCursor,
): boolean {
  return (
    compareEquipmentHistory(event, {
      kind: kindOfRank(cursor.sortRank),
      occurredOn: cursor.occurredOn,
      recordedAt: cursor.recordedAt,
      sortId: cursor.sortId,
    }) > 0
  );
}

/** Вид по номеру порядка: курсор хранит номер, а сравнение работает с видом. */
function kindOfRank(rank: number): EquipmentHistoryKind {
  const found = EQUIPMENT_HISTORY_KINDS.find((kind) => historySortRank[kind] === rank);
  // Номер вне перечня схема не пропускает; значение по умолчанию — защита от курсора, собранного в
  // обход контракта.
  return found ?? 'card_lifecycle';
}

export function cursorOfEvent(event: EquipmentHistoryEventDto): EquipmentHistoryCursor {
  return {
    occurredOn: event.occurredOn,
    sortRank: historySortRank[event.kind],
    recordedAt: event.recordedAt,
    sortId: event.sortId,
  };
}

/** Строка выгрузки: та же лента, но словами — «что произошло» одной ячейкой (Р80). */
export const EQUIPMENT_HISTORY_EXPORT_LIMIT = 5000;
