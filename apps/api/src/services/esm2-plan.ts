import {
  canCancelWaybill,
  type Esm2Period,
  esm2Periods,
  type Esm2Sheet,
  shiftDateKey,
  type VehicleOwnership,
} from '@technic/contracts';
import type {
  AssignmentRange,
  AssignmentSegment,
  AssignmentTerm,
  DriverState,
} from './assignment-history';
import { sameDriverState } from './assignment-history';

/**
 * План листов ЭСМ-2 **на отрезках** и документное замыкание диапазона
 * (`docs/assignment-periods-plan.md`, Р4–Р6, Р11, Р19, §7).
 *
 * Сегодня единица планирования бумаги — календарная неделя срока (`esm2Periods`), а состав у неё
 * один на всю заявку: машина из назначения и машинист, названный переводом в работу. Это верно
 * ровно до того дня, когда машинист или техника меняются **внутри** срока: неделя тогда законно
 * разрезается на два документа — пн–вт прежним составом, ср–вс новым, — и восстановить это по
 * ключу недели нечем. Единицей ответственности за бланк становится **отрезок** постоянного состава
 * (Р4, Р5), а неделя остаётся тем, чем была на бумаге: семь строк «пн…вс» впечатаны в бланк, и
 * лист не умеет пересекать воскресенье.
 *
 * Отсюда двухступенчатый разрез: срок режется изменениями обеих шкал (`assignmentSegments`), а
 * каждый отрезок дополнительно режется границей календарной недели (`esm2Periods`). Ответственность
 * за бланк приписывается **отрезку**, а не заявке: принадлежность читается по его машине, и заказ,
 * который вели арендной единицей, а продолжают своей, заводит бумагу с того дня, а не с начала
 * срока.
 *
 * **Модуль новый и параллельный сегодняшнему `waybill-esm2.ts`.** Тот ведёт боевую сверку по
 * неделям и до переключения чтения (§10 плана) остаётся единственным, кто трогает бумагу. Здесь
 * лежит чистый расчёт, который подставят на этапе 3, и говорит он на том же языке: лист — это
 * `Esm2Sheet` с границами, машиной и человеком, набор нужных листов — `wanted`, а результат сверки
 * — «что аннулировать, что выписать, что оставить».
 *
 * Всё, что здесь есть, — чистые функции: ни базы, ни времени, ни справочников. Причина та же, что
 * у свёртки: этими же функциями считает предпросмотр, которому запрещено записывать хоть что-то
 * (Р20), и теневое сравнение, которое гоняет их на состоянии, никогда не существовавшем в базе.
 * «Сегодня» приходит параметром, а не берётся из часов: полночь между принятым отпечатком и
 * исполнением отдала бы другой план по уже подтверждённому обещанию (Р12).
 */

// ── Что должно быть выписано ──

/**
 * Кто ведёт бланк на этих днях (Р4). Считается по машине отрезка: `vehicles.ownership` неизменяем,
 * и смена принадлежности означала бы подмену сущности, а не правку признака.
 *
 * Значения ровно два, и третьего «портал не знает» здесь нет намеренно: отрезок без машины
 * ответственности не получает вовсе (`null` у отрезка), потому что «неизвестно чем» — это не
 * «арендодатель ведёт», и приписывать такому отрезку бланк нельзя ни одной из двух сторон.
 */
export type Esm2Responsibility = 'portal' | 'lessor';

/** Отрезок постоянного состава с приписанной ему ответственностью за бланк (Р4). */
export interface Esm2PaperSegment {
  from: string;
  to: string;
  vehicle: { vehicleId: string } | null;
  driver: DriverState | null;
  /** `null` — у отрезка нет машины, и приписывать бланк некому. */
  responsibility: Esm2Responsibility | null;
}

