import { z } from 'zod';
import { uuidSchema } from './common';
import { requestStatusLabels, type RequestStatus, type VehicleRequestType } from './enums';
import { isShiftDayInTerm, shiftDaysOf } from './vehicle-request-shifts';
import {
  dayAlreadyPlannedMessage,
  routeTripFieldsSchema,
  type RouteJoinDay,
} from './vehicle-routes';
import type { VehicleOwnership } from './vehicles';
import type { WaybillStatus } from './waybills';

// ── Дни линейного заказа (ADR 0100) ──
// Линейная техника вечером возвращается на базу, а за день успевает поработать на двух-трёх
// площадках. Поэтому её заказ ведётся не неделями стояния на объекте, а днями: каждый день срока —
// отдельный выезд, который кладут в рейс машины на эту дату и печатают в его 4-П.
//
// Своей таблицы у дней нет и не будет (ADR 0100 §2): перечень выводится из срока заявки тем же
// приёмом, каким выводятся дни смен (`shiftDaysOf`), а материализуется только факт «этот день
// поставлен в такой-то рейс» — колонкой `work_date` в составе рейса (миграция 0127).
//
// Правила живут здесь, а не на сервере, по той же причине, что и правила смен и досрочного
// завершения (ADR 0044): портал обязан не предлагать того, что сервер отклонит, — и объяснять
// недоступное теми же словами, которыми откажет API.

/**
 * Заявка глазами правил дней. Структурный тип, а не `Pick` от DTO: модуль стоит в импортах раньше
 * самих заявок, и обратная ссылка замкнула бы круг — тем же порядком устроен `ShiftSubject`.
 */
export interface LinearDaySubject {
  requestType: VehicleRequestType;
  /**
   * Линейный ли **заказанный** тип (ADR 0100 §1). Читается живым признаком справочника: снимка в
   * заявке нет намеренно — заказ решает, как заявка ведётся, а сменить признак под работающими
   * заказами портал не даёт.
   */
  isLinear: boolean;
  status: RequestStatus;
  deletedAt: string | null;
  dateFrom?: string;
  dateTo?: string | null;
  /** Принадлежность назначенной машины; `null` — техника ещё не назначена. */
  ownership: VehicleOwnership | null;
}

/** Рейс, в который поставлен день: чем и с кем выехали и какая бумага на это выписана. */
export interface VehicleRequestDayRouteDto {
  id: string;
  /** «Р-12» — по нему о рейсе говорят по телефону. */
  displayNumber: string;
  /** Строка задания в бланке; она же `slot` талона заказчика (ADR 0068). */
  position: number;
  vehicleId: string;
  /** «КамАЗ 65201 · Е646СК799» — чем выехали в этот день. */
  vehicleLabel: string;
  /** Пусто — водителя ещё не назначили: рейс собирают заранее, человека ставят утром. */
  driverPersonId: string | null;
  driverName: string;
  /**
   * Лист рейса: действующий замораживает день — снять его с рейса нельзя, бланк уже у водителя
   * (`LINEAR_DAY_FROZEN_MESSAGE`). Аннулированный не держит: испорченный бланк списан.
   */
  waybill: { id: string; number: string; status: WaybillStatus } | null;
  /** Версия рейса — ею снятие дня опознаёт рейс, как перенос заявки опознаёт исходный маршрут. */
  version: number;
}

/**
 * Часы дня и подпись объекта под ними. Ведёт их таблица смен (`vehicle_request_shifts`, ADR 0100
 * §12): ключ `(request_id, shift_date)` у неё уже совпадает с ключом дня, и второй такой таблицы
 * заводить не пришлось. Здесь — короткая выжимка: полную смену показывает своя вкладка.
 */
export interface VehicleRequestDayShiftDto {
  startedAt: string | null;
  endedAt: string | null;
  machineHours: number;
  /** Подпись объекта за этот день; `null` — день ещё не согласован. */
  approvedAt: string | null;
  approvedByName: string | null;
}

