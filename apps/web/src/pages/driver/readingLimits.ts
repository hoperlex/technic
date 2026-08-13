import dayjs from 'dayjs';
import type { DriverPreviousReading } from '@technic/contracts';

/**
 * Числа кабинета водителя и правила предупреждений при вводе (план docs/driver-cabinet-ux-plan.md,
 * решения Р6 и Р7).
 *
 * Файл существует ради одного: разработчику, которого попросят «сделать помягче», не приходится
 * искать пороги по компонентам — все числа кабинета лежат здесь, каждое с подписью.
 *
 * **Серверные пороги живут отдельно, и это не забытое дублирование.** В `@technic/contracts` есть
 * свои — `ODOMETER_JUMP_PER_DAY_KM` и `ENGINE_HOURS_JUMP_PER_DAY`, — и здешние с ними не связаны
 * намеренно, потому что роли у них разные: **клиентские ПРЕДУПРЕЖДАЮТ** водителя до отправки,
 * **серверные ЗАПИСЫВАЮТ аномалию** в базу, по которой потом принимают день (ADR 0103, Р20).
 * Числа могут совпадать, но свести их в один источник нельзя: первая же просьба «подсказка мешает,
 * ослабь» начала бы менять учётные пометки — то есть учёт, а не подсказку.
 */

// ── Каркас кабинета ──

/**
 * Масштаб шрифта кабинета. Экран читают с телефона в кабине, на солнце и в перчатках, поэтому
 * величина одна на весь каркас: подобрать её на живом телефоне — работа одного значения, а не
 * поиска по файлам (Р1).
 */
export const DRIVER_FONT_SCALE = 1.15;

// ── Суточные пороги прироста: мягкое предупреждение, снимается галочкой ──

/**
 * Пробег за сутки, выше которого прирост одометра просят подтвердить, км. Значение заведомо
 * щедрое: карьерный самосвал за смену действительно проходит много, и предупреждение здесь — не
 * запрет, а вопрос «вы точно списали с прибора?».
 */
export const ODOMETER_WARN_KM_PER_DAY = 1500;

/** Наработка за сутки, выше которой прирост моточасов просят подтвердить, ч. Сутки — это 24. */
export const ENGINE_HOURS_WARN_PER_DAY = 24;

// ── Абсолютные границы: грубая ошибка, отправка запрещена ──

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

/** Поля показания, к которым относятся предупреждения. */
export type ReadingField = 'odometerKm' | 'engineHours' | 'fuelFilledLiters';

/** Значение поля так, как его видит форма: число, пусто или недонабранное «145 3.». */
export type ReadingValue = number | null | 'invalid';

export interface ReadingWarning {
  field: ReadingField;
  /**
   * Грубое (`true`) — значение вне абсолютных границ: отправку не пропускаем вовсе. Граница между
   * «странно» и «невозможно» проведена по одному признаку: странное число бывает правдой (счётчик
   * заменили, машина неделю стояла в поле), а невозможное — всегда опечатка в разряде, и
   * требовать её подтверждения бессмысленно: водитель подтвердит её так же, как набрал (Р6).
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
  fuelFilledLiters: {
    name: 'Заправлено',
    unit: 'л',
    max: FUEL_MAX_LITERS,
    tooBig: 'Проверьте разряд: столько в бак не входит',
  },
};

/** Суточные пороги — только у счётчиков: заправка не растёт от предыдущей, она разовая. */
const PER_DAY: Partial<Record<ReadingField, number>> = {
  odometerKm: ODOMETER_WARN_KM_PER_DAY,
  engineHours: ENGINE_HOURS_WARN_PER_DAY,
};

const NBSP = '\u00A0';

/**
 * Разряды пробелами — только при ВЫВОДЕ (П2). При наборе группировка недопустима: она сдвигает
 * позицию курсора на каждой третьей цифре, и человек дописывает пробег в середину числа.
 * Пробел неразрывный: «145 320» не должно переноситься на две строки посреди числа.
 */
export function formatReading(value: number): string {
  const [whole = '', fraction] = String(value).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, NBSP);
  // Запятая, а не точка: так число читают с телефона по-русски. Ввод принимает и то, и другое.
  return fraction ? `${grouped},${fraction}` : grouped;
}

/** «10.08» — короткая дата предыдущего снимка: год водителю не нужен, он сверяет свежее. */
const shortDate = (value: string): string => dayjs(value).format('DD.MM');

/**
 * Подпись под полем: «предыдущее: 145 320 (10.08)» (П1). Стоит дешевле любого предупреждения —
 * водитель сверяет два числа глазами до того, как ошибётся. Пусто, когда предыдущего снимка нет:
 * начало ряда — состояние, а не отклонение.
 */
export function previousHintText(
  previous: DriverPreviousReading | null,
  field: ReadingField,
): string | undefined {
  if (!previous || field === 'fuelFilledLiters') return undefined;
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

    // Суточного порога у заправки нет, а без предыдущего снимка сравнивать не с чем: начало
    // ряда — состояние, а не отклонение.
    const perDay = PER_DAY[key];
    if (perDay === undefined || !previous) continue;
    const before = key === 'odometerKm' ? previous.odometerKm : previous.engineHours;
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
