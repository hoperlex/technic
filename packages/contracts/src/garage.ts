import { z } from 'zod';
import { baseListQuery, dateOnlySchema, uuidSchema } from './common';
import {
  classificationFilterSchema,
  withSingleClassificationForm,
} from './vehicle-classifications';
import type { RequestStatus } from './enums';
import type { CredentialTypeCode, DriverDocumentGap } from './persons';
import type { RoutePurpose } from './vehicle-routes';
import type { VehicleStatus } from './vehicles';
import type { WaybillStatus } from './waybills';

/**
 * Гараж: чем заняты собственная техника и водители в конкретный день.
 *
 * Модуль читающий и целиком производный — своих таблиц у него нет. День машины сегодня лежит в
 * четырёх местах сразу: рейс — в `vehicle_routes`, заказ спецтехники — в назначении заявки со
 * сроком в её деталях, неделя работы на площадке — в листе ЭСМ-2, нерабочее состояние — в статусе
 * самой машины. Каждый из четырёх списков отвечает про своё, и **свободной** машины не видно ни в
 * одном: свобода это отсутствие строки во всех сразу, а такого экрана в портале не было.
 *
 * Отсюда два правила модуля, из которых следует всё остальное:
 *
 * - перечень **полный** — в нём стоит каждая живая машина парка и каждый действующий водитель, в
 *   том числе те, у кого на этот день нет ничего;
 * - действий нет вовсе. Срез отвечает «кто чем занят», а ведут работу там, где её правила и
 *   живут: номера — ссылки в заявку, рейс и журнал листов. Второе место, где рейс собирают или
 *   ставят водителя, означало бы второй набор правил рейса.
 */

// ── Состояние дня ──

/**
 * Чем машина занята в этот день — одно значение из четырёх, по старшинству сверху вниз.
 *
 * Старшинство существенно: машина, стоящая на объекте, в тот же день ездит перегоном, а машина в
 * ремонте вполне может числиться в рейсе, заведённом заранее. Колонка обязана называть **главное**,
 * поэтому состояние одно, а полный список занятостей едет рядом (`busy`) и показывает все.
 *
 * Считает состояние сервер одним SQL-выражением: по нему же идут фильтр, сортировка и сводка —
 * четыре разных ответа на один вопрос разъехались бы при первом же изменении правила.
 */
export const GARAGE_VEHICLE_STATES = ['unavailable', 'on_site', 'on_route', 'free'] as const;
export type GarageVehicleState = (typeof GARAGE_VEHICLE_STATES)[number];
export const garageVehicleStateSchema = z.enum(GARAGE_VEHICLE_STATES);

export const garageVehicleStateLabels: Record<GarageVehicleState, string> = {
  // Своей подписи «в ремонте/списана» здесь нет намеренно: чем именно машина недоступна, говорит
  // её статус (`vehicleStatusLabels`) — он и стоит второй строкой в колонке.
  unavailable: 'недоступна',
  on_site: 'на объекте',
  on_route: 'в рейсе',
  free: 'свободна',
};

export const garageVehicleStateColors: Record<GarageVehicleState, string> = {
  unavailable: 'red',
  on_site: 'purple',
  on_route: 'blue',
  // Свободная машина — не «всё хорошо», а вопрос дня: её ищут, чтобы дать работу. Зелёным, чтобы
  // выхватывалась взглядом из списка занятых.
  free: 'green',
};

/**
 * Водитель на этот день: занят или свободен. Третьего состояния нет — недоступного водителя
 * портал не знает: увольнение закрывает специализацию, и такой человек в справочнике уже не
 * водитель, а пробелы в документах никого не убирают (ADR 0064) и едут отдельным признаком.
 */
export const GARAGE_DRIVER_STATES = ['assigned', 'free'] as const;
export type GarageDriverState = (typeof GARAGE_DRIVER_STATES)[number];
export const garageDriverStateSchema = z.enum(GARAGE_DRIVER_STATES);

export const garageDriverStateLabels: Record<GarageDriverState, string> = {
  assigned: 'назначен',
  free: 'свободен',
};

export const garageDriverStateColors: Record<GarageDriverState, string> = {
  assigned: 'blue',
  free: 'green',
};

