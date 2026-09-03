import type {
  ChangeMechRequestStatusInput,
  CreateMechRequestInput,
  ExtendMechRequestInput,
  IssueMechRequestInput,
  MechRequestDto,
  MechRequestHistorySummaryDto,
  MechRequestSummaryDto,
  RequestHistoryEntryDto,
  RevokeMechIssueInput,
  UpdateMechDealInput,
  UpdateMechRequestInput,
} from '@technic/contracts';
import {
  apiDownload,
  apiFetch,
  createGetApi,
  createListApi,
  createWriteApi,
  type ListResult,
  type Query,
} from '@shared/api';

const PATH = '/mech-requests';

/**
 * Заявка на аренду малой механизации (план `docs/mechanization-module-plan.md`).
 *
 * Список, карточка и запись собраны фабриками — они у всех ресурсов одинаковы. Дальше начинается
 * своё, и различия эти содержательные, а не оформительские: у модуля восемь действий над уже
 * существующей строкой, и каждое из них **обязано нести версию** (Р21). Версия — не украшение
 * тела запроса: она отвечает на вопрос, на который замок `FOR UPDATE` не отвечает вовсе, —
 * «карточку открыли час назад, за это время её поменял кто-то ещё», — и сервер разводит 409
 * («перечитайте») с 422 («правило запрещает») ровно по ней.
 *
 * Отсюда и то, что у удаляющих ручек версия уходит **телом** `DELETE`, а не строкой запроса:
 * после них строки нет, увеличивать нечего, и CAS выражается условием самого `DELETE` с проверкой
 * числа удалённых строк. Параметром адреса версия читалась бы как фильтр выборки, а она — условие
 * записи.
 */
export const mechRequestsApi = {
  ...createListApi<MechRequestDto>(PATH),
  ...createGetApi<MechRequestDto>(PATH),
  ...createWriteApi<MechRequestDto, CreateMechRequestInput, UpdateMechRequestInput>(PATH),

  /**
   * Удаление: «Новая» стирается физически вместе с вложениями, прочие уходят в архив (ADR 0070).
   * Что именно случилось, говорит `mode` ответа — портал не решает это сам: барьер состояния
   * (`mechDeleteScope`) считает то же самое до нажатия, но окончательный ответ у сервера, и
   * подпись тоста берётся из него.
   */
  remove: (id: string, version: number) =>
    apiFetch<{ ok: boolean; mode: 'hard' | 'archive' }>(`${PATH}/${id}`, {
      method: 'DELETE',
      // Версия параметром адреса, а не телом: тело у `DELETE` половина посредников выбрасывает, и
      // так же её шлёт единственный сосед с версионным удалением — акт обслуживания
      // (`vehicleMaintenanceApi.remove`). Фильтром выборки это не читается: у ручки нет выборки.
      query: { version },
    }),

  /** Возврат из архива (ADR 0070) и удаление насовсем (ADR 0060) — слова портала, не HTTP. */
  restore: (id: string, version: number) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/restore`, { method: 'POST', body: { version } }),
  purge: (id: string, version: number) =>
    apiFetch<{ ok: boolean }>(`${PATH}/${id}/purge`, { method: 'DELETE', query: { version } }),

  /**
   * Смена статуса. Договорённость приезжает вместе с переходом в «В работе», а факт — вместе с
   * переходом в «Выполнена»: то же устройство, что у закрытия заявки вывоза, и по той же причине —
   * отдельным запросом их пришлось бы проводить не атомарно со сменой статуса.
   */
  changeStatus: (id: string, body: ChangeMechRequestStatusInput) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/status`, { method: 'PATCH', body }),

  /**
   * Правка договорённости отдельной ручкой правом `.status` — тем же, которым её и поставили
   * (Р19): через общий `PATCH` это было бы неверно, там барьер роли пускает площадку, а
   * договорённость — работа офиса.
   */
  updateDeal: (id: string, body: UpdateMechDealInput) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/deal`, { method: 'PATCH', body }),

  /** Отметка выдачи: с этого дня пошли деньги, и в истории он виден своим событием (Р11). */
  issue: (id: string, body: IssueMechRequestInput) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/issue`, { method: 'POST', body }),
  /**
   * Снятие ошибочной отметки — не «выдача с пустой датой», а своё действие с обязательной
   * причиной: без неё в истории осталась бы пара событий, по которой не понять, отменили выдачу
   * или техника уезжала и вернулась.
   */
  revokeIssue: (id: string, body: RevokeMechIssueInput) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/issue-revoke`, { method: 'POST', body }),

  /**
   * Продление аренды (Р9, Р11): своё право (`mechRequests.extend`), обязательная причина, своё
   * событие истории. `PATCH`, а не `POST`, как у выдачи: продление правит уже существующее поле
   * заявки (`planned_to`), а не отмечает новое событие в её жизни.
   */
  extend: (id: string, body: ExtendMechRequestInput) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/extend`, { method: 'PATCH', body }),

  /**
   * Дублирование (Р3): «нужны две виброплиты» — две заявки, потому что ставка задаётся за единицу.
   * Тела нет — копируются значения исходной заявки; версии тоже нет, и это не пропуск: строку
   * здесь не меняют, а заводят новую, и запирать нечего.
   */
  duplicate: (id: string) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/duplicate`, { method: 'POST', body: {} }),

  history: (id: string) => apiFetch<RequestHistoryEntryDto[]>(`${PATH}/${id}/history`),

  /** Четыре числа над списком (§7); из фильтров сводка знает только площадку. */
  summary: (query: Query) => apiFetch<MechRequestSummaryDto>(`${PATH}/summary`, { query }),

  /**
   * Журнал закрытых аренд (Э3): «Выполнена» и «Отменена». Своя ручка, а не список с фильтром по
   * статусу: в рабочем списке закрытой заявки нет вовсе, и вопросы к журналу другие — не «что
   * вести», а «сколько это стоило».
   */
  closedList: (query: Query) => apiFetch<ListResult<MechRequestDto>>(`${PATH}/history`, { query }),
  /** Итог журнала по тем же отборам: без них он отвечал бы не про то, что человек видит. */
  closedSummary: (query: Query) =>
    apiFetch<MechRequestHistorySummaryDto>(`${PATH}/history/summary`, { query }),
  /**
   * Выгрузка журнала книгой. Отбор уходит тот же, что показан на экране, но без страницы: книгу
   * собирают, чтобы посчитать в ней итог за период, и двадцать строк текущей страницы отвечали бы
   * на другой вопрос.
   *
   * Имя файла приходит заголовком `content-disposition` — сервер один знает, за какой период и
   * какой отбор внутри; здесь только запасное, на случай потери заголовка по дороге.
   */
  exportClosed: (query: Query) =>
    apiDownload(`${PATH}/history/export`, 'Механизация — история.xlsx', { query }),

  /**
   * Подсказка ранее вводившихся видов (Р5). Строкой, а не парой «вид — счётчик»: порядок задаёт
   * частота внутри собственной области, и число рядом сообщало бы соседним площадкам, сколько
   * чего арендуют у них.
   */
  kinds: (search: string) =>
    // Обёртка `{ items }`, а не голый массив: так отвечают все перечисляющие ручки портала, и
    // ответ, который однажды захочет отдать что-то ещё (счётчик, признак усечения), не сломает
    // клиента сменой формы.
    apiFetch<{ items: string[] }>(`${PATH}/kinds`, { query: search ? { search } : {} }),
};
