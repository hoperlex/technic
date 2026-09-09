import type {
  CreateOfficeEquipmentConsumableInput,
  CreateOfficeEquipmentInput,
  CreateOfficeEquipmentModelInput,
  EquipmentChangesPageDto,
  EquipmentHistoryPageDto,
  EquipmentMovementsPageDto,
  EquipmentRequestsPageDto,
  CreateOfficeEquipmentTypeInput,
  MoveOfficeEquipmentInput,
  OfficeEquipmentConsumableDetailDto,
  OfficeEquipmentConsumableDto,
  OfficeEquipmentConsumableStockEntriesQuery,
  OfficeEquipmentConsumableStockEntryDto,
  OfficeEquipmentConsumableStockInput,
  OfficeEquipmentConsumableStockResultDto,
  OfficeEquipmentConsumableUsageDto,
  OfficeEquipmentConsumableUsageQuery,
  OfficeEquipmentDto,
  OfficeEquipmentModelDto,
  OfficeEquipmentRequestOptionDto,
  OfficeEquipmentSelectorQuery,
  OfficeEquipmentSpecDto,
  OfficeEquipmentTypeDto,
  UpdateOfficeEquipmentConsumableInput,
  UpdateOfficeEquipmentInput,
  UpdateOfficeEquipmentModelInput,
  UpdateOfficeEquipmentTypeInput,
} from '@technic/contracts';
import {
  apiDownload,
  apiFetch,
  createGetApi,
  createListApi,
  createRemoveApi,
  createWriteApi,
  type ListResult,
} from '@shared/api';

/**
 * Что спрашивают у страницы блока истории (план истории тремя блоками, §6): продолжение и размер.
 * Оба необязательны — сервер сам подставит первую страницу и свои двадцать строк, — но размер
 * называет тот, кто знает, сколько строк поместится: у секции карточки их пять (Р7).
 */
export type EquipmentBlockParams = {
  cursor?: string;
  pageSize?: number;
};

const PATH = '/office-equipment';
const TYPES_PATH = '/office-equipment-types';
const MODELS_PATH = '/office-equipment-models';
const CONSUMABLES_PATH = '/office-equipment-consumables';

/**
 * Справочник оргтехники (ADR 0085): что стоит по кабинетам и площадкам.
 *
 * Карточка (`get`) заведена не «на всякий случай»: единицу открывают ссылкой из заявки на
 * обслуживание, и списка там нет — есть только идентификатор.
 *
 * `remove` гасит запись мягко (Р33), поэтому рядом стоят `restore` и `purge`. Обе — явными
 * ручками, а не фабрикой: «вернуть из архива» и «снести насовсем» — слова портала, а не HTTP, и
 * знать их фабрике в `shared` нечем. Ответы у них разные и не случайно: восстановление возвращает
 * карточку (её тут же показывают в списке), а после `purge` показывать нечего.
 */
