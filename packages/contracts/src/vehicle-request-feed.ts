import { z } from 'zod';
import { dateOnlySchema } from './common';
import {
  parseVehicleRequestNumberSearch,
  vehicleRequestListQuerySchema,
  type VehicleRequestDto,
} from './vehicle-requests';
import {
  parseWeeklyRequestNumberSearch,
  type WeeklyVehicleRequestDto,
} from './weekly-vehicle-requests';

/**
 * Лента раздела «Заказ автотехники»: заказы ТС и недельные заявки одним списком.
 *
 * Недельная заявка перестала быть отдельной вкладкой — она документ-основание над заказами
 * (ADR 0085), и держать её в своём разделе значило множить сущности там, где человек решает одну
 * задачу: «что у нас с техникой». Но объединение — это **представление**, а не общая таблица:
 * `vehicle_request_type` третьим значением не расширяется, потому что заявка ТС одномашинна, её
 * ЭСМ-2 держится частичным `UNIQUE (source_request_id, period_from)`, срок у каждой единицы недели
 * свой, а досрочное завершение имеет PK по заявке. Поэтому вид документа живёт здесь, в параметре
 * ленты, а в базе по-прежнему две разные сущности.
 */

/** Вид документа в ленте. Дискриминатор строки и одновременно фильтр списка. */
export const FEED_KINDS = ['order', 'weekly'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export const feedKindSchema = z.enum(FEED_KINDS);

export const feedKindLabels: Record<FeedKind, string> = {
  order: 'Заказ ТС',
  weekly: 'Недельная заявка',
};

/**
 * Строка ленты — размеченное объединение, а не общий плоский DTO с наполовину пустыми полями.
 * Обе карточки уже собраны своими сборщиками, и «свести их к одному виду» означало бы третий
 * формат, который расходится с обоими при первой же правке любой из сущностей.
 */
export type VehicleFeedRow =
  { kind: 'order'; order: VehicleRequestDto } | { kind: 'weekly'; weekly: WeeklyVehicleRequestDto };

export interface VehicleFeedListDto {
  items: VehicleFeedRow[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * Сколько недельных заявок ждёт визы в области учётки — цифра, ради которой руководитель
   * строительства открывал отдельную вкладку. Считается по площадкам, поэтому у арендодателя её
   * не бывает вовсе: визу он не ставит, а «сколько недель ждёт подписи» — счёт площадки.
   */
  weeklyPendingCount: number;
}

/**
 * Запрос ленты: те же фильтры, что у списка заказов, плюс два своих.
 *
 * `kind` — вид документа, а не тип заявки: в интерфейсе это один селект («Техника на объект»,
 * «Грузоперевозка», «Недельная заявка»), но в запрос уходит либо `requestType`, либо `kind`.
 * Смешивать их в одном параметре нельзя — `requestType` едет и в тело заявки, где третьего
 * значения не существует.
 *
 * `weekStart` спрашивают только у недельных: у заказа недели нет, и заданный фильтр отсекает их
 * целиком — как и любой другой фильтр, которому у второй сущности нет соответствия.
 */
export const vehicleFeedQuerySchema = vehicleRequestListQuerySchema.extend({
  kind: feedKindSchema.optional(),
  weekStart: dateOnlySchema.optional(),
});
export type VehicleFeedQuery = z.infer<typeof vehicleFeedQuerySchema>;

/**
 * Разбор поиска по номеру: «ТС-341» ищет заказ, «НЗ-12» — недельную заявку, голое число — заказ.
 *
 * Номера — две независимые последовательности, и одного поля `num` на ленту не хватает: «12»
 * означает и ТС-12, и НЗ-12. Поэтому ввод отвечает **парой** «вид документа + номер», а вид без
 * префикса считается заказом: так набирают в девяти случаях из десяти, а недельную заявку и в
 * разговоре называют по префиксу.
 *
 * Чего разбор намеренно не умеет: искать неделю по номеру заказа в её составе. Ответ «ТС-341 стоит
 * в НЗ-15» сам по себе есть выдача состава, и для арендодателя его пришлось бы сужать по видимым
 * строкам — то есть держать условие видимости во втором месте и следить, чтобы оно не разошлось с
 * первым. Неделю, в которой стоит заказ, показывает карточка самого заказа обратными ссылками
 * (ADR 0085 §17) — тому, кто этот заказ и так видит.
 */
export function parseFeedNumberSearch(input: string): { kind: FeedKind; num: number } | undefined {
  const weekly = parseWeeklyRequestNumberSearch(input);
  if (weekly !== undefined && /нз/i.test(input)) return { kind: 'weekly', num: weekly };
  const order = parseVehicleRequestNumberSearch(input);
  return order === undefined ? undefined : { kind: 'order', num: order };
}

/**
 * Ключи сортировки, общие для обоих видов. Остальные столбцы у недельной заявки пусты — они
 * сортируются с `NULLS LAST`, и это не «недостаток данных», а честный ответ: позиции
 * классификатора у недельного документа нет.
 *
 * Номера здесь нет намеренно: «НЗ-12» и «ТС-12» не лежат на одной числовой оси, и сортировка по
 * номеру в ленте идёт парой «вид, номер» — сначала заказы, потом недели, каждый по своему счёту.
 */
export const FEED_COMMON_SORT_FIELDS = ['createdAt', 'objectName', 'term', 'approval'] as const;
export type FeedCommonSortField = (typeof FEED_COMMON_SORT_FIELDS)[number];

/**
 * Применим ли фильтр к недельным заявкам. Правило одно и объяснимое: фильтр, которому у недельного
 * документа нет соответствия, исключает недельные строки целиком — а не проходит мимо, оставляя их
 * в выдаче. Иначе «показать заявки в статусе „В работе“» возвращало бы вперемешку документы, у
 * которых такого статуса не бывает вовсе.
 */
export function weeklyRowsExcludedBy(q: VehicleFeedQuery): boolean {
  return (
    q.kind === 'order' ||
    q.requestType !== undefined ||
    q.status !== undefined ||
    q.departmentId !== undefined ||
    q.vehicleTypeId !== undefined ||
    q.vehicleCategoryId !== undefined ||
    // Назначенной машины у недельного документа не бывает вовсе: технику ставят на заказы,
    // созданные из его состава, а сам он остаётся планом недели (ADR 0085).
    q.vehicleId !== undefined ||
    // Номер спрашивают парой «вид документа + номер» (`parseFeedNumberSearch`), и одно число без
    // вида не значит ничего: «12» — это и ТС-12, и НЗ-12. Поэтому номер исключает недельные
    // строки, пока ищут **не** их: «ТС-341» недельные заявки не ищет вовсе, а «НЗ-12» приходит
    // вместе с `kind = 'weekly'` и адресует номер уже недельной последовательности.
    (q.num !== undefined && q.kind !== 'weekly') ||
    q.archive === 'only'
  );
}

/** Оставлены ли в ленте только недельные строки: выбран их вид либо задана неделя. */
export function onlyWeeklyRows(q: VehicleFeedQuery): boolean {
  return q.kind === 'weekly' || q.weekStart !== undefined;
}
