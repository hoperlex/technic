import { z } from 'zod';
import { baseListQuery, dateOnlySchema, formatPhone, uuidSchema } from './common';
import type { RequestStatus, VehicleRequestType } from './enums';
import { requestStatusLabels } from './enums';
import type { DriverDocumentGap } from './persons';
import type { VehicleOwnership, VehicleSpecValues } from './vehicles';
import type { WaybillFormCode, WaybillRequirement, WaybillStatus } from './waybills';
import { RENTAL_WAYBILL_REASON } from './waybills';

// ── Маршрут: рейс одной машины на одну дату (план `docs/vehicle-routes-plan.md`) ──
//
// Между заявкой и путевым листом стоит планировочный слой. Заявку кладут в маршрут переводом в
// работу, лист выписывают с маршрута отдельным действием — когда состав рейса собран. До этого
// маршрут правится свободно: заявки переставляют, водителя меняют, реквизиты рейса уточняют.
//
// Область та же, где выписывается лист 4-П (ADR 0037, ADR 0041): грузоперевозка на собственной
// технике. Арендную машину ведёт арендодатель, он же выписывает на неё лист.
//
// Заказ техники на объект маршрута не знает — машина стоит на площадке неделю, — но **доезжает**
// она туда своим ходом по городу, и на этот перегон выписывается тот же 4-П. Перегон — тоже рейс,
// только другого назначения: одна единица техники, одна заявка-основание и две строки «откуда —
// куда» вместо состава из заявок.

/**
 * Заявок в маршруте — столько, сколько их держит его бланк (ADR 0068).
 *
 * У 4-П число выбирает бумага: четыре строки таблицы «Задание водителю», каждая со своим талоном
 * заказчика, плюс три нижние строки блока «Дополнительное задание водителю», куда рейсы 5–7
 * печатаются одной строкой «откуда — куда, груз, контакты». Талона у них нет (`WAYBILL_COUPONS`).
 *
 * У формы № 3 бумага больше не решает ничего: задание в ней не печатается вовсе (ADR 0071) —
 * заявки легкового доезжают до водителя оповещением, а порядок их выполнения портал не
 * гарантирует. Десять осталось потолком, который держит CHECK позиции в базе (миграция `0096`), —
 * это «сколько заявок портал ведёт в одном рейсе», а не «сколько строк напечатает бланк».
 *
 * `esm2` — лист на неделю работы машины на площадке: рейса у него нет вовсе, он выписывается на
 * одну заявку (ADR 0060). Единица здесь значит «маршрутом такой лист не собирают».
 */
export const ROUTE_REQUEST_CAPACITY: Record<WaybillFormCode, number> = {
  '4p': 7,
  leg3: 10,
  esm2: 1,
};

/**
 * Сколько заявок держит маршрут с этим бланком. `null` — бланк не выписывается (арендная машина):
 * ёмкость берётся наибольшая, потому что запрещает такой рейс не она, а `assertRouteVehicle`, и
 * отвечать «мест нет» там, где дело не в местах, значило бы объяснять человеку не ту причину.
 */
export function routeRequestCapacity(formCode: WaybillFormCode | null): number {
  return formCode ? ROUTE_REQUEST_CAPACITY[formCode] : MAX_ROUTE_REQUESTS;
}

/**
 * Потолок по всем бланкам: им ограничены схема перестановки и CHECK позиции в базе. Сколько
 * заявок влезет в конкретный маршрут, решает его бланк — `routeRequestCapacity`.
 */
export const MAX_ROUTE_REQUESTS = Math.max(...Object.values(ROUTE_REQUEST_CAPACITY));

/**
 * Талонов заказчиков в бланке 4-П. Талон отрывной: заказчик расписывается в нём за выполненный
 * рейс. Заявки сверх четвёртой едут по строке доп. задания и подписи заказчика не собирают —
 * диспетчер, собирая маршрут, обязан это видеть. У формы № 3 талонов нет вовсе.
 */
export const WAYBILL_COUPONS = 4;

// ── Назначение рейса ──

/**
 * Зачем рейс.
 *
 * `freight` — маршрут грузоперевозки: состав из заявок, талоны заказчиков, бланк по типу ТС.
 * `delivery` и `pickup` — перегон спецтехники на объект и обратно: состава нет, есть заявка,
 * ради которой едут, и задание «откуда — куда».
 */
export const ROUTE_PURPOSES = ['freight', 'delivery', 'pickup'] as const;
export const routePurposeSchema = z.enum(ROUTE_PURPOSES);
export type RoutePurpose = (typeof ROUTE_PURPOSES)[number];

export const routePurposeLabels: Record<RoutePurpose, string> = {
  freight: 'Грузоперевозка',
  delivery: 'Доставка техники на объект',
  pickup: 'Вывоз техники с объекта',
};

/** Короткая пометка в списке рейсов: рядом с номером «Р-12» слово «Доставка» читается само. */
export const routePurposeShortLabels: Record<RoutePurpose, string> = {
  freight: 'Рейс',
  delivery: 'Доставка',
  pickup: 'Вывоз',
};

