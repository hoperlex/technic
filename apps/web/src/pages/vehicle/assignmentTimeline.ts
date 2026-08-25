import {
  shiftDateKey,
  type AssignmentChangeDto,
  type AssignmentChangeOrigin,
  type DriverState,
  type RequestAssignmentHistoryDto,
} from '@technic/contracts';

/**
 * Свёртка истории назначения в отрезки — то, из чего рисуется «Состав по датам» (этап 6 плана
 * `docs/assignment-periods-plan.md`, §9).
 *
 * ПОЧЕМУ СЧИТАЕТ ПОРТАЛ, ЕСЛИ ОСТАЛЬНОЕ СЧИТАЕТ СЕРВЕР. Здесь нет ни одного решения: последствия
 * команды, её исход, права и валидность приходят готовыми — предпросмотром и полем `state`.
 * Свёртка нужна только чтобы **показать** присланные строки человеческим языком: сервер отдаёт
 * журнал изменений («с 12 августа машинист такой-то»), а спрашивают у карточки обратное — «кто
 * работал 15 августа». Серверного DTO с отрезками у модуля нет, и второй раз спросить его не у
 * кого. Ни одна кнопка от этого расчёта не зависит: разойдись он с сервером — разъедется показ, а
 * не команда, и разъедется заметно.
 *
 * ЧТО ЗДЕСЬ НЕ СЧИТАЕТСЯ. Валидность истории (Р16) — её отдаёт `state`, а портал только называет
 * вслух дни, из-за которых заявка не готова. Отменяемость решения — её знает сервер, и окно
 * спрашивает его предпросмотром, а не решает само; здесь есть лишь признак «решение ещё не
 * наступило», по которому кнопка отмены вообще предлагается.
 */

/** Один отрезок состава: с какого числа по какое кто работает. */
export interface AssignmentSegment {
  /** Дата вступления состава в силу. */
  from: string;
  /**
   * Последний день отрезка. `null` — конца нет: либо срок заявки бессрочный, либо отрезок дремлет
   * и его конец наступит только вместе с продлением (Р24).
   */
  to: string | null;
  /** Машина отрезка; `null` — шкала ещё не задавалась (истории заявки нет вовсе). */
  vehicle: { vehicleId: string; name: string } | null;
  /** Состояние машиниста (Р19); `null` — шкала ещё не задавалась. */
  driver: DriverState | null;
  /**
   * Изменения, вступившие в силу этой датой: ими отрезок и открыт. Их два, когда одним решением
   * поменяли и машину, и человека (Р3), — и группа у них тогда одна.
   */
  starts: AssignmentChangeDto[];
  /**
   * Отрезок начинается за концом срока работ: решение заведено, но ещё не действует и ждёт
   * продления (Р24). Прятать такие нельзя — спрятанное решение через неделю заводят второй раз.
   */
  dormant: boolean;
}

/** Срок работ заявки: им отрезки обрезаются справа и им же отличается дремлющее решение. */
export interface AssignmentTerm {
  dateFrom: string;
  /** `null` — срок однодневный либо бессрочный: правая граница отрезку не задаётся. */
  dateTo: string | null;
}

/**
 * Отрезки состава по актуальным строкам истории.
 *
 * Погашенные строки (`supersededKind`) в свёртку не входят: они рассказывают, что правили, и
 * читаются журналом, а состав на дату задают только действующие решения.
 */
export function assignmentSegments(
  changes: readonly AssignmentChangeDto[],
  term: AssignmentTerm,
): AssignmentSegment[] {
  const actual = changes.filter((row) => row.supersededKind === null);
  const dates = [...new Set(actual.map((row) => row.effectiveDate))].sort();

  let vehicle: AssignmentSegment['vehicle'] = null;
  let driver: DriverState | null = null;
  const segments: AssignmentSegment[] = [];

  dates.forEach((date, index) => {
    const starts = actual.filter((row) => row.effectiveDate === date);
    for (const row of starts) {
      if (row.dimension === 'vehicle' && row.vehicle) vehicle = row.vehicle;
      if (row.dimension === 'driver') driver = row.driver;
    }
    const next = dates[index + 1];
    const dormant = term.dateTo !== null && date > term.dateTo;
    /*
     * Правая граница — день перед следующим решением, но **не дальше конца срока**: за ним работы
     * нет, и отрезок, дотянутый до дремлющего решения, обещал бы дни, которых у заявки не
     * существует. У самого дремлющего границы нет вовсе — её задаст продление, и назвать её сейчас
     * нечем.
     */
    const nextDay = next ? shiftDateKey(next, -1) : null;
    const to =
      dormant || term.dateTo === null
        ? nextDay
        : nextDay === null || nextDay > term.dateTo
          ? term.dateTo
          : nextDay;
    segments.push({ from: date, to, vehicle, driver, starts, dormant });
  });

  return segments;
}

