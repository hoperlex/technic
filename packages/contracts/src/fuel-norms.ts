import { z } from 'zod';
import { baseListQuery, dateOnlySchema, uuidSchema } from './common';

/**
 * Нормы расхода топлива и сверка с ними (план `docs/fuel-norms-plan.md`).
 *
 * Четыре утверждения, из которых следует вся модель:
 *
 * 1. **Норма принадлежит машине, а не модели** (Р1): приказ адресован госномеру, и «норма модели»
 *    означала бы, что портал назначил её там, где приказ молчит.
 * 2. **У нормы есть дата начала действия** (Р6): правка заводит новую версию, старая остаётся, и
 *    отчёт за июль не меняется от августовского приказа. Действующая версия смены — живая запись с
 *    наибольшим `effectiveFrom ≤ дата смены`.
 * 3. **Ставок две — зимняя и летняя**, и обе строго положительны (Р3): нулевая обращала бы норму
 *    смены в ноль, а любое сожжённое топливо — в бесконечный процент.
 * 4. **Единица одна на запись** (Р2): либо литры на сто километров, либо литры на моточас. Она же
 *    выбирает счётчик, по которому считается база смены, — см. `docs/fuel-norms-plan.md` §3.3.
 *
 * Допуск и границы зимнего сезона — не свойство машины, а способ смотреть: они одни на весь портал
 * и лежат в одиночке настроек (Р8). Версий у них нет осознанно (Р8а), поэтому правка меняет и уже
 * показанные отчёты.
 */

// ── Единица нормы ──

export const FUEL_NORM_UNITS = ['l_per_100km', 'l_per_hour'] as const;
export type FuelNormUnit = (typeof FUEL_NORM_UNITS)[number];

export const fuelNormUnitSchema = z.enum(FUEL_NORM_UNITS);

/**
 * Подписи единиц — общие для окна справочника, файла обмена и книг. Второго списка заводить
 * нельзя: по этим же словам загрузка файла опознаёт колонку «Единица».
 */
export const fuelNormUnitLabels: Record<FuelNormUnit, string> = {
  l_per_100km: 'л/100 км',
  l_per_hour: 'л/час',
};

/** Какой счётчик даёт базу смены при этой единице (§3.3). */
export const fuelNormUnitCounter: Record<FuelNormUnit, 'odometer' | 'engineHours'> = {
  l_per_100km: 'odometer',
  l_per_hour: 'engineHours',
};

// ── Строка справочника ──

export interface VehicleFuelNormDto {
  id: string;
  vehicleId: string;
  /** Подпись машины — та же, какой её зовут сводка и гараж: у справочника своего написания нет. */
  vehicleLabel: string;
  registrationNumber: string | null;
  /** `YYYY-MM-DD`, «Действует с» (Р6). */
  effectiveFrom: string;
  unit: FuelNormUnit;
  winterRate: number;
  summerRate: number;
  /** Вид топлива — справочно (Р4): в сверке не участвует, расход считается в литрах. */
  fuelType: string;
  note: string;
  /**
   * Версия действует сегодня: у машины это запись с наибольшей `effectiveFrom` из наступивших.
   * Считает признак сервер — окну нельзя решать это самому, иначе «действующая» на экране и
   * «действующая» в расчёте разойдутся на первом же приказе задним числом.
   */
  isCurrent: boolean;
  createdAt: string;
  updatedAt: string;
}

export const FUEL_NORM_SORT_FIELDS = [
  'registrationNumber',
  'effectiveFrom',
  'winterRate',
  'summerRate',
] as const;

export const fuelNormListQuerySchema = baseListQuery(FUEL_NORM_SORT_FIELDS).extend({
  /** Окно, открытое из строки реестра, сужено до одной машины (§5). */
  vehicleId: uuidSchema.optional(),
  /**
   * Умолчание окна — только действующие: справочник открывают вопросом «какая норма сейчас», а не
   * «какие приказы были». История разворачивается этим же переключателем.
   */
  currentOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});
export type FuelNormListQuery = z.infer<typeof fuelNormListQuerySchema>;

/**
 * Ставка: положительное число с сотыми. Верхний предел — не педантизм, а защита от опечатки на
 * порядок: 999 л/100 км это и так вчетверо больше самой прожорливой строки приказа.
 */
const rateSchema = z.coerce.number().positive('Ставка должна быть больше нуля').max(999).multipleOf(
  0.01,
  'Не более двух знаков после запятой',
);