/**
 * Лист, который должен существовать: отрезок, подрезанный календарной неделей, со своим составом.
 *
 * Состав лежит в самом ожидании, а не добирается исполнителем из заявки: после разреза пн–вт и
 * ср–вс — два документа с разными машиной и человеком, и восстановить это по ключу недели нечем
 * (§7 плана, `Esm2ScopedPlan`).
 *
 * Состояний машиниста здесь два из трёх: `set` — лист выписывается на этого человека,
 * `unknown` — история этих дней восстановлена приблизительно, лист **не выписывается**, но
 * существующий сверяется по машине и границам, а графа человека считается пробелом (Р19).
 * Отрезка со снятым машинистом (`cleared`) и с незаданной шкалой в ожиданиях нет вовсе: бумаги там
 * не ожидается.
 */
export interface Esm2WantedSheet extends Esm2Period {
  vehicleId: string;
  driver: Extract<DriverState, { state: 'set' } | { state: 'unknown' }>;
  /** Всегда `portal`: арендный отрезок в ожидания не попадает — его бланк ведёт арендодатель. */
  responsibility: 'portal';
}

/** Ожидание, которое портал вправе напечатать: человек известен, значит графа заполняется. */
export type Esm2IssuableSheet = Esm2WantedSheet & {
  driver: Extract<DriverState, { state: 'set' }>;
};

/** Действующий лист заявки в том виде, в каком его сверяет план; форма — общая с контрактами. */
export type Esm2ExistingSheet = Esm2Sheet;

/**
 * Что сделать с бумагой заявки, чтобы она сошлась с разрезом.
 *
 * Три исхода у листа вместо двух: сверх «аннулировать» и «оставить» есть ещё «не трогать вовсе» —
 * отработанный лист (`locked`) и лист вне области сверки. Различать обязательно: `kept` означает
 * «сошлось», а `locked` — «не сверялось», и свести их в один список значило бы спрятать
 * расхождение за неприкосновенностью прошлого (Р11).
 */
export interface Esm2SheetPlan {
  /** Листы, которые должны существовать при этом разрезе, — вместе с неразрешёнными к выписке. */
  wanted: Esm2WantedSheet[];
  /** Идентификаторы листов под аннулирование: состав разошёлся либо этих дней больше нет. */
  cancel: string[];
  /** Что выписать новыми номерами: ожидания, которым не нашлось листа и которым это разрешено. */
  issue: Esm2IssuableSheet[];
  /** Листы, совпавшие с ожиданием: сошлось — не трогаем, и ни один номер не сгорит. */
  kept: string[];
  /**
   * Отработанные листы (граница `canCancelWaybill`), которых план не тронул: работа состоялась, и
   * переписывать её задним числом нельзя. Из них считаются `requiredUnlockIds` предпросмотра
   * (Р11) — это и есть та бумага, которую операция обязана назвать поимённо, чтобы её переоформить.
   */
  locked: string[];
  /**
   * Листы вне области сверки. От `locked` отделены нарочно: разблокировки они не требуют — команда
   * до них просто не дотягивается, — и подмешать их в `requiredUnlockIds` значило бы просить
   * человека подтвердить бумагу, которой он в предпросмотре не видел (Р11).
   */
  outOfScope: string[];
}

/** Что план знает о мире сверх самого разреза. */
export interface Esm2PlanContext {
  /**
   * Принадлежность каждой машины разреза (Р4). Карта обязана быть полной: машину, которой в ней
   * нет, план не угадывает — молча приписать её порталу значит выписать бланк на чужую единицу, а
   * молча арендодателю — сжечь номер уже выписанного листа.
   */
  ownershipByVehicle: ReadonlyMap<string, VehicleOwnership>;
  /**
   * Сегодня по МСК: им отделяются отработанные отрезки от предстоящих. Захватывается вызывающим
   * один раз на транзакцию (Р12), а не читается здесь из часов.
   */
  today: string;
  /**
   * Область сверки (`syncScope`, Р11): вне неё не выписывается и не гасится ничего — даже там, где
   * план видит расхождение. Не задана — весь разрез.
   *
   * Приходить сюда обязана **неподвижная точка** `documentClosure`, а не дневной диапазон команды:
   * иначе половина документа окажется внутри области, а половина снаружи, и лист пн–вс не будет ни
   * переоформлен, ни оставлен в покое.
   */
  scope?: readonly AssignmentRange[];
  /**
   * Листы, которые операция коррекции назвала поимённо (ADR 0101, Р11): им отработанный отрезок не
   * защита. Перечень намерения, а не разрешение: право, принадлежность листа заявке и глубину
   * проверяет вызывающий.
   */
  unlockWaybillIds?: readonly string[];
  /**
   * Контекст проверенной операции коррекции: только с ним выписывается отрезок, который уже
   * кончился. Без него прошедший отрезок без листа не выписывается вовсе — это та же граница, что
   * у сегодняшней сверки (ADR 0101, Р21).
   */
  correction?: { allowed: true };
}

