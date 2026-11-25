import type { WasteTicketBadgeDto } from './waste-tickets';
import { REQUEST_STATUSES, requestTypeShort } from './enums';
import type { ContainerKind, RequestStatus, RequestType } from './enums';
import type { FileDto } from './files';
import { calcWasteAmount } from './waste-tariffs';

/** Префикс номера заявки на мусор — как «ТС-» у заявок на технику (миграция 0064). */
const WASTE_REQUEST_NUM_PREFIX = 'М';

/**
 * Отображаемый номер заявки: «М-128» (в БД хранится только число).
 *
 * `legacyNumFormat` — заявка заведена до префикса и показывается прежним номером «128-ВМ»:
 * число плюс буква типа. Перерисовать его задним числом нельзя, он уже в талонах и переписке.
 */
export function formatWasteRequestNumber(
  num: number,
  requestType: RequestType,
  legacyNumFormat: boolean,
): string {
  return legacyNumFormat
    ? `${num}-${requestTypeShort[requestType]}`
    : `${WASTE_REQUEST_NUM_PREFIX}-${num}`;
}

/**
 * Разбор пользовательского ввода поиска: «128» / «М-128» / «128-ВМ» → 128. Ищут по числу: оно
 * уникально в обоих форматах, а префикс и буква типа — только отображение.
 */