export const createFuelNormSchema = z.object({
  vehicleId: uuidSchema,
  effectiveFrom: dateOnlySchema,
  unit: fuelNormUnitSchema,
  winterRate: rateSchema,
  summerRate: rateSchema,
  fuelType: z.string().trim().max(50).default(''),
  note: z.string().trim().max(500).default(''),
});
export type CreateFuelNormInput = z.infer<typeof createFuelNormSchema>;

/**
 * Правка версии. Машину сменить нельзя: норма — свойство карточки техники, и «перенос» нормы на
 * другую машину есть заведение новой записи, а не правка старой.
 */
export const updateFuelNormSchema = createFuelNormSchema.omit({ vehicleId: true }).partial();
export type UpdateFuelNormInput = z.infer<typeof updateFuelNormSchema>;

// ── Настройки сверки ──

/**
 * Умолчания сезона и допуска — **единственный источник** этих чисел: их сеет миграция, ими же
 * подставляется расчёт, когда строки настроек почему-либо нет. Две копии разошлись бы первой же
 * правкой, и сводка считала бы допуск, отличный от показанного в окне.
 */
export const FUEL_NORM_DEFAULTS = {
  winterFromMd: '11-01',
  winterToMd: '03-31',
  tolerancePercent: 5,
} as const;

export interface FuelNormSettingsDto {
  /** `MM-DD` — начало и конец зимнего периода; он переходит через Новый год, и это норма. */
  winterFromMd: string;
  winterToMd: string;
  tolerancePercent: number;
  /** Кто и когда правил в последний раз: версий у настроек нет (Р8а), и это весь их след. */
  updatedAt: string;
  updatedByName: string | null;
}

/** `MM-DD`: месяц 01–12, день 01–31. Календарность (30 февраля) закрывает форма, а не выражение. */
export const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/u;

const monthDaySchema = z
  .string()
  .trim()
  .regex(MONTH_DAY, 'Дата сезона в формате ММ-ДД');

export const updateFuelNormSettingsSchema = z.object({
  winterFromMd: monthDaySchema,
  winterToMd: monthDaySchema,
  tolerancePercent: z.coerce.number().min(0).max(100).multipleOf(0.01),
});
export type UpdateFuelNormSettingsInput = z.infer<typeof updateFuelNormSettingsSchema>;

/**
 * Дата в зимнем сезоне. Обычный случай — период через Новый год (`from > to`), и тогда зима это
 * «после начала ИЛИ до конца»; обратное соотношение оставлено законным, чтобы настройка не
 * запрещала сезон внутри года.
 *
 * Правило повторяет предикат расчёта знак в знак, и повторяет намеренно: по нему окно объясняет
 * человеку, какая ставка действует сегодня, а тест сверяет обе записи на одних датах. Сравнение
 * текстовое — `MM-DD` лексикографически совпадает с календарным порядком.
 */
export function isWinterMonthDay(monthDay: string, from: string, to: string): boolean {
  return from > to ? monthDay >= from || monthDay <= to : monthDay >= from && monthDay <= to;
}

/** `2026-02-29` → `02-29`: сезон живёт в паре «месяц-день», год для него не значит ничего. */
export function monthDayOf(date: string): string {
  return date.slice(5, 10);
}

// ── Отклонение от нормы ──

export interface FuelDeviation {
  /** Литры сверх нормы (минус — экономия). Прочерк, если сверять нечего. */
  liters: number | null;
  /** Проценты сверх нормы. Прочерк по той же причине — и ещё при нулевой норме. */
  percent: number | null;
  /** Отклонение больше допуска. При прочерке всегда `false`: нечего превышать. */
  exceeded: boolean;
}

/**
 * Отклонение расхода от нормы — **одна функция на портал, сервер и книги** (Р12а). Дом у неё в
 * контрактах именно поэтому: её зовут экран (покраска и отбор), полоса счётчиков и выгрузки, а
 * «одна функция» без общего адреса превращается в две, которые расходятся на округлении.
 *
 * Норма нулевая — законное состояние периода, а не ошибка: у отдельной смены ноль невозможен
 * (ставка положительна, база положительна), но период, где ни одна смена не прошла сверку, даёт
 * ноль и в норме, и в расходе. Процента у такого периода нет — деление молчит, а не возвращает
 * ноль, потому что «0%» читалось бы как «ровно по норме».
 */
export function fuelDeviation(
  spentLiters: number | null,
  normLiters: number | null,
  tolerancePercent: number,
): FuelDeviation {
  if (spentLiters === null || normLiters === null || normLiters <= 0) {
    return { liters: null, percent: null, exceeded: false };
  }
  const liters = Math.round((spentLiters - normLiters) * 10) / 10;
  const percent = Math.round((spentLiters / normLiters - 1) * 1000) / 10;
  return { liters, percent, exceeded: percent > tolerancePercent };
}