// ── Отрезки бумаги ──

/**
 * Отрезки разреза, подрезанные сроком и с приписанной ответственностью за бланк (Р4).
 *
 * Срок здесь — не украшение: разрез считается по истории, а история живёт и за концом срока
 * (Р24), и до его начала. Границы бумаги задаёт срок, поэтому отрезок, вылезший за него,
 * подрезается, а выпавший целиком — отбрасывается.
 *
 * Соседи одинакового состава схлопываются повторно (Р12). `assignmentSegments` это уже сделала, и
 * второй проход обычно ничего не находит — но он бесплатен и защищает от несхлопнутого входа:
 * изменение, вернувшее прежнего человека, законно живёт в истории отдельной строкой, а двумя
 * листами одна неделя из-за него печататься не должна. Схлопываются только **смежные** отрезки:
 * разрыв в календаре — это разрыв в бумаге, и сшивать через него нельзя.
 */
export function esm2PaperSegments(
  segments: readonly AssignmentSegment[],
  term: AssignmentTerm,
  ownershipByVehicle: ReadonlyMap<string, VehicleOwnership>,
): Esm2PaperSegment[] {
  const last = term.dateTo || term.dateFrom;
  if (!term.dateFrom || last < term.dateFrom) return [];

  const clipped: Esm2PaperSegment[] = [];
  for (const segment of segments) {
    const from = segment.from > term.dateFrom ? segment.from : term.dateFrom;
    const to = segment.to < last ? segment.to : last;
    if (to < from) continue;
    clipped.push({
      from,
      to,
      vehicle: segment.vehicle,
      driver: segment.driver,
      responsibility: responsibilityOf(segment.vehicle, ownershipByVehicle),
    });
  }
  return collapsePaperSegments(clipped);
}

/**
 * Какие листы должны существовать при этом разрезе — и что для этого сделать с уже выписанными.
 *
 * Работа делится надвое, и половины эти независимы. Первая — «что должно быть»: portal-отрезки
 * режутся календарной неделей, и каждый кусок становится ожиданием со своим составом. Вторая —
 * сверка с тем, что есть: выданный лист не правится никогда (бланк строгой отчётности с
 * исправленными графами — не документ), поэтому исходов у него ровно три — совпал, аннулируется,
 * не трогается.
 *
 * Что здесь изменилось против недельной сверки (Р5):
 *
 * - `kept` считается по границам, машине **и** человеку отрезка, а не по понедельнику: в одной
 *   неделе законно живут два самостоятельных документа, и ключ недели их не различает;
 * - `locked` запирает **дни** выписанного листа, а не его календарную неделю: разрез пн–вт / ср–вс
 *   означает, что отработанный пн–вт не вправе запретить выписку ср–вс;
 * - граница прошедшего считается по концу **отрезка** (`to >= today`), тем же концом, каким её
 *   считает `canCancelWaybill` для листа.
 *
 * Неприкосновенности прошлого две, и снимаются они разными ключами: `unlockWaybillIds` открывает
 * названный отработанный лист, `correction` разрешает выписать отрезок, который уже кончился. По
 * одиночке они не работают — разблокировав лист, но не разрешив прошедший отрезок, план сжёг бы
 * номер и не выписал замены.
 */
