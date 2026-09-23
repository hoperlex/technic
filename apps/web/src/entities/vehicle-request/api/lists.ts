import type {
  ListResult,
  VehicleFeedListDto,
  VehicleOnSiteListDto,
  VehicleOnSiteSummaryDto,
  VehicleRequestDto,
  VehicleRequestHistorySummaryDto,
  VehicleRequestSummaryDto,
} from '@technic/contracts';
import { apiFetch, type Query } from '@shared/api';

/**
 * Витрины раздела «Заказ техники»: список заявок, лента раздела, журнал закрытых, срез «На объекте»
 * и сводка к каждому из них.
 *
 * Собраны по способу обращения, а не по вкладкам, которым служат: все они только читают, все
 * сужаются строкой запроса и ни одна не знает о версии заявки — ни рукопожатий, ни отпечатков тут
 * нет вовсе. Ручки, которые пишут, лежат в соседних модулях слайса: по этой границе и видно, где у
 * заказа есть порядок обращения, а где его нет и быть не должно.
 *
 * Сводки стоят своими ручками, а не полем в ответе списка: их считают по всему отбору, а список
 * отдаётся страницами — одним телом они разошлись бы на первом же листании.
 */
export const vehicleRequestLists = {
  list: (q: Query) => apiFetch<ListResult<VehicleRequestDto>>('/vehicle-requests', { query: q }),
  /**
   * Лента раздела: заказы ТС и недельные заявки одним списком (ADR 0085 переехал в общий список).
   *
   * Отдельный маршрут, а не флаг у `list`: тем списком пользуются архив и подбор заявок в рейс, и
   * подмешивать туда документы, которые в рейс не ставятся, нельзя. Строка ленты размечена видом,
   * поэтому таблица разбирает её ветками, а не гадает по пустым полям.
   */
  feed: (q: Query) => apiFetch<VehicleFeedListDto>('/vehicle-requests/feed', { query: q }),
  /** Счётчики заявок по статусам — сводка над списком; сужается объектом и типом заявки. */
  summary: (q: Query) =>
    apiFetch<VehicleRequestSummaryDto>('/vehicle-requests/summary', { query: q }),
  /**
   * Журнал закрытых заявок — вкладка «История» (ADR 0029): «Выполнена» и «Отменена» с фактом
   * выполнения. Отдельный маршрут: свой фильтр по арендодателю и свой порядок (по сроку работ).
   */
  historyList: (q: Query) =>
    apiFetch<ListResult<VehicleRequestDto>>('/vehicle-requests/history', { query: q }),
  /** Итог журнала по тем же фильтрам: сколько закрыто, чем закончилось и на какую сумму. */
  historySummary: (q: Query) =>
    apiFetch<VehicleRequestHistorySummaryDto>('/vehicle-requests/history/summary', { query: q }),
  /**
   * Техника на объектах прямо сейчас — вкладка «На объекте» (ADR 0036). День среза считает сервер
   * и возвращает в `onDate`: от него, а не от часов браузера, считаются подписи присутствия.
   */
  onSite: (q: Query) => apiFetch<VehicleOnSiteListDto>('/vehicle-requests/on-site', { query: q }),
  /** Итог среза по тем же фильтрам: сколько машин, на скольких объектах, кто вышел и кто уезжает. */
  onSiteSummary: (q: Query) =>
    apiFetch<VehicleOnSiteSummaryDto>('/vehicle-requests/on-site/summary', { query: q }),
};
