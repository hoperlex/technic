import { z } from 'zod';
import { baseListQuery, dateOnlySchema, uuidSchema } from './common';
import type { RequestStatus, VehicleRequestType } from './enums';
import { requestStatusLabels } from './enums';
import type { VehicleOwnership } from './vehicles';
import type { WaybillStatus } from './waybills';

// ── Маршрут: рейс одной машины на одну дату (план `docs/vehicle-routes-plan.md`) ──
//
// Между заявкой и путевым листом стоит планировочный слой. Заявку кладут в маршрут переводом в
// работу, лист выписывают с маршрута отдельным действием — когда состав рейса собран. До этого
// маршрут правится свободно: заявки переставляют, водителя меняют, реквизиты рейса уточняют.
//
// Область та же, где выписывается лист 4-П (ADR 0037, ADR 0041): грузоперевозка на собственной
// технике. Заказ техники на объект рейса не знает — машина стоит на площадке неделю; арендную
// машину ведёт арендодатель, он же выписывает на неё лист.

/** Талонов заказчиков в бланке 4-П — столько же заявок держит маршрут. */
export const MAX_ROUTE_REQUESTS = 4;

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

export interface VehicleRouteDto {
  id: string;
  /** «Р-12» — по нему о рейсе говорят по телефону. */
  displayNumber: string;
  routeDate: string;
  vehicleId: string;
  /** «КамАЗ 65201 · Е646СК799» — чем едут. */
  vehicleLabel: string;
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
  requests: VehicleRouteRequestDto[];
  waybill: VehicleRouteWaybillDto | null;
  createdByName: string;
  createdAt: string;
  version: number;
}

/**
 * Маршрут в карточке и списке заявок: номер рейса, позиция в нём и есть ли лист. Тремя полями, а
 * не целым `VehicleRouteDto`: списку заявок нужна колонка, а не состав чужого рейса.
 */
export interface VehicleRequestRouteDto {
  id: string;
  displayNumber: string;
  position: number;
  hasWaybill: boolean;
}

// ── Правила ──

/**
 * Можно ли править маршрут. Выписанный лист замораживает состав, порядок, водителя и реквизиты
 * рейса: бланк уже у водителя, и запись, разошедшаяся с бумагой на руках, хуже отсутствия записи
 * (ADR 0037 п. 9). Аннулированный лист не мешает — испорченный бланк списывают и рейс пересобирают.
 *
 * Статусов заявок правило не касается вовсе: заявку закрывают и отменяют независимо от того, что
 * с листом, иначе заявку с выписанным листом было бы нечем закрыть в день рейса.
 */
export function isRouteEditable(waybillStatus: WaybillStatus | null): boolean {
  return waybillStatus === null || waybillStatus === 'cancelled';
}

export const ROUTE_FROZEN_MESSAGE =
  'По маршруту выписан путевой лист — аннулируйте его, чтобы править рейс';

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
  route: { routeDate: string; requestCount: number },
): RouteJoinCheck {
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
  driverPersonId: string | null;
  requests: readonly { displayNumber: string; status: RequestStatus }[];
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
    version: versionSchema,
  })
  .strict();
export type UpdateVehicleRouteInput = z.infer<typeof updateVehicleRouteSchema>;
export type UpdateVehicleRouteBody = z.input<typeof updateVehicleRouteSchema>;

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
