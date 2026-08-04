import { z } from 'zod';
import { baseListQuery, dateOnlySchema, uuidSchema } from './common';
import type { RequestStatus, VehicleRequestType } from './enums';
import { requestStatusLabels } from './enums';
import type { VehicleOwnership, VehicleSpecValues } from './vehicles';
import type { WaybillFormCode, WaybillRequirement, WaybillStatus } from './waybills';

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

/** Талонов заказчиков в бланке 4-П — столько же заявок держит маршрут. */
export const MAX_ROUTE_REQUESTS = 4;

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
   * Тип машины рейса и ТТХ её категории. Ими заявка сверяет заказанное с тем, чем рейс поедет
   * (ADR 0059): подсказка рейсов больше не сужена равенством типов, а помечает каждый рейс —
   * заказанный тип, крупнее, меньше. Сравнение считает портал правилом из контрактов
   * (`vehicleSubstitutionOf`): сервер здесь ничего не решает и ничего не запрещает.
   */
  vehicleTypeId: string;
  vehicleTypeName: string;
  vehicleCategoryId: string | null;
  vehicleCategorySpecs: VehicleSpecValues | null;
  /** Пусто — водителя ещё не назначили: маршрут собирают заранее, человека ставят утром. */
  driverPersonId: string | null;
  driverName: string;
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
 * Бланк, по которому выписывается лист этого рейса.
 *
 * У грузового рейса его выбирает тип машины (ADR 0037 п. 1) — самосвалу 4-П, легковой форма № 3.
 * У перегона бланк всегда 4-П, независимо от типа: экскаватор идёт по дорогам общего пользования
 * как транспортное средство, и документ у этой поездки один. Проставить `waybill_form_code` типам
 * спецтехники нельзя — тогда экскаватор попал бы в подсказки грузовых рейсов и прошёл бы проверку
 * машины маршрута, а заявку на грузоперевозку экскаватором портал собрать не должен.
 *
 * Принадлежность спрашивается у обоих: на арендную машину лист выписывает арендодатель, и
 * перегон арендной техники — его же забота.
 */
export function routeWaybillForm(input: {
  purpose: RoutePurpose;
  ownership: VehicleOwnership;
  /** Бланк, закреплённый за типом ТС; решает только грузовой рейс. */
  formCode: WaybillFormCode | null;
  /** Название типа ТС — им объясняется отсутствие бланка. */
  typeName: string;
}): WaybillRequirement {
  if (input.ownership !== 'own') {
    return { formCode: null, reason: 'Путевой лист на арендную технику выписывает арендодатель' };
  }
  if (isRelocationPurpose(input.purpose)) return { formCode: '4p', reason: null };
  if (!input.formCode) {
    return {
      formCode: null,
      reason: `Для типа «${input.typeName}» бланк путевого листа не заведён`,
    };
  }
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
  route: { routeDate: string; requestCount: number; purpose: RoutePurpose },
): RouteJoinCheck {
  // Перегон везёт одну единицу техники по одной заявке-основанию, и состава у него нет вовсе:
  // талоны заказчиков — про грузоперевозку, где машина за смену объезжает четверых.
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
  if (route.requestCount >= MAX_ROUTE_REQUESTS) {
    return {
      ok: false,
      reason: `В листе ${MAX_ROUTE_REQUESTS} талона заказчиков — заведите второй маршрут`,
    };
  }
  return { ok: true };
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
  if (route.requests.length === 0) {
    return { ok: false, reason: 'В маршруте нет заявок — лист выписывать не на что', blocking: [] };
  }
  const blocking = route.requests.filter((r) => r.status !== 'confirmed');
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: 'В маршруте есть заявки не в работе — уберите их из рейса или заведите новый маршрут',
      blocking: blocking.map((r) => r.displayNumber),
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