/** Перегон техники: рейс без состава, с заявкой-основанием и заданием «откуда — куда». */
export function isRelocationPurpose(purpose: RoutePurpose): boolean {
  return purpose !== 'freight';
}

/** Отображаемый номер маршрута: «Р-12» (в БД хранится только число). */
export function formatVehicleRouteNumber(num: number): string {
  return `Р-${num}`;
}

/** Разбор пользовательского ввода поиска: «12» / «Р-12» / «р-0012» → 12. */
export function parseVehicleRouteNumberSearch(input: string): number | undefined {
  const digits = input.replace(/^[рРpP]\s*-?\s*/u, '').trim();
  if (!/^\d+$/.test(digits)) return undefined;
  const num = Number(digits);
  return Number.isSafeInteger(num) && num > 0 ? num : undefined;
}

// ── Реквизиты рейса ──
// Прицеп, гаражный номер, вид сообщения и вид перевозки описывают выезд, а не заявку: от рейса к
// рейсу они почти не меняются, поэтому форма подставляет их от прошлого рейса этой машины, а
// человек правит раз в сезон. До появления маршрутов они жили в назначении заявки под именем
// `waybillFieldsSchema` (ADR 0037) — там же осталось устаревшее имя, пока его читает старое тело
// запроса на перевод в работу.

export const routeTripFieldsSchema = z
  .object({
    /**
     * Рейс с прицепом. Признак рейса, а не свойство машины: прицепа в реестре техники нет, а
     * требование к категории водителя он поднимает — «C» превращается в «CE».
     */
    withTrailer: z.boolean().optional().default(false),
    trailer1Model: z.string().trim().max(100).optional().default(''),
    trailer1RegNumber: z.string().trim().max(20).optional().default(''),
    trailer2Model: z.string().trim().max(100).optional().default(''),
    trailer2RegNumber: z.string().trim().max(20).optional().default(''),
    /** Гаражный номер машины: если пуст, берётся из справочника техники. */
    garageNumber: z.string().trim().max(50).optional().default(''),
    /** Вид сообщения: «городское», «пригородное», «междугородное». */
    communicationKind: z.string().trim().max(50).optional().default(''),
    /** Вид перевозки: в образцах бланка — «коммерческая». */
    transportationKind: z.string().trim().max(50).optional().default(''),
  })
  .strict()
  .refine(
    (w) =>
      w.withTrailer ||
      (!w.trailer1Model && !w.trailer1RegNumber && !w.trailer2Model && !w.trailer2RegNumber),
    { message: 'Реквизиты прицепа без прицепа в рейсе не печатаются', path: ['withTrailer'] },
  );
export type RouteTripFields = z.infer<typeof routeTripFieldsSchema>;

// ── DTO ──

/** Заявка в составе рейса: талон будущего листа плюс то, что показывает карточка маршрута. */
export interface VehicleRouteRequestDto {
  requestId: string;
  /** «ТС-123» — номер заявки, как его читают в портале. */
  displayNumber: string;
  /** Позиция в рейсе, 1..4; она же `slot` талона заказчика в бланке. */
  position: number;
  /**
   * Статус заявки: отменённая или закрытая остаётся в маршруте историей рейса (лист уже выписан),
   * но новый лист по такому составу не выписывается — см. `canIssueWaybill`.
   */
  status: RequestStatus;
  /** Заказчик: объект строительства или отдел (ADR 0040). */
  customerName: string;
  loadingLocation: string;
  unloadingLocation: string;
  scheduledAt: string;
  scheduledTimeUnspecified: boolean;
  /** «12 м³» либо «8 т» — тем же правилом, которым груз печатается в бланке. */
  cargoLabel: string;
}

/** Лист, выписанный по рейсу: действующий, а если его нет — последний аннулированный. */
export interface VehicleRouteWaybillDto {
  id: string;
  /** «260604-646-00000004897» — как номер напечатан на бланке. */
  number: string;
  status: WaybillStatus;
  issuedForDate: string;
}

/** Заявка, ради которой едет перегон: у рейса перемещения она вместо состава. */
export interface VehicleRouteSourceRequestDto {
  requestId: string;
  /** «ТС-501» — номер заявки, как его читают в портале. */
  displayNumber: string;
  status: RequestStatus;
  /** Заказчик: объект строительства или отдел (ADR 0040). */
  customerName: string;
}