// ── Занятость ──

/** Машина занятости: ею строка водителя называет, на чём он едет. */
export interface GarageBusyVehicle {
  vehicleId: string;
  /** «Е646СК799» либо марка/тип — тем же правилом, что и везде (`vehicleLabel`). */
  vehicleLabel: string;
}

/** Человек занятости: им строка техники называет, кто за рулём. */
export interface GarageBusyDriver {
  driverPersonId: string | null;
  /** Пусто — водителя ещё не поставили: рейс собирают заранее, человека ставят утром. */
  driverName: string;
}

/** Лист, выписанный по рейсу: номер бланка и что с ним стало. */
export interface GarageBusyWaybill {
  waybillId: string;
  /** «260604-646-00000004897» — как номер напечатан на бланке и как его ищут в журнале. */
  number: string;
  status: WaybillStatus;
}

/** Заявка в составе рейса: номер, заказчик и статус — по ним из гаража и переходят в заявку. */
export interface GarageBusyRequest {
  requestId: string;
  /** «ТС-123» — номер заявки, как его читают в портале. */
  displayNumber: string;
  status: RequestStatus;
  /** Заказчик: объект строительства или отдел (ADR 0040). */
  customerName: string;
  /**
   * День линейного заказа, ради которого строка стоит в рейсе (ADR 0100 §2); `null` —
   * грузоперевозка, у неё своего дня нет: день несёт сам рейс.
   *
   * Различие не формальное, и подпись обязана его называть: заказ линейной техники больше не
   * занимает машину на весь срок (ADR 0100 §12), а показывается ровно тем рейсом, которым машина в
   * этот день выехала. Без дня такая строка читалась бы как обычная перевозка — «Р-12, состав
   * ТС-15», — и диспетчер не увидел бы главного: машина работает на площадке по заказу ТС-15, а не
   * везёт по нему груз. Заявка-основание перегона и недельного листа дня не несёт никогда.
   */
  workDate: string | null;
}

/**
 * Рейс этого дня. У перегона (`purpose <> 'freight'`) состава нет: его задание — заявка-основание
 * и «откуда — куда», ровно как в списке маршрутов.
 *
 * С ADR 0100 в составе стоят и дни линейных заказов: занятость такой машины говорит рейс дня, а не
 * срок заявки, — и рейс, отвечающий «на объекте по ТС-15», приходит сюда же, где раньше был только
 * груз (`GarageBusyRequest.workDate`).
 */
export interface GarageRouteBusy extends GarageBusyVehicle, GarageBusyDriver {
  kind: 'route';
  routeId: string;
  /** «Р-12» — по нему о рейсе говорят по телефону. */
  displayNumber: string;
  purpose: RoutePurpose;
  requests: GarageBusyRequest[];
  moveFrom: string;
  moveTo: string;
  sourceRequest: GarageBusyRequest | null;
  waybill: GarageBusyWaybill | null;
}

/**
 * Заказ спецтехники, накрывающий этот день: машина стоит на площадке весь срок заявки, рейсов при
 * этом нет — работа идёт на месте.
 *
 * Линейного заказа здесь не бывает (ADR 0100 §12): его машина вечером возвращается на базу, и
 * занятость дня у неё говорит рейс — `GarageRouteBusy` со днём в составе.
 */
export interface GarageSpecialBusy extends GarageBusyVehicle {
  kind: 'special';
  requestId: string;
  displayNumber: string;
  status: RequestStatus;
  /** Заказчик заявки: объект строительства (отдел спецтехнику не заказывает). */
  customerName: string;
  dateFrom: string;
  /** Пусто — однодневный срок: `coalesce(date_to, date_from)`, как и в отборе. */
  dateTo: string | null;
  /** Смена этого дня: заполнена ли и подписана ли объектом; `null` — строки за день нет вовсе. */
  shift: { filled: boolean; approved: boolean } | null;
  /** Запрошено досрочное завершение и ждёт визы (ADR 0044): срок ещё прежний, но машина уедет. */
  earlyEndPending: boolean;
}

