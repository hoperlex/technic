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

/**
 * Календарная дата по МСК в виде `YYYY-MM-DD`. В этом же виде даты приходят в заявках на
 * спецтехнику, а лексикографическое сравнение таких строк совпадает с хронологическим —
 * поэтому день сравнивается как день, без пересчёта в моменты времени.
 */
export function moscowDateKeyOf(date: Date): string {
  const shifted = new Date(date.getTime() + MOSCOW_UTC_OFFSET_MINUTES * 60_000);
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${mm}-${dd}`;
}

/** Дата по МСК в виде `DD.MM.YYYY`. */
export function moscowDateOf(date: Date): string {
  const [yyyy, mm, dd] = moscowDateKeyOf(date).split('-');
  return `${dd}.${mm}.${yyyy}`;
}

/**
 * Отметка «дата и время» по МСК для показа человеку: `DD.MM.YYYY HH:mm`, а при незаданном
 * времени — только дата. Нужна серверу: в историю заявки значения полей уходят снимком уже
 * готовым текстом (справочник мог измениться), и формат там обязан совпадать с таблицей в вебе.
 */
export function formatMoscowDateTime(date: Date, timeUnspecified = false): string {
  return timeUnspecified ? moscowDateOf(date) : `${moscowDateOf(date)} ${moscowTimeOf(date)}`;
}

// ── Минимальная дата новой заявки ──
// Заявку заводят и день в день: срочный вывоз и подача техники «на сегодня» — обычное дело, а
// запрет отправлял бы такую заявку в обход портала. Задним числом заявок по-прежнему нет.
// Отсчёт ведётся от текущей даты по МСК — по ней живут диспетчеры, и в этом же поясе считаются
// сроки в заявках. Правило касается только заведения заявки: у заведённой дата остаётся такой,
// какой была, иначе вчерашнюю заявку нельзя было бы даже отредактировать.

/** Минимальная дата назначения новой заявки — сегодня по МСК, `YYYY-MM-DD`. */
export function minRequestDateKey(now: Date = new Date()): string {
  return moscowDateKeyOf(now);
}

/** Календарная дата `YYYY-MM-DD` не раньше сегодняшней по МСК. */
export function isAllowedRequestDate(dateKey: string, now?: Date): boolean {
  return dateKey >= minRequestDateKey(now);
}

/** Момент времени приходится на дату не раньше сегодняшней по МСК. */
export function isAllowedRequestDateAt(date: Date, now?: Date): boolean {
  return isAllowedRequestDate(moscowDateKeyOf(date), now);
}

/** Сообщение об ошибке рабочего окна — одинаковое в форме и в ответе API. */
export const WORK_TIME_MESSAGE = 'Время должно быть в рабочем окне с 07:00 до 21:00';
export const TIME_FORMAT_MESSAGE = 'Время в формате чч:мм (24 часа)';
/** Сообщение о слишком ранней дате — общее для формы и ответа API. */
export const MIN_REQUEST_DATE_MESSAGE = 'Дата не может быть раньше сегодняшней';