export interface VehicleRouteDto {
  id: string;
  /** «Р-12» — по нему о рейсе говорят по телефону. */
  displayNumber: string;
  /** Зачем рейс: грузоперевозка либо перегон техники на объект и обратно. */
  purpose: RoutePurpose;
  /**
   * Бланк, по которому выпишется лист: у грузового рейса — закреплённый за типом машины, у
   * перегона — всегда 4-П. `null` — лист не выписывается вовсе (тип без бланка). Портал спрашивает
   * его не ради документа: у формы № 3 нет граф прицепа, и вводить их реквизиты незачем.
   */
  formCode: WaybillFormCode | null;
  routeDate: string;
  vehicleId: string;
  /** «КамАЗ 65201 · Е646СК799» — чем едут. */
  vehicleLabel: string;
  /**
   * Вид и тип машины рейса и ТТХ её категории. Ими заявка сверяет заказанное с тем, чем рейс
   * поедет (ADR 0059, ADR 0064): подсказка рейсов не сужена ни типом, ни видом — она помечает
   * каждый рейс (заказанный тип, крупнее, меньше, другой вид) и этим же порядком стоит. Сравнение
   * считает портал правилом из контрактов (`vehicleSubstitutionOf`): сервер здесь ничего не
   * решает и ничего не запрещает.
   */
  vehicleKindId: string;
  vehicleTypeId: string;
  vehicleTypeName: string;
  vehicleCategoryId: string | null;
  vehicleCategorySpecs: VehicleSpecValues | null;
  /** Пусто — водителя ещё не назначили: маршрут собирают заранее, человека ставят утром. */
  driverPersonId: string | null;
  driverName: string;
  /**
   * Чего не хватает назначенному водителю для листа на дату рейса (ADR 0064); пусто — комплект
   * полный либо водителя ещё нет. Выписку не останавливает: по нему карточка предупреждает о
   * графах, которые в бланке останутся пустыми, — до печати, а не после.
   */
  driverGaps: DriverDocumentGap[];
  withTrailer: boolean;
  trailerLabel: string;
  trailer1Model: string;
  trailer1RegNumber: string;
  trailer2Model: string;
  trailer2RegNumber: string;
  garageNumber: string;
  communicationKind: string;
  transportationKind: string;
  comment: string;
  /** Состав грузового рейса; у перегона пуст — талонов заказчиков там не бывает. */
  requests: VehicleRouteRequestDto[];
  /** Заявка-основание перегона; у грузового рейса `null` — его основание это состав. */
  sourceRequest: VehicleRouteSourceRequestDto | null;
  /** Задание перегона: откуда и куда едет техника. У грузового рейса пусто. */
  moveFrom: string;
  moveTo: string;
  waybill: VehicleRouteWaybillDto | null;
  createdByName: string;
  createdAt: string;
  version: number;
}

/**
 * Маршрут в карточке и списке заявок: номер рейса, позиция в нём и есть ли лист. Несколькими
 * полями, а не целым `VehicleRouteDto`: списку заявок нужна колонка, а не состав чужого рейса.
 */
export interface VehicleRequestRouteDto {
  id: string;
  displayNumber: string;
  /**
   * День рейса. Заявке он не свой — свой у неё день подачи, — но они обязаны совпадать
   * (`canJoinRoute`), и разойтись могут только правкой одной из сторон. По этому полю портал и
   * ловит расхождение (`routeDateMismatch`): без него «заявка уехала на завтра, а рейс остался
   * на сегодня» обнаруживалось бы у принтера.
   */
  routeDate: string;
  position: number;
  hasWaybill: boolean;
  /**
   * Версия рейса — ею перенос заявки опознаёт исходный маршрут (`attachRouteRequestSchema.source`).
   * Без неё пришлось бы грузить рейс отдельным запросом перед каждым переносом, а между чтением и
   * отправкой рейс успевал бы измениться — и оптимистическая блокировка проверяла бы устаревшее.
   */
  version: number;
}

// ── Правила ──

/**
 * Можно ли править маршрут. Выписанный лист замораживает состав, порядок, водителя и реквизиты
 * рейса: бланк уже у водителя, и запись, разошедшаяся с бумагой на руках, хуже отсутствия записи
 * (ADR 0037 п. 9). Аннулированный лист не мешает — испорченный бланк списывают и рейс пересобирают.
 *
 * Движения заявки вперёд по циклу правило не касается: заявку закрывают и отменяют независимо от
 * того, что с листом, иначе заявку с выписанным листом было бы нечем закрыть в день рейса. Назад —
 * касается: возврат в «Новую» стирает работу, а стереть её у заявки, стоящей в выданном бланке,
 * значило бы разойтись с бумагой на руках (`ROLLBACK_WAYBILL_MESSAGE`).
 */
export function isRouteEditable(waybillStatus: WaybillStatus | null): boolean {
  return waybillStatus === null || waybillStatus === 'cancelled';
}

export const ROUTE_FROZEN_MESSAGE =
  'По маршруту выписан путевой лист — аннулируйте его, чтобы править рейс';

/**
 * Отказ вернуть в «Новую» заявку с выписанным листом. Отмене лист не мешает — отменённая заявка
 * остаётся талоном выданного бланка, — а возврат в работу-с-нуля мешает: заявка снова пойдёт в
 * чей-то рейс, и одна и та же работа окажется сразу в двух действующих документах (ADR 0050).
 */
