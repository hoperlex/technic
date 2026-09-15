/**
 * Ранжированная очередь долга: в каком порядке тяжёлое окно разбирает накопленное.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ ОТБОРА. `selector.ts` отвечает на вопрос «можно ли это чинить» — допуск,
 * защищённые области, бюджет одного прохода. Здесь другой вопрос: «что из допустимого стоит взять
 * первым». Повседневному циклу такой вопрос не нужен — он чинит то немногое, что нашлось вокруг
 * изменённых файлов, и порядок там почти не важен. В окне на два часа находок заведомо больше, чем
 * влезет, и порядок становится главным решением: взяли не то — окно потрачено, а долг остался.
 *
 * ПОЧЕМУ СЧЁТ СЧИТАЕТ КОД, А НЕ МОДЕЛЬ. Человек обязан понимать, почему находка оказалась третьей,
 * а не первой, — иначе он не сможет ни согласиться с очередью, ни оспорить её. Модель на вопрос
 * «почему третья» отвечает правдоподобным текстом, который не проверить и который завтра будет
 * другим. Формула из пяти слагаемых проверяется тестом, воспроизводится и объясняется построчно:
 * `reasons` каждой позиции — это и есть объяснение, а не украшение отчёта.
 *
 * ЗДЕСЬ НЕТ ДИСКА, GIT И ПРОЦЕССОВ. Частоту правок считает вызывающий (это git), возраст находки —
 * журнал; сюда они приходят готовыми числами. Иначе порядок очереди нельзя было бы проверить, не
 * заводя репозиторий с историей, и он не проверялся бы вовсе.
 */
import type { BehaviorRisk, FindingSeverity, TrackedFinding } from './finding.ts';
import type { DeepMaintenanceZone } from './types.ts';

/**
 * Сигналы, которых нет в самой находке.
 *
 * Оба считает вызывающий, и оба намеренно числа, а не источники: подмени их на «репозиторий» и
 * «журнал» — и ранжирование станет непроверяемым.
 */
export interface DebtSignals {
  /** Сколько раз файл менялся за окно наблюдения: считает вызывающий (git), сюда приходит числом. */
  readonly hotness: ReadonlyMap<string, number>;
  /** Возраст находки в днях по журналу: 0 для новых. Ключ — отпечаток находки. */
  readonly ageDays: ReadonlyMap<string, number>;
}

/**
 * Вес каждого слагаемого. Все со значениями по умолчанию.
 *
 * Веса вынесены наружу не ради гибкости, а ради спора: если человек считает, что окно тратится не
 * на то, он меняет число и видит новый порядок — вместо того чтобы переписывать формулу.
 */
export interface DebtWeights {
  readonly severity: number;
  readonly confidence: number;
  readonly risk: number;
  readonly hotness: number;
  readonly age: number;
}

export interface DebtItem {
  readonly finding: TrackedFinding;
  /** Зона, к которой отнесена находка. */
  readonly zone: string;
  /** Больше — раньше в очереди. */
  readonly score: number;
  /** Почему такой счёт: по одной строке на слагаемое. */
  readonly reasons: readonly string[];
}

export interface RankInput {
  readonly findings: readonly TrackedFinding[];
  readonly zones: readonly DeepMaintenanceZone[];
  readonly signals: DebtSignals;
  readonly weights?: Partial<DebtWeights>;
}

export const DEFAULT_DEBT_WEIGHTS: DebtWeights = {
  severity: 3,
  confidence: 1,
  risk: 2,
  hotness: 1.5,
  age: 1,
};

/**
 * Строгость и риск переводятся в доли единицы, а не берутся рангами 1–3.
 *
 * Ранг 1–3 сделал бы `low` втрое дешевле `high` только вместе с весом, и вес перестал бы означать
 * «во сколько раз это слагаемое важнее остальных»: он смешивался бы с внутренним масштабом шкалы.
 * Когда каждое слагаемое лежит в [0, 1], вес читается напрямую и его можно сравнивать с соседним.
 */