/** День линейного заказа: сам день, его рейс и то, что за этот день уже подтвердили. */
export interface VehicleRequestDayDto {
  /** `YYYY-MM-DD`. */
  date: string;
  /**
   * День за пределами нынешнего срока. В норме таких не бывает — сверка снимает их с рейсов
   * (`syncLinearRouteDays`), — но замороженный выписанным листом рейс день не отдаёт: срок
   * сократили, а бумага на этот день уже у водителя, и молча спрятать её нельзя.
   */
  outOfTerm: boolean;
  /** Рейс дня; `null` — день ещё не распланирован. */
  route: VehicleRequestDayRouteDto | null;
  /** Смена дня; `null` — часы за этот день ещё не вносили. */
  shift: VehicleRequestDayShiftDto | null;
  /**
   * Машина дня не та, что стоит в назначении заявки. Расхождение законное и помечается, а не
   * отклоняется (ADR 0100 §4): назначение у линейного заказа — машина по умолчанию, а работает в
   * конкретный день та, чьим рейсом день закрыт. Ради этого признак и заведён.
   */
  otherVehicle: boolean;
}

/** Распланированный день до того, как его сверили со сроком: `outOfTerm` считает `linearDaysOf`. */
export type PlannedVehicleRequestDay = Omit<VehicleRequestDayDto, 'outOfTerm'>;

/**
 * Таблица дней заказа и день среза. `blocker` — почему по этой заявке дней не ведут вовсе: у
 * арендной заявки блок дней обязан показывать причину, а не пустую таблицу.
 */
export interface VehicleRequestDaysDto {
  items: VehicleRequestDayDto[];
  /** День среза (`YYYY-MM-DD`) по Москве: его считает сервер — часы клиента бывают сбиты. */
  onDate: string;
  blocker: string | null;
}

/**
 * Почему по этой заявке нельзя вести дни вовсе — текстом, либо `null`, если можно. Одна функция на
 * портал и API: сервер отвечает этой строкой (422), портал ею же объясняет пустую таблицу дней.
 *
 * Порядок — от «это не та заявка» к «этой заявке пока нечем»: первым читается то, что не
 * исправить здесь и сейчас.
 */
export function linearDaysBlocker(r: LinearDaySubject): string | null {
  if (r.requestType !== 'special_equipment') {
    return 'Дни планируют по заказу техники на объект: у грузоперевозки рейс и есть сама работа';
  }
  if (!r.isLinear) {
    return 'Заказ ведётся неделями стояния машины на площадке — по дням планируют только линейную технику';
  }
  if (r.deletedAt) return 'Заявка в архиве';
  if (r.status !== 'confirmed') {
    return `Заявка в статусе «${requestStatusLabels[r.status]}» — дни планируют у заявки в работе`;
  }
  // Машина назначения — машина дня по умолчанию (ADR 0100 §4), и без неё непонятно даже, чем
  // заявку взяли в работу. Арендная в рейсы не ходит вовсе: лист на неё выписывает арендодатель,
  // и дней у такого заказа не бывает (план У14).
  if (r.ownership === null) {
    return 'На заявку не назначена техника — дни планировать нечем';
  }
  if (r.ownership !== 'own') {
    return 'Заявку ведут арендной техникой: в рейсы она не ходит, путевой лист на неё выписывает арендодатель';
  }
  if (!r.dateFrom) return 'У заказа не заполнен срок работ — дней у него нет';
  return null;
}

/**
 * Почему нельзя распланировать этот день. Сверх общего запрета — две границы: день обязан
 * принадлежать сроку заявки и не стоять уже в другом рейсе.
 *
 * Будущий день здесь, в отличие от смен, законен и планируется первым делом: рейс на завтра
 * собирают сегодня, ради этого маршруты и заведены. Прошедший — тоже: бумагу оформляют и задним
 * числом, а запрет отправил бы такой выезд мимо портала.
 */
export function planDayBlocker(
  r: LinearDaySubject,
  day: string,
  /** Дни этой заявки, уже стоящие в рейсах. */
  plannedDays: readonly string[],
): string | null {
  const blocker = linearDaysBlocker(r);
  if (blocker) return blocker;
  // Те же слова, что у смен (`shiftDayBlocker`): день у них общий, и два разных объяснения одной
  // границы читались бы как две разные границы.
  if (!isShiftDayInTerm(r, day)) return 'День вне срока заявки';
  if (plannedDays.includes(day)) return dayAlreadyPlannedMessage(day);
  return null;
}

