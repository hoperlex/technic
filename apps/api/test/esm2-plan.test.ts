import { describe, expect, it } from 'vitest';
import type { VehicleOwnership } from '@technic/contracts';
import {
  type AssignmentChangeRow,
  type AssignmentSegment,
  assignmentSegments,
  type AssignmentTerm,
  type DriverState,
} from '../src/services/assignment-history';
import {
  documentClosure,
  esm2PaperSegments,
  type Esm2ExistingSheet,
  esm2SheetPlan,
  normalizeRangeSet,
  sheetMatchesWanted,
} from '../src/services/esm2-plan';

/**
 * План листов ЭСМ-2 на отрезках и документное замыкание (`docs/assignment-periods-plan.md`,
 * Р4–Р6, Р11, Р19, §7).
 *
 * Функции чистые, и цена ошибки у них бумажная: лишний элемент `issue` — это сгоревший бланк
 * строгой отчётности, лишний `cancel` — сгоревший дважды, пропущенный отрезок — дни работы без
 * документа. Ни одно из трёх не падает и не пишет в лог; замечает это тот, кто берёт бумагу в
 * руки, и обычно через неделю.
 *
 * Сюжет у всех проверок один: неделя перестала быть единицей планирования. Она осталась единицей
 * **бланка** — семь строк «пн…вс» впечатаны, — но состав внутри неё теперь меняется, и один и тот
 * же понедельник законно принадлежит двум разным документам.
 */

// Читаемые идентификаторы вместо uuid: «B вместо A» в отчёте о падении понятнее любого ключа.
const term: AssignmentTerm = { dateFrom: '2026-08-03', dateTo: '2026-08-16' };
/** Две полные календарные недели: пн 03.08 — вс 09.08 и пн 10.08 — вс 16.08. */
const MONDAY = '2026-08-03';
const WEDNESDAY = '2026-08-05';
const SUNDAY = '2026-08-09';
/** «Сегодня» раньше срока: в этих проверках вся бумага предстоящая, и прошлое им не мешает. */
const TODAY = '2026-08-01';

const own = new Map<string, VehicleOwnership>([
  ['A', 'own'],
  ['B', 'own'],
  ['R', 'rental'],
]);

const context = { ownershipByVehicle: own, today: TODAY };

let counter = 0;

function segment(
  from: string,
  to: string,
  vehicleId: string | null,
  driver: DriverState | null,
): AssignmentSegment {
  return { from, to, vehicle: vehicleId ? { vehicleId } : null, driver };
}

function set(personId: string): DriverState {
  return { state: 'set', personId };
}

/** Действующий лист заявки: границы, машина и человек — всё, чем он сверяется (Р5). */
function sheet(
  id: string,
  periodFrom: string,
  periodTo: string,
  vehicleId: string,
  driverPersonId: string,
): Esm2ExistingSheet {
  return { id, periodFrom, periodTo, vehicleId, driverPersonId };
}

function vehicleChange(effectiveDate: string, vehicleId: string): AssignmentChangeRow {
  counter += 1;
  return {
    id: `change-${counter}`,
    effectiveDate,
    dimension: 'vehicle',
    vehicleId,
    driverPersonId: null,
    driverState: null,
    origin: 'assignment',
    changeGroupId: `group-${counter}`,
    supersededAt: null,
  };
}

function driverChange(effectiveDate: string, personId: string): AssignmentChangeRow {
  counter += 1;
  return {
    id: `change-${counter}`,
    effectiveDate,
    dimension: 'driver',
    vehicleId: null,
    driverPersonId: personId,
    driverState: 'set',
    origin: 'machinist_change',
    changeGroupId: `group-${counter}`,
    supersededAt: null,
  };
}