/**
 * Действующий недельный лист ЭСМ-2 (ADR 0060). Самостоятельный источник, а не приписка к заказу:
 * заявку могли закрыть, а бланк недели остаётся у машиниста — машина по документу всё ещё занята.
 */
export interface GarageEsm2Busy extends GarageBusyVehicle, GarageBusyDriver {
  kind: 'esm2';
  waybillId: string;
  number: string;
  status: WaybillStatus;
  periodFrom: string;
  periodTo: string;
  /** Заявка-основание листа; `null` — заявку удалили, а бланк в журнале остался. */
  sourceRequest: GarageBusyRequest | null;
}

/**
 * Чем занят день — размеченным объединением по `kind`. Одним типом на обе вкладки: у водителя
 * бывают те же две записи, что у машины (рейс и недельный лист), и вторая пара типов ради одного
 * поля означала бы два описания одного и того же дня.
 *
 * Листов 4-П и № 3 отдельным видом здесь нет: такой лист выписывается **по рейсу** и едет внутри
 * него (`GarageRouteBusy.waybill`) — второй строкой он повторял бы уже показанное.
 */
export type GarageBusyEntry = GarageRouteBusy | GarageSpecialBusy | GarageEsm2Busy;

// ── Строки ──

/** Строка вкладки «Техника»: краткая карточка машины и её день. */
export interface GarageVehicleDto {
  id: string;
  /** Состояние дня — главное из занятостей; полный их список рядом, в `busy`. */
  state: GarageVehicleState;
  /** Состояние самой машины: им объясняется `unavailable` («в ремонте», «списана»). */
  status: VehicleStatus;
  /** Как машину называют в списках (`vehicleLabel`). */
  label: string;
  registrationNumber: string | null;
  /** Гаражный номер — своя графа бланка, отдельная от инвентарного (ADR 0037). */
  garageNumber: string;
  modelName: string | null;
  vehicleTypeId: string;
  typeName: string;
  vehicleCategoryId: string | null;
  categoryName: string | null;
  busy: GarageBusyEntry[];
  /**
   * Кто сегодня за рулём этой машины — из её же занятостей. Отдельным полем, а не выуживанием из
   * `busy` на портале: колонка «Водитель» есть в таблице, а собирать её из объединения в разметке
   * значило бы повторять правило «водитель бывает у рейса и у недельного листа» в каждом месте.
   */
  drivers: { personId: string; fullName: string }[];
  /**
   * Последнее числовое показание одометра **не позже дня среза** и день, за который его сняли
   * (план «Показания техники», Р16).
   *
   * Не «последнее вообще», и разница не теоретическая: показания правят задним числом (ADR 0101),
   * после чего «последнее известное» и «известное на 10 марта» — разные числа. Гараж отвечает про
   * конкретный день, тот же самый, которым он считает занятость.
   *
   * Дата снятия едет рядом с числом и подписью-украшением не является: одометр без даты читается
   * как сегодняшний и врёт тем сильнее, чем дольше машина стоит.
   *
   * Три состояния, и они разные:
   *
   * - **поля нет вовсе** — у смотрящего нет `vehicleReadings.read`. Одометр принадлежит модулю
   *   показаний, а не гаражу (`garage.read` открывает срез дня, а не цифры приборов), и колонка
   *   такому человеку не показывается. `null` тут означал бы «показаний не было» — то есть врал бы
   *   про парк вместо того, чтобы промолчать про доступ;
   * - `null` — право есть, а числового показания не позже дня среза за машиной не числится;
   * - объект — само число и день, за который его сняли.
   */
  lastOdometer?: { km: number; measuredOn: string } | null;
}

/** Строка вкладки «Водители»: краткая карточка человека и его день. */
export interface GarageDriverDto {
  personId: string;
  state: GarageDriverState;
  fullName: string;
  personnelNo: string;
  /** Десять цифр без кода страны (ADR 0066); пусто — не указан. */
  phone: string;
  /**
   * Чем подписаны пробелы: каким документом человек допущен по должности (ADR 0095). Портал
   * показывает пробелы подсказкой («без номера ВУ»), и без вида документа подпись врёт — у
   * машиниста экскаватора в кабину едет удостоверение тракториста-машиниста.
   */
  credentialTypeCode: CredentialTypeCode;
  /** «7712 345678» — серия с номером удостоверения, которым выпишется лист на этот день. */
  licenseNumber: string;
  licenseExpiresOn: string | null;
  /** Категории того же удостоверения: «B», «C», «CE». */
  categories: string[];
  /**
   * Чего не хватает для листа на выбранный день (`driverDocumentGaps`); пусто — комплект полный.
   * Состоянием не является (ADR 0064): пробелы помечают строку, а работать человеку не мешают.
   */
  gaps: DriverDocumentGap[];
  busy: GarageBusyEntry[];
}

