import { describe, expect, it } from 'vitest';
import {
  approvalClearRangeOf,
  type AssignmentEffectsInput,
  type AssignmentMutation,
  assignmentCommandEffects,
  assignmentEffectsPayloadOf,
  assignmentOperationOutcome,
  correctionEffectiveDateOf,
  paperRangeOf,
  paperScopeOf,
  resolveAssignmentMutations,
  tailEffectiveDate,
  workBlockRangeOf,
} from '../src/services/assignment-effects';
import type { AssignmentChangeRow, AssignmentTerm } from '../src/services/assignment-history';

/**
 * Проекции последствий команды (`docs/assignment-periods-plan.md`, Р11, Р18, Р24, Р31, Р32).
 *
 * Проверяется здесь ровно то, ради чего проекций шесть, а не одна: они **расходятся**. Смена
 * машиниста трогает бумагу и не трогает подписи; смена машины трогает и то и другое; замыкание
 * тянет документ целиком там, где дневной диапазон кончается посреди недели; составная команда
 * держит диапазоны порознь, потому что их объединение дало бы право снимать подписи за дни, где
 * машина не менялась.
 *
 * Ни одна ошибка такого рода не падает и не пишет в лог. Слишком широкая проекция снимает подпись
 * объекта за отработанный день, слишком узкая — оставляет непроверенной часть бумаги строгой
 * отчётности; замечают обе через неделю и по бумаге.
 */

// Читаемые идентификаторы вместо uuid: «B вместо A» в отчёте о падении понятнее любого ключа.
const YEAR: AssignmentTerm = { dateFrom: '2026-01-01', dateTo: '2026-12-31' };
/** «Сегодня» — календарный ключ, один на весь расчёт (Р32). */
const TODAY = '2026-08-20';

let counter = 0;

function vehicleRow(
  effectiveDate: string,
  vehicleId: string,
  extra: Partial<AssignmentChangeRow> = {},
): AssignmentChangeRow {
  counter += 1;
  return {
    id: `vehicle-${vehicleId}-${effectiveDate}`,
    effectiveDate,
    dimension: 'vehicle',
    vehicleId,
    driverPersonId: null,
    driverState: null,
    origin: 'assignment',
    changeGroupId: `group-${counter}`,
    supersededAt: null,
    ...extra,
  };
}

function driverRow(
  effectiveDate: string,
  personId: string,
  extra: Partial<AssignmentChangeRow> = {},
): AssignmentChangeRow {
  counter += 1;
  return {
    id: `driver-${personId}-${effectiveDate}`,
    effectiveDate,
    dimension: 'driver',
    vehicleId: null,
    driverPersonId: personId,
    driverState: 'set',
    origin: 'machinist_change',
    changeGroupId: `group-${counter}`,
    supersededAt: null,
    ...extra,
  };
}

/** Новая строка машиниста: обычная смена человека, своей одиночной группой. */
function setDriver(effectiveDate: string): AssignmentMutation {
  return { kind: 'insert', dimension: 'driver', effectiveDate, origin: 'machinist_change' };
}

/** Новая строка машины: обычная смена техники с названного дня. */
function setVehicle(effectiveDate: string): AssignmentMutation {
  return { kind: 'insert', dimension: 'vehicle', effectiveDate, origin: 'reassignment' };
}

function effects(
  input: Partial<AssignmentEffectsInput> & Pick<AssignmentEffectsInput, 'mutations'>,
) {
  return assignmentCommandEffects({
    changes: input.changes ?? [],
    term: input.term ?? YEAR,
    asOf: input.asOf ?? TODAY,
    mutations: input.mutations,
    sheets: input.sheets,
    wanted: input.wanted,
  });
}

