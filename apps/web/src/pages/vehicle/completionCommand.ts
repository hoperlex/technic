import dayjs, { type Dayjs } from 'dayjs';
import {
  calcVehicleRequestCost,
  type CompleteVehicleRequestInput,
  rateForWorkUnit,
  type VehicleRequestDto,
  type VehicleWorkUnit,
} from '@technic/contracts';
import { calendarDayCount } from '@shared/lib';
import type { CompletionFormValues } from './CompletionFields';
import { billedCount, rentalFactOf, rentalPrefill } from './rentalCompletion';

/**
 * Сборка команды закрытия и подстановки её умолчаний (ADR 0178, Р2, Р3).
 *
 * Отдельным файлом от окна по той же границе, что `machinistCommand` отделён от своего: окно
 * спрашивает и показывает, а здесь — правила разговора с дверью. Тело у предпросмотра и у боевого
 * вызова **одно** (Л1 плана периодов), и собирается оно ровно в одном месте: вторая сборка
 * разошлась бы с первой на первом же новом поле, а вместе с ней разошёлся бы отпечаток, которым
 * сервер сверяет обещанное человеку — в него входят и единица, и количество, и сумма.
 */

/** Семантическая половина команды: ею считают предпросмотр, ею же потом закрывают (Л1). */
export interface CompletionBody {
  completion: CompleteVehicleRequestInput & { endedOn?: string };
  comment: string;
  version: number;
}

/**
 * Единица по умолчанию: та, за которую есть ставка. Смена — первая, потому что технику на объект
 * так и берут; часами закрывают то, что не доработало до смены.
 */
export function defaultUnit(request: VehicleRequestDto): VehicleWorkUnit {
  const previous = request.completion?.workedUnit;
  if (previous) return previous;
  const a = request.assignment;
  if (a?.pricePerShift != null) return 'shifts';
  if (a?.pricePerHour != null) return 'hours';
  return 'shifts';
}

/**
 * Сколько отработано «по умолчанию» — им и открывается поле.
 *
 * У спецтехники это длина **фактического** периода в сменах (день работы = смена), а не заказанного
 * (Р2): закрывают средой — подставляется работа по среду, иначе первым же движением человека стало
 * бы стирание лишних дней. Без фактической даты (арендодатель) остаётся заказанный срок: срок он не
 * двигает, и другого периода у его закрытия нет. У грузоперевозки одна подача. Часы по периоду
 * портал не угадывает — их считают по табелю.
 */
export function plannedAmount(
  request: VehicleRequestDto,
  unit: VehicleWorkUnit,
  endedOn: string | null,
): number | null {
  if (unit !== 'shifts') return null;
  if (request.requestType !== 'special_equipment') return 1;
  return calendarDayCount(request.dateFrom, endedOn ?? request.dateTo);
}

/** Дата поля календарём — ключом `YYYY-MM-DD`; `null` — поля нет или оно пусто. */
export function dateKeyOf(value: Dayjs | null | undefined): string | null {
  return value ? value.format('YYYY-MM-DD') : null;
}

/**
 * Тело двери закрытия: факт, слово закрывающего и версия (Л1). Одно и то же и у предпросмотра, и у
 * боевого вызова — расчёт обязан идти по тем входам, которыми потом закроют, иначе отпечаток не
 * сойдётся: в него входят и единица, и количество, и сумма.
 */
export function bodyOf(
  request: VehicleRequestDto,
  v: CompletionFormValues,
  unit: VehicleWorkUnit,
  endedOn: string | null,
  rental = false,
): CompletionBody {
  return {
    completion: factOf(v, unit, rental, endedOn),
    comment: (v.comment ?? '').trim(),
    version: request.version,
  };
}

/**
 * The fact half of the body — the status door of a freight request sends it alone, the completion
 * door inside `bodyOf`. A rental sends both counts and the delivery with the billed count as
 * `workedAmount` (D1, D3); any other closing sends none of them, and the server refuses them there.
 */
export function factOf(
  v: CompletionFormValues,
  unit: VehicleWorkUnit,
  rental: boolean,
  endedOn: string | null = null,
): CompletionBody['completion'] {
  return {
    workedUnit: unit,
    workedAmount: v.workedAmount!,
    totalCost: v.totalCost ?? null,
    ...(rental ? rentalFactOf(v, unit) : {}),
    ...(endedOn ? { endedOn } : {}),
  };
}

/**
 * The fields a window opens with for `start` as the unit. A repeated closing opens on the previous
 * fact: usually one number is corrected, not everything typed again. The default end date is the
 * upper bound (Р2) — today is Wednesday, the order ran to Sunday, Wednesday goes in.
 */
export function startValues(
  request: VehicleRequestDto,
  start: VehicleWorkUnit,
  basisHours: number,
  endedOn: string | null,
  rental: boolean,
): CompletionFormValues {
  const previous = request.completion;
  const amount =
    previous?.workedAmount ??
    (start === 'hours' && basisHours > 0 ? basisHours : plannedAmount(request, start, endedOn));
  const counts = rental
    ? rentalPrefill(request, basisHours, plannedAmount(request, 'shifts', endedOn))
    : {};
  const billed = rental ? billedCount(counts, start) : amount;
  return {
    endedOn: endedOn ? dayjs(endedOn) : undefined,
    workedAmount: amount,
    ...counts,
    totalCost:
      previous?.totalCost ??
      calcVehicleRequestCost(rateForWorkUnit(request.assignment, start), billed ?? 0),
    comment: '',
    cancelAck: false,
    reason: '',
  };
}
