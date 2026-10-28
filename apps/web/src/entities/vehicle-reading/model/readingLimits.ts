import dayjs from 'dayjs';
import { groupDigits } from '@shared/lib';
import type { DriverPreviousReading } from '@technic/contracts';

/**
 * Правила ввода показаний: что подсказать, о чём предупредить и чего не пустить вовсе
 * (план docs/driver-cabinet-ux-plan.md, решения Р6 и Р7).
 *
 * Файл существует ради одного: разработчику, которого попросят «сделать помягче», не приходится
 * искать пороги по компонентам — все числа ввода лежат здесь, каждое с подписью.
 *
 * **Серверные пороги живут отдельно, и это не забытое дублирование.** В `@technic/contracts` есть
 * свои — `ODOMETER_JUMP_PER_DAY_KM` и `ENGINE_HOURS_JUMP_PER_DAY`, — и здешние с ними не связаны
 * намеренно, потому что роли у них разные: **клиентские ПРЕДУПРЕЖДАЮТ** вводящего до отправки,
 * **серверные ЗАПИСЫВАЮТ аномалию** в базу, по которой потом принимают день (ADR 0103, Р20).
 * Числа могут совпадать, но свести их в один источник нельзя: первая же просьба «подсказка мешает,
 * ослабь» начала бы менять учётные пометки — то есть учёт, а не подсказку.
 *
 * **Почему в слайсе, а не в кабинете.** Показания вводят из двух мест: водитель со своего телефона
 * и персонал — за него, из карточки отчёта в гараже (ADR 0103, Р26). Экраны эти лежат на одном
 * слое и друг друга не видят, поэтому пороги, оставшиеся у одного из них, второму пришлось бы
 * переписать — и первая же правка развела бы «странное число» кабинета со «странным числом»
 * приёмки. Масштаб шрифта кабинета сюда не переехал: он про экран в кабине, а не про показания.
 *
 * **Fuel in the tank is checked differently from the counters.** The levels at the start and at
 * the end of a shift have the absolute ceiling and no daily threshold: a level does not grow from
 * the previous snapshot, it is a state. Since ADR 0237 the START level is compared with the END
 * level of the previous shift (`DriverPreviousReading.fuelEndLiters`) and any difference is a soft
 * warning that the driver confirms in the submit window; the old ban on that comparison (fuel plan
 * Р9, Р10) went with the consumption ban (ADR 0194). The ceiling is still shared with the refuel.
 * The consumption itself is the server's, once (`fuelSpentSql`), not a third formula in this file.
 */

// ── Daily growth thresholds: a soft warning, confirmed in the submit window (ADR 0237) ──

/**
 * Пробег за сутки, выше которого прирост одометра просят подтвердить, км. Значение заведомо
 * щедрое: карьерный самосвал за смену действительно проходит много, и предупреждение здесь — не
 * запрет, а вопрос «вы точно списали с прибора?».
 */
export const ODOMETER_WARN_KM_PER_DAY = 1500;

/** Наработка за сутки, выше которой прирост моточасов просят подтвердить, ч. Сутки — это 24. */
export const ENGINE_HOURS_WARN_PER_DAY = 24;

// ── Absolute bounds: a hard error, the submit is refused ──

/**
 * Потолок одометра, км. Ловит опечатку в разряде там, где сравнивать не с чем (первое показание
 * машины): списанные грузовики доезжают до полутора миллионов, семь знаков подряд — это промах по
 * клавише, а не пробег.
 */
export const ODOMETER_MAX_KM = 2_000_000;

/** Потолок моточасов, ч: сорок лет непрерывной работы. Больше — лишний разряд. */
export const ENGINE_HOURS_MAX = 100_000;

/** Потолок разовой заправки, л: столько не входит ни в один бак нашей техники с прицепом. */
export const FUEL_MAX_LITERS = 1_000;

// ── Правила ──

/**
 * Поля показания, к которым относятся предупреждения. Топливных среди них три, и они не однородны:
 * заправка — разовое событие смены, остатки — состояние бака на её границах. Общего у всех трёх
 * ровно одно — литры и их потолок; всё остальное (порог прироста, подсказка) есть только у
 * счётчиков.
 */
export type ReadingField =
  'odometerKm' | 'engineHours' | 'fuelStartLiters' | 'fuelFilledLiters' | 'fuelEndLiters';

/** Значение поля так, как его видит форма: число, пусто или недонабранное «145 3.». */
export type ReadingValue = number | null | 'invalid';

