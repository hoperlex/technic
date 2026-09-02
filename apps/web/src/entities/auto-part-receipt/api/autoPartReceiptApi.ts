import type {
  AutoPartReceiptDto,
  AutoPartReceiptListItemDto,
  AutoPartReceiptsSummaryDto,
  CreateReceiptBody,
  ReceiptDeletionMarkInput,
  UpdateReceiptBody,
  VehiclePartsSpendDto,
  VehiclePartsSpendSnapshotDto,
} from '@technic/contracts';
import { apiFetch, type ListResult, type Query } from '@shared/api';

/**
 * Клиент чеков на автозапчасти (план `docs/auto-part-receipts-plan.md`, §7): десять ручек одного
 * префикса — лента, сводка, карточка, четыре мутации и два ответа про машину.
 *
 * Формы ответов сюда не переписываются: они описаны в `@technic/contracts` (§6), и сервер отдаёт
 * ровно их. Своего представления денег и своего расчёта итога здесь нет вовсе — `total` и
 * `unitPrice` считает сервер (Р9, Р11), и второй формулы в портале быть не должно.
 */

/** Префикс модуля: своя ветка, а не хвост склада, который эти чеки заменяют (Р1). */
const BASE = '/auto-part-receipts';

/**
 * Ответ пакетного снимка сумм (Р14) — единственный тип слайса не из контрактов: обёртку сервер
 * собирает прямо в ручке, как и у соседнего снимка обслуживания (`MaintenanceSnapshotDto`).
 *
 * День среза приходит в ответе, потому что его мог посчитать сервер: подпись колонки обязана
 * называть тот день, по которому шёл отбор, а не тот, что показали часы браузера.
 *
 * Машины, по которым чеков нет вовсе, в ответе не приходят: колонка рисует им прочерк, а не «0 ₽»
 * (Р14) — ноль был бы утверждением «на машину не тратили», а это другое знание.
 */
export interface VehiclePartsSpendSnapshotResult {
  to: string;
  items: VehiclePartsSpendSnapshotDto[];
}

export const autoPartReceiptApi = {
  /** Лента вкладки: период по дате чека, машина, поиск, «помеченные к удалению», страницы (§8). */
  list: (query: Query) => apiFetch<ListResult<AutoPartReceiptListItemDto>>(BASE, { query }),
  /**
   * Четыре числа под фильтрами. Отбор у неё тот же, что у ленты, но без страниц и порядка: сводка
   * отвечает про то, что видно, иначе «Сумма» над отфильтрованным списком называла бы чужое число.
   */
  summary: (query: Query) => apiFetch<AutoPartReceiptsSummaryDto>(`${BASE}/summary`, { query }),
  /** Карточка: шапка, строки, сканы, оба итога и пометка. Строки приходят только ею (§6). */
  get: (id: string) => apiFetch<AutoPartReceiptDto>(`${BASE}/${id}`),
  /** Завести чек целиком — шапка, строки и сканы одним телом (Р12): формы «по частям» у чека нет. */
  create: (body: CreateReceiptBody) => apiFetch<AutoPartReceiptDto>(BASE, { method: 'POST', body }),
  /**
   * Правка целиком с версией, которую видел правящий (Р12): 409 при расхождении. Версия в теле, а
   * не в адресе, — PATCH и так идёт телом, и разносить два обязательных значения незачем.
   */
  update: (id: string, body: UpdateReceiptBody) =>
    apiFetch<AutoPartReceiptDto>(`${BASE}/${id}`, { method: 'PATCH', body }),
  /**
   * Пометить на удаление: причина и версия (Р12). Отдельная ручка, а не поле правки, — правка
   * пометку не трогает вовсе, и поле внутри общей формы означало бы обратное.
   *
   * В ответе — сам чек: карточка после пометки показывает полосу «Помечен к удалению» и работает
   * дальше, а следующая мутация спрашивает уже новую версию.
   */
  markDeletion: (id: string, body: ReceiptDeletionMarkInput) =>
    apiFetch<AutoPartReceiptDto>(`${BASE}/${id}/deletion-mark`, { method: 'POST', body }),
  /**
   * Снять пометку — версией в адресе: тела у DELETE нет (Р12). Без версии можно было бы снять
   * пометку, поставленную уже после того, как экран открыли, то есть ответить не на ту просьбу.
   */
  unmarkDeletion: (id: string, version: number) =>
    apiFetch<AutoPartReceiptDto>(`${BASE}/${id}/deletion-mark`, {
      method: 'DELETE',
      query: { version },
    }),
  /**
   * Удалить чек — только администратор (`autoParts.delete`, Р4а), версией в адресе. Ответ пустой:
   * после удаления от чека в портале не остаётся ничего, кроме следа в аудите (Р19).
   */
  remove: (id: string, version: number) =>
    apiFetch<{ ok: true }>(`${BASE}/${id}`, { method: 'DELETE', query: { version } }),
  /**
   * Суммы пакетом на видимую страницу «Техники» (Р14). Запросом из строки это не делается по той
   * же причине, что и колонка «ТО»: полсотни ответов ради одной колонки открывали бы срез дня
   * заметно дольше, чем он открывается сейчас.
   *
   * `ids` — машины **строкой через запятую**, а не повтором параметра: повтор Fastify разбирает в
   * массив, только пока значений больше одного, и страница с единственной машиной получила бы
   * строку там, где схема ждёт список (§6). `to` — день среза; без него сервер берёт сегодняшний
   * московский день.
   */
  vehiclesSnapshot: (query: Query) =>
    apiFetch<VehiclePartsSpendSnapshotResult>(`${BASE}/vehicles/snapshot`, { query }),
  /**
   * Окно «Запчасти машины» (Р15): итог за период, итог за всё время и строки с реквизитами чеков.
   * Один ответ на оба вопроса карточки машины — вторым запросом они стали бы парой снимков, снятых
   * в разные моменты (§6).
   */
  vehicleSpend: (vehicleId: string, query: Query = {}) =>
    apiFetch<VehiclePartsSpendDto>(`${BASE}/vehicles/${vehicleId}`, { query }),
};