describe('approvalClearRange: подписи снимает только изменение машины', () => {
  it('плановая смена машиниста меняет бумагу, но подписей не касается', () => {
    const result = effects({
      changes: [vehicleRow('2026-01-01', 'A'), driverRow('2026-01-01', 'Иван')],
      mutations: [setDriver('2026-09-01')],
    });

    // Бумага сентября–декабря переоформляется: в бланке печатается фамилия.
    expect(result.paperRange).toEqual([{ from: '2026-09-01', to: '2026-12-31' }]);
    // А подписывать заново нечего: фамилии машиниста в подписанных часах нет вовсе.
    expect(result.approvalClearRange).toEqual([]);
    expect(result.workBlockRange).toEqual([]);
    expect(result.operationOutcome).toBe('none');
    expect(result.needsOperation).toBe(false);
  });

  it('историческая коррекция машиниста тоже не снимает подписей — но требует прав', () => {
    const result = effects({
      changes: [vehicleRow('2026-01-01', 'A'), driverRow('2026-03-01', 'Иван')],
      mutations: [{ kind: 'replace', changeId: 'driver-Иван-2026-03-01' }],
    });

    expect(result.paperRange).toEqual([{ from: '2026-03-01', to: '2026-12-31' }]);
    expect(result.approvalClearRange).toEqual([]);
    // Прошлое задето — значит журнал, причина и `waybills.correct` (Р32).
    expect(result.operationOutcome).toBe('crew');
    expect(result.needsCorrection).toBe(true);
  });

  it('обычная смена машины снимает подписи и запирается работой дня', () => {
    const result = effects({
      changes: [vehicleRow('2026-01-01', 'A'), driverRow('2026-01-01', 'Иван')],
      mutations: [setVehicle(TODAY)],
    });

    const fromToday = [{ from: TODAY, to: '2026-12-31' }];
    expect(result.paperRange).toEqual(fromToday);
    expect(result.approvalClearRange).toEqual(fromToday);
    // Тот же диапазон меряет два множества смен Р18 — подписанные и заполненные без подписи.
    expect(result.workBlockRange).toEqual(fromToday);
    // Рядовая работа диспетчера: новая строка сегодняшней датой причины не требует.
    expect(result.operationOutcome).toBe('none');
  });

  it('коррекция машины задним числом снимает подписи, но запретом Р18 не мерится', () => {
    const result = effects({
      changes: [vehicleRow('2026-01-01', 'A'), vehicleRow('2026-03-01', 'B')],
      mutations: [{ kind: 'replace', changeId: 'vehicle-B-2026-03-01' }],
    });

    const fromMarch = [{ from: '2026-03-01', to: '2026-12-31' }];
    expect(result.approvalClearRange).toEqual(fromMarch);
    // Подписанные дни прошлого не запирают команду: они разблокируются и снимаются коррекцией.
    expect(result.workBlockRange).toEqual([]);
    expect(result.operationOutcome).toBe('crew');
  });
});

describe('paperScope: документ втягивается целиком', () => {
  /** Две полные недели: пн 03.08 — вс 09.08 и пн 10.08 — вс 16.08. */
  const fortnight: AssignmentTerm = { dateFrom: '2026-08-03', dateTo: '2026-08-16' };
  const beforeTerm = '2026-08-01';

  it('среда режет неделю, а замыкание возвращает в область понедельник и вторник', () => {
    const result = effects({
      changes: [vehicleRow('2026-08-03', 'A'), driverRow('2026-08-03', 'Иван')],
      term: fortnight,
      asOf: beforeTerm,
      mutations: [setDriver('2026-08-05')],
      sheets: [
        { periodFrom: '2026-08-03', periodTo: '2026-08-09' },
        { periodFrom: '2026-08-10', periodTo: '2026-08-16' },
      ],
    });

    // Дневной эффект начинается со среды…
    expect(result.paperRange).toEqual([{ from: '2026-08-05', to: '2026-08-16' }]);
    // …а переоформить операция обязана всю неделю: пн–вт выписываются прежним составом, и без
    // них постусловие проверило бы ср–вс и молча пропустило потерянный отрезок.
    expect(result.paperScope).toEqual([{ from: '2026-08-03', to: '2026-08-16' }]);
  });

  it('без листов область равна дневному диапазону — округления до недели нет', () => {
    const result = effects({
      changes: [vehicleRow('2026-08-03', 'A'), driverRow('2026-08-03', 'Иван')],
      term: fortnight,
      asOf: beforeTerm,
      mutations: [setDriver('2026-08-05')],
    });

    expect(result.paperScope).toEqual(result.paperRange);
  });

  /*
   * ЭСМ2-РАЗРЕЗ. Листы здесь заданы недельными, и это законная форма — но не единственная: после
   * переключения чтения (этап 5) документ бывает любой длины. Замыкание границам-агностично: оно
   * втягивает лист **целиком**, каким бы он ни был, и до недели ничего не округляет.
   *
   * Проверено: отрезковые листы втягиваются так же, как недельные, и соседний отрезок той же недели
   * в область не попадает. Именно это и отличает замыкание по документам от округления по
   * календарю — на недельных листах разницы не видно, потому что документ и неделя совпадают.
   */
  it('отрезковые листы: замыкание втягивает документ, а не неделю', () => {
    const result = effects({
      changes: [vehicleRow('2026-08-03', 'A'), driverRow('2026-08-03', 'Иван')],
      term: fortnight,
      asOf: beforeTerm,
      mutations: [setDriver('2026-08-06')],
      // Та же неделя, разрезанная надвое: пн–ср и чт–вс. Плюс целая вторая неделя.
      sheets: [
        { periodFrom: '2026-08-03', periodTo: '2026-08-05' },
        { periodFrom: '2026-08-06', periodTo: '2026-08-09' },
        { periodFrom: '2026-08-10', periodTo: '2026-08-16' },
      ],
    });

    // Дневной эффект — с четверга; область равна ему же, потому что четверг открывает свой лист.
    expect(result.paperRange).toEqual([{ from: '2026-08-06', to: '2026-08-16' }]);
    // Понедельник — среда не втянуты: это **другой** документ, и он не тронут. Округление до
    // недели вернуло бы сюда 03.08 и потребовало бы разблокировки чужого номера.
    expect(result.paperScope).toEqual([{ from: '2026-08-06', to: '2026-08-16' }]);
  });

  it('соседний документ, которого диапазон не касается, в область не входит', () => {
    const result = effects({
      changes: [vehicleRow('2026-08-03', 'A'), driverRow('2026-08-03', 'Иван')],
      term: fortnight,
      asOf: beforeTerm,
      mutations: [setDriver('2026-08-10')],
      sheets: [
        { periodFrom: '2026-08-03', periodTo: '2026-08-09' },
        { periodFrom: '2026-08-10', periodTo: '2026-08-16' },
      ],
    });

    // Первая неделя не тронута: её номер не горит и разблокировки не просит.
    expect(result.paperScope).toEqual([{ from: '2026-08-10', to: '2026-08-16' }]);
  });
});