export function parseWasteRequestNumberSearch(input: string): number | undefined {
  const digits = input.match(/\d+/)?.[0];
  if (!digits) return undefined;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

// Сортировка доступна во всех столбцах таблицы заявок; ключ поля совпадает с ключом колонки.
export const WASTE_REQUEST_SORT_FIELDS = [
  'num',
  'objectName',
  'containerTypeName',
  'wasteTypeName',
  'requestType',
  'deliveryAt',
  'status',
  'operatorName',
  'comment',
  'createdByName',
  'createdAt',
  // Столбец вкладки «Архив» (ADR 0070): когда заявку удалили. Порядок по нему там умолчанием —
  // архив открывают вопросом «что снесли последним».
  'deletedAt',
] as const;

/**
 * Статусы журнала «История» (ADR 0135): заявка, по которой уже нечего решать. «Выполнена» сюда не
 * входит намеренно — по ней ещё разбирают талоны, и работа с ней не кончена.
 */
export const CLOSED_WASTE_STATUSES = [
  'completed',
  'cancelled',
] as const satisfies readonly RequestStatus[];

export function isClosedWasteStatus(status: RequestStatus): boolean {
  return (CLOSED_WASTE_STATUSES as readonly RequestStatus[]).includes(status);
}

/**
 * Статусы рабочей вкладки «Заявки»: всё, что ещё ведут. Считается вычитанием, а не вторым
 * перечнем: появись у цикла новый статус, он попал бы в работу сам — а забытый в списке статус
 * пропал бы из обеих вкладок молча.
 */
export const OPEN_WASTE_STATUSES: readonly RequestStatus[] = REQUEST_STATUSES.filter(
  (s) => !isClosedWasteStatus(s),
);

/**
 * Итог журнала за выбранные фильтры: сколько заявок закрыто, чем закончилось и что по ним вывезли.
 * Вывезенное двумя числами, а не одним: мусор меряют объёмом, лом принимают по весу (ADR 0067), и
 * сложить их не во что. Сумма — по завершённым с известной стоимостью: у отменённой её не бывает,
 * а контейнерные операции не тарифицируются вовсе (ADR 0019).
 */
export interface WasteRequestHistorySummaryDto {
  total: number;
  completed: number;
  cancelled: number;
  /**
   * Sum of the known completion costs. Kept a number for tabs built before snow; a snow-only
   * selection reads `snowCompletedWithoutCost` to show a dash or an incomplete-sum mark next to it.
   */
  totalCost: number;
  volumeM3: number;
  weightTons: number;
  /** Completed snow requests whose completion carries a cost (0 included — a known amount). */
  snowCompletedWithCost: number;
  /** Completed snow requests whose cost was never entered: the sum above misses them. */
  snowCompletedWithoutCost: number;
}

/** Количество видимых заявок в каждом статусе (удалённые не считаются). */
export type WasteRequestSummaryDto = Record<RequestStatus, number>;

/**
 * Upper bound of an ordered volume: `waste_requests.volume_m3` is a PostgreSQL `integer`. Without it
 * a large number passed validation and failed at the insert as a server error instead of a field
 * message.
 */
export const MAX_ORDERED_VOLUME_M3 = 2_147_483_647;

// ── Факт вывоза и талоны (ADR 0035, ADR 0013) ──

/**
 * В чём меряется вывезенное. Единица — свойство типа заявки, а не поле формы: мусор возят
 * объёмом (ADR 0035), металлолом сдают по весу (ADR 0067), и одной колонкой их не описать —
 * «3,2» без единицы не отвечает, кубометры это или тонны.
 */
export type WasteFactUnit = 'volume_m3' | 'weight_tons';

/** Подпись единицы факта — для полей формы, карточки заявки и истории. */
export const wasteFactUnitLabels: Record<WasteFactUnit, string> = {
  volume_m3: 'м³',
  weight_tons: 'т',
};

/**
 * Чем предъявляется закрытие заявки:
 *  - `volume_m3` — вывоз мусора: объём заказан заявкой, а сколько увезли, видно лишь по закрытию;
 *  - `weight_tons` — вывоз металлолома: заявка объёма не несёт вовсе, лом принимают по весу;
 *  - `null` — контейнерные операции: они считаются по самим контейнерам и закрываются талоном.
 */
export function wasteFactUnit(t: RequestType): WasteFactUnit | null {
  // Snow is ordered and closed in cubic metres exactly like garbage (snow-removal plan, §2).
  if (t === 'waste_removal' || t === 'snow_removal') return 'volume_m3';
  if (t === 'metal_removal') return 'weight_tons';
  return null;
}

/**
 * Требует ли тип заявки предъявленного факта. Производная от `wasteFactUnit`: вопрос «нужен ли
 * факт» задают чаще, чем «в чём он», и раздваивать правило между двумя предикатами нельзя.
 */
export function requiresWasteFact(t: RequestType): boolean {
  return wasteFactUnit(t) !== null;
}

/**
 * Тип контейнера — предмет только контейнерных операций. У вывоза мусора техника не указывается
 * (ADR 0022), у вывоза металлолома нет и её (ADR 0067): заявка говорит «приезжайте забрать», а
 * чем забирать, решает исполнитель.
 */
export function usesContainerType(t: RequestType): boolean {
  return t === 'container_install' || t === 'container_replace' || t === 'container_removal';
}

// ── Snow removal and the per-rule type predicates (snow-removal plan, §2) ──
//
// Garbage and snow share most of the request, but not all of it, and each difference is its own
// question. One predicate per question, never «is it garbage or snow»: a future type that is
// ordered by volume but priced by a list would otherwise inherit the wrong half silently.

/** The request is ordered by volume, at least `MIN_WASTE_VOLUME_M3` m³ (S5). */
export function requiresOrderedVolume(t: RequestType): boolean {
  return t === 'waste_removal' || t === 'snow_removal';
}

/**
 * The requester picks the waste type from the directory. Snow has its type set by the server (S2):
 * whatever a caller sends there is discarded, and the service row never appears in a picker.
 */
export function requesterSelectsWasteType(t: RequestType): boolean {
  return t === 'waste_removal';
}

/**
 * Completion money is entered by hand only (S6): no price list, no tariff snapshot, no estimate,
 * and the server never computes a sum. An omitted cost on the first completion is unknown, not 0.
 */
export function isManualCostOnly(t: RequestType): boolean {
  return t === 'snow_removal';
}

/**
 * Attached ticket paper counts as unreviewed before recognition has looked at it (ADR 0150
 * boundary). Other types may carry a ticket file from long ago and must not flood the review
 * register on a cache miss; garbage and snow are reviewed paper (S4).
 */
export function countsUnreviewedTicketPaper(t: RequestType): boolean {
  return t === 'waste_removal' || t === 'snow_removal';
}

/**
 * Reserved service waste type «Снег» (S2, S10, S11). The migration seeds this exact row and binds
 * id, code, name and the active flag together with a CHECK, so these literals are the identity the
 * SQL guards hold. The server resolves the row by code; the id exists for the guards and for
 * refusing it at every directory entry point.
 */
export const SNOW_WASTE_TYPE_ID = '29cd9e92-0d72-4666-8ff1-76e0d6aad553';
export const SNOW_WASTE_TYPE_CODE = 'snow';
export const SNOW_WASTE_TYPE_NAME = 'Снег';

/** The service waste type a request type carries, by reserved code; `null` — the requester picks. */
export function serviceWasteTypeCode(t: RequestType): string | null {
  return t === 'snow_removal' ? SNOW_WASTE_TYPE_CODE : null;
}

/** Service waste type codes: never editable, never priced, never matched by an import. */
export const SERVICE_WASTE_TYPE_CODES: readonly string[] = [SNOW_WASTE_TYPE_CODE];

export function isServiceWasteTypeCode(code: string | null | undefined): boolean {
  return code != null && SERVICE_WASTE_TYPE_CODES.includes(code.trim().toLowerCase());
}

/** UUIDs compare as UUIDs: an uppercase spelling of the reserved id is still the reserved id. */
export function isServiceWasteTypeId(id: string | null | undefined): boolean {
  return id != null && id.trim().toLowerCase() === SNOW_WASTE_TYPE_ID;
}

/** Field message shared by the directory refusals (tariffs, pricing, imports) and the portal. */
export const SNOW_COST_AT_COMPLETION_MESSAGE =
  'Для вывоза снега стоимость вносится при закрытии заявки';

/**
 * May a filed request change its type from `from` to `to` (S12)? An actual change to or from snow
 * is refused in both directions and for every other type: a wrong type is cancelled and filed again.
 * Equal types are always valid — the PATCH may repeat the saved type.
 */
export function wasteRequestTypeChangeAllowed(from: RequestType, to: RequestType): boolean {
  if (from === to) return true;
  return from !== 'snow_removal' && to !== 'snow_removal';
}

/** One explanation for the portal and the API (S12). */
export const SNOW_TYPE_CHANGE_MESSAGE =
  'Тип «Вывоз снега» не меняют на другой и другой тип не меняют на него: отмените заявку и заведите новую';

/**
 * Capability negotiation for snow (snow-removal plan, §3.5). A portal that understands the snow type
 * sends this header on waste request calls. Without it the API hides snow from lists and summaries
 * and answers a direct snow request with `426 client_upgrade_required`: a tab opened before this
 * release would otherwise close snow requests through the ticket-only flow of an unknown type.
 */
export const WASTE_REQUEST_CAPABILITY_HEADER = 'X-Waste-Request-Capability';
export const WASTE_REQUEST_CAPABILITY_SNOW = 'snow-removal-v1';

/** `GET /waste-requests/capabilities`: what the serving API supports. */
export interface WasteRequestCapabilitiesDto {
  capabilities: string[];
}

// ── Snow removal API: capability per request type (snow-removal plan, §3.5) ──

/**
 * The capability a client must declare to see or act on requests of this type; `null` — every
 * client understands the type. The API derives its legacy type filter and its 426 refusals from
 * this one mapping, so a future type negotiated the same way is hidden from older tabs by adding
 * one line here rather than by a second list on the server.
 */
export function wasteRequestTypeCapability(t: RequestType): string | null {
  return t === 'snow_removal' ? WASTE_REQUEST_CAPABILITY_SNOW : null;
}

// ── End of snow removal API additions ──

/**
 * How `DELETE /waste-requests/:id` removes a request: a «Новая» request is deleted for good, any
 * other goes to the archive (ADR 0070). One rule for the server and the confirmation dialog, so the
 * dialog never promises the archive for a request the server would delete outright.
 */
export type WasteRequestDeleteMode = 'hard' | 'soft';

export function wasteRequestDeleteMode(status: RequestStatus): WasteRequestDeleteMode {
  return status === 'new' ? 'hard' : 'soft';
}

// ── Operator site binding (snow-removal plan, §3.2; added by the portal wave) ──

/**
 * May this operator serve a request on the site? The established binding rule (ADR 0010,
 * migration 0027): a site with no operator link at all accepts any operator, because the directory
 * fills up gradually; a linked site accepts only its linked operators. `siteOperatorIds` must hold
 * EVERY link of the site, inactive and archived operators included: a site whose only link points
 * to an inactive operator is a configured site, and treating it as unlinked would offer operators
 * the server refuses. Activity of the operator itself is a separate check.
 */
export function wasteOperatorServesSite(
  siteOperatorIds: readonly string[],
  operatorId: string,
  /** Links to removed operators, which `siteOperatorIds` omits but the server counts. */
  hiddenLinks = 0,
): boolean {
  return siteOperatorIds.length + hiddenLinks === 0 || siteOperatorIds.includes(operatorId);
}

/**
 * Талоны на одно закрытие: их несколько (талон с двух сторон, весовая квитанция рядом), но
 * список общий на заявку — к отдельной машине талон больше не крепится (ADR 0024).
 */
export const MAX_TICKETS_PER_REQUEST = 20;

/**
 * Расчёт стоимости по факту: объём × цена прайса. `null` — цены нет, и считать нечем: тогда
 * сумму вводят руками, а закрытие всё равно проходит (ADR 0035).
 */
export function calcWasteFactCost(volumeM3: number, pricePerM3: number | null): number | null {
  return pricePerM3 == null ? null : calcWasteAmount(volumeM3, pricePerM3);
}

/** Один текст на отказ сервера и на проверку формы — единица факта задана типом заявки. */
export const FACT_UNIT_MISMATCH_MESSAGE =
  'Закрытие предъявляет не ту величину, которой меряется этот тип заявки';

/**
 * Переход, требующий факта: «Выполнена» отвечает на «сколько вывезли и сколько стоило».
 * Отмена факта не требует — по отменённой заявке никто не выезжал.
 */
export function wasteTransitionRequiresFact(to: RequestStatus): boolean {
  return to === 'done';
}

/**
 * Вывезенное: величина вместе со своей единицей, одним неразделимым значением.
 *
 * Размеченное объединение, а не пара необязательных чисел, — и это не стилистика. Пара
 * `volumeM3: number | null` + `weightTons: number | null` разъезжается молча: `null` легален и в
 * шаблонной строке, и в JSX, поэтому `Вывезено {c.volumeM3} м³` в заявке на металлолом
 * компилируется и печатает «Вывезено null м³». Объединение такую строку не пропускает: поля
 * `volumeM3` у ветки веса нет вовсе, и добраться до числа можно, только назвав единицу.
 *
 * Единицу несёт сам факт, а не тип заявки рядом: печатают факт в четырёх местах (карточка, список,
 * окно отката, история), и в трёх из них типа заявки под рукой нет.
 */
export type WasteFactAmount =
  { unit: 'volume_m3'; volumeM3: number } | { unit: 'weight_tons'; weightTons: number };

/**
 * Факт выполнения заявки (ADR 0035): вывезенное, цена-основание и итог. Цена — снимок прайса на
 * момент закрытия, а не текущий тариф: сумма обязана объясняться сама, а прайс могли переписать.
 *
 * Вывезенное приходит `WasteFactAmount`-ом — величиной со своей единицей. Общего поля «сколько» с
 * единицей в соседней колонке нет намеренно: объём умножается на цену прайса, а вес — ни на что,
 * и единое поле предлагало бы считать тонны по ₽/м³.
 */
export type WasteRequestCompletionDto = WasteFactAmount & {
  /** Цена за м³ на момент закрытия; `null` — в прайсе её не было либо заявка не тарифицируется. */
  pricePerM3: number | null;
  /** Итоговая стоимость; `null` — считать было нечем и руками не ввели. */
  totalCost: number | null;
  /**
   * Stored removal day (`YYYY-MM-DD`), `null` — unknown. Carried so that a re-close can show and
   * keep it: an omitted date on a snow re-close keeps the saved one (snow-removal plan, §1).
   */
  removedOn: string | null;
  completedBy: string;
  completedByName: string;
  completedAt: string;
};

/**
 * Вывезенное строкой с единицей: «48 м³», «3,2 т». Собирается здесь, а не в вёрстке: единица не
 * должна потеряться ни в одном месте показа.
 *
 * `switch` с проверкой на `never` вместо цепочки `if`: третья единица (примут лом по штукам,
 * грунт по тоннам) обязана сломать сборку здесь, а не тихо напечатать прочерк.
 */
export function wasteFactLabel(c: WasteFactAmount): string {
  switch (c.unit) {
    case 'volume_m3':
      return `${c.volumeM3} ${wasteFactUnitLabels.volume_m3}`;
    case 'weight_tons':
      return `${c.weightTons} ${wasteFactUnitLabels.weight_tons}`;
    default: {
      const unhandled: never = c;
      return unhandled;
    }
  }
}

/**
 * Объём закрытия — только у закрытия, меряемого объёмом. Отдельной ручкой, потому что объём здесь
 * нужен для счёта (сверка с заявленным, расчёт по прайсу), а не для показа: показ идёт через
 * `wasteFactLabel`, и подставлять единицу вызывающему нечего.
 */
export function factVolumeOf(c: WasteFactAmount | null | undefined): number | null {
  return c?.unit === 'volume_m3' ? c.volumeM3 : null;
}

/** Вес закрытия — только у закрытия, меряемого весом (ADR 0067). Тем же порядком, что и объём. */
export function factWeightOf(c: WasteFactAmount | null | undefined): number | null {
  return c?.unit === 'weight_tons' ? c.weightTons : null;
}

// ── Контейнеры на объекте: владелец и количество (миграция 0080) ──

/**
 * Операции над контейнером, который уже стоит на площадке. У них, и только у них, есть владелец
 * (чей контейнер трогаем) и количество: установка привозит свой контейнер, а вывоз мусора
 * контейнеров не касается вовсе (ADR 0022).
 */
export function usesContainerGroup(t: RequestType): boolean {
  return t === 'container_replace' || t === 'container_removal';
}

/** Потолок количества — защита от опечатки: сколько снять можно, ограничено присутствием. */
export const MAX_CONTAINERS_PER_REQUEST = 20;

/**
 * Группа присутствия: что и чьё стоит на объекте, сколько штук. Единицы внутри группы
 * взаимозаменяемы — какую именно из двух одинаковых бочек одного оператора увезут, вопрос не
 * учёта, а водителя.
 */
export interface PresentContainerGroupDto {
  objectId: string;
  containerTypeId: string;
  containerTypeName: string;
  /** Оператор, установивший контейнеры; null — установку завели без оператора. */
  ownerCounterpartyId: string | null;
  ownerName: string | null;
  quantity: number;
}

/**
 * Подпись группы: «Контейнер 8 м³ — Оператор А (2 шт.)». Показывается в четырёх местах — выбор
 * контейнера в форме, подсказка под полем оператора, окно назначения при переводе в работу и
 * вкладка «На объекте», — поэтому собирается здесь, а не в вёрстке каждого из них.
 */
export function presentGroupLabel(
  g: Pick<PresentContainerGroupDto, 'containerTypeName' | 'ownerName' | 'quantity'>,
): string {
  return `${g.containerTypeName} — ${g.ownerName ?? 'оператор не указан'} (${g.quantity} шт.)`;
}

/**
 * Вывозит ли заявку не тот, кто контейнер привёз. Считается, а не хранится: это отношение двух
 * колонок, и хранимый признак разошёлся бы с ними при первой же смене оператора.
 *
 * Молчит в двух случаях, и оба — «данных нет», а не «всё в порядке»: оператор ещё не назначен
 * (заявку завела площадка) и владелец не известен (установку завели без оператора).
 */
export function containerOwnerMismatch(
  r: Pick<
    WasteRequestDto,
    'requestType' | 'operatorCounterpartyId' | 'containerOwnerCounterpartyId'
  >,
): boolean {
  if (!usesContainerGroup(r.requestType)) return false;
  if (!r.operatorCounterpartyId || !r.containerOwnerCounterpartyId) return false;
  return r.operatorCounterpartyId !== r.containerOwnerCounterpartyId;
}

/**
 * Чем кончается расхождение «вывозит не тот, кто привёз»:
 *  - `ok` — расхождения нет либо о нём нечего сказать (оператор или владелец не известны);
 *  - `reasonRequired` — снятие чужого контейнера: пройдёт, если объяснить причину;
 *  - `reasonGiven` — то же снятие с объяснённой причиной: проходит и попадает в историю;
 *  - `splitRequired` — замена чужого контейнера: не проходит вовсе.
 *
 * У замены обхода нет намеренно. Заменить чужой контейнер — значит увезти контейнер одного
 * оператора и оставить контейнер другого, то есть сменить владельца единицы на площадке. Одной
 * заявкой это описать нечем: либо учёт соврёт (единица останется числиться за прежним), либо в
 * присутствие придётся заводить перенос владельца — третий механизм ради редкого случая. Две
 * заявки — снятие чужого и установка своего — описывают ровно то, что произошло.
 *
 * Политика одна на сервер и на форму: сервер ею отказывает, форма — предупреждает заранее, и
 * расходиться им нельзя.
 */
export type ContainerOwnerVerdict = 'ok' | 'reasonRequired' | 'reasonGiven' | 'splitRequired';

export function checkContainerOwner(
  r: Pick<
    WasteRequestDto,
    'requestType' | 'operatorCounterpartyId' | 'containerOwnerCounterpartyId'
  >,
  reasonGiven = false,
): ContainerOwnerVerdict {
  if (!containerOwnerMismatch(r)) return 'ok';
  if (r.requestType === 'container_replace') return 'splitRequired';
  return reasonGiven ? 'reasonGiven' : 'reasonRequired';
}

/** Один текст на отказ сервера и на объяснение в форме — см. `checkContainerOwner`. */
export const FOREIGN_CONTAINER_SPLIT_MESSAGE =
  'Замена чужого контейнера оформляется двумя заявками: снятие чужого и установка своего';

/**
 * Предмет заявки строкой — для колонки списка и мобильной карточки. Объём есть там, где он
 * определяет сумму (ADR 0019); количество показывается только когда контейнер не один: «× 1»
 * читателю ничего не сообщает. Техники у вывоза нет вовсе (ADR 0022) — у заявок, заведённых до
 * этого решения, тип в базе остался, но предметом заявки уже не является. У вывоза металлолома
 * предмета нет и подавно (ADR 0067): строка выходит пустой, и это правда — заявка говорит
 * «приезжайте забрать», а сколько увезли, отвечает уже закрытие.
 */
export function wasteSubjectLabel(
  r: Pick<WasteRequestDto, 'requestType' | 'containerTypeName' | 'containersCount' | 'volumeM3'>,
): string {
  const container = usesContainerType(r.requestType) ? r.containerTypeName : null;
  const parts = [
    container && r.containersCount > 1 ? `${container} × ${r.containersCount}` : container,
    r.volumeM3 != null ? `${r.volumeM3} м³` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : '—';
}

/**
 * Строка состава техники прошлых закрытий (миграции 0029, 0042). Только чтение: с ADR 0035
 * закрытие предъявляет объём и стоимость, а не перечень машин, и новых строк не появляется —
 * заведённые остаются в истории заявки, по ним её принимали.
 */
export interface WasteRequestVehicleDto {
  id: string;
  containerTypeId: string;
  containerTypeName: string;
  /** Вид техники: вывоз оформлялся и самосвалами, и контейнерами (ADR 0024). */
  containerKind: ContainerKind;
  /** Вместимость одной машины, м³ — снимок справочника на момент заведения строки. */
  volumeM3: number;
  /** Сколько таких машин вывезло заявку. */
  count: number;
  /**
   * Цена за м³ по прайсу на момент заведения строки — снимок, как и у самой заявки.
   * null — у строк, заведённых до ADR 0024: тарифа им тогда не подбирали.
   */
  pricePerM3: number | null;
  /** Сумма строки = вместимость × количество × цена (считала БД); null — цены нет. */
  amount: number | null;
  /** Была помечена на удаление: в факт вывоза такая строка не входила. */
  isDeleted: boolean;
  createdAt: string;
}

/** Объём строки: вместимость одной машины × количество. */
export function vehicleVolume(v: Pick<WasteRequestVehicleDto, 'volumeM3' | 'count'>): number {
  return Math.round(v.volumeM3 * v.count * 1000) / 1000;
}

/** Объём по составу техники: сумма строк без помеченных на удаление. */
export function sumVehicleVolume(vehicles: readonly WasteRequestVehicleDto[]): number {
  const sum = vehicles.reduce((acc, v) => (v.isDeleted ? acc : acc + vehicleVolume(v)), 0);
  return Math.round(sum * 1000) / 1000;
}

export interface WasteRequestDto {
  id: string;
  /** Сквозной человекочитаемый номер: по нему ищут и сортируют. Показывают `displayNumber`. */
  num: number;
  /** Номер как его показывают: «М-128», а у заявок до префикса — «128-ВМ» (миграция 0064). */
  displayNumber: string;
  objectId: string;
  objectCode: string;
  objectName: string;
  /**
   * Адрес площадки; пустая строка — адрес у объекта не заполнен (колонка справочника
   * необязательная). Показывают второй строкой к наименованию — «куда ехать» спрашивают у
   * списка заявок чаще всего, а своей колонки адрес не стоит.
   */
  objectAddress: string;
  requestType: RequestType;
  // Только контейнерные операции: тип контейнера. У вывоза мусора техника не указывается
  // (ADR 0022) — поле остаётся заполненным лишь у заявок, заведённых до этого решения.
  containerTypeId: string | null;
  containerTypeName: string | null;
  /**
   * Сколько контейнеров снимает или меняет заявка (миграция 0080). У остальных типов всегда 1:
   * установка привозит один контейнер, вывоза мусора контейнеры не касаются.
   */
  containersCount: number;
  /**
   * Чей контейнер снимаем/меняем: оператор его заявки установки. null — владелец не известен
   * (установку завели без оператора либо заявка старше миграции 0080), и тогда правило
   * совпадения молчит: запрет там, где нет данных, — не запрет ошибки.
   */
  containerOwnerCounterpartyId: string | null;
  containerOwnerName: string | null;
  // Тарифицируемые операции (замена / снятие / вывоз): что вывозим, сколько и почём.
  wasteTypeId: string | null;
  wasteTypeName: string | null;
  volumeM3: number | null;
  /** Снимок цены за м³ на момент сохранения заявки; прайс мог измениться позже. */
  pricePerM3: number | null;
  /** Плановая сумма = заявленный объём × цена (считает БД). */
  amount: number | null;
  /**
   * Факт выполнения (ADR 0035): сколько вывезли и во сколько это обошлось. После закрытия его
   * сумма и есть то, что заявка стоила: `amount` выше — план по заявленному объёму.
   * null — заявка не закрыта либо закрыта контейнерной операцией (у неё факта нет).
   */
  completion: WasteRequestCompletionDto | null;
  /** Оператор вывоза (контрагент): кто выполняет заявку. NULL — ещё не назначен (ADR 0010). */
  operatorCounterpartyId: string | null;
  operatorName: string | null;
  deliveryAt: string;
  /** Время доставки не задано — в `deliveryAt` значима только дата (00:00 МСК). */
  deliveryTimeUnspecified: boolean;
  /** Кто принимает машину на площадке; пусто — заявка заведена до миграции 0062. */
  responsibleName: string;
  responsiblePhone: string;
  /** Комментарий площадки — стороны заказчика; пишется формой заявки. */
  comment: string;
  /**
   * Комментарий исполнителя (ADR 0053): что о заявке сказал оператор. Пишется своей ручкой —
   * заявку исполнитель не редактирует. Показывается второй строкой там же, где комментарий
   * площадки: обе стороны собирает `wasteRequestCommentLines`.
   */
  operatorComment: string;
  status: RequestStatus;
  /** Причина отмены из истории статусов; заполнена только у отменённых заявок. */
  cancelReason: string | null;
  /** Документы заявки: прикладываются при заведении и правятся свободно. Талонов здесь нет. */
  files: FileDto[];
  /**
   * Талоны, приложенные при закрытии заявки (ADR 0013). Общий пул на заявку у любого типа:
   * с ADR 0024 бумага не делится по машинам.
   */
  tickets: FileDto[];
  /**
   * Состав техники прошлых закрытий: строки «тип × количество» (ADR 0024). Только у заявок,
   * закрытых до ADR 0035 — новых строк не появляется, а прежние остаются в истории заявки.
   */
  vehicles: WasteRequestVehicleDto[];
  /**
   * Значок разбора талонов для строки списка (ADR 0114, Р24): ⛔ расхождения · ⚠️ предупреждения ·
   * ⏳ ждут подтверждения · нечитаемое.
   *
   * `null` означает ровно две вещи сразу — «смотрящий не разбирает талоны» либо «бумаги у заявки
   * нет». Нулями это не заменяется: «разбирать нечего» и «всё разобрано» — разные ответы, и один
   * значок на оба показывал бы молчащую подсистему как порядок (Р29).
   */
  ticketBadge: WasteTicketBadgeDto | null;
  version: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /**
   * Кто отправил заявку в архив (ADR 0070). Пусто у живой заявки и у архивной, чей автор удаления
   * не сохранился (`deleted_by` объявлен `ON DELETE SET NULL` — учётку могли снести насовсем).
   * Именем, а не только идентификатором: «кто удалил» — первый вопрос к строке архива, и ответ на
   * него не должен требовать второго запроса.
   */
  deletedByName: string | null;
}

// ── Комментарий заявки: две стороны (ADR 0053) ──

/** Строка комментария с подписью стороны. */
export interface WasteCommentLine {
  key: 'site' | 'operator';
  /** Подпись строки: «Площадка» либо название контрагента-исполнителя. */
  label: string;
  text: string;
}

/**
 * Комментарий заявки двумя подписанными строками (ADR 0053). Пустая сторона строкой не
 * показывается: «Площадка: —» — шум, а не сведения.
 *
 * Подпись площадки — слово, а не название объекта: объект виден и в своей колонке списка, и в
 * шапке карточки. Подпись исполнителя — наоборот, название контрагента: в списке оператора
 * колонки «Оператор» нет вовсе (ADR 0010), а площадке, у которой операторов несколько, слово
 * «Оператор» ничего не сообщает. Назначение сняли, а текст остался — подписываем словом: имя
 * контрагента, которого у заявки уже нет, было бы неправдой.
 *
 * Собирается здесь, а не в верстке экрана: мест показа три (таблица, карточка на телефоне,
 * карточка заявки), и разойтись подписи не должны.
 */
export function wasteRequestCommentLines(
  r: Pick<WasteRequestDto, 'comment' | 'operatorComment' | 'operatorName'>,
): WasteCommentLine[] {
  const lines: WasteCommentLine[] = [];
  if (r.comment) lines.push({ key: 'site', label: 'Площадка', text: r.comment });
  if (r.operatorComment) {
    lines.push({ key: 'operator', label: r.operatorName || 'Оператор', text: r.operatorComment });
  }
  return lines;
}

/**
 * Пишется ли ещё примечание исполнителя. У закрытой заявки — нет: с «Выполнена» работа
 * исполнителя кончена, заявка стала документом, и дописывать в неё нечего. «Завершена» и
 * «Отменена» закрыты тем более — они терминальны (ADR 0135). Понадобилась правка — администратор
 * откатывает статус, тем же порядком, что и с фактом вывоза (ADR 0035).
 */
export function wasteOperatorCommentEditable(status: RequestStatus): boolean {
  return status !== 'done' && !isClosedWasteStatus(status);
}

/**
 * Принимает ли заявка добавочный талон — правило одного места для сервера и портала (ADR 0189).
 *
 * Окно ровно одно: «Выполнена». Раньше неё талон едет вместе с закрытием — заявке, которую ещё
 * везут, предъявлять нечего, и отдельная дверь к бумаге означала бы «Новую» заявку с талоном о
 * вывозе. Позже — «Завершена», и это объявление разбора законченным (ADR 0135): бумага, доложенная
 * после точки, разбиралась бы в заявке, про которую уже сказано «принято», а сверка нарисовала бы
 * расхождение задним числом. Понадобилось — администратор возвращает заявку в «Выполнена» тем же
 * откатом, что и всюду, и окно открывается снова.
 *
 * Совпадает с окном разбора талонов (`assertReviewOpen` в маршрутах): бумагу приносят и разбирают
 * в одном и том же состоянии заявки — иначе исполнитель мог бы дослать талон туда, где его уже
 * никто не посмотрит.
 *
 * Примечание исполнителя в этом окне, наоборот, закрыто (`wasteOperatorCommentEditable`), и
 * противоречия здесь нет: словами работа исполнителя кончена, а бумага — предъявление вывоза,
 * которое заявка ждёт до самого завершения.
 */
export function wasteTicketsAttachable(status: RequestStatus): boolean {
  return status === 'done';
}

// ── История заявки (ADR 0012) ──
// Сами события описаны в `request-history.ts` — их форма общая для всех модулей заявок.
// Здесь остаётся своё: как называются поля этого модуля в перечне изменений.

/** Подписи полей в истории; ключи проставляет сервер при вычислении изменений. */
export const wasteRequestChangeLabels: Record<string, string> = {
  object: 'Объект',
  requestType: 'Тип заявки',
  containerType: 'Контейнер / машина',
  // Контейнеры на объекте (миграция 0080): чей контейнер трогаем и сколько штук.
  containerOwner: 'Владелец контейнера',
  containersCount: 'Количество контейнеров',
  // Подтверждённый вывоз чужого контейнера: событие-список — значима только правая часть.
  ownerMismatch: 'Вывоз чужого контейнера',
  wasteType: 'Тип мусора',
  volumeM3: 'Объём',
  pricePerM3: 'Цена за м³',
  amount: 'Стоимость',
  operator: 'Оператор вывоза',
  deliveryAt: 'Доставка',
  // Контакт ответственного на площадке (миграция 0062).
  responsibleName: 'Ответственный',
  responsiblePhone: 'Телефон ответственного',
  // Комментарий разведён по сторонам (ADR 0053): в истории они названы порознь — иначе «изменён
  // комментарий» не отвечает, чей.
  comment: 'Комментарий площадки',
  operatorComment: 'Комментарий оператора',
  filesAdded: 'Прикреплены файлы',
  filesRemoved: 'Откреплены файлы',
  // Добавочные талоны выполненной заявки (ADR 0189). Своя подпись, а не общая «Прикреплены
  // файлы»: талон предъявляет вывоз, а не сопровождает заявку, и в истории эти две строки
  // отвечают на разные вопросы — «чем подтверждён вывоз» и «какие бумаги к заявке приложены».
  ticketsAdded: 'Приложены талоны',
  // Факт выполнения (ADR 0035): своё событие истории — «выполнена» и «вывезено столько-то на
  // такую-то сумму» отвечают на разные вопросы. Вес назван отдельной строкой, а не общим
  // «Вывезено»: у металлолома это другая величина (ADR 0067), и одна подпись на обе означала бы,
  // что «48» и «3,2» в истории про одно и то же.
  factVolume: 'Вывезено',
  factWeight: 'Сдано металлолома',
  factPrice: 'Цена по факту',
  factCost: 'Стоимость по факту',
  // Состав техники прошлых закрытий: события больше не появляются, но в истории остаются.
  vehiclesAdded: 'Добавлены машины',
  vehiclesMarkedDeleted: 'Машины помечены на удаление',
  vehiclesRestored: 'Машины возвращены',
  vehiclesRemoved: 'Машины удалены',
};