describe('esm2SheetPlan: разрез недели', () => {
  it('смена машиниста в среду режет неделю надвое', () => {
    // Разрез считается настоящей свёрткой, а не выписанными руками отрезками: план и свёртка
    // обязаны сходиться на том же входе, каким их зовёт этап 3.
    const segments = assignmentSegments(
      [
        vehicleChange(MONDAY, 'A'),
        driverChange(MONDAY, 'Иван'),
        driverChange(WEDNESDAY, 'Пётр'),
      ],
      { dateFrom: MONDAY, dateTo: SUNDAY },
    );

    const plan = esm2SheetPlan(segments, { dateFrom: MONDAY, dateTo: SUNDAY }, [], context);

    expect(plan.wanted).toEqual([
      { from: MONDAY, to: '2026-08-04', vehicleId: 'A', driver: set('Иван'), responsibility: 'portal' },
      { from: WEDNESDAY, to: SUNDAY, vehicleId: 'A', driver: set('Пётр'), responsibility: 'portal' },
    ]);
    // Оба листа выписываются: одна календарная неделя, два документа — и состав каждого лежит в
    // самом плане, а не добирается исполнителем по ключу недели.
    expect(plan.issue).toHaveLength(2);
    expect(plan.cancel).toEqual([]);
  });

  it('смена машины режет неделю так же, как смена человека', () => {
    const segments = assignmentSegments(
      [vehicleChange(MONDAY, 'A'), driverChange(MONDAY, 'Иван'), vehicleChange(WEDNESDAY, 'B')],
      { dateFrom: MONDAY, dateTo: SUNDAY },
    );

    const plan = esm2SheetPlan(segments, { dateFrom: MONDAY, dateTo: SUNDAY }, [], context);

    expect(plan.issue.map((s) => [s.from, s.to, s.vehicleId, s.driver.personId])).toEqual([
      [MONDAY, '2026-08-04', 'A', 'Иван'],
      [WEDNESDAY, SUNDAY, 'B', 'Иван'],
    ]);
  });

  it('отрезок короче недели на границе срока подрезается сроком, а не растягивается до воскресенья', () => {
    // Срок кончается в четверг: бланк остаётся недельным по форме, но «Период работы» — по срок.
    const shortTerm: AssignmentTerm = { dateFrom: WEDNESDAY, dateTo: '2026-08-06' };
    const plan = esm2SheetPlan(
      [segment(WEDNESDAY, '2026-08-06', 'A', set('Иван'))],
      shortTerm,
      [],
      context,
    );

    expect(plan.issue).toHaveLength(1);
    expect(plan.issue[0]).toMatchObject({ from: WEDNESDAY, to: '2026-08-06' });
  });

  it('отрезок длиннее недели режется воскресеньем: лист не перешагивает границу недели', () => {
    const plan = esm2SheetPlan([segment(MONDAY, '2026-08-16', 'A', set('Иван'))], term, [], context);

    expect(plan.wanted.map((s) => [s.from, s.to])).toEqual([
      [MONDAY, SUNDAY],
      ['2026-08-10', '2026-08-16'],
    ]);
  });

  it('арендный отрезок бумаги не заводит, а его сосед на своей машине — заводит', () => {
    const plan = esm2SheetPlan(
      [segment(MONDAY, '2026-08-04', 'R', set('Иван')), segment(WEDNESDAY, SUNDAY, 'A', set('Иван'))],
      { dateFrom: MONDAY, dateTo: SUNDAY },
      [],
      context,
    );

    // Ответственность считается по машине **отрезка** (Р4), а не одна на всю заявку.
    expect(plan.wanted).toHaveLength(1);
    expect(plan.wanted[0]).toMatchObject({ from: WEDNESDAY, to: SUNDAY, vehicleId: 'A' });
  });

  it('машину без принадлежности план не угадывает', () => {
    expect(() =>
      esm2SheetPlan([segment(MONDAY, SUNDAY, 'Z', set('Иван'))], { dateFrom: MONDAY, dateTo: SUNDAY }, [], context),
    ).toThrow(/Принадлежность машины Z/);
  });
});