export const officeEquipmentApi = {
  ...createListApi<OfficeEquipmentDto>(PATH),
  ...createGetApi<OfficeEquipmentDto>(PATH),
  ...createWriteApi<OfficeEquipmentDto, CreateOfficeEquipmentInput, UpdateOfficeEquipmentInput>(
    PATH,
  ),
  ...createRemoveApi<{ ok: boolean }>(PATH),
  /**
   * ВЫБОР ПРЕДМЕТА ЗАЯВКИ (план `docs/office-equipment-request-subject-plan.md`, Р1) — своя пара
   * ручек, а не `list`/`get` с параметром.
   *
   * Ответ у них другой и намеренно бедный: подпись, номера, место, гарантия и два признака области.
   * Ни комментария, ни закупки, ни состояния, ни характеристик, ни расходников, ни истории — по
   * этой выдаче от трёх набранных символов виден весь активный парк компании, и открывать по нему
   * учётные данные значило бы не «расширить поиск», а раздать справочник.
   *
   * `selectorPicked` дочитывает уже выбранное по идентификатору: выдача — срез по набранному, и
   * аппарат, названный не набором (обращение по гарантии, правка заявки), в ней может не лежать
   * вовсе. Погашенная карточка приходит с `isActive: false`, архивная — 404.
   *
   * Обе просят ещё и `serviceRequests.create`: без него сервер отвечает 403.
   */
  selector: (query: OfficeEquipmentSelectorQuery) =>
    apiFetch<ListResult<OfficeEquipmentRequestOptionDto>>(`${PATH}/selector`, { query }),
  selectorPicked: (id: string) =>
    apiFetch<OfficeEquipmentRequestOptionDto>(`${PATH}/selector/${id}`),
  /**
   * Перемещение (Р59): переезд — событие с датой, причиной и обеими сторонами, а не поле правки.
   * Ответ — обновлённая карточка: следующее действие делают уже по новому месту.
   */
  move: (id: string, body: MoveOfficeEquipmentInput) =>
    apiFetch<OfficeEquipmentDto>(`${PATH}/${id}/move`, { method: 'POST', body }),
  /**
   * Лента карточки (Р75–Р79): шесть источников одним потоком с курсором. Порядок считает сервер —
   * у половины событий нет времени, и клиентская сортировка разошлась бы с порядком страницы.
   */
  history: (id: string, query: { cursor?: string; pageSize?: number } = {}) =>
    apiFetch<EquipmentHistoryPageDto>(`${PATH}/${id}/history`, { query }),
  /**
   * Три бизнес-блока той же истории (план `docs/office-equipment-history-blocks-plan.md`, Р1):
   * «Связанные заявки», «Ручные правки», «Перемещения». Тремя методами, а не одним с видом блока
   * в параметрах: у ручек разные строки, разные ключи порядка и разные права — притворяться, что
   * это одна выдача, дороже, чем назвать их тремя.
   *
   * Курсор у каждого блока свой и с соседними не совместим: подставленный чужой сервер отобьёт
   * словами («ссылка на продолжение не читается»), а не молчаливой первой страницей.
   *
   * `requests` требует ещё и `serviceRequests.read`: без него ручка отвечает `403`, и вкладку
   * такому читателю портал не показывает вовсе (Р11) — спрашивать её, чтобы узнать об отказе,
   * незачем.
   */
  requests: (id: string, query: EquipmentBlockParams = {}) =>
    apiFetch<EquipmentRequestsPageDto>(`${PATH}/${id}/requests`, { query }),
  changes: (id: string, query: EquipmentBlockParams = {}) =>
    apiFetch<EquipmentChangesPageDto>(`${PATH}/${id}/changes`, { query }),
  movements: (id: string, query: EquipmentBlockParams = {}) =>
    apiFetch<EquipmentMovementsPageDto>(`${PATH}/${id}/movements`, { query }),
  /**
   * Выгрузка истории (Р80). Через `apiDownload`, а не ссылкой: файл отдаётся под тем же токеном,
   * что и остальные запросы, — обычная ссылка открыла бы вкладку с «Требуется авторизация».
   */
  historyExport: (id: string, name: string) =>
    apiDownload(`${PATH}/${id}/history.xlsx`, `История ${name}.xlsx`),
  restore: (id: string) =>
    apiFetch<OfficeEquipmentDto>(`${PATH}/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем — только из архива и только без ссылок (ADR 0060). */
  purge: (id: string) => apiFetch<{ ok: boolean }>(`${PATH}/${id}/purge`, { method: 'DELETE' }),
};

/**
 * Перечень типов: МФУ, принтер, ноутбук, монитор. Ведётся в окне из вкладки справочника (Р34) —
 * сам по себе тип ничего не значит, и отдельной вкладки ради десяти строк не заводят.
 *
 * Удаление здесь настоящее, а не пометка: перечень наполняют руками, и заведённый по ошибке код
 * вычищают. Тип, на который уже ссылаются карточки, сервер удалить не даёт — его выключают
 * отметкой «Активен». Отсюда и `{ ok }` в ответе: возвращать после удаления нечего.
 */
export const officeEquipmentTypesApi = {
  ...createListApi<OfficeEquipmentTypeDto>(TYPES_PATH),
  ...createWriteApi<
    OfficeEquipmentTypeDto,
    CreateOfficeEquipmentTypeInput,
    UpdateOfficeEquipmentTypeInput
  >(TYPES_PATH),
  ...createRemoveApi<{ ok: boolean }>(TYPES_PATH),
};

/**
 * Справочник моделей аппаратов (план `docs/office-equipment-consumables-plan.md`, Р1): к модели, а
 * не к отдельной карточке, привязывается картридж — «Тонер Ricoh 201» годится и 68 нынешним
 * Ricoh Aficio MP 201SPF, и 69-му, который приедет завтра. Ведётся окном из вкладки «Оргтехника»
 * (Р8) и правами самого справочника техники (Р10) — своей пары прав у моделей нет.
 *
 * Удаление настоящее, а не пометка, — как у перечня типов: справочник наполняют руками, и
 * заведённую по ошибке строку вычищают. Модель, на которую уже ссылается техника (в том числе
 * архивная), сервер удалить не даст — её гасят отметкой «Активна» (Р11). Отсюда `{ ok }` в ответе:
 * после удаления показывать нечего.
 */
/**
 * Какие характеристики спрашивают у типа и что у них за значения (план
 * `docs/office-equipment-specs-plan.md`, Р4): им форма модели строит поле «Цветность печати».
 *
 * Отдельной ручкой, а не полем строки списка: перечень значений нужен там, где значение вводят, и
 * спрашивают его в том числе до того, как модель существует, — при заведении новой.
 */
export const officeEquipmentSpecsApi = {
  list: (equipmentTypeId: string) =>
    apiFetch<OfficeEquipmentSpecDto[]>(`${TYPES_PATH}/${equipmentTypeId}/specs`),
};

export const officeEquipmentModelsApi = {
  ...createListApi<OfficeEquipmentModelDto>(MODELS_PATH),
  ...createWriteApi<
    OfficeEquipmentModelDto,
    CreateOfficeEquipmentModelInput,
    UpdateOfficeEquipmentModelInput
  >(MODELS_PATH),
  ...createRemoveApi<{ ok: boolean }>(MODELS_PATH),
};

/**
 * Расходники печатной техники — картриджи и тонеры (план
 * `docs/office-equipment-consumables-plan.md`, Р5–Р7). Подсправочник вкладки «Оргтехника»: код
 * номенклатуры учётной системы, наименование, остаток на складе и перечень моделей, которым
 * расходник подходит. Права те же, что у справочника техники (Р10).
 *
 * Карточка (`get`) заведена не для симметрии: она перечитывает остаток по идентификатору, и это
 * половина ответа на 409 — окно правки показывает то число, с которым уйдёт следующая попытка, а
 * строку списка из выдачи мог унести отбор «нет в наличии». Ленты журнала она больше не возит:
 * та уехала в свою ручку `stockEntries` (план `…-and-purchase-plan.md`, Р4), и второго места, где
 * решают, что показывать в журнале, у портала нет намеренно.
 *
 * Остатка в `update` нет вовсе, и это правило контракта, а не экономия: количество меняется
 * событием с причиной и автором (Р7). Приняв его формой правки, портал соврал бы человеку —
 * «сохранено» стояло бы там, где остаток не тронут и в журнал ничего не легло.
 *
 * `remove` удаляет насовсем — как у типов и моделей: пока журнал остатка пуст, так убирают
 * опечатку первого дня. Расходник с движением сервер удалить не даст (`ON DELETE RESTRICT` у
 * журнала), его гасят отметкой «Активен» (Р11). Отсюда `{ ok }` в ответе: показывать после
 * удаления нечего.
 */
/**
 * Тело заведения в том виде, в каком его шлёт портал: без начального остатка.
 *
 * Схема заведения количество принимает (`.optional().default(0)`) — им пользуется наполнение
 * миграцией и обменом файлом. Форма портала им не пользуется никогда: первое число — такое же
 * событие с причиной и автором, как и всякое следующее, и приходит оно ручкой остатка (Р7).
 * Поэтому поле снято на уровне типа, а не «просто не заполняется»: иначе первый же сосед,
 * заводящий расходник из своего экрана, тихо завёл бы остаток мимо журнала.
 */
export type OfficeEquipmentConsumableCreateBody = Omit<
  CreateOfficeEquipmentConsumableInput,
  'quantity'
>;

export const officeEquipmentConsumablesApi = {
  ...createListApi<OfficeEquipmentConsumableDto>(CONSUMABLES_PATH),
  ...createGetApi<OfficeEquipmentConsumableDetailDto>(CONSUMABLES_PATH),
  ...createWriteApi<
    OfficeEquipmentConsumableDto,
    OfficeEquipmentConsumableCreateBody,
    UpdateOfficeEquipmentConsumableInput
  >(CONSUMABLES_PATH),
  ...createRemoveApi<{ ok: boolean }>(CONSUMABLES_PATH),
  /**
   * Правка остатка своей ручкой (Р7): новое значение, то значение, которое человек видел, и
   * причина. `expectedQuantity` — не формальность: без него два кладовщика, открывшие карточку с
   * числом 12, запишут «12 → 10» и «12 → 8», и журнал станет враньём при верном итоге. Разошлось
   * — сервер отвечает 409 «остаток изменил другой человек, сейчас N», и это нормальный исход
   * одновременной работы, а не сбой: окно правки показывает его словами и перечитывает карточку.
   */
  setStock: (id: string, body: OfficeEquipmentConsumableStockInput) =>
    apiFetch<OfficeEquipmentConsumableStockResultDto>(`${CONSUMABLES_PATH}/${id}/stock`, {
      method: 'POST',
      body,
    }),
  /**
   * Журнал остатка позиции страницами (план `docs/office-equipment-consumables-and-purchase-plan.md`,
   * Р4) — то, чем живёт окно «История остатка».
   *
   * СВОЯ РУЧКА, А НЕ СРЕЗ КАРТОЧКИ: до Р4 ленту возил `GET /:id`, и с переездом её в отдельное окно
   * она оттуда убрана совсем. Две двери к одному журналу разошлись бы на первой же правке — вот на
   * этом самом отборе по виду события, которого у карточки не было бы.
   *
   * Порядок задаёт сервер (`seq` вниз, а не время: две правки одной секунды по `createdAt`
   * неразличимы), и портал строки не пересортировывает вовсе. Права своего у ленты нет: её читает
   * тот же, кому открыт сам перечень.
   */
  stockEntries: (id: string, query: OfficeEquipmentConsumableStockEntriesQuery) =>
    apiFetch<ListResult<OfficeEquipmentConsumableStockEntryDto>>(
      `${CONSUMABLES_PATH}/${id}/stock-entries`,
      { query },
    ),
  /**
   * Расход за период (Р10, опрос В18): кто, сколько, на какие аппараты и по каким заявкам.
   *
   * Считает сервер по журналу движения склада — тем же источником, что и остаток. Второй счётчик
   * на портале (например, сумма по строкам заявок) разошёлся бы с остатком на первом же сторно,
   * поэтому портал только показывает присланное и ничего не складывает сам: итоги приходят вместе
   * со строками.
   */
  usage: (query: OfficeEquipmentConsumableUsageQuery) =>
    apiFetch<OfficeEquipmentConsumableUsageDto>(`${CONSUMABLES_PATH}/usage-report`, { query }),
  /**
   * Он же файлом. Через `apiDownload`, а не ссылкой: файл отдаётся под тем же токеном, что и
   * остальные запросы, — обычная ссылка открыла бы вкладку с «Требуется авторизация».
   *
   * Имя файла приходит заголовком ответа; здесь — запасное, на случай, если заголовок срежет
   * посредник.
   */
  usageExport: (query: OfficeEquipmentConsumableUsageQuery) =>
    apiDownload(
      `${CONSUMABLES_PATH}/usage-report.xlsx`,
      `Расход расходников ${query.from} – ${query.to}.xlsx`,
      { query },
    ),
};