describe('составная команда: диапазоны врозь, а не общий', () => {
  /*
   * Коррекция машины января–февраля с якорем машиниста на март. Объединять диапазоны нельзя:
   * driver-якорь марта не даёт права снимать мартовские подписи — машина в марте не менялась.
   */
  const changes = [
    vehicleRow('2026-01-01', 'A'),
    vehicleRow('2026-03-01', 'B'),
    driverRow('2026-01-01', 'Иван'),
  ];
  const command = effects({
    changes,
    mutations: [{ kind: 'replace', changeId: 'vehicle-A-2026-01-01' }, setDriver('2026-03-01')],
  });

  it('paperRange сливает соседние диапазоны в один — и потому мерой подписей быть не может', () => {
    // Январь–февраль и март–декабрь смежны, и в нормальной форме это один отрезок.
    expect(command.paperRange).toEqual([{ from: '2026-01-01', to: '2026-12-31' }]);
  });

  it('approvalClearRange держится только за машину: мартовские подписи не сняты', () => {
    expect(command.approvalClearRange).toEqual([{ from: '2026-01-01', to: '2026-02-28' }]);
  });

  it('payload несёт диапазон каждой мутации отдельно', () => {
    expect(command.payload.mutations).toEqual([
      expect.objectContaining({
        kind: 'replace',
        dimension: 'vehicle',
        effectiveDate: '2026-01-01',
        logical: { from: '2026-01-01', to: '2026-02-28' },
        inTerm: { from: '2026-01-01', to: '2026-02-28' },
      }),
      expect.objectContaining({
        kind: 'insert',
        dimension: 'driver',
        effectiveDate: '2026-03-01',
        logical: { from: '2026-03-01', to: null },
        inTerm: { from: '2026-03-01', to: '2026-12-31' },
      }),
    ]);
    // Общего диапазона в снимке нет ни одного поля ради: восстановить по нему, что чему
    // принадлежало, было бы уже нечем.
    expect(command.payload.approvalClearRange).toEqual(command.approvalClearRange);
    expect(command.payload.paperRange).toEqual(command.paperRange);
  });

  it('исход — максимум по эффектам: замена прошлой строки даёт crew всей команде', () => {
    expect(command.operationOutcome).toBe('crew');
    expect(command.needsOperation).toBe(true);
    expect(command.needsCorrection).toBe(true);
  });
});