/** Можно ли распланировать этот день — тот же разбор, что и `planDayBlocker`. */
export function canPlanDay(
  r: LinearDaySubject,
  day: string,
  plannedDays: readonly string[],
): boolean {
  return planDayBlocker(r, day, plannedDays) === null;
}

/**
 * Отказ снять день с замороженного рейса: бланк уже у водителя, и исчезнуть из него день не
 * может — сначала лист аннулируют. Тем же правилом рейс держит заявку при смене её статуса
 * (`shouldDetachOnStatus`).
 */
export const LINEAR_DAY_FROZEN_MESSAGE =
  'По рейсу этого дня выписан путевой лист — аннулируйте его, чтобы снять день';

/**
 * Дни срока с приклеенным планом — ими и рисуется таблица «Дни работ».
 *
 * Основа — сам срок: строк в базе на эти дни может не быть вовсе, и пустой день это не пробел, а
 * «на этот день ещё никого не назначили». Распланированные дни за пределами срока не выбрасываются,
 * а помечаются `outOfTerm`: их оставил замороженный лист, и прятать выданную бумагу нельзя.
 */
export function linearDaysOf(
  term: Pick<LinearDaySubject, 'dateFrom' | 'dateTo'>,
  planned: readonly PlannedVehicleRequestDay[],
): VehicleRequestDayDto[] {
  const byDate = new Map(planned.map((day) => [day.date, day]));
  // Дни заказа считаются тем же `shiftDaysOf`, что и дни смен: это один и тот же перечень дней
  // одного и того же срока, и разъехаться им нельзя — иначе таблица дней и таблица смен показали
  // бы разные строки одной заявки.
  const days = new Set(shiftDaysOf(term));
  const items: VehicleRequestDayDto[] = [];
  for (const date of days) {
    const plan = byDate.get(date);
    items.push(plan ? { ...plan, outOfTerm: false } : emptyDay(date));
  }
  for (const plan of planned) {
    if (!days.has(plan.date)) items.push({ ...plan, outOfTerm: true });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

/** День, на который ещё ничего не назначили: строка в таблице есть, а плана за ней нет. */
function emptyDay(date: string): VehicleRequestDayDto {
  return { date, outOfTerm: false, route: null, shift: null, otherVehicle: false };
}

/**
 * Ответ линейного заказа на вопрос рейса о дне (`canJoinRoute`). Собирается одной функцией, а не
 * тремя полями по месту: срок и уже занятые дни — это то, чем линейная заявка отличается от
 * грузовой, и складывать их заново в каждом вызывающем значило бы плодить копии правила.
 */
export function linearRouteJoinDay(
  term: Pick<LinearDaySubject, 'dateFrom' | 'dateTo'>,
  plannedDays: readonly string[],
): RouteJoinDay {
  return {
    kind: 'linear',
    dateFrom: term.dateFrom ?? '',
    dateTo: term.dateTo ?? null,
    plannedDays,
  };
}

// ── Схемы ──

/**
 * Поставить день в рейс: в уже заведённый рейс машины на этот день либо в новый, заведённый тут же.
 * Ровно одно из двух — «и то, и другое» означало бы два разных ответа на вопрос, куда едет день.
 *
 * Машина в новом рейсе спрашивается, а не берётся из назначения: у линейного заказа назначение —
 * машина по умолчанию, а на разные дни выходят разные единицы (ADR 0100 §4, §8). Водитель
 * необязателен: рейс собирают заранее, человека ставят утром, — и подставлять вчерашнего портал не
 * вправе (ADR 0083).
 *
 * Дата в теле не передаётся: день — часть адреса (`/days/:date/route`), и второй ответ на «за
 * какой это день» расходился бы с первым — тем же порядком устроены смены.
 */
export const planVehicleRequestDaySchema = z.union([
  z.object({ routeId: uuidSchema }).strict(),
  z
    .object({
      newRoute: z
        .object({
          vehicleId: uuidSchema,
          driverPersonId: uuidSchema.nullable().optional(),
          trip: routeTripFieldsSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type PlanVehicleRequestDayInput = z.infer<typeof planVehicleRequestDaySchema>;
export type PlanVehicleRequestDayBody = z.input<typeof planVehicleRequestDaySchema>;