export interface ReadingWarning {
  field: ReadingField;
  /**
   * Грубое (`true`) — значение вне абсолютных границ: отправку не пропускаем вовсе. Граница между
   * «странно» и «невозможно» проведена по одному признаку: странное число бывает правдой (счётчик
   * заменили, машина неделю стояла в поле), а невозможное — всегда опечатка в разряде, и
   * требовать её подтверждения бессмысленно: её подтвердят так же, как набрали (Р6).
   */
  hard: boolean;
  text: string;
}

const FIELDS: Record<ReadingField, { name: string; unit: string; max: number; tooBig: string }> = {
  odometerKm: {
    name: 'Одометр',
    unit: 'км',
    max: ODOMETER_MAX_KM,
    tooBig: 'Проверьте разряд: столько одометр не показывает',
  },
  engineHours: {
    name: 'Моточасы',
    unit: 'ч',
    max: ENGINE_HOURS_MAX,
    tooBig: 'Проверьте разряд: столько моточасов не бывает',
  },
  /**
   * У обоих остатков потолок общий с заправкой, и это не копипаста: остаток и заправка меряются
   * одним баком (Р10). Своё число завело бы второе место, куда придут с просьбой «ослабь», и первая
   * же такая правка развела бы границы одного и того же бака.
   */
  fuelStartLiters: {
    name: 'Топливо на начало',
    unit: 'л',
    max: FUEL_MAX_LITERS,
    tooBig: 'Проверьте разряд: столько в бак не входит',
  },
  fuelFilledLiters: {
    name: 'Заправлено',
    unit: 'л',
    max: FUEL_MAX_LITERS,
    tooBig: 'Проверьте разряд: столько в бак не входит',
  },
  /** Тот же бак и тот же потолок, что у остатка на начало. */
  fuelEndLiters: {
    name: 'Топливо на конец',
    unit: 'л',
    max: FUEL_MAX_LITERS,
    tooBig: 'Проверьте разряд: столько в бак не входит',
  },
};

/**
 * Daily thresholds exist only for the counters: they grow from the previous snapshot, so "too fast"
 * means something for them. Fuel has none: a refuel is a single event and a level is a state that
 * is drained, topped up from the side and changed under a driver overnight, so an increase is an
 * ordinary day. Fuel is compared for continuity instead (`readingWarnings`), not for growth.
 *
 * A missing key here is part of the rule, not a forgotten row: `readingWarnings` decides by it that
 * the field is not checked beyond the ceiling.
 */
const PER_DAY: Partial<Record<ReadingField, number>> = {
  odometerKm: ODOMETER_WARN_KM_PER_DAY,
  engineHours: ENGINE_HOURS_WARN_PER_DAY,
};

/**
 * Разряды пробелами — только при ВЫВОДЕ (П2). При наборе группировка недопустима: она сдвигает
 * позицию курсора на каждой третьей цифре, и человек дописывает пробег в середину числа.
 * Пробел неразрывный: «145 320» не должно переноситься на две строки посреди числа.
 */
export function formatReading(value: number): string {
  const [whole = '', fraction] = String(value).split('.');
  const grouped = groupDigits(whole);
  // Запятая, а не точка: так число читают с телефона по-русски. Ввод принимает и то, и другое.
  return fraction ? `${grouped},${fraction}` : grouped;
}

/** «10.08» — короткая дата предыдущего снимка: год не нужен, сверяют свежее. */
const shortDate = (value: string): string => dayjs(value).format('DD.MM');

/**
 * Поля, у которых прошлое значение вообще существует: `DriverPreviousReading` возит только два
 * счётчика и расширяться не будет (Р9). Предикат нужен не для красоты, а чтобы снимок
 * индексировался полем без приведения: TypeScript сам не пустит сюда ключ, которого в снимке нет.
 * Проверка держит обе стороны — исчезнет поле из `ReadingField`, и предикат не сойдётся тоже.
 */
type CounterField = 'odometerKm' | 'engineHours';

const isCounterField = (field: ReadingField): field is CounterField =>
  field === 'odometerKm' || field === 'engineHours';

/**
 * The caption under a field: «предыдущее: 145 320 (10.08)» for a counter (П1) and «в конце прошлой
 * смены: 92 л (27.10)» for the fuel at the start (ADR 0237). It costs less than any warning — two
 * numbers are compared by eye before they are wrong. Empty when there is no previous snapshot, or
 * it has no value for the field: the start of a series is a state, not a deviation.
 *
 * Other fuel fields have no caption: a refuel is a single event and the end level of THIS shift has
 * nothing before it to be compared with. Fields are cut off BEFORE the snapshot is read, not by a
 * list of exceptions, so a new reading field does not slip in silently.
 */
