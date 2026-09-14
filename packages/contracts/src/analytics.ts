import { z } from 'zod';
import { dateOnlySchema, uuidSchema } from './common';
import type { RequestStatus } from './enums';

/**
 * Сводная аналитика по заказчикам (план `docs/analytics-summary-export-plan.md`).
 *
 * Общий язык трёх модулей — заказа техники, вывоза мусора и механизации — для служебной книги и
 * для будущего экрана аналитики. Здесь только словарь и формы ответа: как считается каждое число,
 * решает слой `apps/api/src/services/analytics/`, и второго ответа на «сколько смен за август» в
 * проекте быть не должно (план, Р13).
 *
 * Три правила, из которых следует вся модель:
 *
 * 1. **Ось строк — заказчик, а не заявка** (Р4): объект строительства или отдел. Механизация
 *    относится к объекту-месту, отдел-плательщик едет отдельным полем (Р22).
 * 2. **Единицы не складываются** (Р17): объём в м³ и лом в тоннах, смены и часы механизации —
 *    разные поля, а не одно с подписью.
 * 3. **Деньги — вилкой** (Р9): факт закрытий, нижняя и верхняя оценка незакрытых заявок. Одно
 *    смешанное число не отвечает на вопрос «чему тут верить».
 */

// ── Модули ──

/**
 * Четыре разряда работы. Заказ техники разрезан надвое намеренно: перевозка и работа на площадке
 * меряются разным (ездками против моточасов) и в одну колонку не ложатся.
 */
export const ANALYTICS_MODULES = ['freight', 'onsite', 'waste', 'mech'] as const;
export type AnalyticsModule = (typeof ANALYTICS_MODULES)[number];

export const analyticsModuleLabels: Record<AnalyticsModule, string> = {
  freight: 'Перевозки',
  onsite: 'Техника на объекте',
  waste: 'Вывоз мусора',
  mech: 'Механизация',
};

/** Кто заказчик строки. У вывоза бывает только объект, у механизации объект — это место (Р22). */
export type AnalyticsCustomerKind = 'object' | 'department';

// ── Шаг периода ──

export const ANALYTICS_STEPS = ['week', 'month', 'quarter', 'half', 'year'] as const;
export type AnalyticsStep = (typeof ANALYTICS_STEPS)[number];

export const analyticsStepLabels: Record<AnalyticsStep, string> = {
  week: 'Неделя',
  month: 'Месяц',
  quarter: 'Квартал',
  half: 'Полугодие',
  year: 'Год',
};

export const analyticsStepSchema = z.enum(ANALYTICS_STEPS);

/**
 * Потолки. Период — год, шагов — 53 (год по неделям, Р26): сочетание разрешено, ограничены только
 * эти два числа, и проверяются они одинаково формой и сервером — форма гасит кнопку по тому же
 * правилу, по которому сервер отвечает отказом.
 */
export const MAX_ANALYTICS_PERIOD_DAYS = 366;
export const MAX_ANALYTICS_STEPS = 53;

/** Точек на графике больше этого — столбцы сменяются линией (Р26): 53 столбца нечитаемы. */
export const ANALYTICS_BAR_POINT_LIMIT = 26;

/** Отрезок шага: ключ для группировки, подпись для книги и границы для отбора. */
export interface AnalyticsPeriodRef {
  /** Машинный ключ отрезка: `2026-08`, `2026-W32`, `2026-Q3`, `2026-H1`, `2026`. */
  key: string;
  /** Человеку: «08.2026», «нед. 32 (03.08 – 09.08)», «III кв. 2026». */
  label: string;
  from: string;
  to: string;
}

// ── Числа ──

/**
 * Счётчики одного разряда работы. Все поля — суммируемые числа за период; `null` означает
 * «величины не бывает у этого модуля», а не ноль (Р16): у перевозок не бывает моточасов, у вывоза
 * — единиц техники.
 *
 * Смена считается по-разному в каждом модуле, и это записано в плане: у перевозок — пара
 * «машина и день рейса», в которой участвовала заявка заказчика (Р6, суммы по строкам больше
 * числа машино-смен парка); на объекте — строка `vehicle_request_shifts` (Р7); у механизации —
 * отработанные единицы при ставке за смену.
 */