describe('дремлющие команды: логический диапазон есть, бумажного нет', () => {
  it('изменение за концом срока не трогает ни бумаги, ни подписей, ни прав', () => {
    const result = effects({
      changes: [vehicleRow('2026-01-01', 'A'), driverRow('2026-01-01', 'Иван')],
      mutations: [setDriver('2027-01-01')],
    });

    const [dormant] = result.mutations;
    // Логический диапазон существует всегда — им изменение и оживает после продления срока.
    expect(dormant?.logical).toEqual({ from: '2027-01-01', to: null });
    expect(dormant?.inTerm).toBeNull();

    expect(result.paperRange).toEqual([]);
    expect(result.paperScope).toEqual([]);
    expect(result.approvalClearRange).toEqual([]);
    expect(result.workBlockRange).toEqual([]);
    expect(result.operationOutcome).toBe('none');
    expect(result.needsCorrection).toBe(false);
    // Но дата у команды есть, и в отпечаток она входит: пустой она была бы неотличима от «ничего».
    expect(result.correctionEffectiveDate).toBe('2027-01-01');
  });

  it('дремлющая запись прошлой датой требует журнала, но не коррекционных прав', () => {
    // Срок кончился 1 августа, 19-го ставят человека со 2-го — ради будущего продления (Р24).
    const result = effects({
      changes: [vehicleRow('2026-07-01', 'A'), driverRow('2026-07-01', 'Иван')],
      term: { dateFrom: '2026-07-01', dateTo: '2026-08-01' },
      asOf: '2026-08-19',
      mutations: [setDriver('2026-08-02')],
    });

    expect(result.paperRange).toEqual([]);
    expect(result.operationOutcome).toBe('assignment_tail');
    expect(result.needsOperation).toBe(true);
    // Глубину меряет только `crew`: прошлого эта запись не трогает, мерить нечего.
    expect(result.needsCorrection).toBe(false);
  });

  it('гашение дремлющей группы хвоста разрешено календарём, но объяснения требует', () => {
    // Срок кончился 31 марта, решение стоит на 1 апреля, сегодня — август: дата давно прошла, а
    // строка по-прежнему ни одного рабочего дня не описывает (Р31).
    const tailRow = vehicleRow('2026-04-01', 'B', {
      id: 'tail-2026-04-01',
      origin: 'tail_resolution',
    });
    const result = effects({
      changes: [vehicleRow('2026-01-01', 'A'), driverRow('2026-01-01', 'Иван'), tailRow],
      term: { dateFrom: '2026-01-01', dateTo: '2026-03-31' },
      mutations: [{ kind: 'cancel', changeId: 'tail-2026-04-01' }],
    });

    expect(result.mutations[0]?.inTerm).toBeNull();
    expect(result.paperRange).toEqual([]);
    // Vehicle-мутация — а снимать нечего: пустой диапазон не даёт подписям ни дня.
    expect(result.approvalClearRange).toEqual([]);
    expect(result.workBlockRange).toEqual([]);
    expect(result.operationOutcome).toBe('assignment_tail');
    expect(result.needsCorrection).toBe(false);
  });

  it('решение хвоста без строки бумаги не трогает, но исход и дату даёт', () => {
    const term: AssignmentTerm = { dateFrom: '2026-01-01', dateTo: '2026-03-31' };
    const result = effects({
      changes: [vehicleRow('2026-01-01', 'A'), driverRow('2026-01-01', 'Иван')],
      term,
      mutations: [{ kind: 'tail_decision', effectiveDate: tailEffectiveDate(term) }],
    });

    expect(tailEffectiveDate(term)).toBe('2026-04-01');
    expect(result.paperRange).toEqual([]);
    // Строки истории у первичного `history_wins` нет вовсе — переписывать нечего, а объяснять есть.
    expect(result.operationOutcome).toBe('assignment_tail');
    expect(result.correctionEffectiveDate).toBe('2026-04-01');
  });
});