export const ROLLBACK_WAYBILL_MESSAGE =
  'По заявке выписан действующий путевой лист — аннулируйте его, чтобы вернуть заявку в «Новую»';

/**
 * Предупреждение о расхождении дат: заявку правят, а она лежит в рейсе другого дня.
 *
 * Такое расхождение портал не запрещает — заявку и рейс правят разные люди в разное время, — но и
 * молчать о нём нельзя: рейс останется на прежнем дне, а лист напечатает задание, которого в этот
 * день уже нет. Человека отправляют туда, где это чинится, — в карточку маршрута.
 */
export function routeDateMismatch(
  request: { tripDate: string },
  route: { displayNumber: string; routeDate: string },
): string | null {
  if (request.tripDate === route.routeDate) return null;
  return `Заявка теперь на ${request.tripDate}, а маршрут ${route.displayNumber} заведён на ${route.routeDate}. Лист печатает задание на день рейса — перенесите маршрут или выньте из него заявку.`;
}

/**
 * Бланк, по которому выписывается лист этого рейса.
 *
 * У грузового рейса его выбирает тип машины (ADR 0037 п. 1) — самосвалу 4-П, легковой форма № 3.
 * У перегона бланк всегда 4-П, независимо от типа: экскаватор идёт по дорогам общего пользования
 * как транспортное средство, и документ у этой поездки один.
 *
 * Отказ здесь один — принадлежность: на арендную машину лист выписывает арендодатель, и перегон
 * арендной техники его же забота. Прежний второй отказ («у типа не заведён бланк») снят вместе с
 * пустым значением колонки: бланк есть у каждого типа, по умолчанию 4-П (ADR 0065).
 */
export function routeWaybillForm(input: {
  purpose: RoutePurpose;
  ownership: VehicleOwnership;
  /** Бланк, закреплённый за типом ТС; решает только грузовой рейс. */
  formCode: WaybillFormCode;
}): WaybillRequirement {
  if (input.ownership !== 'own') {
    return { formCode: null, reason: RENTAL_WAYBILL_REASON };
  }
  if (isRelocationPurpose(input.purpose)) return { formCode: '4p', reason: null };
  return { formCode: input.formCode, reason: null };
}

export const ROUTE_LEGACY_WAYBILL_MESSAGE =
  'По заявке уже выписан путевой лист вне маршрутов — аннулируйте его или дождитесь переноса истории';

/** Что не так с заявкой для этого рейса; `{ ok: true }` — годится. */
export type RouteJoinCheck = { ok: true } | { ok: false; reason: string };

/**
 * Годится ли заявка для маршрута.
 *
 * Порядок проверок задаёт и то, что прочитает человек: сначала «такие заявки в рейс не ходят»
 * (вид, принадлежность машины), потом состояние самой заявки, и только потом — вместимость.
 * Дата сверяется календарная: лист печатает задание на день, и заявка соседнего дня напечатала бы
 * рейс, которого в этот день не было.
 */
export function canJoinRoute(
  request: {
    requestType: VehicleRequestType;
    status: RequestStatus;
    deletedAt: string | null;
    /** Дата рейса заявки по МСК, `YYYY-MM-DD`: у грузоперевозки её несёт время подачи. */
    tripDate: string;
    /** Принадлежность назначенной машины; `null` — машина ещё не назначена. */
    ownership: VehicleOwnership | null;
  },
  route: {
    routeDate: string;
    requestCount: number;
    purpose: RoutePurpose;
    /** Бланк рейса: им задана вместимость — у 4-П семь строк задания, у формы № 3 десять. */
    formCode: WaybillFormCode | null;
  },
): RouteJoinCheck {
  // Перегон везёт одну единицу техники по одной заявке-основанию, и состава у него нет вовсе:
  // задание из нескольких строк — про грузоперевозку, где машина за смену объезжает несколько
  // площадок.
  if (isRelocationPurpose(route.purpose)) {
    return {
      ok: false,
      reason: 'Это перегон техники — заявки в него не кладут, он едет по своей одной',
    };
  }
  if (request.requestType !== 'freight_transport') {
    return {
      ok: false,
      reason: 'В рейс ходят только грузоперевозки: техника на объект не едет по маршруту',
    };
  }
  if (request.deletedAt) return { ok: false, reason: 'Заявка удалена' };
  if (request.status !== 'confirmed') {
    return {
      ok: false,
      reason: `Заявка в статусе «${requestStatusLabels[request.status]}» — в рейс кладут заявку в работе`,
    };
  }
  if (request.ownership !== 'own') {
    return {
      ok: false,
      reason:
        request.ownership === null
          ? 'На заявку не назначена техника'
          : 'Путевой лист на арендную технику выписывает арендодатель — маршрут ей не ведётся',
    };
  }
  if (request.tripDate !== route.routeDate) {
    return {
      ok: false,
      reason: `Заявка подаётся ${request.tripDate}, а маршрут заведён на ${route.routeDate}`,
    };
  }
  const capacity = routeRequestCapacity(route.formCode);
  if (route.requestCount >= capacity) {
    return {
      ok: false,
      reason: `${capacityLimit(route.formCode, capacity)} — заведите второй маршрут`,
    };
  }
  return { ok: true };
}

