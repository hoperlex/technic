import type {
  AnalyticsCustomerKind,
  AnalyticsModule,
  AnalyticsQualityEntry,
  RequestStatus,
  RequestType,
} from '@technic/contracts';

/**
 * Атом сводной аналитики (план `docs/analytics-summary-export-plan.md`, Р13).
 *
 * **Все листы книги рисуются из одного набора атомов.** Свод, детализация по площадкам, динамика
 * по шагам и скрытый источник сводной таблицы — это четыре группировки одного и того же набора, а
 * не четыре запроса. Правило ADR 0180 §4 («оба листа из одной выборки») здесь становится основой:
 * второй ответ на «сколько вывезли за август» в проекте недопустим.
 *
 * Зерно атома — «модуль × заказчик × день × позиция». Мельче не нужно ни одному листу, крупнее
 * не хватило бы динамике по неделям.
 *
 * **Деньги в атоме уже разложены по дням** (Р28): стоимость заявки делится между её днями работы
 * пропорционально сменам. Иначе сумма листа «Свод» и сумма листа «Инфографика» разошлись бы на
 * заявках, начавшихся в одном месяце и закрытых в другом, — а они обязаны сходиться, потому что
 * это один и тот же набор строк.
 */
export interface AnalyticsAtom {
  module: AnalyticsModule;

  // ── Заказчик (Р4) ──
  customerKind: AnalyticsCustomerKind;
  customerId: string;
  customerCode: string;
  customerName: string;
  customerIsActive: boolean;
  /**
   * Отдел-плательщик механизации (Р22). У прочих модулей пусто: там отдел — сам заказчик и стоит
   * в `customer*`, а здесь объект это место эксплуатации, а отдел — тот, на кого идут расходы.
   */
  payerDepartmentId: string | null;
  payerDepartmentName: string | null;

  /** День отнесения по правилу своего модуля (Р11), `YYYY-MM-DD`, московский. */
  date: string;

  // ── Позиция внутри модуля ──
  /** Ключ группировки детализации: id машины, id модели механизации, «вид отхода + контейнер». */
  positionKey: string;
  positionLabel: string;
  /** Гос. номер, если позиция — машина парка; у вывоза и механизации пусто. */
  registrationNumber: string | null;

  // ── Заявка ──
  requestId: string;
  /** Человеку: «ТС-40», «М-12», «МХ-7». */
  requestLabel: string;
  requestStatus: RequestStatus;

  // ── Счётчики. Каждое поле складывается по любой группировке ──
  shifts: number;
  /**
   * День срока заказа на объект: 1 у каждого дня срока внутри периода, включая тот, на который
   * смену уже завели (Р7). Это ПЛАН, и он не обязан совпадать с фактом — разница «план 56, факт
   * 52» и есть то, ради чего колонка заводится.
   *
   * Из этого следует, что день срока порождает атом ВСЕГДА, даже когда нести ему больше нечего:
   * ни смены, ни денег. Без этого план заявки, которую забыли заполнять, оказался бы ниже плана
   * соседней — то есть колонка отвечала бы про заполненность, а не про срок.
   */
  planShifts: number;
  trips: number;
  volumeM3: number;
  /**
   * ORDERED volume of a waste request that is not done yet (fact status, `analyticsCountsAsFact`);
   * zero once it is done.
   *
   * A field of its own rather than an addition to `volumeM3`: "removed 620 m3" must stay
   * distinguishable from "ordered 620 m3" (header of `facts-waste.ts`). The book does not read it;
   * the statistics tab reads it only for its deprecated combined figures.
   */
  volumeOrderedM3: number;
  /**
   * Ticket volume of the request (ADR 0213): every ticket that is not dismissed — accepted and
   * recognised-but-unreviewed alike — except idle tickets (sum rule: `countsInWasteVolumeSum`).
   * Until ADR 0213 only accepted tickets counted; with most paper unreviewed, that column read as
   * "nothing was brought". How much of it is still a machine reading says
   * `volumeTicketsUnconfirmedM3`.
   *
   * A ticket with an unread volume is not in the sum; `ticketsWithoutVolume` counts them, because a
   * zero here would mean an empty trip.
   */
  volumeTicketsM3: number;
  /**
   * Of `volumeTicketsM3` — the volume whose completion has no price (R5 of the stats plan). A field
   * of its own and not a conclusion from zero money: once atoms are summed, "there was no price"
   * can no longer be told from "there was nothing to price".
   */
  volumeTicketsUnpricedM3: number;
  /** Of `volumeTicketsM3` — the volume of tickets nobody has accepted yet (ADR 0213). */
  volumeTicketsUnconfirmedM3: number;
  /**
   * Planned volume of the statistics tab: the ordered volume of EVERY waste request of a volume
   * type, done or not; an old request filed without a volume takes the removed one. Kept apart from
   * `volumeOrderedM3`, which is zero for done requests and so cannot answer "what was ordered".
   */
  volumePlannedM3: number;
  /**
   * Money of `volumePlannedM3`, taken from the same source as the volume (request amount, truck
   * rows or — in the fallback — the completion sum), so the planned pair always describes the same
   * requests. Not the book estimate: `moneyLow` covers unfinished requests only.
   */
  moneyPlanned: number;
  /** Share of `volumePlannedM3` that has no money: a dash, not zero, in the tab (see below). */
  volumePlannedUnpricedM3: number;
  /**
   * Share of the removed volume whose completion has no sum. The same reason as
   * `volumeTicketsUnpricedM3`: after atoms are summed, zero money no longer tells "no price" from
   * "nothing to price".
   */
  volumeFactUnpricedM3: number;
  /**
   * Tickets of the request (not dismissed, not idle) whose volume is unread. Summed as a plain
   * counter and needed next to `volumeTicketsM3`: without it "380 of 412 m3 by tickets" reads as
   * under-delivery, while the shortfall may lie entirely in one smudged field.
   */
  ticketsWithoutVolume: number;
  /** Tickets (not idle) recognised but not reviewed by a person yet (ADR 0213). */
  ticketsUnconfirmed: number;
  /**
   * Ticket scans the recognition could not read — rejected or out of attempts (ADR 0213). Counted
   * by files: how many tickets such a scan holds is exactly what is unknown.
   */
  ticketFilesUnread: number;
  /** Ticket scans read without a single ticket found on them (ADR 0213). */
  ticketFilesWithoutTickets: number;
  weightTons: number;
  engineHours: number;
  mechHours: number;
  mechDays: number;
  removals: number;
  containerOps: number;
  relocations: number;