export function esm2SheetPlan(
  segments: readonly AssignmentSegment[],
  term: AssignmentTerm,
  existing: readonly Esm2ExistingSheet[],
  context: Esm2PlanContext,
): Esm2SheetPlan {
  const wanted = wantedSheets(esm2PaperSegments(segments, term, context.ownershipByVehicle));
  const scope = context.scope ? normalizeRangeSet(context.scope) : null;
  const unlocked = new Set(context.unlockWaybillIds ?? []);

  const cancel: string[] = [];
  const kept: string[] = [];
  const locked: string[] = [];
  const outOfScope: string[] = [];
  /** Ожидания, за которыми уже стоит документ: второй такой же лист не выписывается. */
  const covered = new Set<Esm2WantedSheet>();
  /**
   * Дни, занятые листом, который остаётся на месте. Отработанный лист держит свою работу, лист вне
   * области — чужую бумагу, и в обоих случаях выписать поверх значило бы выдать два документа на
   * одни и те же дни. Занятость считается по дням листа, а не по его неделе (Р5).
   */
  const busy: AssignmentRange[] = [];

  for (const sheet of existing) {
    const period: AssignmentRange = { from: sheet.periodFrom, to: sheet.periodTo };
    // Область спрашивается первой: вне неё сверка не трогает ничего — даже когда видит расхождение,
    // — и разблокировки такому листу не нужно, потому что переоформлять его никто не собирается.
    if (scope && !rangeSetCovers(scope, period)) {
      outOfScope.push(sheet.id);
      busy.push(period);
      continue;
    }
    if (
      !unlocked.has(sheet.id) &&
      !canCancelWaybill(
        { issuedForDate: sheet.periodFrom, periodTo: sheet.periodTo },
        context.today,
      )
    ) {
      locked.push(sheet.id);
      busy.push(period);
      continue;
    }
    const match = wanted.find((expected) => sheetMatchesWanted(sheet, expected));
    if (match) {
      kept.push(sheet.id);
      covered.add(match);
      continue;
    }
    cancel.push(sheet.id);
  }

  const issue = wanted.filter(
    (want): want is Esm2IssuableSheet =>
      // Ожидание без имени человека не печатается: графа машиниста в бланке одна, и заполнить её
      // нечем (Р19). Чинит это якорь по Р16, а не план бумаги.
      want.driver.state === 'set' &&
      !covered.has(want) &&
      !busy.some((period) => rangesIntersect(period, { from: want.from, to: want.to })) &&
      // Кончившийся отрезок выписывается только проверенной операцией (Р21): прошедший день без
      // листа — это дыра, и заполнять её попутно, без права и причины, портал не вправе.
      (context.correction?.allowed === true || want.to >= context.today) &&
      (scope === null || rangeSetCovers(scope, { from: want.from, to: want.to })),
  );

  return { wanted, cancel, issue, kept, locked, outOfScope };
}

// ── Предикаты сверки ──

/**
 * Совпал ли выписанный лист с ожиданием: границы, машина и человек (Р5).
 *
 * Границы сверяются обе, а не один понедельник: после разреза в неделе законно стоят два
 * документа, и лист пн–вс, чьи дни теперь принадлежат двум составам, обязан сгореть, а не
 * зачесться за первый попавшийся.
 *
 * Человек сверяется точно у ожидания `set` и не сверяется вовсе у `unknown` (Р19): заблокированный
 * `unknown` означает ровно то, что написано, — бланк выдан, человек в нём напечатан, а история
 * этого дня восстановлена приблизительно; без этой поблажки сверка каждый раз хотела бы
 * переоформить старую бумагу, кем именно — не зная. Игнорируется при этом **только** графа
 * человека: машина и границы сверяются как обычно, потому что `unknown` — пробел в одной графе, а
 * не разрешение считать весь лист совпавшим с чем угодно.
 */
export function sheetMatchesWanted(sheet: Esm2ExistingSheet, wanted: Esm2WantedSheet): boolean {
  if (sheet.periodFrom !== wanted.from || sheet.periodTo !== wanted.to) return false;
  if (sheet.vehicleId !== wanted.vehicleId) return false;
  if (wanted.driver.state === 'unknown') return true;
  return sheet.driverPersonId === wanted.driver.personId;
}