// ── Запросы ──

/**
 * Сортировка обеих вкладок. `state` — не украшение: гараж открывают вопросом «кто свободен», и
 * порядок по состоянию собирает ответ в начало списка.
 */
export const GARAGE_VEHICLE_SORT_FIELDS = ['state', 'registrationNumber', 'typeName'] as const;

export const GARAGE_DRIVER_SORT_FIELDS = ['state', 'fullName'] as const;

/**
 * День среза — в запросе, а не «сегодня» сервера: этим гараж и отличается от вкладки «На объекте»
 * (ADR 0036). Там срез отвечает про текущий момент, здесь день выбирают — завтрашний, чтобы
 * распределить работу, вчерашний, чтобы вспомнить, кто куда ездил. Пустой `on` означает сегодня по
 * Москве, и посчитает его всё равно сервер: часы браузера бывают сбиты, а восточнее Москвы сутки
 * начинаются раньше.
 */
const garageDayQuery = { on: dateOnlySchema.optional() };

export const garageVehicleQuerySchema = withSingleClassificationForm(
  baseListQuery(GARAGE_VEHICLE_SORT_FIELDS).extend({
    ...garageDayQuery,
    state: garageVehicleStateSchema.optional(),
    // Набор позиций классификатора (ADR 0028): тип целиком либо его категория, несколько сразу —
    // тот же фильтр, что в списке заявок и на «На объекте».
    classifications: classificationFilterSchema.optional(),
    // Прежняя форма того же фильтра — одна позиция парой полей: её шлют вкладки со старым JS.
    vehicleTypeId: uuidSchema.optional(),
    vehicleCategoryId: uuidSchema.optional(),
  }),
);
export type GarageVehicleQuery = z.infer<typeof garageVehicleQuerySchema>;

export const garageDriverQuerySchema = baseListQuery(GARAGE_DRIVER_SORT_FIELDS).extend({
  ...garageDayQuery,
  state: garageDriverStateSchema.optional(),
  /** Комплект документов на день среза — тот же фильтр, что в справочнике водителей. */
  documents: z.enum(['complete', 'incomplete']).optional(),
});
export type GarageDriverQuery = z.infer<typeof garageDriverQuerySchema>;

// ── Ответы ──

/**
 * `onDate` — день, по которому сервер собирал строки. Возвращается всегда, даже когда клиент
 * прислал `on`: подписи вида «день 3 из 5» и сводка обязаны считаться от того же дня, что и отбор.
 */
export interface GarageVehicleListDto {
  items: GarageVehicleDto[];
  total: number;
  page: number;
  pageSize: number;
  onDate: string;
}

export interface GarageDriverListDto {
  items: GarageDriverDto[];
  total: number;
  page: number;
  pageSize: number;
  onDate: string;
}

/**
 * Итог по парку на день. Считается по тем же фильтрам, что и таблица, кроме самого состояния:
 * фильтр по состоянию свёл бы сводку к одной её цифре.
 */
export interface GarageVehiclesSummaryDto {
  total: number;
  free: number;
  onRoute: number;
  onSite: number;
  unavailable: number;
  /**
   * Рейсы этого дня, в которых ещё нет водителя. Цифра, ради которой сводку и открывают утром:
   * без водителя лист не выписать, а по состоянию машины этого не видно — она уже «в рейсе».
   */
  routesWithoutDriver: number;
  onDate: string;
}

export interface GarageDriversSummaryDto {
  total: number;
  free: number;
  assigned: number;
  /** Сколько водителей с пробелами в документах на этот день — долг кадровика, а не запрет. */
  documentsIncomplete: number;
  onDate: string;
}