export function previousHintText(
  previous: DriverPreviousReading | null,
  field: ReadingField,
): string | undefined {
  if (!previous) return undefined;
  if (field === 'fuelStartLiters') {
    const end = previous.fuelEndLiters;
    if (end == null) return undefined;
    return `в конце прошлой смены: ${formatReading(end)} л (${shortDate(previous.measuredOn)})`;
  }
  if (!isCounterField(field)) return undefined;
  const value = previous[field];
  if (value == null) return undefined;
  return `предыдущее: ${formatReading(value)} (${shortDate(previous.measuredOn)})`;
}

/** «2 дня», «1 день», «5 дней»: текст предупреждения обязан читаться, а не считаться. */
function daysLabel(days: number): string {
  const n = Math.max(1, Math.round(days));
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return `${n} дней`;
  if (ones === 1) return `${n} день`;
  if (ones >= 2 && ones <= 4) return `${n} дня`;
  return `${n} дней`;
}

/**
 * Что не так с введённым — во время ввода, до отправки.
 *
 * Проверка чистая и одна на всех: её зовёт и блок (показать), и лист (не пустить отправку). Две
 * копии правила разошлись бы в первый же день — форма предупреждала бы об одном, а не пускала за
 * другое.
 */
export function readingWarnings(
  values: Partial<Record<ReadingField, ReadingValue>>,
  previous: DriverPreviousReading | null,
): ReadingWarning[] {
  const warnings: ReadingWarning[] = [];
  for (const key of Object.keys(FIELDS) as ReadingField[]) {
    const value = values[key];
    // Пусто и недонабранное — не повод предупреждать: «Введите число» скажет разбор, а пустое
    // поле законно (на технике без одометра его нет физически).
    if (typeof value !== 'number') continue;
    const field = FIELDS[key];

    if (value < 0 || value > field.max) {
      warnings.push({ field: key, hard: true, text: field.tooBig });
      // Грубая ошибка старше мягких: сравнивать опечатку с предыдущим снимком нечего.
      continue;
    }

    // The start level has no threshold, but it must equal the end of the previous shift (ADR 0237):
    // compared to the column's tenth, as the server stores it. A previous shift without the end
    // level is "nothing to compare with", never an older shift's level.
    if (key === 'fuelStartLiters') {
      const end = previous?.fuelEndLiters;
      if (previous && typeof end === 'number' && Math.round(value * 10) !== Math.round(end * 10)) {
        warnings.push({
          field: key,
          hard: false,
          text: `Топливо на начало смены (${formatReading(value)} л) не совпадает с остатком на конец прошлой смены (${formatReading(end)} л, ${shortDate(previous.measuredOn)})`,
        });
      }
      continue;
    }

    // Beyond this only the daily growth is left, and only the counters have it: the other fuel
    // fields have neither a `PER_DAY` threshold nor a previous value in the snapshot. The two
    // conditions answer different questions — `perDay` is "is there a growth norm", `isCounterField`
    // is "does the contract carry anything to compare with" — and the second also makes
    // `previous[key]` type-safe.
    const perDay = PER_DAY[key];
    if (perDay === undefined || !isCounterField(key)) continue;
    // Без предыдущего снимка сравнивать не с чем: начало ряда — состояние, а не отклонение.
    if (!previous) continue;
    const before = previous[key];
    if (before == null) continue;

    if (value < before) {
      warnings.push({
        field: key,
        hard: false,
        text: `${field.name}: меньше предыдущего (${formatReading(before)} от ${shortDate(previous.measuredOn)})`,
      });
      continue;
    }

    // `max(1, daysAgo)` существенно: у двух смен одного дня прошло ноль суток, и без нижней
    // границы любой прирост второй смены стал бы предупреждением.
    const growth = value - before;
    const limit = perDay * Math.max(1, previous.daysAgo);
    if (growth > limit) {
      warnings.push({
        field: key,
        hard: false,
        text: `${field.name}: прирост ${formatReading(Number(growth.toFixed(2)))} ${field.unit} за ${daysLabel(previous.daysAgo)} — проверьте`,
      });
    }
  }
  return warnings;
}

/** Пусто — это `null` (поля нет физически), а не ноль: ноль в учёте счётчика был бы ложью. */
export function parseReadingNumber(raw: string): ReadingValue {
  const text = raw.trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : 'invalid';
}