/**
 * Дни, из-за которых история неполна (Р16): на них машинист **неизвестен**.
 *
 * `unknown` — не «поле не заполнили», а «историю восстановить нечем»: строку писал бэкфилл по
 * бумаге, и кто именно работал, из неё не следует (Р19). Показывать это пустой строкой нельзя —
 * человек прочтёт «машиниста не было», хотя лист за эти дни выдан и фамилия в нём напечатана.
 */
export function unknownDriverSegments(segments: readonly AssignmentSegment[]): AssignmentSegment[] {
  return segments.filter((s) => s.driver?.state === 'unknown');
}

/**
 * Расхождение хвоста (Р31): машина, действующая на конце срока, не равна машине назначения.
 *
 * Пока срок не продлевают, это предупреждение — бумаге оно не мешает. Но продление активирует
 * хвост молча: свёртка унаследует машину истории, и новые листы уйдут на неё, хотя работа и ставки
 * относятся к машине назначения. Поэтому карточка называет обе поимённо.
 *
 * Разрешённый хвост расхождением **не считается**: после `assignment_wins` за концом срока стоит
 * дремлющая граница на машину назначения, и вопрос «чем заявка закрыта дальше» уже отвечен — такой
 * хвост карточка показывает отрезком «ожидает продления срока», а не отказом.
 */
export function tailVehicleMismatch(
  segments: readonly AssignmentSegment[],
  term: AssignmentTerm,
  assignment: { vehicleId: string; name: string } | null,
): { tailVehicleName: string; assignmentVehicleName: string; since: string } | null {
  if (!assignment || term.dateTo === null) return null;
  // Дремлющая граница о машине — это и есть принятое решение о хвосте: расхождения больше нет.
  if (segments.some((s) => s.dormant && s.starts.some((row) => row.dimension === 'vehicle'))) {
    return null;
  }
  const tail = [...segments].reverse().find((s) => !s.dormant && s.from <= term.dateTo!);
  const tailVehicle = tail?.vehicle ?? null;
  if (!tailVehicle || tailVehicle.vehicleId === assignment.vehicleId) return null;
  return {
    tailVehicleName: tailVehicle.name,
    assignmentVehicleName: assignment.name,
    since: shiftDateKey(term.dateTo, 1),
  };
}

/**
 * Состояние машиниста человеческим языком (Р19) — три состояния, а не два.
 *
 * Имя приходит из справочника водителей: строка истории носит **состояние**, а не человека
 * (`{ state: 'set', personId }`), и выдумывать фамилию окну нечем. Не нашли в справочнике —
 * так и говорим: подставить «того, кто работал до него» значило бы отправить чужую фамилию в
 * бланк строгой отчётности.
 */
export function driverStateLabel(
  driver: DriverState | null,
  nameOf: (personId: string) => string | undefined,
): string {
  if (!driver) return 'не задан';
  if (driver.state === 'cleared') return 'снят — бланк ведёт арендодатель';
  if (driver.state === 'unknown') {
    return 'неизвестен — историю восстановили по бланкам, и человек известен только по бумаге';
  }
  return nameOf(driver.personId) ?? 'машиниста нет в справочнике водителей';
}

/** Откуда взялось решение: провенансом отличается восстановленное по бумаге от заведённого людьми. */
export const assignmentOriginLabels: Record<AssignmentChangeOrigin, string> = {
  assignment: 'перевод заявки в работу',
  reassignment: 'смена техники',
  machinist_change: 'смена машиниста',
  backfill: 'восстановлено по бланкам',
  tail_resolution: 'решение о технике после конца срока',
  known_fill: 'заполнено вручную',
  unknown_remainder: 'остаток неизвестного прошлого',
};

/**
 * Готовность истории — состоянием, а не булевым «готово» (Р20, Р26).
 *
 * «Истории нет» и «история есть, но неполна» — разные ответы и разные действия: первое портал
 * достроит сам при первой же команде, второе чинится только тем, что человек назовёт людей.
 * Поэтому текст `empty` не зовёт «открыть карточку заново» — открывать её заново незачем, и
 * совет, который нельзя выполнить, хуже молчания.
 */
export function assignmentHistoryNote(history: RequestAssignmentHistoryDto): string | null {
  if (history.state === 'empty') {
    return 'Состав по датам ещё не построен: он появится при первой смене машиниста — портал восстановит историю по назначению и выписанным бланкам прямо в этой команде.';
  }
  if (history.state === 'materialized') {
    return 'История заявки восстановлена не полностью: пока за все дни срока не назван машинист, портал не выпишет за них лист ЭСМ-2.';
  }
  return null;
}
