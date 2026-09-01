import type {
  ChangeMechRequestStatusInput,
  CounterpartyType,
  MechRateUnit,
} from '@technic/contracts';
import { err } from '../lib/errors';
import { numToDb, type MechTx } from './mech-request-dto';
import { assertMechLessorAssignable, type LockedMechRequest } from './mech-request-guards';

// Что делает со строкой переход статуса механизации (план `docs/mechanization-module-plan.md`, Р2,
// Р7, Р8). Отдельно от маршрута, потому что переход у модуля несёт больше, чем статус: договорённость
// приезжает вместе с «В работе», факт возврата — вместе с «Выполнена», а вход в «Новую» стирает
// обоих. Отдельными запросами их пришлось бы проводить не атомарно со сменой статуса, и заявка на
// секунду оказывалась бы в состоянии, которого CHECK-и не допускают.
//
// Функция возвращает ПЛАН, а не пишет сама: строгий аудит требует знать, какие события переход
// породил, и решать это в трёх местах маршрута значило бы трижды переспрашивать «а была ли выдача».

/** Договорённость: пять колонок живут и умирают вместе (`deal_parts_check`, Р6). */
export interface MechDealColumns {
  lessorId: string | null;
  lessorType: CounterpartyType | null;
  lessorIsActive: boolean | null;
  rate: string | null;
  rateUnit: MechRateUnit | null;
}

/** Договорённости нет вовсе: `num_nonnulls(...) = 0`, чего и требует CHECK у «Новой». */
export const NO_MECH_DEAL: MechDealColumns = {
  lessorId: null,
  lessorType: null,
  lessorIsActive: null,
  rate: null,
  rateUnit: null,
};

/** Факт: выдача и возврат. Возврат целиком или его нет — `return_parts_check`. */
export interface MechFactColumns {
  actualFrom: string | null;
  actualTo: string | null;
  actualUnits: string | null;
  finalCost: string | null;
}

/**
 * Факта нет вовсе — пустое из трёх допустимых состояний лестницы `issue_first`/`return_parts`
 * («фактов нет», «только выдача», «выдача плюс полный возврат»). Промежуточных ступеней у неё нет.
 */
export const NO_MECH_FACT: MechFactColumns = {
  actualFrom: null,
  actualTo: null,
  actualUnits: null,
  finalCost: null,
};

/** Договорённость глазами истории — ровно то, что показывает событие `mech_request.deal`. */
export interface MechDealView {
  lessorName: string | null;
  rate: number | null;
  rateUnit: MechRateUnit | null;
}

/** Факт возврата глазами истории — то, что показывает событие `mech_request.complete`. */
export interface MechCompletionView {
  actualFrom: string | null;
  actualTo: string | null;
  actualUnits: number | null;
  rateUnit: MechRateUnit | null;
  finalCost: number | null;
}

const EMPTY_DEAL_VIEW: MechDealView = { lessorName: null, rate: null, rateUnit: null };

export interface MechTransitionPlan {
  deal: MechDealColumns;
  fact: MechFactColumns;
  /** Договорённость после перехода; `null` — событие `deal` не пишется, менять было нечего. */
  dealAfter: MechDealView | null;
  /** День выдачи, проставленный ЭТИМ переходом; `null` — события `issue` нет. */
  issuedAt: string | null;
  /** Факт возврата, предъявленный ЭТИМ переходом; `null` — события `complete` нет. */
  completion: MechCompletionView | null;
}

/**
 * Во что переход превращает договорённость и факт — и какие предметные события он порождает.
 *
 * Проверок здесь три, и каждая закрывает свою потерю денег:
 *
 * 1. **«В работе» без арендодателя и ставки** — это не состояние заявки, а потерянные деньги (Р8).
 *    Тот же отказ дал бы и CHECK базы, но пятисотым вместо внятного;
 * 2. **правка договорённости после выдачи** — техника уже работает по этой ставке, и новая ушла бы
 *    задним числом. Лечение одно: снять отметку выдачи, поправить, отметить заново (Р19);
 * 3. **завершение без факта возврата** — без отработанных единиц расчёт `actualUnits × rate` не
 *    сходится ни с чем, и расхождение с введённой суммой не видно (Р7).
 *
 * Повторное завершение (после отката «Выполнена» → «В работе») своих цифр не требует — они уже
 * предъявлены, — но присланные ПЕРЕЗАПИСЫВАЕТ, и прежние не сохранит ничто, кроме события истории:
 * ради этого у завершения оно и заведено.
 */
