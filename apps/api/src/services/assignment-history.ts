import {
  shiftDateKey,
  type AssignmentChangeOrigin,
  type AssignmentDimension,
  type DriverState,
  type DriverStateKind,
} from '@technic/contracts';

export type { AssignmentChangeOrigin, AssignmentDimension, DriverState, DriverStateKind };

/**
 * Свёртка истории назначения: чем и с кем заявка работала в каждый свой день
 * (`docs/assignment-periods-plan.md`, Р1–Р3, Р19, Р24).
 *
 * Сегодня состав заявки — одна строка `vehicle_request_assignments`, то есть «эта машина на весь
 * срок». История заменяет её разреженными изменениями «с этого дня — вот так», и отсюда всё
 * остальное: конца у изменения нет — его задаёт следующее изменение той же шкалы, — а «не
 * менялось» выражается отсутствием строки, а не значением. Поэтому вопрос «что действовало 5
 * августа» нельзя задать одной строке: на него отвечает свёртка, и другого ответа у системы быть
 * не должно.
 *
 * Шкал две, и независимы они на уровне строк (Р3): у одной даты законно стоят два изменения —
 * своё по машине и своё по машинисту, — с разным происхождением, разными авторами и разными
 * коррекциями. Свернуть их в общую строку «состав на дату» нельзя ни в таблице, ни здесь: смена
 * машиниста машину не переписывает, и наоборот.
 *
 * Погашенные строки (`supersededAt`) не участвуют ни в одной функции модуля. Правка изменения не
 * правит строку, а гасит прежнюю и вставляет новую (Р3); оставь свёртка погашенную в счёте — у
 * заявки оказалось бы два ответа на один день, и какой из них попал в бумагу, выяснялось бы по
 * бумаге.
 *
 * Модуль чистый: он ничего не читает и ничего не пишет — строки приносит вызывающий, уже
 * отобранные по своей заявке. Это не аккуратность ради аккуратности: теми же функциями считает
 * предпросмотр, которому запрещено записывать хоть что-нибудь (Р20), и теневое сравнение, которое
 * гоняет их на состоянии, никогда не существовавшем в базе.
 */

// ── Строка истории ──

/*
 * Шкалы, состояния машиниста и происхождение строки живут в контрактах и сюда только приходят.
 * Второе объявление той же формы было бы прямым нарушением Р19: три состояния ценны ровно тем, что
 * проходят сквозь таблицу, свёртку, DTO и план **одной** формой, а два независимо правимых
 * определения расходятся молча и именно на редком третьем состоянии.
 *
 * Свёртке `origin` безразличен: и заполнение дыры (`known_fill`), и граница остатка
 * (`unknown_remainder`) — обычные строки своей шкалы. Различает их только отмена, которой нужно
 * знать, чьё решение она снимает.
 */

/**
 * Строка `vehicle_request_assignment_changes` так, как её отдаёт выборка по заявке.
 *
 * `origin` и `changeGroupId` свёртка не читает, но из типа не убраны: строку приносят те же
 * выборки, которыми пользуются отмена и решение хвоста, и урезанный тип заставил бы их держать
 * второй. Значения `vehicleId`/`driverPersonId`/`driverState` разложены по колонкам, а не сведены в
 * union: их согласованность держит CHECK в базе, и повторять его формой типа значило бы иметь два
 * источника правды об одной строке.
 */
export interface AssignmentChangeRow {
  id: string;
  effectiveDate: string;
  dimension: AssignmentDimension;
  vehicleId: string | null;
  driverPersonId: string | null;
  driverState: DriverStateKind | null;
  origin: AssignmentChangeOrigin;
  changeGroupId: string;
  /**
   * Погашена ли строка. Само значение свёртке не нужно — важно только «да или нет», — а тип
   * широкий, потому что строка приходит и из выборки drizzle (`Date`), и из снимка операции, где
   * та же метка уже приведена к тексту.
   */
  supersededAt: Date | string | null;
}

// ── Диапазоны ──

/**
 * Срок работ заявки — рамка, внутри которой у истории есть бумажный смысл.
 *
 * Пустой `dateTo` читается как однодневный срок (Р24) — тем же правилом, каким его читают
 * `esm2Periods` и отбор среза: заявка без даты окончания работает один день, а не бесконечно.
 */
export interface AssignmentTerm {
  dateFrom: string;
  dateTo: string | null;
}

/** Отрезок календаря с включёнными границами; обе известны. */
export interface AssignmentRange {
  from: string;
  to: string;
}

/**
 * Логический диапазон изменения (Р24): с его даты до дня перед следующим изменением своей шкалы.
 *
 * Пустой `to` означает противоположное пустому `dateTo` срока — не «один день», а «следующего
 * изменения нет»: последнее изменение шкалы действует и за концом срока, и именно поэтому его
 * оживляет любое будущее продление.
 */
export interface AssignmentLogicalRange {
  from: string;
  to: string | null;
}

// ── Состояние на дату ──

