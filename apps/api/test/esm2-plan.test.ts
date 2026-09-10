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
  type Esm2WantedSheet,
  esm2RequestedSheetPlan,
  esm2SheetPlan,
  normalizeRangeSet,
  sheetMatchesWanted,
  sheetTrimTarget,
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

    /*
     * Понедельник–вторник прежним составом переписывается тоже: границы листа напечатаны в графе
     * «Период работы», и оставить пн–вс рядом с новым ср–вс значило бы два документа на одни дни.
     *
     * Правка периода (`trim`, Р6) сюда не дотягивается, и это её пятое условие: голова недели по
     * составу и началу подходит, но отнятые ср–вс забирает соседний документ. Сократи мы лист —
     * на площадке остались бы два действующих бланка с одной и той же средой в печатной графе
     * (Р13, решение В8), потому что напечатанный экземпляр невырезанного периода не теряет.
     */
    expect(plan.cancel).toEqual(['w1']);
    expect(plan.trim).toEqual([]);
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

  it('прошедший отрезок выписывается взамен листа, который гасит эта же сверка', () => {
    /*
     * ЭСМ2-РАЗРЕЗ. Смена машиниста со среды: лист пн–вс горит целиком, и взамен обязаны выйти два
     * документа — пн–вт прежним человеком и ср–вс новым. Первый уже кончился, но дырой не является:
     * его дни держал документ, который эта же сверка и гасит. Не разреши мы этого, обычная работа
     * диспетчера оставила бы понедельник со вторником без бумаги — молча (§7, замыкание).
     *
     * Правка периода этот путь не подменяет (пятое условие Р6): хвост ср–вс нужен соседнему
     * документу, значит лист гасится, а не укорачивается, — и `freed` остаётся единственным
     * источником прав на выписку прошедших дней.
     */
    const today = { ...context, today: WEDNESDAY };
    const plan = esm2SheetPlan(
      [segment(MONDAY, '2026-08-04', 'A', set('Иван')), segment(WEDNESDAY, SUNDAY, 'A', set('Пётр'))],
      { dateFrom: MONDAY, dateTo: SUNDAY },
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')],
      today,
    );

    expect(plan).toMatchObject({ cancel: ['w1'], trim: [] });
    expect(plan.issue.map((s) => [s.from, s.to])).toEqual([
      [MONDAY, '2026-08-04'],
      [WEDNESDAY, SUNDAY],
    ]);
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
    // Разблокировка снимает неприкосновенность прошлого — а что делать с открывшимся листом,
    // решают общие правила: неделя режется сменой машиниста, хвост нужен соседнему документу, и
    // правкой периода это не закрывается (пятое условие Р6).
    expect(
      esm2SheetPlan(segments, { dateFrom: MONDAY, dateTo: SUNDAY }, existing, {
        ...past,
        unlockWaybillIds: ['w1'],
      }),
    ).toMatchObject({ locked: [], cancel: ['w1'], trim: [] });
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

/**
 * Сокращение выданного листа — третий исход сверки (Р5, Р6 плана
 * `docs/vehicle-request-actual-end-date-plan.md`).
 *
 * Правило узкое нарочно, и цена ошибки у него в обе стороны бумажная. Сократи сверка лист, который
 * сокращать нельзя, — и заказ получит документ, разошедшийся с работой, но живой: аннулирования не
 * было, следа в журнале нет, а номер по-прежнему числится за этими днями. Не сократи там, где
 * можно, — сгорит бланк строгой отчётности, которого хватило бы на всю неделю.
 *
 * Отсюда пять условий сразу: состав совпал теми же сверками, что решают `kept` против `cancel`;
 * начало не двигается; новый конец не раньше начала и строго раньше прежнего; лист целиком внутри
 * области сверки; отнятые дни не нужны никакому другому ожиданию. Правка умеет **только отнимать
 * дни**, и только в пустоту.
 */
describe('esm2SheetPlan: сокращение выданного листа (Р6)', () => {
  it('срок укоротили внутри недели — лист правится, и ни один номер не расходуется', () => {
    const plan = esm2SheetPlan(
      [segment(MONDAY, WEDNESDAY, 'A', set('Иван'))],
      { dateFrom: MONDAY, dateTo: WEDNESDAY },
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')],
      context,
    );

    // Замены не выписывается: неделю по-прежнему закрывает тот же документ, только короче.
    expect(plan).toMatchObject({
      cancel: [],
      issue: [],
      kept: [],
      trim: [{ waybillId: 'w1', to: WEDNESDAY }],
    });
  });

  it('отнятые дни забирает соседний лист — правки нет, идёт перевыпуск', () => {
    /*
     * Та же неделя и тот же лист, что в проверке выше, и разница ровно в одном: срок не
     * сократили, а разрезали сменой машиниста со среды. По составу, началу и концу голова недели
     * правке подходит — но её хвост ср–вс ждёт второй документ, и это пятое условие Р6.
     *
     * Причина в бумаге, а не в записи: печатный экземпляр остаётся с прежним, невырезанным
     * периодом (Р13, решение В8). Сократи портал лист — на площадке лежали бы два действующих
     * бланка, у обоих в графе «Период работы» стояла бы среда, и один и тот же день можно было бы
     * вписать дважды. Аннулирование этого не допускает: старый бланк уходит из оборота целиком.
     */
    const plan = esm2SheetPlan(
      [
        segment(MONDAY, '2026-08-04', 'A', set('Иван')),
        segment(WEDNESDAY, SUNDAY, 'A', set('Пётр')),
      ],
      { dateFrom: MONDAY, dateTo: SUNDAY },
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')],
      context,
    );

    expect(plan).toMatchObject({ cancel: ['w1'], trim: [] });
    expect(plan.issue.map((s) => [s.from, s.to])).toEqual([
      [MONDAY, '2026-08-04'],
      [WEDNESDAY, SUNDAY],
    ]);
  });

  it('период расширяется — по-прежнему перевыпуск: раздвинуть бланк нечем', () => {
    const plan = esm2SheetPlan(
      [segment(MONDAY, SUNDAY, 'A', set('Иван'))],
      { dateFrom: MONDAY, dateTo: SUNDAY },
      [sheet('w1', MONDAY, WEDNESDAY, 'A', 'Иван')],
      context,
    );

    expect(plan).toMatchObject({ cancel: ['w1'], trim: [] });
    expect(plan.issue.map((s) => [s.from, s.to])).toEqual([[MONDAY, SUNDAY]]);
  });

  it('сменилась машина или человек — перевыпуск, даже когда период только укорачивается', () => {
    const otherVehicle = esm2SheetPlan(
      [segment(MONDAY, WEDNESDAY, 'B', set('Иван'))],
      { dateFrom: MONDAY, dateTo: WEDNESDAY },
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')],
      context,
    );
    const otherDriver = esm2SheetPlan(
      [segment(MONDAY, WEDNESDAY, 'A', set('Пётр'))],
      { dateFrom: MONDAY, dateTo: WEDNESDAY },
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')],
      context,
    );

    // В бланке напечатаны госномер и фамилия: правкой периода это не чинится ни в какую сторону.
    expect(otherVehicle).toMatchObject({ cancel: ['w1'], trim: [] });
    expect(otherDriver).toMatchObject({ cancel: ['w1'], trim: [] });
    expect(otherVehicle.issue).toHaveLength(1);
    expect(otherDriver.issue).toHaveLength(1);
  });

  it('сдвинулось начало — перевыпуск: другой первый день это другой документ', () => {
    const plan = esm2SheetPlan(
      [segment('2026-08-04', WEDNESDAY, 'A', set('Иван'))],
      { dateFrom: '2026-08-04', dateTo: WEDNESDAY },
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')],
      context,
    );

    expect(plan).toMatchObject({ cancel: ['w1'], trim: [] });
    expect(plan.issue.map((s) => [s.from, s.to])).toEqual([['2026-08-04', WEDNESDAY]]);
  });

  it('лист вне области сверки не сокращают: до него команда не дотягивается', () => {
    const plan = esm2SheetPlan(
      [segment(MONDAY, '2026-08-12', 'A', set('Иван'))],
      { dateFrom: MONDAY, dateTo: '2026-08-12' },
      [
        sheet('w1', MONDAY, SUNDAY, 'A', 'Иван'),
        sheet('w2', '2026-08-10', '2026-08-16', 'A', 'Иван'),
      ],
      { ...context, scope: [{ from: MONDAY, to: SUNDAY }] },
    );

    // Сократить w2 напрашивается — срок кончается в среду, — но чинить чужой участок попутно
    // нельзя (Р11): человек этого листа в предпросмотре не видел.
    expect(plan).toMatchObject({ outOfScope: ['w2'], kept: ['w1'], cancel: [], trim: [] });
    expect(plan.issue).toEqual([]);
  });

  it('отработанный лист не сокращают: работа состоялась, и переписывать её нельзя', () => {
    const plan = esm2SheetPlan(
      [segment(MONDAY, WEDNESDAY, 'A', set('Иван'))],
      { dateFrom: MONDAY, dateTo: WEDNESDAY },
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')],
      { ...context, today: '2026-08-20' },
    );

    // Правка периода — такое же вмешательство в прошлое, как аннулирование, и той же
    // неприкосновенностью она и останавливается: снимает её только названная коррекция.
    expect(plan).toMatchObject({ locked: ['w1'], cancel: [], trim: [], issue: [] });
  });

  it('ожидание, за которым уже стоит точный лист, соседа к себе не пускает', () => {
    const both = [
      sheet('w1', MONDAY, SUNDAY, 'A', 'Иван'),
      sheet('w2', MONDAY, WEDNESDAY, 'A', 'Иван'),
    ];
    const plan = esm2SheetPlan(
      [segment(MONDAY, WEDNESDAY, 'A', set('Иван'))],
      { dateFrom: MONDAY, dateTo: WEDNESDAY },
      both,
      context,
    );
    // Порядок листов на ответ не влияет: сокращение решается вторым проходом, когда все точные
    // совпадения уже разобраны. Иначе у заявки оказалось бы два действующих документа пн–ср.
    const reversed = esm2SheetPlan(
      [segment(MONDAY, WEDNESDAY, 'A', set('Иван'))],
      { dateFrom: MONDAY, dateTo: WEDNESDAY },
      [...both].reverse(),
      context,
    );

    expect(plan).toMatchObject({ kept: ['w2'], cancel: ['w1'], trim: [] });
    expect(reversed).toMatchObject({ kept: ['w2'], cancel: ['w1'], trim: [] });
  });

  it('правило правки в чистом виде: состав, начало, конец ближе — и пустой хвост', () => {
    // Ожидания закрытия: одна неделя, укороченная сроком до среды. Хвост чт–вс не ждёт никто.
    const closing = esm2SheetPlan(
      [segment(MONDAY, WEDNESDAY, 'A', set('Иван'))],
      { dateFrom: MONDAY, dateTo: WEDNESDAY },
      [],
      context,
    ).wanted;
    const target = closing[0];
    expect(target).toBeDefined();
    if (!target) return;
    const free = new Set<Esm2WantedSheet>();

    expect(sheetTrimTarget(sheet('w', MONDAY, SUNDAY, 'A', 'Иван'), closing, free)).toBe(target);
    // Те же границы — это совпадение, а не правка: отнимать нечего.
    expect(sheetTrimTarget(sheet('w', MONDAY, WEDNESDAY, 'A', 'Иван'), closing, free)).toBeNull();
    expect(sheetMatchesWanted(sheet('w', MONDAY, WEDNESDAY, 'A', 'Иван'), target)).toBe(true);
    // Лист короче ожидания — расширение, которого правка не умеет ни при каких данных.
    expect(sheetTrimTarget(sheet('w', MONDAY, MONDAY, 'A', 'Иван'), closing, free)).toBeNull();
    // Сдвинутое начало и чужой состав правкой не чинятся вовсе.
    expect(
      sheetTrimTarget(sheet('w', '2026-08-04', SUNDAY, 'A', 'Иван'), closing, free),
    ).toBeNull();
    expect(sheetTrimTarget(sheet('w', MONDAY, SUNDAY, 'B', 'Иван'), closing, free)).toBeNull();
    expect(sheetTrimTarget(sheet('w', MONDAY, SUNDAY, 'A', 'Пётр'), closing, free)).toBeNull();
    // За ожиданием уже стоит документ: второй лист в него не сокращается.
    expect(
      sheetTrimTarget(sheet('w', MONDAY, SUNDAY, 'A', 'Иван'), closing, new Set([target])),
    ).toBeNull();

    // Пятое условие: та же голова недели, но хвост ср–вс ждёт соседний документ.
    const split = esm2SheetPlan(
      [
        segment(MONDAY, '2026-08-04', 'A', set('Иван')),
        segment(WEDNESDAY, SUNDAY, 'A', set('Пётр')),
      ],
      { dateFrom: MONDAY, dateTo: SUNDAY },
      [],
      context,
    ).wanted;
    expect(sheetTrimTarget(sheet('w', MONDAY, SUNDAY, 'A', 'Иван'), split, free)).toBeNull();
  });
});

/**
 * Заказ с бумагой «по требованию»: ожидания приходят из выписанного (ADR 0100 §5, Р14).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ НАБОР. Дыра, ради которой этот план и заведён, была молчаливой: общий расчёт
 * сокращения срока планировал листы только у `auto`, у линейного заказа отдавал **пустой** план, а
 * пустой план ничего не правит — выданный на неделю бланк оставался стоять по дни, которых у
 * заказа больше нет. Ни отказа, ни события, ни расхождения в числе листов: заметить это можно было
 * только по самому периоду, взяв бумагу в руки.
 *
 * Правило проверяется тем же составом случаев, каким живёт недельная сторона
 * (`esm2RequestedPeriods` контрактов): неделя внутри срока остаётся как есть, пересечённая новым
 * концом — правится на месте, выпавшая целиком — гаснет без замены, а недели, о которой человек не
 * просил, у заказа не появляется ни при каком сроке.
 */
describe('esm2RequestedSheetPlan: бумага по требованию (ADR 0100 §5)', () => {
  /** Вторая календарная неделя срока: пн 10.08 — вс 16.08. */
  const NEXT_MONDAY = '2026-08-10';
  const NEXT_SUNDAY = '2026-08-16';

  it('срок сократили внутри просимой недели — лист правится на месте, номер не расходуется', () => {
    const plan = esm2RequestedSheetPlan(
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')],
      { dateFrom: MONDAY, dateTo: WEDNESDAY },
      context,
    );

    // Ровно то, чего не делал пустой план: бланк доведён до факта, а замены не выписано — неделю
    // по-прежнему закрывает тот же документ, только короче.
    expect(plan).toMatchObject({
      cancel: [],
      issue: [],
      kept: [],
      trim: [{ waybillId: 'w1', to: WEDNESDAY }],
    });
  });

  it('неделя, целиком ушедшая за новый конец срока, гаснет без замены', () => {
    const plan = esm2RequestedSheetPlan(
      [
        sheet('w1', MONDAY, SUNDAY, 'A', 'Иван'),
        sheet('w2', NEXT_MONDAY, NEXT_SUNDAY, 'A', 'Иван'),
      ],
      { dateFrom: MONDAY, dateTo: SUNDAY },
      context,
    );

    // Замены выпавшей неделе не выписывается: работы в эти дни не будет, и бумаги на них не будет
    // ни у кого. А неделя, оставшаяся внутри срока, не тронута вовсе.
    expect(plan).toMatchObject({ cancel: ['w2'], issue: [], trim: [], kept: ['w1'] });
  });

  it('своих недель режим не заводит: срок длиннее просьбы бумаги не добавляет', () => {
    const plan = esm2RequestedSheetPlan(
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')],
      { dateFrom: MONDAY, dateTo: NEXT_SUNDAY },
      context,
    );

    // Вторую неделю никто не просил — «нужного листа» у неё нет, и портал его не выводит. Это и
    // есть определение режима: бумагу линейному заказу называет человек, а не срок.
    expect(plan).toMatchObject({ cancel: [], issue: [], trim: [], kept: ['w1'] });
    expect(plan.wanted.map((want) => [want.from, want.to])).toEqual([[MONDAY, SUNDAY]]);
  });

  it('состав ожидания берётся из самого листа: неделю закрывают две машины сразу', () => {
    /*
     * ADR 0100 §7: у линейного заказа неделя уникальна на машину, и один и тот же понедельник
     * законно несут два действующих бланка с разными машинами и разными людьми. Сверь мы состав с
     * назначением заявки — один из двух сгорел бы, а его недельный отчёт переписался бы на чужую
     * единицу. Недельная сторона отказывается сверять состав в `on_demand` ровно поэтому; здесь то
     * же самое сказано иначе: ожидание вырезано из листа, и сверяется лист сам с собой.
     */
    const plan = esm2RequestedSheetPlan(
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван'), sheet('w2', MONDAY, SUNDAY, 'B', 'Пётр')],
      { dateFrom: MONDAY, dateTo: SUNDAY },
      context,
    );

    expect(plan).toMatchObject({ cancel: [], issue: [], trim: [] });
    expect([...plan.kept].sort()).toEqual(['w1', 'w2']);
  });

  it('обе недели правятся врозь: сокращение доводит до факта только пересечённую', () => {
    const plan = esm2RequestedSheetPlan(
      [
        sheet('w1', MONDAY, SUNDAY, 'A', 'Иван'),
        sheet('w2', NEXT_MONDAY, NEXT_SUNDAY, 'A', 'Пётр'),
      ],
      { dateFrom: MONDAY, dateTo: '2026-08-12' },
      context,
    );

    expect(plan).toMatchObject({
      cancel: [],
      issue: [],
      kept: ['w1'],
      trim: [{ waybillId: 'w2', to: '2026-08-12' }],
    });
  });

  it('сдвинутое начало срока — другой документ: лист гаснет, а оставшиеся дни выписываются заново', () => {
    /*
     * Правка умеет только отнимать дни с конца: первый день листа напечатан, и сдвинуть его нечем.
     * Поэтому сдвиг начала срока стоит номера — ровно так же, как у недельной стороны, и это не
     * недосмотр разреза, а единственный честный ответ. Случай записан здесь затем, чтобы разница
     * между «правим» и «жжём» была видна набором, а не выводилась из общего правила.
     */
    const plan = esm2RequestedSheetPlan(
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')],
      { dateFrom: '2026-08-04', dateTo: SUNDAY },
      context,
    );

    expect(plan).toMatchObject({ cancel: ['w1'], trim: [] });
    expect(plan.issue.map((want) => [want.from, want.to, want.vehicleId, want.driver])).toEqual([
      ['2026-08-04', SUNDAY, 'A', { state: 'set', personId: 'Иван' }],
    ]);
  });

  it('отработанную неделю сокращение не трогает: работа состоялась', () => {
    // «Сегодня» после конца недели — тот же замок `canCancelWaybill`, каким его ставит недельная
    // сторона: лист отработан, и правка периода ему такая же чужая, как аннулирование.
    const plan = esm2RequestedSheetPlan(
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Иван')],
      { dateFrom: MONDAY, dateTo: WEDNESDAY },
      { ...context, today: '2026-08-20' },
    );

    expect(plan).toMatchObject({ cancel: [], issue: [], trim: [], locked: ['w1'] });
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
    // Лист шире ожидания правкой периода здесь не чинится: неделя разрезана надвое, и хвост ср–вс
    // ждёт соседний документ (пятое условие Р6). Поблажка `unknown` границ не касается вовсе.
    const wrongBounds = esm2SheetPlan(
      segments,
      { dateFrom: MONDAY, dateTo: SUNDAY },
      [sheet('w1', MONDAY, SUNDAY, 'A', 'Неизвестно-кто')],
      context,
    );

    expect(wrongVehicle.cancel).toEqual(['w1']);
    expect(wrongBounds.cancel).toEqual(['w1']);
    expect(wrongBounds.trim).toEqual([]);
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