/**
 * Ожидания portal-отрезков, разрезанные календарной неделей.
 *
 * Неделя остаётся границей документа и после Р5: строки «пн…вс» впечатаны в бланк, недельные итоги
 * считаются по ним, и лист, перешагнувший воскресенье, не документ. Разрез отрезком — вторая
 * граница поверх этой, а не вместо неё.
 *
 * Ожидания заводятся только там, где бумага портала вообще ожидается: у арендного отрезка её ведёт
 * арендодатель, у отрезка без машины печатать нечего, а снятый машинист (`cleared`) — это прямое
 * «работы портальной единицы здесь нет». Портальный отрезок без имени человека — нарушение Р16, и
 * чинит его якорь, а не план бумаги.
 */
function wantedSheets(segments: readonly Esm2PaperSegment[]): Esm2WantedSheet[] {
  const wanted: Esm2WantedSheet[] = [];
  for (const segment of segments) {
    if (segment.responsibility !== 'portal' || !segment.vehicle) continue;
    const driver = segment.driver;
    if (!driver || driver.state === 'cleared') continue;
    for (const period of esm2Periods(segment.from, segment.to)) {
      wanted.push({
        from: period.from,
        to: period.to,
        vehicleId: segment.vehicle.vehicleId,
        driver,
        responsibility: 'portal',
      });
    }
  }
  return wanted;
}

// ── Сравнимая проекция плана (Г4, §7) ──

/**
 * Один документ плана в сравнимой форме: границы, машина и человек.
 *
 * Всё, что рождается **после** расхода номера, сюда не входит: `waybillId`, серия, номер и
 * соответствие `issueKey → waybillId`. Их у плана ещё нет, и сравнивать по ним значило бы
 * сравнивать не планы, а результаты двух разных записей.
 */
export interface LegacyComparableSheet {
  from: string;
  to: string;
  vehicleId: string;
  /**
   * `null` — сторона человека не называет. У недельной сверки это законное состояние: машиниста
   * она берёт с последнего листа заявки и до выписки может не знать его вовсе.
   */
  driverPersonId: string | null;
}

/**
 * Нормализованная проекция плана бумаги — то, чем сравнивают недельный расчёт с отрезковым (Г4).
 *
 * Одна на три места: гейт совместимости этапа 3 (В3), теневое сравнение этапа 4 и тесты. Три
 * независимых нормализатора разошлись бы, и разошлись бы молча — каждый на своей правке.
 *
 * Сравнивать сырые планы нельзя: старый несёт одни периоды, новый — ещё и состав со снимками.
 * Сравнивать одни периоды мало: документы различаются машиной и человеком.
 */
export interface LegacyComparablePlan {
  /** Идентификаторы листов под аннулирование, отсортированные. */
  cancel: string[];
  /** Документы к выписке в каноническом порядке. */
  issue: LegacyComparableSheet[];
}

/**
 * Привести план к сравнимой форме: отсортировать обе половины и отбросить всё лишнее.
 *
 * Порядок канонический, а не «как сложилось»: у старого расчёта недели идут сроком, у нового —
 * отрезками, и сравнение двух списков, отличающихся только порядком, дало бы ложное расхождение.
 */
export function toLegacyComparable(
  cancel: readonly string[],
  issue: readonly LegacyComparableSheet[],
): LegacyComparablePlan {
  return {
    cancel: [...cancel].sort(),
    issue: issue
      .map((sheet) => ({
        from: sheet.from,
        to: sheet.to,
        vehicleId: sheet.vehicleId,
        driverPersonId: sheet.driverPersonId,
      }))
      .sort((a, b) => (sheetKey(a) < sheetKey(b) ? -1 : sheetKey(a) > sheetKey(b) ? 1 : 0)),
  };
}