/**
 * Состав заявки на день: что действует по каждой шкале.
 *
 * `null` у шкалы — «ещё не задавалась»: до первого изменения машины у заявки нет, а до первого
 * изменения машиниста портал о нём ничего не утверждает. У шкалы `driver` это третий ответ вдобавок
 * к трём состояниям `DriverState`, и путать его с `cleared` нельзя: «машиниста сняли» — решение
 * человека, «шкала не задана» — его отсутствие.
 */
export interface AssignmentState {
  vehicle: { vehicleId: string } | null;
  driver: DriverState | null;
}

/**
 * Состав на дату: последнее актуальное изменение каждой шкалы с `effectiveDate <= date`.
 *
 * Шкалы сворачиваются порознь и до конца независимо — иначе февральская смена машины стёрла бы
 * январского машиниста, которого никто не менял.
 *
 * Дата вне истории отвечает честно, а не приблизительно: раньше первого изменения — обе шкалы
 * пустые, позже последнего — состав последнего изменения, потому что конца у изменения нет.
 */
export function assignmentStateOn(
  changes: readonly AssignmentChangeRow[],
  date: string,
): AssignmentState {
  const state: AssignmentState = { vehicle: null, driver: null };
  for (const row of actualChanges(changes)) {
    if (row.effectiveDate > date) break;
    applyChange(state, row);
  }
  return state;
}

// ── Отрезки постоянного состава ──

/** Отрезок срока, на котором состав не менялся: границы и то, что на них действует. */
export interface AssignmentSegment {
  from: string;
  to: string;
  vehicle: { vehicleId: string } | null;
  driver: DriverState | null;
}

/**
 * Срок, разрезанный на отрезки постоянного состава: по отрезку на каждый набор «машина + человек».
 *
 * Это замена недельному разрезу (Р5): единица ответственности за бланк — отрезок, а не заявка, и
 * считать её один раз на весь срок неверно с того дня, как машина внутри срока стала меняться.
 * Границы отрезков задают даты изменений **обеих** шкал: смена машиниста в среду режет неделю так
 * же, как смена машины.
 *
 * Изменения, случившиеся до начала срока, отрезков не открывают, но состав первого дня задают — их
 * действие продолжается, а не начинается заново. Изменения за концом срока не открывают ничего:
 * они дремлют (Р24), и разрезать ими нечего.
 *
 * Соседние отрезки одинакового состава схлопываются (Р12). Схлопывать обязательно: изменение,
 * вернувшее прежнего человека, законно живёт в истории отдельной строкой (у него свои автор,
 * причина и коррекция), но двумя листами одна неделя из-за него печататься не должна.
 */
export function assignmentSegments(
  changes: readonly AssignmentChangeRow[],
  term: AssignmentTerm,
): AssignmentSegment[] {
  const last = term.dateTo || term.dateFrom;
  if (!term.dateFrom || last < term.dateFrom) return [];

  const rows = actualChanges(changes);
  const state: AssignmentState = { vehicle: null, driver: null };
  let index = 0;
  for (; index < rows.length && rows[index]!.effectiveDate <= term.dateFrom; index += 1) {
    applyChange(state, rows[index]!);
  }

  const segments: AssignmentSegment[] = [];
  let from = term.dateFrom;
  while (index < rows.length && rows[index]!.effectiveDate <= last) {
    const date = rows[index]!.effectiveDate;
    segments.push({ from, to: shiftDateKey(date, -1), ...state });
    // Все изменения одной даты применяются разом: шкалы у них разные, а отрезок нулевой длины
    // между двумя решениями одного дня не существует ни на бумаге, ни в календаре.
    for (; index < rows.length && rows[index]!.effectiveDate === date; index += 1) {
      applyChange(state, rows[index]!);
    }
    from = date;
  }
  segments.push({ from, to: last, ...state });
  return collapseSegments(segments);
}

// ── Диапазон одного изменения ──

/** Два диапазона одного изменения (Р24): логический и его пересечение со сроком. */
export interface AssignmentEffect {
  /** До какого дня изменение действует по своей шкале — мера логического эффекта (Р11). */
  logical: AssignmentLogicalRange;
  /**
   * Пересечение со сроком. `null` — изменение дремлющее: бумаги, подписей и запретов оно не
   * трогает, постусловие проверять не на чем, а отмена ему разрешена независимо от календаря.
   */
  inTerm: AssignmentRange | null;
}

/**
 * С какого дня по какой действует конкретное изменение.
 *
 * Диапазонов два, потому что дату за концом срока заводить разрешено (Р13, шкала `driver`): один
 * диапазон дал бы на такое изменение перевёрнутый отрезок вроде «с 1 сентября по 31 августа» и
 * потащил бы его в разблокировки и постусловие. Логический диапазон существует всегда — им
 * считается «тот же человек» при проверке пустой команды (Р12) и им же изменение оживает после
 * продления срока; бумажный (`inTerm`) у дремлющего изменения пуст.
 *
 * `null` в ответе — изменения среди актуальных нет: либо чужой `changeId`, либо строка уже
 * погашена. Погашенная не действует ни одного дня, и выдавать ей диапазон нельзя — прежний
 * `inTermRange` группы, по которому Р32 выбирает вид операции, считается **до** гашения, пока
 * строка ещё актуальна.
 */