describe('correctionEffectiveDate: самая ранняя дата всех мутаций', () => {
  it('якорь января задаёт глубину мартовской команде', () => {
    const result = effects({
      changes: [
        vehicleRow('2026-01-01', 'A'),
        vehicleRow('2026-03-01', 'B'),
        driverRow('2026-01-01', 'Иван'),
      ],
      // Правится мартовское изменение машины, а вместе с ним закрывается январский пробел Р16.
      mutations: [{ kind: 'replace', changeId: 'vehicle-B-2026-03-01' }, setDriver('2026-01-15')],
    });

    // Дата основного изменения — март, но право и глубину меряет январь: иначе якорь прошёл бы
    // мимо `correctBeyondLimit`.
    expect(result.correctionEffectiveDate).toBe('2026-01-15');
    expect(result.operationOutcome).toBe('crew');
  });

  it('логическая дата безстрочного решения участвует наравне со строками', () => {
    const term: AssignmentTerm = { dateFrom: '2026-01-01', dateTo: '2026-03-31' };
    const result = effects({
      changes: [vehicleRow('2026-01-01', 'A'), driverRow('2026-01-01', 'Иван')],
      term,
      // Обе мутации дремлют: решение хвоста на 1 апреля и машинист, назначенный на июнь впрок.
      mutations: [
        { kind: 'tail_decision', effectiveDate: tailEffectiveDate(term) },
        setDriver('2026-06-01'),
      ],
    });

    expect(result.correctionEffectiveDate).toBe('2026-04-01');
    expect(result.operationOutcome).toBe('assignment_tail');
    expect(result.needsCorrection).toBe(false);
  });

  it('мутаций нет — даты нет: подставлять сюда «сегодня» значило бы соврать журналу', () => {
    expect(correctionEffectiveDateOf([])).toBeNull();
  });
});

describe('проекции поодиночке считают то же, что и общий проход', () => {
  const changes = [
    vehicleRow('2026-01-01', 'A'),
    vehicleRow('2026-03-01', 'B'),
    driverRow('2026-01-01', 'Иван'),
  ];
  const input: AssignmentEffectsInput = {
    changes,
    term: YEAR,
    asOf: TODAY,
    mutations: [{ kind: 'replace', changeId: 'vehicle-A-2026-01-01' }, setDriver('2026-03-01')],
  };

  it('общий вход у всех один — посчитанные диапазоны мутаций', () => {
    const mutations = resolveAssignmentMutations(input);
    const whole = assignmentCommandEffects(input);

    expect(paperRangeOf(mutations)).toEqual(whole.paperRange);
    expect(approvalClearRangeOf(mutations)).toEqual(whole.approvalClearRange);
    expect(workBlockRangeOf(mutations, TODAY)).toEqual(whole.workBlockRange);
    expect(correctionEffectiveDateOf(mutations)).toEqual(whole.correctionEffectiveDate);
    expect(assignmentOperationOutcome(mutations, TODAY)).toEqual(whole.operationOutcome);
    expect(paperScopeOf(whole.paperRange, [], [])).toEqual(whole.paperScope);
  });

  it('снимок операции — копия расчёта, а не ссылка на него', () => {
    const whole = assignmentCommandEffects(input);
    const snapshot = assignmentEffectsPayloadOf(whole);

    expect(snapshot).toEqual(whole.payload);
    // День расчёта и срок в снимке обязательны: без них диапазоны не с чем сверить через полгода.
    expect(snapshot.asOf).toBe(TODAY);
    expect(snapshot.term).toEqual(YEAR);
    // И это именно копия: дополнение результата после записи снимка его не перепишет.
    expect(snapshot.paperRange[0]).not.toBe(whole.paperRange[0]);
    expect(snapshot.mutations[0]).not.toBe(whole.mutations[0]);
  });

  it('исход одной мутации не заслоняет исход другой', () => {
    // Порядок перечисления не значим: `crew` старше `assignment_tail`, а тот старше `none`.
    const mutations = resolveAssignmentMutations({
      ...input,
      mutations: [setDriver('2026-09-01'), { kind: 'replace', changeId: 'vehicle-B-2026-03-01' }],
    });

    expect(assignmentOperationOutcome(mutations, TODAY)).toBe('crew');
    expect(assignmentOperationOutcome([mutations[0]!], TODAY)).toBe('none');
  });
});

describe('цель мутации: погашенную строку молча не пропускаем', () => {
  it('гашение неизвестной строки — внутренняя ошибка, а не команда без последствий', () => {
    expect(() =>
      effects({
        changes: [vehicleRow('2026-01-01', 'A')],
        mutations: [{ kind: 'cancel', changeId: 'нет-такой' }],
      }),
    ).toThrow(/не найдена среди актуальных строк/);
  });

  it('уже погашенная строка целью не годится: её диапазон давно чужой', () => {
    const superseded = driverRow('2026-03-01', 'Иван', {
      id: 'driver-погашен',
      supersededAt: new Date('2026-08-19T10:00:00Z'),
    });
    expect(() =>
      effects({
        changes: [vehicleRow('2026-01-01', 'A'), superseded],
        mutations: [{ kind: 'replace', changeId: 'driver-погашен' }],
      }),
    ).toThrow(/не найдена среди актуальных строк/);
  });
});