/**
 * Чем ограничена вместимость рейса — так, как это читает человек. У 4-П её задаёт бумага: сверх
 * седьмой заявки печатать задание некуда. У формы № 3 задание не печатается вовсе (ADR 0071), и
 * ссылаться на строки бланка стало неправдой — предел там портальный.
 */
function capacityLimit(formCode: WaybillFormCode | null, capacity: number): string {
  return formCode === 'leg3'
    ? `В рейсе легкового ${capacity} мест`
    : `В листе ${capacity} строк задания`;
}

/**
 * Вынимать ли заявку из маршрута при смене её статуса.
 *
 * «Выполнена» состав не трогает: рейс состоялся, и связь заявки с маршрутом — история, а не план.
 * Отмена и возврат в «Новую» заявку вынимают — рейса не будет, держать её в плане незачем, — но
 * только пока маршрут не заморожен выписанным листом: из бумаги, которая уже у водителя, заявка
 * исчезнуть не может.
 */
export function shouldDetachOnStatus(next: RequestStatus, frozen: boolean): boolean {
  if (frozen) return false;
  return next === 'cancelled' || next === 'new';
}

/** Готов ли рейс к выписке листа; `blocking` — номера заявок, из-за которых лист не выписать. */
export type IssueWaybillCheck =
  { ok: true } | { ok: false; reason: string; blocking: readonly string[] };

/**
 * Отказ выписать лист по рейсу без заявок. Право `waybills.issueBlank` его снимает (ADR 0071) —
 * поэтому текст называет причину, а не запрет: у того, кто такие бланки не выписывает, пустой
 * рейс это чаще всего забытый состав.
 */
export const BLANK_WAYBILL_DENIED = 'В маршруте нет заявок — лист выписывать не на что';

/**
 * Подтверждение выписки пустого бланка. Спрашивается всегда, а не только при пробелах в
 * документах водителя: номер строгой отчётности расходуется на лист, задание в котором портал не
 * печатает вовсе, и вернуть его можно только аннулированием.
 */
export const BLANK_WAYBILL_CONFIRM =
  'В маршруте нет заявок: лист выпишется с машиной, водителем и датой, но с пустым заданием — его вписывают от руки.';

/**
 * Можно ли выписать лист по этому рейсу.
 *
 * Отдельно от `isRouteEditable` проверяются статусы заявок: заявку отменили, пока маршрут был
 * заморожен (она осталась талоном выданного бланка), лист аннулировали, маршрут разморозился — и
 * без этой проверки следующая выписка молча внесла бы отменённую заявку в новый документ. То же и
 * с закрытой: «Выполнена» в маршруте — история состоявшегося рейса, а не задание на новый.
 */