export function assignmentEffectRange(
  changes: readonly AssignmentChangeRow[],
  changeId: string,
  term: AssignmentTerm,
): AssignmentEffect | null {
  const rows = actualChanges(changes);
  const target = rows.find((row) => row.id === changeId);
  if (!target) return null;
  return effectFrom(rows, target.dimension, target.effectiveDate, term);
}

/**
 * Тот же диапазон, но у строки, которой ещё нет: «если записать изменение этой шкалы такой датой —
 * до какого дня оно будет действовать».
 *
 * Нужен предпросмотру и расчёту последствий (Р11): они обязаны назвать ширину команды **до** того,
 * как что-нибудь записано. Считать это вторым списком правил нельзя — он разошёлся бы с
 * `assignmentEffectRange` на первой же тонкости, вроде второй строки той же даты, — поэтому обе
 * функции ведёт один расчёт.
 *
 * Строка своей же даты границей не считается: новая заменит её, а не встанет следом.
 */
export function plannedEffectRange(
  changes: readonly AssignmentChangeRow[],
  dimension: AssignmentDimension,
  effectiveDate: string,
  term: AssignmentTerm,
): AssignmentEffect {
  return effectFrom(actualChanges(changes), dimension, effectiveDate, term);
}

function effectFrom(
  rows: readonly AssignmentChangeRow[],
  dimension: AssignmentDimension,
  effectiveDate: string,
  term: AssignmentTerm,
): AssignmentEffect {
  const next = rows.find((row) => row.dimension === dimension && row.effectiveDate > effectiveDate);
  const logical: AssignmentLogicalRange = {
    from: effectiveDate,
    to: next ? shiftDateKey(next.effectiveDate, -1) : null,
  };
  return { logical, inTerm: intersectTerm(logical, term) };
}

// ── Сравнение состава ──

/** Тот же человек на шкале? `null` («не задана») равен только `null`, но не `cleared`. */
export function sameDriverState(a: DriverState | null, b: DriverState | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.state === 'set') return b.state === 'set' && a.personId === b.personId;
  return a.state === b.state;
}

/**
 * Одинаков ли состав. По этому сравнению схлопываются соседние отрезки и по нему же отклоняется
 * пустая команда (Р12) — двумя разными сравнениями они однажды разошлись бы, и портал предложил бы
 * изменение, которое сервер считает ничем.
 */
export function sameAssignmentState(a: AssignmentState, b: AssignmentState): boolean {
  if ((a.vehicle?.vehicleId ?? null) !== (b.vehicle?.vehicleId ?? null)) return false;
  return sameDriverState(a.driver, b.driver);
}

// ── Внутреннее ──

/**
 * Актуальные строки по возрастанию даты. Сортировка своя, а не «как пришло из выборки»: порядок
 * строк — часть ответа, и полагаться на `ORDER BY` вызывающего значило бы получить другой состав от
 * запроса, отсортированного по времени создания.
 */
function actualChanges(changes: readonly AssignmentChangeRow[]): AssignmentChangeRow[] {
  return changes
    .filter((row) => !row.supersededAt)
    .sort((a, b) => {
      if (a.effectiveDate < b.effectiveDate) return -1;
      return a.effectiveDate > b.effectiveDate ? 1 : 0;
    });
}

/**
 * Применяет одно изменение к накопленному состоянию.
 *
 * Строка без значения своей шкалы пропускается, а не читается как «шкалу очистили»: CHECK такой
 * строки не допускает вовсе (§6), и появись она — правильнее оставить историю как есть, чем дать
 * испорченной строке молча стереть машину или человека.
 */
function applyChange(state: AssignmentState, row: AssignmentChangeRow): void {
  if (row.dimension === 'vehicle') {
    if (row.vehicleId) state.vehicle = { vehicleId: row.vehicleId };
    return;
  }
  switch (row.driverState) {
    case 'set':
      if (row.driverPersonId) state.driver = { state: 'set', personId: row.driverPersonId };
      return;
    case 'cleared':
      state.driver = { state: 'cleared' };
      return;
    case 'unknown':
      state.driver = { state: 'unknown' };
      return;
    default:
      return;
  }
}

/** Схлопывание соседей одинакового состава: первый отрезок растёт до конца последнего из них. */
function collapseSegments(segments: readonly AssignmentSegment[]): AssignmentSegment[] {
  const merged: AssignmentSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && sameAssignmentState(previous, segment)) {
      previous.to = segment.to;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

/** Пересечение логического диапазона со сроком; пусто — изменение дремлет. */
function intersectTerm(
  range: AssignmentLogicalRange,
  term: AssignmentTerm,
): AssignmentRange | null {
  const last = term.dateTo || term.dateFrom;
  if (!term.dateFrom || last < term.dateFrom) return null;
  const from = range.from > term.dateFrom ? range.from : term.dateFrom;
  const to = range.to === null || range.to > last ? last : range.to;
  return to < from ? null : { from, to };
}