  // ── Деньги (Р9, Р28) ──
  /** Доля факта закрытия, пришедшаяся на этот день. */
  moneyFact: number;
  moneyLow: number;
  moneyHigh: number;
  /**
   * Ticket volume in money: `volumeTicketsM3 × price_per_m3` of the completion (R5 of the stats
   * plan). Zero when the completion has no price at all — the tab tells "nothing to price" from
   * "free" by `volumeTicketsUnpricedM3`, not by a zero in this field.
   *
   * Not a share of `moneyFact`: the price is a snapshot taken at closing (ADR 0022, ADR 0026), and a
   * multiplication by it explains itself, while a proportion of the sum does not.
   */
  moneyTickets: number;
  /**
   * Удалось ли оценить заявку хоть как-нибудь. Флаг живёт на атоме, а считается по заявке:
   * `count(DISTINCT requestId) FILTER (WHERE NOT priced)` — иначе заявка с десятью сменами дала бы
   * десять «без цены» (тест `analytics-rollup`).
   */
  priced: boolean;
}

/**
 * Ответ загрузчика модуля: атомы плюс его собственные строки листа «Качество данных» (Р20).
 *
 * Качество приходит от того, кто знает данные, а не считается поверх атомов: «смены без визы» и
 * «вывозы без талона» не выводятся из счётчиков вовсе, а попытка вывести их дала бы второе
 * определение там, где уже есть первое.
 */
export interface AnalyticsFacts {
  atoms: AnalyticsAtom[];
  quality: AnalyticsQualityEntry[];
}

/** Период запроса: обе границы включительно, `YYYY-MM-DD`. */
export interface AnalyticsRange {
  from: string;
  to: string;
}

/**
 * Сужение выборки модуля — то, чего у книги нет и быть не должно.
 *
 * Книга сводит всю организацию и отказывает держателю права с узкой областью (Р3 плана аналитики),
 * поэтому зовёт загрузчик БЕЗ параметров. Сужение появилось ради экрана внутри модуля
 * (`docs/waste-stats-tab-plan.md`, Р6, Р7): там область — обычная площадочная, а разряд работы
 * один. Оба условия встают внутрь запроса, а не отсекают уже загруженное: отбор поверх готового
 * набора читал бы заявки всей компании, чтобы выбросить чужие.
 */
export interface AnalyticsFactsScope {
  /**
   * Объекты, которыми ограничена учётка (`placeObjectScopeIds`): `null` — ограничения нет,
   * пустой список — видимых объектов нет вовсе, и ответ пуст. Пустой список обязан отличаться от
   * `null`, иначе учётка без единого объекта увидела бы всю организацию.
   */
  objectIds?: readonly string[] | null;
  /** Типы заявок, которые попадают в выборку; не задан — все типы модуля. */
  requestTypes?: readonly RequestType[];
}

/**
 * Загрузчик модуля. Один запрос на модуль, все условия (период, статусы, удаление, сужение)
 * внутри, никаких запросов в цикле по объектам (Р15).
 */
export type AnalyticsFactsLoader = (
  range: AnalyticsRange,
  scope?: AnalyticsFactsScope,
) => Promise<AnalyticsFacts>;

/**
 * Позиция «техника не назначена» (Р8). Смена заказа существует и тогда, когда машины у него нет
 * ни в назначении, ни в истории: день работы записан, а чем работали — неизвестно.
 *
 * Ключ синтетический и общий на весь слой затем, чтобы счётчик «единиц техники» умел его
 * **исключать**: `count(DISTINCT positionKey)` с ним внутри объявил бы отсутствие машины ещё одной
 * машиной, и площадка с одним экскаватором и одной такой сменой показала бы две единицы.
 */
export const NO_VEHICLE_POSITION_KEY = 'no-vehicle';

/**
 * Предел атомов (Р15). Тот же приём, что у книги показаний: отказ приходит **до** сборки, словами
 * «сузьте период», а не после десяти секунд работы.
 */
export const ANALYTICS_ATOM_LIMIT = 50_000;