describe('esm2SheetPlan: сверка с выписанным', () => {
  it('лист, выписанный ровно на нужный отрезок, не трогается', () => {
    const existing = [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')];

    const plan = esm2SheetPlan(
      [segment(MONDAY, SUNDAY, 'A', set('Иван'))],
      { dateFrom: MONDAY, dateTo: SUNDAY },
      existing,
      context,
    );

    // Сошлось — не трогаем: пустые `cancel` и `issue` означают, что ни один номер не сгорит.
    expect(plan).toMatchObject({ cancel: [], issue: [], kept: ['w1'], locked: [], outOfScope: [] });
  });

  it('лист на период, который теперь режется надвое, аннулируется и заменяется двумя', () => {
    const existing = [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')];

    const plan = esm2SheetPlan(
      [segment(MONDAY, '2026-08-04', 'A', set('Иван')), segment(WEDNESDAY, SUNDAY, 'A', set('Пётр'))],
      { dateFrom: MONDAY, dateTo: SUNDAY },
      existing,
      context,
    );

    // Понедельник–вторник прежним составом переписывается тоже: границы листа напечатаны в графе
    // «Период работы», и оставить пн–вс рядом с новым ср–вс значило бы два документа на одни дни.
    expect(plan.cancel).toEqual(['w1']);
    expect(plan.issue.map((s) => [s.from, s.to, s.driver.personId])).toEqual([
      [MONDAY, '2026-08-04', 'Иван'],
      [WEDNESDAY, SUNDAY, 'Пётр'],
    ]);
    expect(plan.kept).toEqual([]);
  });

  it('лист с прежним человеком на прежних границах аннулируется: сверяется и графа человека', () => {
    const plan = esm2SheetPlan(
      [segment(MONDAY, SUNDAY, 'A', set('Пётр'))],
      { dateFrom: MONDAY, dateTo: SUNDAY },
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')],
      context,
    );

    expect(plan.cancel).toEqual(['w1']);
    expect(plan.issue).toHaveLength(1);
  });

  it('отработанный лист не трогается и запирает свои дни, а не свою неделю', () => {
    // «Сегодня» — среда: лист пн–вт уже отработан, лист ср–вс ещё нет.
    const worked = { ...context, today: WEDNESDAY };
    const plan = esm2SheetPlan(
      [segment(MONDAY, '2026-08-04', 'A', set('Иван')), segment(WEDNESDAY, SUNDAY, 'A', set('Пётр'))],
      { dateFrom: MONDAY, dateTo: SUNDAY },
      [sheet('w1', MONDAY, '2026-08-04', 'A', 'Кто-то')],
      worked,
    );

    // Прежний недельный запрет закрыл бы всю неделю и не дал бы выписать ср–вс. Р5: запираются дни.
    expect(plan).toMatchObject({ locked: ['w1'], cancel: [], kept: [] });
    expect(plan.issue.map((s) => [s.from, s.to])).toEqual([[WEDNESDAY, SUNDAY]]);
  });

  it('прошедший отрезок без листа сам не выписывается, а с проверенной коррекцией — выписывается', () => {
    const past = { ...context, today: '2026-08-20' };
    const segments = [segment(MONDAY, SUNDAY, 'A', set('Иван'))];

    expect(esm2SheetPlan(segments, { dateFrom: MONDAY, dateTo: SUNDAY }, [], past).issue).toEqual([]);
    expect(
      esm2SheetPlan(segments, { dateFrom: MONDAY, dateTo: SUNDAY }, [], {
        ...past,
        correction: { allowed: true },
      }).issue,
    ).toHaveLength(1);
  });

  it('названный коррекцией лист теряет неприкосновенность отработанного', () => {
    const past = { ...context, today: '2026-08-20', correction: { allowed: true } as const };
    const existing = [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')];
    const segments = [segment(MONDAY, '2026-08-04', 'A', set('Иван')), segment(WEDNESDAY, SUNDAY, 'A', set('Пётр'))];

    expect(esm2SheetPlan(segments, { dateFrom: MONDAY, dateTo: SUNDAY }, existing, past)).toMatchObject({
      locked: ['w1'],
      cancel: [],
      issue: [],
    });
    expect(
      esm2SheetPlan(segments, { dateFrom: MONDAY, dateTo: SUNDAY }, existing, {
        ...past,
        unlockWaybillIds: ['w1'],
      }),
    ).toMatchObject({ locked: [], cancel: ['w1'] });
  });

  it('лист вне области сверки не трогают, даже когда он разошёлся с разрезом', () => {
    const existing = [
      sheet('w1', MONDAY, SUNDAY, 'A', 'Иван'),
      sheet('w2', '2026-08-10', '2026-08-16', 'A', 'Иван'),
    ];
    const segments = [segment(MONDAY, '2026-08-16', 'B', set('Иван'))];

    const plan = esm2SheetPlan(segments, term, existing, {
      ...context,
      scope: [{ from: MONDAY, to: SUNDAY }],
    });

    // Расхождение по машине есть у обоих листов, но чинить чужой участок попутно нельзя (Р11).
    expect(plan.cancel).toEqual(['w1']);
    // Лист вне области не «заперт»: разблокировать его никто не просит — его просто не трогают.
    expect(plan).toMatchObject({ locked: [], outOfScope: ['w2'] });
    expect(plan.issue.map((s) => [s.from, s.to])).toEqual([[MONDAY, SUNDAY]]);
  });
});

describe('esm2SheetPlan: unknown внутри отрезка (Р19)', () => {
  const segments = [
    segment(MONDAY, '2026-08-04', 'A', { state: 'unknown' }),
    segment(WEDNESDAY, SUNDAY, 'A', set('Пётр')),
  ];

  it('лист на unknown-отрезке считается совпавшим, кем бы он ни был выписан', () => {
    const plan = esm2SheetPlan(
      segments,
      { dateFrom: MONDAY, dateTo: SUNDAY },
      [sheet('w1', MONDAY, '2026-08-04', 'A', 'Неизвестно-кто')],
      context,
    );

    // Без этой поблажки сверка каждый раз хотела бы переоформить старую бумагу, кем именно — не
    // зная, и жгла бы номер за номером на каждом прогоне.
    expect(plan).toMatchObject({ kept: ['w1'], cancel: [] });
    expect(plan.issue.map((s) => [s.from, s.to])).toEqual([[WEDNESDAY, SUNDAY]]);
  });

  it('unknown-отрезок бумаги не выписывает: имени для графы нет', () => {
    const plan = esm2SheetPlan(segments, { dateFrom: MONDAY, dateTo: SUNDAY }, [], context);

    expect(plan.wanted).toHaveLength(2);
    expect(plan.issue.map((s) => [s.from, s.to])).toEqual([[WEDNESDAY, SUNDAY]]);
  });

  it('игнорируется только графа человека: чужая машина и чужие границы — расхождение', () => {
    const wrongVehicle = esm2SheetPlan(
      segments,
      { dateFrom: MONDAY, dateTo: SUNDAY },
      [sheet('w1', MONDAY, '2026-08-04', 'B', 'Неизвестно-кто')],
      context,
    );
    const wrongBounds = esm2SheetPlan(
      segments,
      { dateFrom: MONDAY, dateTo: SUNDAY },
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Неизвестно-кто')],
      context,
    );

    expect(wrongVehicle.cancel).toEqual(['w1']);
    expect(wrongBounds.cancel).toEqual(['w1']);
  });

  it('снятый машинист бумаги не ожидает вовсе', () => {
    const plan = esm2SheetPlan(
      [segment(MONDAY, SUNDAY, 'A', { state: 'cleared' })],
      { dateFrom: MONDAY, dateTo: SUNDAY },
      [],
      context,
    );

    expect(plan.wanted).toEqual([]);
  });
});

describe('esm2PaperSegments', () => {
  it('подрезает разрез сроком и схлопывает смежных соседей одинакового состава', () => {
    const segments = [
      segment('2026-07-20', '2026-08-04', 'A', set('Иван')),
      // Изменение вернуло прежнего человека: в истории это законная отдельная строка (свой автор и
      // своя причина), но двумя листами одна неделя из-за него печататься не должна.
      segment(WEDNESDAY, '2026-08-20', 'A', set('Иван')),
    ];

    expect(esm2PaperSegments(segments, term, own)).toEqual([
      {
        from: MONDAY,
        to: '2026-08-16',
        vehicle: { vehicleId: 'A' },
        driver: set('Иван'),
        responsibility: 'portal',
      },
    ]);
  });

  it('отрезок, выпавший из срока целиком, отбрасывается', () => {
    expect(esm2PaperSegments([segment('2026-09-01', '2026-09-07', 'A', set('Иван'))], term, own)).toEqual([]);
  });

  it('отрезок без машины ответственности не получает', () => {
    const [first] = esm2PaperSegments([segment(MONDAY, SUNDAY, null, null)], term, own);

    expect(first?.responsibility).toBeNull();
  });
});

describe('sheetMatchesWanted', () => {
  const wanted = {
    from: MONDAY,
    to: SUNDAY,
    vehicleId: 'A',
    driver: set('Иван'),
    responsibility: 'portal',
  } as const;

  it('сверяет обе границы, машину и человека', () => {
    expect(sheetMatchesWanted(sheet('w', MONDAY, SUNDAY, 'A', 'Иван'), wanted)).toBe(true);
    expect(sheetMatchesWanted(sheet('w', MONDAY, '2026-08-08', 'A', 'Иван'), wanted)).toBe(false);
    expect(sheetMatchesWanted(sheet('w', MONDAY, SUNDAY, 'B', 'Иван'), wanted)).toBe(false);
    expect(sheetMatchesWanted(sheet('w', MONDAY, SUNDAY, 'A', 'Пётр'), wanted)).toBe(false);
  });
});

describe('documentClosure', () => {
  it('на пустом множестве листов возвращает сам диапазон', () => {
    expect(documentClosure([{ from: WEDNESDAY, to: WEDNESDAY }], [], [])).toEqual([
      { from: WEDNESDAY, to: WEDNESDAY },
    ]);
  });

  it('втягивает задетый лист целиком: смена со среды перевыписывает и понедельник', () => {
    const closure = documentClosure(
      [{ from: WEDNESDAY, to: SUNDAY }],
      [{ periodFrom: MONDAY, periodTo: SUNDAY }],
      [
        { from: MONDAY, to: '2026-08-04' },
        { from: WEDNESDAY, to: SUNDAY },
      ],
    );

    expect(closure).toEqual([{ from: MONDAY, to: SUNDAY }]);
  });

  it('не округляет до недели: самостоятельный лист пн–вт остаётся вне области', () => {
    const closure = documentClosure(
      [{ from: '2026-08-07', to: '2026-08-07' }],
      [
        { periodFrom: MONDAY, periodTo: '2026-08-04' },
        { periodFrom: WEDNESDAY, periodTo: SUNDAY },
      ],
      [
        { from: MONDAY, to: '2026-08-04' },
        { from: WEDNESDAY, to: SUNDAY },
      ],
    );

    // Округление до календарной недели втянуло бы чужой пн–вт, назвало бы его в разблокировках и
    // сожгло бы его номер; а не будь там листа вовсе — заполнило бы прошлую дыру.
    expect(closure).toEqual([{ from: WEDNESDAY, to: SUNDAY }]);
  });

  it('дыру без листа не втягивает: замыкание идёт по документам, а не по дням', () => {
    expect(documentClosure([{ from: '2026-08-07', to: '2026-08-07' }], [], [{ from: MONDAY, to: SUNDAY }])).toEqual([
      { from: '2026-08-07', to: '2026-08-07' },
    ]);
  });

  it('доходит до неподвижной точки: отрезок замены втягивает второй документ', () => {
    // Листы недели — пн–вт и ср–вс; новый разрез — пн–чт и пт–вс. Диапазон команды — один четверг.
    const closure = documentClosure(
      [{ from: '2026-08-06', to: '2026-08-06' }],
      [
        { periodFrom: MONDAY, periodTo: '2026-08-04' },
        { periodFrom: WEDNESDAY, periodTo: SUNDAY },
      ],
      [
        { from: MONDAY, to: '2026-08-06' },
        { from: '2026-08-07', to: SUNDAY },
      ],
    );

    // Шаг 1: лист ср–вс. Шаг 2: его замена пн–чт вылезает за него влево. Шаг 3: втянут лист пн–вт.
    // Один проход дал бы ср–вс и оставил бы пн–вт без переоформления — молча.
    expect(closure).toEqual([{ from: MONDAY, to: SUNDAY }]);
  });

  it('втягивает соседний лист, пересечённый разросшейся областью, и на этом останавливается', () => {
    const closure = documentClosure(
      [{ from: SUNDAY, to: '2026-08-10' }],
      [
        { periodFrom: MONDAY, periodTo: SUNDAY },
        { periodFrom: '2026-08-10', periodTo: '2026-08-16' },
        { periodFrom: '2026-08-17', periodTo: '2026-08-23' },
      ],
      [],
    );

    expect(closure).toEqual([{ from: MONDAY, to: '2026-08-16' }]);
  });
});

describe('normalizeRangeSet', () => {
  it('сливает пересекающиеся и смежные, отбрасывает перевёрнутые', () => {
    expect(
      normalizeRangeSet([
        { from: '2026-08-10', to: '2026-08-12' },
        { from: MONDAY, to: '2026-08-04' },
        { from: WEDNESDAY, to: SUNDAY },
        { from: '2026-08-20', to: '2026-08-19' },
      ]),
    ).toEqual([{ from: MONDAY, to: '2026-08-12' }]);
  });
});
