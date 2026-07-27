// ── Время суток в заявках ──
// Общий для веба и API разбор/нормализация пользовательского ввода времени и правило рабочего
// окна. Живёт в контрактах, потому что и форма, и серверная валидация обязаны трактовать одну и
// ту же строку одинаково — иначе клиент примет ввод, который API отклонит.

/** Рабочее окно приёма заявок: с 07:00 по 21:00 включительно (МСК). */
export const WORK_TIME_START_MINUTES = 7 * 60;
export const WORK_TIME_END_MINUTES = 21 * 60;

/** Москва — UTC+3 без переходов на летнее время (с 2014 г.); тот же сдвиг используют фильтры API. */
const MOSCOW_UTC_OFFSET_MINUTES = 180;

const MINUTES_PER_DAY = 24 * 60;

/** Канонический вид времени: строго `HH:mm`, 24 часа. */
export const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `07:30` → 450. Для нераспознанного ввода — `undefined`. */
export function timeToMinutes(time: string): number | undefined {
  const m = TIME_PATTERN.exec(time.trim());
  if (!m) return undefined;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 450 → `07:30`. */
export function minutesToTime(minutes: number): string {
  const norm = ((Math.trunc(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hh = String(Math.floor(norm / 60)).padStart(2, '0');
  const mm = String(norm % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Нормализация ручного ввода к `HH:mm`: недостающие знаки добиваются нулями.
 * Разделители и любые нецифровые символы игнорируются — значимы только цифры:
 *
 *   `7`    → `07:00`   (часы, минуты нулями)
 *   `21`   → `21:00`
 *   `730`  → `07:30`   (первая цифра — часы)
 *   `0730` → `07:30`
 *   `7:5`  → `07:05`   (минуты добиваются слева нулём)
 *
 * Возвращает `undefined`, если ввод пуст или не складывается в существующее время суток
 * (`25`, `0790`) — вызывающая сторона показывает ошибку формата.
 */
export function normalizeTimeInput(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return undefined;

  // Разделитель задан явно — доверяем разбиению пользователя: `7:5` это 07:05, а не 07:50.
  const separated = /^(\d{1,2})\D+(\d{1,2})$/.exec(raw);
  if (separated) {
    return buildTime(Number(separated[1]), Number(separated[2]!.padStart(2, '0')));
  }

  const digits = raw.replace(/\D/g, '');
  if (!digits || digits.length > 4) return undefined;

  switch (digits.length) {
    case 1:
    case 2:
      // Только часы — минуты нулями.
      return buildTime(Number(digits), 0);
    case 3:
      // `730` — одна цифра часов и две минут.
      return buildTime(Number(digits.slice(0, 1)), Number(digits.slice(1)));
    default:
      return buildTime(Number(digits.slice(0, 2)), Number(digits.slice(2)));
  }
}

function buildTime(hours: number, minutes: number): string | undefined {
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Время попадает в рабочее окно 07:00–21:00 (границы включительно). */
export function isWithinWorkTime(time: string): boolean {
  const minutes = timeToMinutes(time);
  if (minutes === undefined) return false;
  return minutes >= WORK_TIME_START_MINUTES && minutes <= WORK_TIME_END_MINUTES;
}

/** Время суток по московскому времени для момента `Date` (сдвиг фиксированный, см. выше). */
export function moscowTimeOf(date: Date): string {
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return minutesToTime(utcMinutes + MOSCOW_UTC_OFFSET_MINUTES);
}

/** Момент приходится на рабочее окно по МСК. */
export function isWithinWorkTimeAt(date: Date): boolean {
  return isWithinWorkTime(moscowTimeOf(date));
}

/** Сообщение об ошибке рабочего окна — одинаковое в форме и в ответе API. */
export const WORK_TIME_MESSAGE = 'Время должно быть в рабочем окне с 07:00 до 21:00';
export const TIME_FORMAT_MESSAGE = 'Время в формате чч:мм (24 часа)';