/**
 * Ключ сравнения: две проекции равны тогда и только тогда, когда равны их ключи.
 *
 * `withDriver` — не настройка удобства, а сам вопрос, который задают сравнению, и у двух его
 * потребителей он разный:
 *
 * - **гейт совместимости** (В3) спрашивает «выйдут ли те же документы»: человека он не сверяет,
 *   потому что старый исполнитель печатает во всех своих листах одного машиниста заявки по
 *   построению, и сверка по человеку отвергала бы саму работу двери. Кого именно напечатают,
 *   гейт спрашивает отдельно (`assertLegacyDriverReachable`);
 * - **теневое сравнение** (этап 4) спрашивает «выйдет ли та же бумага»: графа машиниста в бланке
 *   есть, и лист, выписанный не на того человека, — другой документ.
 */
export function legacyComparableKey(
  plan: LegacyComparablePlan,
  options: { withDriver: boolean },
): string {
  return JSON.stringify({
    cancel: plan.cancel,
    issue: plan.issue.map((sheet) =>
      options.withDriver ? sheetKey(sheet) : `${sheet.from}|${sheet.to}|${sheet.vehicleId}`,
    ),
  });
}

/** Каноническая строка документа: по ней и сортируют, и сравнивают. */
function sheetKey(sheet: LegacyComparableSheet): string {
  return `${sheet.from}|${sheet.to}|${sheet.vehicleId}|${sheet.driverPersonId ?? ''}`;
}

// ── Документное замыкание (§7, Р11) ──

/**
 * Набор календарных диапазонов: отсортирован, без пересечений и без смежностей.
 *
 * Форма нормальная, а не «как сложилось»: этот набор уходит в отпечаток предпросмотра, и два
 * расчёта одного и того же состояния обязаны дать посимвольно один и тот же ответ.
 */
export type DateRangeSet = AssignmentRange[];

/**
 * Замыкание диапазона по **документам**, которых он касается, — до неподвижной точки.
 *
 * Дневной диапазон команды (`paperRange`) — мера логического эффекта: что она изменила по дням.
 * Мера бумаги другая, потому что единица бумаги — документ, а не день: лист `A + Иван` выписан на
 * пн–вс, с среды ставят Петра — команда обязана переоформить **всю** неделю, включая понедельник и
 * вторник прежним составом. Считай область по дневному диапазону — и пн–вт остались бы без бумаги,
 * причём молча: план бы их не назвал, а постусловие бы их не проверило.
 *
 * И столь же твёрдо обратное: **это не округление до календарной недели**. У заявки уже бывают два
 * самостоятельных документа внутри одной недели — пн–вт и ср–вс (разрез Р5), — и округление
 * втянуло бы в область чужой пн–вт, назвало бы его в разблокировках и сожгло бы его номер. А если
 * листа за пн–чт не было вовсе, округление попутно заполнило бы прошлую дыру: ту самую, ради
 * запрета которой область и заведена.
 *
 * Отсюда алгоритм и его итеративность:
 *
 * ```
 * scope = range
 * повторять до стабилизации:
 *   scope ∪= действующие листы, пересекающие scope, целиком
 *   scope ∪= отрезки wanted, нужные для замены этих листов
 * ```
 *
 * Второй шаг тянется за первым, а первый — за вторым: добавленный отрезок `wanted` может
 * дотянуться до соседнего документа, тот втянет свои отрезки замены, и область вырастет ещё раз.
 * Один проход поэтому неверен — нужна неподвижная точка. Сходимость даёт монотонность: за проход
 * область только растёт и растёт целыми документами, а их конечное число.
 *
 * `wanted` берутся **и до, и после команды**: замена считается по обоим разрезам, иначе область не
 * накрыла бы отрезок, который команда как раз упраздняет. Отрезок `wanted`, не пересёкший ни
 * одного втянутого листа, в область не входит: он не «замена документа», а просто соседний день, и
 * втягивать его значило бы чинить то, о чём не просили.
 */