export function canIssueWaybill(route: {
  purpose: RoutePurpose;
  driverPersonId: string | null;
  /**
   * Разрешено ли выписать лист по рейсу без заявок (право `waybills.issueBlank`, ADR 0071).
   * Пустым остаётся только задание: машина, водитель и дата — реквизиты самого рейса, и без них
   * лист не выписывается никому.
   */
  blankAllowed?: boolean;
  /**
   * Бланк рейса: у 4-П он задаёт, сколько строк задания напечатается. Состав собирался под него
   * (`canJoinRoute`), но бланк типа машины правится справочником (ADR 0065) — и рейс легкового,
   * собранный на десять заявок, мог остаться с семью строками 4-П.
   */
  formCode: WaybillFormCode | null;
  requests: readonly { displayNumber: string; status: RequestStatus }[];
  /** Заявка-основание перегона: у грузового рейса её нет, у перегона она вместо состава. */
  sourceRequest: { displayNumber: string; status: RequestStatus } | null;
  /** Лист, уже выписанный по этому рейсу: действующий выписать второй не даёт. */
  waybillStatus: WaybillStatus | null;
}): IssueWaybillCheck {
  if (!isRouteEditable(route.waybillStatus)) {
    return { ok: false, reason: 'По маршруту уже выписан действующий путевой лист', blocking: [] };
  }
  if (!route.driverPersonId) {
    return {
      ok: false,
      reason: 'Назначьте водителя — он обязательный реквизит листа',
      blocking: [],
    };
  }
  /*
   * У перегона состава нет: вместо талонов заказчиков он держит заявку, ради которой едет. Её
   * состояние и проверяется — отменённая означает, что технику никуда не повезут, а «Новая» —
   * что заявку откатили и машина с неё снята. «Выполнена» перегону не мешает: технику вывозят
   * с объекта и после того, как работы закрыли.
   */
  if (isRelocationPurpose(route.purpose)) {
    const source = route.sourceRequest;
    if (!source) {
      return {
        ok: false,
        reason: 'У перегона нет заявки — лист выписывать не на что',
        blocking: [],
      };
    }
    if (source.status === 'cancelled' || source.status === 'new') {
      return {
        ok: false,
        reason: `Заявка в статусе «${requestStatusLabels[source.status]}» — перегон по ней не выписывают`,
        blocking: [source.displayNumber],
      };
    }
    return { ok: true };
  }
  /*
   * Рейс без заявок. Обычной выписке это отказ: лист рождается из работы по заявкам, и бланк без
   * задания расходовал бы номер строгой отчётности ни на что.
   *
   * По праву `waybills.issueBlank` — не отказ, а решение человека (ADR 0071): диспетчеру нужен
   * пустой бланк на машину и водителя, чтобы задание вписали от руки в дороге. Пустым при этом
   * остаётся только задание — машина, водитель и дата приходят из самого рейса, и лист без них не
   * выписывается ни с правом, ни без.
   */
  if (route.requests.length === 0 && !route.blankAllowed) {
    return { ok: false, reason: BLANK_WAYBILL_DENIED, blocking: [] };
  }
  const blocking = route.requests.filter((r) => r.status !== 'confirmed');
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: 'В маршруте есть заявки не в работе — уберите их из рейса или заведите новый маршрут',
      blocking: blocking.map((r) => r.displayNumber),
    };
  }
  /*
   * Состав не влезает в бланк. Собрать такой рейс портал не даёт, но бланк типа машины меняют
   * справочником уже после сборки (ADR 0065) — и лишние заявки напечатались бы пустым местом:
   * бумага у водителя, а часть работы дня в ней не названа. Лучше отказать до расхода номера.
   */
  const capacity = routeRequestCapacity(route.formCode);
  if (route.requests.length > capacity) {
    return {
      ok: false,
      reason: `${capacityLimit(route.formCode, capacity)}, а в маршруте заявок ${route.requests.length} — уберите лишние или заведите второй маршрут`,
      blocking: route.requests.slice(capacity).map((r) => r.displayNumber),
    };
  }
  return { ok: true };
}

/**
 * Груз в том виде, в каком его печатает бланк: объём, а если его нет — масса. Правило одно на
 * портал и на снимок листа, чтобы карточка рейса и бумага не расходились в единицах.
 */
export function routeCargoLabel(
  volumeM3: string | number | null,
  weightTons: string | number | null,
): string {
  if (volumeM3 !== null && volumeM3 !== '') return `${volumeM3} м³`;
  if (weightTons !== null && weightTons !== '') return `${weightTons} т`;
  return '';
}

/**
 * Сколько знаков комментария печатается в графе «Груз» бланка 4-П.
 *
 * Число снято с бумаги, а не выведено из ширины колонок: графа (объединение `AT75:BF75`) держит
 * около двадцати знаков в строку при кегле 6 pt, а высота строки — ровно две строки, из которых
 * первую занимает сам груз. Двадцать первый знак уезжает на третью строку, которой в строке листа
 * нет, и обрезается по её границе — молча и посреди слова, как это уже было с наименованием
 * машины в ЭСМ-2 (ADR 0060). Поэтому режет портал и ставит многоточие: у обрыва должен быть
 * виден обрыв.
 *
 * Предел с запасом: шрифт пропорциональный, и «ЖЖЖ» шире «ллл» — считать знаки можно только
 * приблизительно, а третья строка не должна появляться и на самой широкой записи.
 */
export const CARGO_NOTE_LIMIT = 20;

/**
 * Груз в том виде, в каком он идёт в бланк: количество первой строкой, комментарий заявки —
 * второй (ADR 0071).
 *
 * Комментарий у заявки свободный и многострочный («песок, звонить за час»), а графа держит одну
 * строку под него — поэтому переводы строк схлопываются, а хвост отрезается многоточием.
 * Собирает строку портал, а не бланк: склейка плейсхолдеров в ячейке оставила бы у заявки без
 * комментария пустую вторую строку, а у заявки без груза — начинающуюся с переноса графу.
 */
export function routeCargoWithNote(cargo: string, comment: string): string {
  const note = comment.replace(/\s+/gu, ' ').trim();
  const short =
    note.length > CARGO_NOTE_LIMIT ? `${note.slice(0, CARGO_NOTE_LIMIT - 1).trimEnd()}…` : note;
  return [cargo.trim(), short].filter((part) => part !== '').join('\n');
}

/**
 * ФИО ответственного так, как его пишет бланк: фамилия с инициалами. В заявке человека называют
 * полностью, а графа держит около полусотни знаков в строку и ровно две строки по высоте —
 * «Кузнецова Анна Владимировна, +7 914 123-45-67» переносится на вторую строку и вытесняет с
 * бумаги контакт разгрузки.
 *
 * Сокращается только запись ровно из трёх слов, каждое из которых начинается буквой и точек в
 * себе не несёт. Всё прочее — одно имя, должность рядом с фамилией, уже сокращённые инициалы —
 * печатается как есть: разобрать, где здесь отчество, а где примечание, портал не берётся.
 */
