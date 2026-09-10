import {
  calcVehicleRequestCost,
  rateForWorkUnit,
  vehicleWorkUnitRateLabels,
  type CompleteVehicleRequestInput,
  type VehicleOwnership,
  type VehicleRequestCompletionDto,
} from '@technic/contracts';
import type { db } from '../db/client';
import { vehicleRequestCompletions } from '../db/schema';
import { err } from '../lib/errors';

/**
 * Факт выполнения заказа техники (ADR 0029): чем заявку закрывают и во что это обошлось.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Закрывающих дверей стало две: сегодняшняя статусная ручка
 * (`PATCH /vehicle-requests/:id/status`) и дверь закрытия фактической датой
 * (`docs/vehicle-request-actual-end-date-plan.md`, Р1). Правило «ставку берёт не клиент, а сервер»
 * и запрет закрывать аренду без суммы — предметные правила самого факта, а не той двери, через
 * которую он приехал; написанные по разу в каждой, они разошлись бы молча и в деньгах. Поэтому
 * разбор факта и его запись живут здесь, а двери их зовут.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Ни статуса, ни срока, ни бумаги: факт отвечает на «сколько отработали и сколько
 * это стоило», а «до какого числа стоял заказ» — вопрос срока, и на него отвечает дверь. Сюда
 * фактическая дата приходит **посчитанной** (`CompletionDates`), а не выводится из заявки.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** number → строка для колонки numeric. */
function numToDb(v: number | null | undefined): string | null {
  return v == null ? null : String(v);
}

/**
 * Ставки назначения — всё, что факту нужно от машины: по ним считается сумма и по ним же решается,
 * обязательна ли она. Структурный тип, а не `VehicleRequestAssignmentDto`: дверь канона читает
 * назначение под блокировкой тремя колонками, и собирать ради факта весь DTO ей незачем.
 */
export interface CompletionRates {
  ownership: VehicleOwnership;
  pricePerHour: number | null;
  pricePerShift: number | null;
}

/**
 * Фактический конец работ и срок до закрытия — снимок пары (Р2, §4 плана).
 *
 * Обе половины или ни одной: «закрыли 05.08» без «было 09.08» не отвечает на вопрос, ради которого
 * снимок заведён, и это же держит CHECK таблицы. `previousDateTo` — **эффективный** конец
 * (`coalesce(date_to, date_from)`), а не сырая колонка: у однодневного заказа она пуста, и сырой
 * `null` уронил бы тот самый CHECK на самом обычном заказе на день.
 */
export interface CompletionDates {
  endedOn: string | null;
  previousDateTo: string | null;
}

/** Закрытие без фактической даты: старый статусный путь и грузоперевозка (Р3). */
const NO_ACTUAL_END: CompletionDates = { endedOn: null, previousDateTo: null };

/**
 * Факт, которым закрывают заявку (ADR 0029). Ставку берёт не клиент, а сервер — из назначения,
 * по выбранной единице: «сколько стоило» должно объясняться той ценой, о которой договорились
 * при переводе в работу, а не той, что пришла в теле запроса. Сумма приходит уже посчитанной
 * (её видел человек в окне закрытия) и правится свободно — счёт арендодателя включает перегон и
 * простой; не прислана — считается ставкой на количество.
 *
 * Возвращает DTO «как будет после записи»: им же пишется история.
 *
 * `dates` не передан — закрытие фактической даты не знает: так закрывает старая статусная ручка и
 * так закрывается грузоперевозка. Умолчание здесь безопасно ровно потому, что означает прежнее
 * поведение, а не «забыли»: новая дверь дату считает всегда и передаёт её явно.
 */
export function resolveCompletion(
  assignment: CompletionRates | null,
  input: CompleteVehicleRequestInput,
  actor: { id: string; name: string },
  dates: CompletionDates = NO_ACTUAL_END,
): VehicleRequestCompletionDto {
  const rate = rateForWorkUnit(assignment, input.workedUnit);
  const totalCost = input.totalCost ?? calcVehicleRequestCost(rate, input.workedAmount);
  // Аренда — счёт от контрагента (ADR 0027): закрытие без суммы означало бы «сколько заплатили,
  // выясним потом». Своя машина без ставок закрывается и без суммы: внутреннюю технику не всегда
  // считают в деньгах. Ставка не задана именно за выбранную единицу — об этом и говорим: обычно
  // достаточно закрыть сменами вместо часов.
  if (assignment?.ownership === 'rental' && totalCost == null) {
    throw err.unprocessable(
      `Ставка ${vehicleWorkUnitRateLabels[input.workedUnit]} у назначенной техники не задана — укажите стоимость`,
      { totalCost: 'Укажите стоимость' },
    );
  }
  return {
    workedUnit: input.workedUnit,
    workedAmount: input.workedAmount,
    rate,
    totalCost,
    completedBy: actor.id,
    completedByName: actor.name,
    completedAt: new Date().toISOString(),
    endedOn: dates.endedOn,
    previousDateTo: dates.previousDateTo,
  };
}

/**
 * Закрытие заявки: одна строка на заявку. Повторное закрытие (после отката администратором)
 * переписывает её — двух фактов об одной работе не бывает.
 *
 * Пара дат переписывается вместе со всем остальным, в том числе в `NULL`: заявка, закрытая новой
 * дверью, откаченная в работу и закрытая потом старым путём, обязана остаться без снимка, которого
 * второе закрытие не подтверждало.
 */
export async function saveCompletion(
  tx: Tx,
  requestId: string,
  c: VehicleRequestCompletionDto,
): Promise<void> {
  const values = {
    workedUnit: c.workedUnit,
    workedAmount: String(c.workedAmount),
    rate: numToDb(c.rate),
    totalCost: numToDb(c.totalCost),
    completedBy: c.completedBy,
    endedOn: c.endedOn,
    previousDateTo: c.previousDateTo,
  };
  await tx
    .insert(vehicleRequestCompletions)
    .values({ requestId, ...values })
    .onConflictDoUpdate({
      target: vehicleRequestCompletions.requestId,
      set: { ...values, completedAt: new Date(), updatedAt: new Date() },
    });
}