export function documentClosure(
  range: readonly AssignmentRange[],
  sheets: readonly Pick<Esm2ExistingSheet, 'periodFrom' | 'periodTo'>[],
  wanted: readonly Esm2Period[] = [],
): DateRangeSet {
  let scope = normalizeRangeSet(range);
  if (scope.length === 0) return scope;

  const absorbedSheets: AssignmentRange[] = [];
  const takenSheet = new Set<number>();
  const takenWanted = new Set<number>();

  for (;;) {
    let grown = false;
    sheets.forEach((sheet, index) => {
      if (takenSheet.has(index)) return;
      const period: AssignmentRange = { from: sheet.periodFrom, to: sheet.periodTo };
      if (period.to < period.from || !rangeSetIntersects(scope, period)) return;
      takenSheet.add(index);
      absorbedSheets.push(period);
      scope = normalizeRangeSet([...scope, period]);
      grown = true;
    });
    wanted.forEach((sheet, index) => {
      if (takenWanted.has(index)) return;
      const period: AssignmentRange = { from: sheet.from, to: sheet.to };
      if (period.to < period.from) return;
      // Условие здесь — пересечение с втянутым **листом**, а не с областью: отрезок замены входит
      // в область постольку, поскольку он замещает документ, который команда и так переоформляет.
      if (!absorbedSheets.some((absorbed) => rangesIntersect(absorbed, period))) return;
      takenWanted.add(index);
      scope = normalizeRangeSet([...scope, period]);
      grown = true;
    });
    if (!grown) return scope;
  }
}

// ── Наборы диапазонов ──

/** Пересекаются ли два диапазона хотя бы одним днём. */
export function rangesIntersect(a: AssignmentRange, b: AssignmentRange): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/** Касается ли набор диапазона хотя бы одним днём. */
export function rangeSetIntersects(
  set: readonly AssignmentRange[],
  range: AssignmentRange,
): boolean {
  return set.some((part) => rangesIntersect(part, range));
}

/**
 * Лежит ли диапазон в наборе **целиком**.
 *
 * Целиком, а не наполовину: половина документа внутри области означала бы лист, который команда и
 * не переоформила, и не оставила в покое. Проверка идёт по одному отрезку набора, и этого
 * достаточно — набор нормализован, а смежные отрезки в нём слиты в один.
 */
export function rangeSetCovers(set: readonly AssignmentRange[], range: AssignmentRange): boolean {
  return set.some((part) => part.from <= range.from && range.to <= part.to);
}

/**
 * Нормальная форма набора: перевёрнутые диапазоны отброшены, остальные отсортированы и слиты.
 *
 * Слияние идёт и по пересечению, и по смежности: «1–3» и «4–5» — это «1–5», и в область они входят
 * одинаково. Без слияния смежных та же область имела бы два разных написания, а от написания
 * зависит отпечаток предпросмотра.
 */
export function normalizeRangeSet(ranges: readonly AssignmentRange[]): DateRangeSet {
  const sorted = ranges
    .filter((range) => range.from <= range.to)
    .map((range) => ({ from: range.from, to: range.to }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1));

  const merged: DateRangeSet = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    // Смежность — это «следующий день», и считается она сдвигом ключа, а не сравнением строк.
    if (previous && range.from <= shiftDateKey(previous.to, 1)) {
      if (range.to > previous.to) previous.to = range.to;
      continue;
    }
    merged.push(range);
  }
  return merged;
}

// ── Внутреннее ──

/** Кто ведёт бланк на машине отрезка; машины нет — приписывать некому. */
function responsibilityOf(
  vehicle: { vehicleId: string } | null,
  ownershipByVehicle: ReadonlyMap<string, VehicleOwnership>,
): Esm2Responsibility | null {
  if (!vehicle) return null;
  const ownership = ownershipByVehicle.get(vehicle.vehicleId);
  if (!ownership) {
    throw new Error(
      `Принадлежность машины ${vehicle.vehicleId} не передана: план бумаги её не угадывает`,
    );
  }
  return ownership === 'own' ? 'portal' : 'lessor';
}

/** Схлопывание смежных отрезков одинакового состава: первый растёт до конца последнего из них. */
function collapsePaperSegments(segments: readonly Esm2PaperSegment[]): Esm2PaperSegment[] {
  const merged: Esm2PaperSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      shiftDateKey(previous.to, 1) === segment.from &&
      (previous.vehicle?.vehicleId ?? null) === (segment.vehicle?.vehicleId ?? null) &&
      sameDriverState(previous.driver, segment.driver)
    ) {
      previous.to = segment.to;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}