export interface AnalyticsTotals {
  /** Смены; у вывоза их не бывает. */
  shifts: number | null;
  /**
   * Смены ПО ПЛАНУ — дни срока заказа на объект в пересечении с периодом (Р7). Живёт только у
   * `onsite`: у перевозки срока нет вовсе, а у механизации дни присутствия и есть её план.
   *
   * Стоит рядом с фактом намеренно: «план 56, факт 52» — сама по себе аналитика, и прятать эту
   * разницу в один столбец значило бы отвечать на вопрос «сколько отработали» числом, в котором
   * простой неотличим от незаполненного дня.
   */
  planShifts: number | null;
  /** Единиц техники — `count(DISTINCT)` по тем же сменам (Р8). У вывоза машин не считаем (Р21). */
  units: number | null;
  /** Ездки грузоперевозок. */
  trips: number | null;
  /** Перевезено и вывезено. Мусор меряют объёмом, лом принимают по весу — две величины (Р17). */
  volumeM3: number | null;
  weightTons: number | null;
  /** Моточасы заказа техники на объекте. */
  engineHours: number | null;
  /** Часы механизации при ставке за час: со сменами не складываются (Р17). */
  mechHours: number | null;
  /** Дни присутствия арендованной техники на площадке. */
  mechDays: number | null;
  /** Вывозы — заявки, а не самосвалы (Р21). */
  removals: number | null;
  /** Установки, замены и снятия контейнеров: без объёма и без денег. */
  containerOps: number | null;
  /** Перегоны техники к своему заказу и обратно: в смены перевозок не входят (Р27). */
  relocations: number | null;
  /** Заявок в разряде — знаменатель долей и основание счётчика «без цены». */
  requests: number;
  money: AnalyticsMoney;
}

/**
 * Деньги разряда (Р9). Факт — сумма закрытий; оценка незакрытых заявок считается двумя способами,
 * и книга показывает обе. У вывоза и механизации оценка одна, поэтому `low` и `high` совпадают.
 *
 * `unpriced` — заявки, которые не удалось оценить ни фактом, ни расчётом. Считается по заявкам, а
 * не по строкам: нулевая клетка иначе неотличима от бесплатной работы.
 */
export interface AnalyticsMoney {
  fact: number;
  low: number;
  high: number;
  unpriced: number;
}

/** Строка свода: заказчик и его работа по разрядам (Р4, Р25 — пустые строки в книгу не идут). */
export interface AnalyticsCustomerRow {
  kind: AnalyticsCustomerKind;
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  byModule: Record<AnalyticsModule, AnalyticsTotals>;
  money: AnalyticsMoney;
}

/** Строка детализации: позиция внутри разряда — машина, вид отхода, модель механизации. */
export interface AnalyticsPositionRow {
  module: AnalyticsModule;
  /** Ключ позиции: id машины, id модели, «вид отхода + тип контейнера». */
  key: string;
  label: string;
  /** Гос. номер, если позиция — машина парка; у прочих пусто. */
  registrationNumber: string | null;
  totals: AnalyticsTotals;
}

/** Строка динамики: отрезок шага и работа в нём (лист инфографики, Р12а). */
export interface AnalyticsPeriodRow {
  period: AnalyticsPeriodRef;
  byModule: Record<AnalyticsModule, AnalyticsTotals>;
  money: AnalyticsMoney;
}

/**
 * Строка листа «Качество данных» (Р20). Книга обязана отвечать, насколько цифрам можно верить:
 * аналитика по данным, покрытым на 60 %, без этого листа выглядит точной.
 */