const SEVERITY_SCORE: Record<FindingSeverity, number> = { high: 1, medium: 0.6, low: 0.3 };
const RISK_SCORE: Record<BehaviorRisk, number> = { low: 0, medium: 0.5, high: 1 };

/**
 * Число правок, при котором вклад «горячести» достигает половины своего веса.
 *
 * Кривая насыщающая (`n / (n + HALF)`), а не линейная, намеренно: файл с тремястами правок не
 * должен в сто раз перевешивать файл с тремя. Разница между «не трогали» и «трогали пять раз»
 * содержательна, разница между пятьюдесятью и двумястами — уже нет: и то, и другое означает
 * «живой код», а сверх этого число говорит только о возрасте файла.
 */
const HOTNESS_HALF = 5;

/**
 * Возраст, при котором вклад «залежалости» выходит на полный вес.
 *
 * Полгода выбрано как срок, за который повседневный цикл имел все шансы находку подобрать и не
 * подобрал: значит, тяжёлое окно для неё — единственная дверь, и вечно уступать её свежим находкам
 * нельзя. Раньше полугода спешить некуда, позже — расти уже незачем.
 */
const AGE_FULL_DAYS = 180;

/**
 * Точность, до которой округляется счёт перед сравнением.
 *
 * Без округления два слагаемых, равных по смыслу, расходятся в пятнадцатом знаке, сравнение
 * «счета равны» не срабатывает никогда, и отпечаток — единственный источник повторяемости — до
 * решения не доходит. Шесть знаков заведомо мельче любой осмысленной разницы весов.
 */
const SCORE_SCALE = 1e6;

/**
 * Отнести находку к зоне по её виду (`looksFor` зоны).
 *
 * Зоны перебираются в порядке политики, и первая подходящая выигрывает: порядок в YAML — это
 * приоритет, заданный человеком, а не случайность файла. Регистр и пробелы вида гасятся, потому
 * что вид находки пишет модель, и «Dead-Code» с «dead-code» — одно и то же.
 *
 * `null` означает «в окно не идёт»: зона задаёт не только приоритет, но и разрешённые изменения
 * (`mayChange`/`mustNotChange`). Чинить находку, для которой никто не описал границ дозволенного,
 * в автоматическом окне нельзя — не потому, что она неважна, а потому, что её правку нечем
 * ограничить.
 */
export function zoneOf(
  finding: TrackedFinding,
  zones: readonly DeepMaintenanceZone[],
): string | null {
  const category = normalizeKind(finding.category);
  for (const zone of zones) {
    if (zone.looksFor.some((kind) => normalizeKind(kind) === category)) return zone.id;
  }
  return null;
}

/**
 * Очередь долга: находки, отсортированные по счёту.
 *
 * Находки вне зон отбрасываются молча — это штатный исход, а не ошибка: широкий скан видит весь
 * репозиторий, а окно работает только там, где заданы границы.
 */
export function rankDebt(input: RankInput): readonly DebtItem[] {
  const weights = resolveWeights(input.weights);
  const items: DebtItem[] = [];

  for (const finding of input.findings) {
    const zone = zoneOf(finding, input.zones);
    if (zone === null) continue;
    items.push(scoreFinding(finding, zone, input.signals, weights));
  }

  return items.sort(compareItems);
}

/**
 * Порядок очереди: счёт, затем отпечаток.
 *
 * Отпечаток последним ключом нужен не для смысла, а для повторяемости: без него две одинаково
 * оценённые находки меняются местами от прогона к прогону, и два отчёта об одном и том же коде
 * нечем сравнить. Отпечаток берётся именно потому, что он не зависит ни от порядка прихода, ни от
 * номера находки в прогоне.
 */
function compareItems(a: DebtItem, b: DebtItem): number {
  const byScore = b.score - a.score;
  if (byScore !== 0) return byScore;
  return a.finding.fingerprint < b.finding.fingerprint
    ? -1
    : a.finding.fingerprint > b.finding.fingerprint
      ? 1
      : 0;
}

