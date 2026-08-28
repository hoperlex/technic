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

/**
 * Минуты от полуночи по МСК для момента `Date`. Нужна там, где момент сравнивают с часом суток —
 * с отсечкой приёма заявок, например: сравнивать строки `HH:mm` можно, но число честнее, а
 * разбирать собственный же вывод обратно (`timeToMinutes(moscowTimeOf(d))`) незачем.
 */
export function moscowMinutesOf(date: Date): number {
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (
    (((utcMinutes + MOSCOW_UTC_OFFSET_MINUTES) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY
  );
}

/** Время суток по московскому времени для момента `Date` (сдвиг фиксированный, см. выше). */
export function moscowTimeOf(date: Date): string {
  return minutesToTime(moscowMinutesOf(date));
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

/**
 * Обратная сборка: момент по календарному дню и времени суток МСК.
 *
 * Нужна там, где день записи меняют, а время суток остаётся прежним, — при переносе рейса на
 * другую дату вместе с его заявками. Сдвиг фиксированный, как и в разборе: летнего времени в
 * России нет, а хранить момент по чужому поясу портал не умеет.
 */
export function moscowInstantOf(dateKey: string, time: string): Date {
  return new Date(`${dateKey}T${time}:00.000+03:00`);
}

/** Дата по МСК в виде `DD.MM.YYYY`. */
export function moscowDateOf(date: Date): string {
  const [yyyy, mm, dd] = moscowDateKeyOf(date).split('-');
  return `${dd}.${mm}.${yyyy}`;
}

/**
 * Календарный ключ `YYYY-MM-DD`, сдвинутый на `days` суток. Считается в UTC: день здесь — это
 * день календаря, а не сутки часового пояса, поэтому переход через границу месяца и високосный
 * февраль отрабатывают сами, а летнего времени в Москве нет с 2014 года.
 *
 * Нераспознанный ключ возвращается как есть: подставлять «сегодня» вместо мусора значило бы
 * молча посчитать не тот срок.
 */
export function shiftDateKey(dateKey: string, days: number): string {
  const at = Date.parse(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(at)) return dateKey;
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Понедельник той календарной недели, в которую попадает день. Неделя здесь начинается с
 * понедельника — так её читают и производственный календарь, и недельные бланки (ЭСМ-2), тогда
 * как `Date.getUTCDay()` считает от воскресенья.
 *
 * Нераспознанный ключ возвращается как есть — тем же правилом, что и `shiftDateKey`.
 */
export function weekStartKey(dateKey: string): string {
  const at = Date.parse(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(at)) return dateKey;
  const weekday = (new Date(at).getUTCDay() + 6) % 7;
  return new Date(at - weekday * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Последний день того календарного месяца, в который попадает день.
 *
 * Заведён ради недельного листа ЭСМ-2 (ADR 0142): бланк ведут месяцем — недельные итоги сводят в
 * месячные, — и неделя, перешагнувшая последнее число, это два документа, а не один. Считается
 * нулевым днём следующего месяца: переход через декабрь и високосный февраль `Date` знает сам, а
 * таблица длин месяцев в портале разошлась бы с календарём на первом же феврале.
 *
 * Нераспознанный ключ возвращается как есть — тем же правилом, что и `shiftDateKey`.
 */
export function monthEndKey(dateKey: string): string {
  const at = Date.parse(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(at)) return dateKey;
  const date = new Date(at);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
}

/**
 * Все календарные дни от `from` до `to` включительно. Пустой список — границы не разбираются
 * или конец раньше начала: такого периода не существует, и выдумывать за него дни не нужно.
 */
export function dateKeysBetween(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  const days: string[] = [];
  for (let at = start; at <= end; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Сколько календарных дней в периоде от `from` до `to` включительно; 0 — периода нет.
 * Тем же счётом считается и «сколько дней заказано», и «сколько из них уже прошло».
 */
export function dateKeySpan(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * Отметка «дата и время» по МСК для показа человеку: `DD.MM.YYYY HH:mm`, а при незаданном
 * времени — только дата. Нужна серверу: в историю заявки значения полей уходят снимком уже
 * готовым текстом (справочник мог измениться), и формат там обязан совпадать с таблицей в вебе.
 */
export function formatMoscowDateTime(date: Date, timeUnspecified = false): string {
  return timeUnspecified ? moscowDateOf(date) : `${moscowDateOf(date)} ${moscowTimeOf(date)}`;
}

// ── Минимальная дата заявки и глубина заднего числа (ADR 0101) ──
// Заявку заводят и день в день: срочный вывоз и подача техники «на сегодня» — обычное дело, а
// запрет отправлял бы такую заявку в обход портала. Прошлое до ADR 0101 было закрыто наглухо, и
// это оказалось неверно: техника выходит во вторник, а заявку оформляют в среду, и ритуал
// «завести сегодняшним днём, чтобы тут же исправить на вчера» не защищает ничего (Р15). Теперь
// прошлое открывается правом и причиной, а глубина ограничена днями.
//
// Отсчёт ведётся от текущей даты по МСК — по ней живут диспетчеры, и в этом же поясе считаются
// сроки в заявках.

/**
 * Глубина коррекции задним числом — 30 дней от эффективной даты операции (Р9). Дальше правит
 * только обладатель `waybills.correctBeyondLimit` (Р37).
 *
 * Константа живёт в модуле времени, а не рядом с путевыми листами, по одной причине: нижнюю
 * границу дейтпикера (`minRequestDateKey`) и отказ сервера (`backdateGuard`) обязано считать одно
 * и то же число, а `waybills.ts` этот модуль уже импортирует — обратный импорт замкнул бы
 * контракты в цикл. В `waybills.ts` она реэкспортирована: там её ищут по имени. Имя осталось от
 * бланков — бланк самое тяжёлое из того, что правится задним числом (Р4).
 */
export const WAYBILL_CORRECTION_DAYS = 30;

/**
 * Что субъекту позволено задним числом. Прав два, а не одно (Р37): `waybills.correct` открывает
 * прошлое вообще (даты заявок, бланки, коррекция рейса, перенос — Р14), а
 * `waybills.correctBeyondLimit` снимает предел глубины и без первого силы не имеет. Тем же
 * порядком их читает и `backdateGuard`: сперва право, потом глубина.
 */
export interface BackdateAccess {
  /** `waybills.correct` — задним числом вообще. */
  correct: boolean;
  /** `waybills.correctBeyondLimit` — глубже `WAYBILL_CORRECTION_DAYS`. */
  beyondLimit: boolean;
}

/**
 * Минимальная дата в форме заявки — три режима (Р37, §10 плана):
 *
 * - права нет — сегодня по МСК: правило, которым портал жил до ADR 0101;
 * - `waybills.correct` — `сегодня − WAYBILL_CORRECTION_DAYS`, граница диспетчера;
 * - `waybills.correctBeyondLimit` — `null`: границы нет вовсе.
 *
 * Именно `null`, а не «очень давняя дата»: выдуманным годом портал запирал бы то, что сервер
 * примет, и обещал бы там, где ручка откажет. Правило у формы и у сервера одно, поэтому и режимов
 * ровно три — столько же, сколько исходов у `backdateGuard`.
 *
 * Перегрузки нужны вызывающим без прав (форма вывоза мусора, `isAllowedRequestDate`): им граница
 * возвращается строкой, и `null` в типе заставил бы их обрабатывать случай, которого у них нет.
 */
export function minRequestDateKey(now?: Date): string;
export function minRequestDateKey(now: Date | undefined, access: BackdateAccess): string | null;
export function minRequestDateKey(now: Date = new Date(), access?: BackdateAccess): string | null {
  const today = moscowDateKeyOf(now);
  // Второе право в одиночку предела не снимает: без `waybills.correct` прошлого нет вовсе, и
  // граница остаётся сегодняшним днём — как и в `backdateGuard`, где право спрашивается первым.
  if (!access?.correct) return today;
  return access.beyondLimit ? null : shiftDateKey(today, -WAYBILL_CORRECTION_DAYS);
}

/**
 * Календарная дата `YYYY-MM-DD` не раньше сегодняшней по МСК — режим «права нет».
 *
 * Полный вердикт по прошлому даёт `backdateGuard` (Р29): он один знает и право, и причину, и
 * глубину. Эта функция осталась там, где субъекта нет вовсе, — в схемах, которые разбирают тело
 * запроса до того, как известно, кто его прислал.
 */
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