export interface AnalyticsQualityEntry {
  key: string;
  label: string;
  value: number;
  /** Знаменатель, если показатель — доля («14 из 52»); `null` — просто счётчик. */
  outOf: number | null;
  /** Чем грозит: что именно искажено в книге, если число велико. */
  note: string;
}

// ── Ответ ручки ──

/**
 * Свод целиком: строки, итоги и качество. Тот же ответ читает книга и будет читать экран — второго
 * запроса под аналитику не заводится (Р14).
 */
export interface AnalyticsSummaryDto {
  from: string;
  to: string;
  step: AnalyticsStep;
  periods: AnalyticsPeriodRef[];
  rows: AnalyticsCustomerRow[];
  /** Итог по всем строкам. Считается из тех же атомов, а не сложением строк ответа. */
  totals: Record<AnalyticsModule, AnalyticsTotals>;
  money: AnalyticsMoney;
  quality: AnalyticsQualityEntry[];
  /** Динамика по шагам; пусто, если шагов больше потолка. */
  periodRows: AnalyticsPeriodRow[];
}

// ── Запросы ──

const analyticsPeriodShape = {
  from: dateOnlySchema,
  to: dateOnlySchema,
  step: analyticsStepSchema,
};

function checkPeriodOrder(v: { from: string; to: string }, ctx: z.RefinementCtx): void {
  if (v.to < v.from) {
    ctx.addIssue({ code: 'custom', message: 'Конец периода раньше начала', path: ['to'] });
  }
}

/**
 * Свод в JSON. Потолок длины периода здесь не проверяется — он живёт на сервере вместе с
 * потолком атомов, а схема общая с порталом (приём `readingStatsQuerySchema`).
 */
export const analyticsSummaryQuerySchema = z
  .object(analyticsPeriodShape)
  .strict()
  .superRefine(checkPeriodOrder);
export type AnalyticsSummaryQuery = z.infer<typeof analyticsSummaryQuerySchema>;

/**
 * Книга. Отличается от свода одним полем: площадкой листа инфографики (Р12а).
 *
 * Поле необязательное, и пустое оно означает «книга без листа инфографики», а не «инфографика по
 * всем»: сравнительных представлений в книге нет вовсе, и лист, собранный по всем площадкам сразу,
 * был бы ровно им.
 */
export const analyticsExportQuerySchema = z
  .object({ ...analyticsPeriodShape, chartObjectId: uuidSchema.optional() })
  .strict()
  .superRefine(checkPeriodOrder);
export type AnalyticsExportQuery = z.infer<typeof analyticsExportQuerySchema>;

// ── Помощники ──

export function emptyMoney(): AnalyticsMoney {
  return { fact: 0, low: 0, high: 0, unpriced: 0 };
}

/**
 * Пустой счётчик разряда. Поля, которых у модуля не бывает, остаются `null` — их список и есть
 * ответ на «что этот разряд меряет» (Р16).
 */
export function emptyTotals(module: AnalyticsModule): AnalyticsTotals {
  const base: AnalyticsTotals = {
    shifts: null,
    planShifts: null,
    units: null,
    trips: null,
    volumeM3: null,
    weightTons: null,
    engineHours: null,
    mechHours: null,
    mechDays: null,
    removals: null,
    containerOps: null,
    relocations: null,
    requests: 0,
    money: emptyMoney(),
  };
  switch (module) {
    case 'freight':
      return { ...base, shifts: 0, units: 0, trips: 0, volumeM3: 0, weightTons: 0 };
    case 'onsite':
      return { ...base, shifts: 0, planShifts: 0, units: 0, engineHours: 0, relocations: 0 };
    case 'waste':
      return { ...base, removals: 0, containerOps: 0, volumeM3: 0, weightTons: 0 };
    case 'mech':
      return { ...base, shifts: 0, units: 0, mechHours: 0, mechDays: 0 };
  }
}

/** Статусы заявок, чьи деньги считаются фактом. Отменённые не считаются нигде (Р10). */
export function analyticsCountsAsFact(status: RequestStatus): boolean {
  return status === 'done' || status === 'completed';
}