function scoreFinding(
  finding: TrackedFinding,
  zone: string,
  signals: DebtSignals,
  weights: DebtWeights,
): DebtItem {
  const severity = SEVERITY_SCORE[finding.severity];
  const confidence = clamp01(finding.confidence);
  const risk = RISK_SCORE[finding.behaviorRisk];
  const changes = hotnessOf(finding, signals.hotness);
  const hotness = changes / (changes + HOTNESS_HALF);
  const days = ageOf(finding, signals.ageDays);
  const age = Math.min(days / AGE_FULL_DAYS, 1);

  const parts = [
    weights.severity * severity,
    weights.confidence * confidence,
    weights.hotness * hotness,
    weights.age * age,
    // Риск ВЫЧИТАЕТСЯ, а не отбрасывает находку: тяжёлое окно правит помногу и подряд, и рискованная
    // правка здесь стоит дороже, чем в повседневном цикле, — её труднее отделить от соседних при
    // откате и труднее заметить на ревью общей кучи. Но «дороже» не значит «никогда»: находка с
    // риском и высокой строгостью всё ещё может обогнать безрисковую мелочь.
    -weights.risk * risk,
  ];

  const score = round(parts.reduce((sum, part) => sum + part, 0));
  const reasons = [
    `строгость (${finding.severity}): ${signed(parts[0])}`,
    `уверенность (${confidence}): ${signed(parts[1])}`,
    `частота правок (${changes} за окно наблюдения): ${signed(parts[2])}`,
    `возраст находки (${days} дн.): ${signed(parts[3])}`,
    `риск для поведения (${finding.behaviorRisk}): ${signed(parts[4])}`,
  ];

  return { finding, zone, score, reasons };
}

/**
 * Горячесть находки — по самому горячему из её файлов.
 *
 * Максимум, а не сумма и не среднее: долг в живом коде дороже долга в спящем, потому что живой код
 * читают и правят каждую неделю, и каждая правка платит за этот долг заново — временем чтения и
 * риском ошибки. Достаточно ОДНОГО горячего файла, чтобы находка мешала уже сейчас; среднее
 * размыло бы этот сигнал соседними спящими файлами, а сумма превратила бы «много файлов» в
 * «горячо», хотя это разные вещи.
 */
function hotnessOf(finding: TrackedFinding, hotness: ReadonlyMap<string, number>): number {
  let top = 0;
  for (const file of finding.files) {
    const value = sanitize(hotness.get(file));
    if (value > top) top = value;
  }
  return top;
}

/** Возраст ищется по отпечатку: он переживает переформулировку находки, а её номер — нет. */
function ageOf(finding: TrackedFinding, ageDays: ReadonlyMap<string, number>): number {
  return sanitize(ageDays.get(finding.fingerprint));
}

/**
 * Веса из настроек поверх умолчаний.
 *
 * Нечисло не игнорируется, а роняет прогон: молча подставленное умолчание дало бы очередь,
 * порядок которой человек объясняет одними весами, а получен он другими, — ровно та
 * необъяснимость, против которой весь файл.
 */
function resolveWeights(overrides: Partial<DebtWeights> | undefined): DebtWeights {
  if (overrides === undefined) return DEFAULT_DEBT_WEIGHTS;
  const merged = { ...DEFAULT_DEBT_WEIGHTS, ...overrides };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isFinite(value)) throw new Error(`вес «${name}» не число: ${String(value)}`);
  }
  return merged;
}

/**
 * Сигнал приводится к неотрицательному числу.
 *
 * Отсутствующий ключ, `NaN` из неудачного разбора и отрицательное число значат для очереди одно и
 * то же — «сигнала нет». Пропустить их дальше значит получить счёт `NaN`, который при сортировке
 * не больше и не меньше ничего, и тогда порядок очереди зависит от алгоритма сортировки.
 */
function sanitize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function normalizeKind(kind: string): string {
  return kind.trim().toLowerCase();
}

function round(value: number): number {
  return Math.round(value * SCORE_SCALE) / SCORE_SCALE;
}

/** Слагаемое печатается со знаком: строка «-1.00» и строка «1.00» читаются по-разному. */
function signed(value: number | undefined): string {
  const number = value ?? 0;
  return `${number < 0 ? '' : '+'}${number.toFixed(2)}`;
}