function contactNameLabel(name: string): string {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/u);
  if (parts.length !== 3) return trimmed;
  const [family, first, patronymic] = parts as [string, string, string];
  if ([family, first, patronymic].some((part) => part.includes('.') || !/^\p{L}/u.test(part))) {
    return trimmed;
  }
  return `${family} ${first[0]!.toUpperCase()}.${patronymic[0]!.toUpperCase()}.`;
}

/**
 * Контакты задания в том виде, в каком их печатает графа «заказчик, телефон» бланка 4-П: строка
 * на каждый конец маршрута — кто отдаёт груз и кто его принимает.
 *
 * Строки не подписаны «погрузка/разгрузка»: порядок тот же, что у граф «откуда» и «куда» той же
 * строки задания, а подпись вытеснила бы из графы телефон. Пустой контакт пропускается целиком, а
 * не печатается пустой строкой: у заявок старше миграции 0062 контакта нет вовсе, и одинокая
 * запятая читалась бы как потерянный номер.
 */
export function routeContactsLabel(contacts: readonly { name: string; phone: string }[]): string {
  return contacts
    .map(({ name, phone }) =>
      // Номер печатается тем же видом, что и везде (ADR 0066): в бланке его читают и набирают.
      [contactNameLabel(name), formatPhone(phone.trim())].filter((part) => part !== '').join(', '),
    )
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Задание рейсов 5–7 одной строкой — так, как их печатает блок «Дополнительное задание водителю»
 * бланка 4-П (ADR 0068).
 *
 * Графы там нет ни одной: три нижние строки блока — это три объединённые ячейки во всю ширину, и
 * «откуда», «куда», груз и контакты приходится складывать в строку самим. Порядок тот же, что у
 * граф таблицы выше, — водитель читает обе части бланка подряд, и менять местами их нельзя.
 *
 * Номер рейса в строку не идёт: в четырёх строках таблицы его тоже не печатают, а рядом с адресом
 * он читался бы как номер дома. Собирается строка на сервере, а не склейкой плейсхолдеров в
 * ячейке: у пустого рейса из бланка вышли бы осиротевшие стрелка и запятые.
 *
 * Контакты приходят готовой подписью `routeContactsLabel` — двумя строками, погрузка и разгрузка.
 * Здесь они сводятся в одну через «; »: строк у ячейки две, и перенос внутри контактов вытеснил бы
 * с бумаги вторую половину задания. Тем же порядком сводится груз: с комментарием заявки он идёт
 * двумя строками (`routeCargoWithNote`), а здесь строка одна на всё задание.
 */
export function routeExtraTaskLine(task: {
  from: string;
  to: string;
  cargo: string;
  contacts: string;
}): string {
  const oneLine = (value: string): string =>
    value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join('; ');
  const route = [task.from.trim(), task.to.trim()].filter((part) => part !== '').join(' → ');
  return [route, oneLine(task.cargo), oneLine(task.contacts)]
    .filter((part) => part !== '')
    .join(', ');
}

// ── Схемы ──

/** Версия маршрута: оптимистическая блокировка, как у заявки. */
const versionSchema = z.coerce.number().int().min(0);

/**
 * Откуда и куда едет перегон. Свободная строка, а не адрес из подсказок: техника уходит с базы, с
 * прошлой площадки или из ремонта, и половина этих мест в ФИАС не значится.
 */
const moveLocationSchema = z.string().trim().min(1, 'Укажите место').max(1000);

export const createVehicleRouteSchema = z
  .object({
    vehicleId: uuidSchema,
    routeDate: dateOnlySchema,
    /** Водителя назначают и позже: маршрут собирают заранее, человека ставят утром. */
    driverPersonId: uuidSchema.nullable().optional(),
    trip: routeTripFieldsSchema.optional(),
    comment: z.string().trim().max(2000).optional().default(''),
  })
  .strict();
export type CreateVehicleRouteInput = z.infer<typeof createVehicleRouteSchema>;
export type CreateVehicleRouteBody = z.input<typeof createVehicleRouteSchema>;

export const updateVehicleRouteSchema = z
  .object({
    /**
     * День рейса. Меняется вместе с составом: заявка едет в тот день, в который заведён рейс, и
     * лист печатает задание на него (`canJoinRoute`). Поэтому сервер переносит и время подачи
     * заявок рейса — иначе рейс и его заявки разошлись бы по разным дням, а бумага напечатала бы
     * работу, которой в этот день никто не заказывал.
     */
    routeDate: dateOnlySchema.optional(),
    driverPersonId: uuidSchema.nullable().optional(),
    trip: routeTripFieldsSchema.optional(),
    comment: z.string().trim().max(2000).optional(),
    /** Задание перегона: правится, пока лист не выписан. У грузового рейса сервер их не примет. */
    moveFrom: moveLocationSchema.optional(),
    moveTo: moveLocationSchema.optional(),
    version: versionSchema,
  })
  .strict();
export type UpdateVehicleRouteInput = z.infer<typeof updateVehicleRouteSchema>;
export type UpdateVehicleRouteBody = z.input<typeof updateVehicleRouteSchema>;

/**
 * Перегон техники по заявке: доставка на объект или вывоз с него (миграция 0082).
 *
 * Заводится по желанию — портал не знает, поедет техника своим ходом или тралом, и решать это ему
 * нечем. Машина не спрашивается: её несёт назначение заявки, и «перегнать одну, а работать другой»
 * — не состояние, а расхождение.
 *
 * Дата отдельная: у заявки спецтехники период работ, а перегон — один день внутри него (обычно
 * первый и последний, но техника приезжает и накануне).
 */
export const createRelocationRouteSchema = z
  .object({
    purpose: z.enum(['delivery', 'pickup']),
    routeDate: dateOnlySchema,
    driverPersonId: uuidSchema.nullable().optional(),
    moveFrom: moveLocationSchema,
    moveTo: moveLocationSchema,
    trip: routeTripFieldsSchema.optional(),
    comment: z.string().trim().max(2000).optional().default(''),
  })
  .strict();
export type CreateRelocationRouteInput = z.infer<typeof createRelocationRouteSchema>;
export type CreateRelocationRouteBody = z.input<typeof createRelocationRouteSchema>;

/**
 * Положить заявку в рейс или перенести её из другого.
 *
 * Исходный маршрут опознаётся парой «кто + версия», а не одной версией: версии нумеруются в каждом
 * маршруте отдельно, и после конкурентного переноса в третий маршрут одинокая версия совпала бы
 * случайно. Сервер проверяет, что заявка **сейчас** лежит именно в `source.routeId`.
 */
export const attachRouteRequestSchema = z
  .object({
    requestId: uuidSchema,
    version: versionSchema,
    source: z.object({ routeId: uuidSchema, version: versionSchema }).strict().optional(),
  })
  .strict();
export type AttachRouteRequestInput = z.infer<typeof attachRouteRequestSchema>;
export type AttachRouteRequestBody = z.input<typeof attachRouteRequestSchema>;

/**
 * Новый порядок заявок — полным списком, а не парой «подвинуть вверх»: сервер переписывает талоны
 * целиком, и две одновременные перестановки не соберут дыр в нумерации.
 */
export const routeOrderSchema = z
  .object({
    requestIds: z.array(uuidSchema).min(1).max(MAX_ROUTE_REQUESTS),
    version: versionSchema,
  })
  .strict()
  .refine((v) => new Set(v.requestIds).size === v.requestIds.length, {
    message: 'Заявка не может стоять в рейсе дважды',
    path: ['requestIds'],
  });
export type RouteOrderInput = z.infer<typeof routeOrderSchema>;
export type RouteOrderBody = z.input<typeof routeOrderSchema>;

/** Выписка листа и изъятие заявки версию тоже сверяют — состав рейса меняют оба. */
export const issueRouteWaybillSchema = z.object({ version: versionSchema }).strict();
export type IssueRouteWaybillInput = z.infer<typeof issueRouteWaybillSchema>;

export const routeVersionQuerySchema = z.object({ version: versionSchema });
export type RouteVersionQuery = z.infer<typeof routeVersionQuerySchema>;

/**
 * Маршрут при переводе заявки в работу: существующий рейс этой машины на эту дату либо новый.
 * Ровно одно из двух — «и то, и другое» означало бы два разных ответа на вопрос, куда едет заявка.
 */
export const assignRouteSchema = z.union([
  z.object({ routeId: uuidSchema }).strict(),
  z
    .object({
      newRoute: z
        .object({
          driverPersonId: uuidSchema.optional(),
          trip: routeTripFieldsSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type AssignRouteInput = z.infer<typeof assignRouteSchema>;
export type AssignRouteBody = z.input<typeof assignRouteSchema>;

export const VEHICLE_ROUTE_SORT_FIELDS = ['routeDate', 'num', 'createdAt'] as const;

export const vehicleRouteListQuerySchema = baseListQuery(VEHICLE_ROUTE_SORT_FIELDS).extend({
  /** Период рейсов: маршруты читают по дням, а не всей историей сразу. */
  dateFrom: dateOnlySchema.optional(),
  dateTo: dateOnlySchema.optional(),
  vehicleId: uuidSchema.optional(),
  driverPersonId: uuidSchema.optional(),
  num: z.coerce.number().int().positive().optional(),
  /** Состояние документа: «ещё не выписан» — то, чем диспетчер закрывает день. */
  waybill: z.enum(['none', 'issued']).optional(),
  /** Есть ли куда положить ещё одну заявку — форма перевода в работу спрашивает только такие. */
  hasFreeSlots: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});
export type VehicleRouteListQuery = z.infer<typeof vehicleRouteListQuerySchema>;