export async function planMechTransition(
  tx: MechTx,
  row: LockedMechRequest,
  body: Pick<ChangeMechRequestStatusInput, 'status' | 'deal' | 'actualFrom' | 'completion'>,
): Promise<MechTransitionPlan> {
  const { status, deal, actualFrom, completion } = body;
  const plan: MechTransitionPlan = {
    deal: {
      lessorId: row.lessorId,
      lessorType: row.lessorType,
      lessorIsActive: row.lessorIsActive,
      rate: row.rate,
      rateUnit: row.rateUnit,
    },
    fact: {
      actualFrom: row.actualFrom,
      actualTo: row.actualTo,
      actualUnits: row.actualUnits,
      finalCost: row.finalCost,
    },
    dealAfter: null,
    issuedAt: null,
    completion: null,
  };

  if (status === 'new') {
    // Модульное правило: договорённость стирается при ЛЮБОМ входе в «Новую» (Р8), в том числе
    // цепочкой `confirmed → cancelled → new`. Общий `transitionResetsWork` описывает один переход и
    // соседние модули — трогать его нельзя, поэтому правило своё. Факт обнуляется вместе с ней: до
    // сюда доходит только заявка без выдачи (её стережёт `mechTransitionBlocker`), но состояние
    // приводится к «фактов нет» целиком — половинчатого лестница не допускает.
    plan.deal = NO_MECH_DEAL;
    plan.fact = { ...NO_MECH_FACT };
    if (row.lessorId) plan.dealAfter = EMPTY_DEAL_VIEW;
  }

  if (status === 'confirmed') {
    if (deal) {
      if (row.actualFrom !== null) {
        throw err.unprocessable(
          'Техника выдана: чтобы поправить договорённость, сначала снимите отметку выдачи',
          { deal: 'Снимите отметку выдачи' },
        );
      }
      const lessor = await assertMechLessorAssignable(tx, deal.lessorId);
      plan.deal = {
        lessorId: deal.lessorId,
        lessorType: lessor.lessorType,
        lessorIsActive: lessor.lessorIsActive,
        rate: String(deal.rate),
        rateUnit: deal.rateUnit,
      };
      plan.dealAfter = { lessorName: lessor.lessorName, rate: deal.rate, rateUnit: deal.rateUnit };
    } else if (!row.lessorId) {
      throw err.badRequest(
        'Укажите арендодателя, ставку и единицу — без них заявку в работу не берут',
        { deal: 'Укажите арендодателя и ставку' },
      );
    }
    if (actualFrom) {
      if (row.actualFrom !== null) {
        throw err.unprocessable('Отметка выдачи уже стоит — снимите её, если она ошибочна', {
          actualFrom: 'Отметка уже стоит',
        });
      }
      plan.fact.actualFrom = actualFrom;
      plan.issuedAt = actualFrom;
    }
  }

  if (status === 'done') {
    if (!completion && row.actualTo === null) {
      throw err.badRequest(
        'Укажите фактические даты, отработанные часы или смены и итоговую стоимость',
        { completion: 'Заполните факт возврата' },
      );
    }
    if (completion) {
      plan.fact = {
        actualFrom: completion.actualFrom,
        actualTo: completion.actualTo,
        actualUnits: numToDb(completion.actualUnits),
        finalCost: numToDb(completion.finalCost),
      };
      plan.completion = {
        actualFrom: completion.actualFrom,
        actualTo: completion.actualTo,
        actualUnits: completion.actualUnits,
        // Единица берётся из договорённости ПОСЛЕ перехода: закрывают заявку той же ставкой, по
        // которой её и вели, а «120» без единицы не значит ничего (Р7).
        rateUnit: plan.deal.rateUnit,
        finalCost: completion.finalCost,
      };
      // Завершение — последний момент, когда исправляют дату выдачи, и у заявки, которую отмечали
      // выданной прямо в этот же ход, событие `issue` обязано появиться: без него в ленте не видно
      // дня, с которого пошли деньги.
      if (row.actualFrom === null) plan.issuedAt = completion.actualFrom;
    }
  }

  return plan;
}
