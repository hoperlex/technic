/**
 * Когда расписание сработает в следующий раз (ADR 0075).
 *
 * Чистые функции без обращения к БД: расчёт времени — это то место, где ошибка не роняет ничего,
 * а просто отправляет рассылку не тогда. Проверять её надо тестом, а тест не должен поднимать базу.
 *
 * Время расписания местное (`MAIL_SCHEDULER_TIMEZONE`), а хранится и сравнивается всё в UTC.
 * Перевода часов в России нет с 2014 года, поэтому смещение зоны берётся у самой зоны через
 * `Intl` — на случай, если порталу однажды назначат другую.
 */

export interface SchedulePlan {
  /** «18:00» или «18:00:00» — как хранит `time` в БД. */
  sendAt: string;
  /**
   * По каким дням выполняется рассылка. Пустой набор считается «по всем».
   *
   * Периодичности отдельным полем нет: «недельная» — это набор из одного дня, и хранить то же
   * знание вторым способом значило бы держать два ответа на вопрос «когда сработает».
   */
  runWeekdays?: number[];
  /** Даты, в которые запуск пропускается: праздники и остановки. */
  excludedDates?: string[];
}

/** Смещение зоны в минутах на конкретный момент — с ним локальное время переводится в UTC. */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  // `en-CA` даёт «2026-08-07, 18:00:00» — разбирается без догадок о порядке частей.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // 24 в 'hour' у некоторых зон означает полночь следующих суток.
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return (asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000;
}

/** Местная календарная дата момента: «какой сегодня день» в часовом поясе расписания. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** ISO-день недели местной даты: 1 — понедельник, 7 — воскресенье. */
export function isoWeekday(dateOnly: string): number {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Дата плюс дни, без часовых поясов: обе стороны — календарные сутки. */
export function addDays(dateOnly: string, days: number): string {
  const [y, m, d] = dateOnly.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d! + days));
  return date.toISOString().slice(0, 10);
}

/** Момент, когда местные `dateOnly` и `sendAt` наступят по UTC. */
function momentOf(dateOnly: string, sendAt: string, timeZone: string): Date {
  const [hh, mm] = sendAt.split(':').map(Number);
  const [y, m, d] = dateOnly.split('-').map(Number);
  const naive = Date.UTC(y!, m! - 1, d!, hh ?? 0, mm ?? 0);
  // Смещение берётся на сам момент, а не на «сейчас»: у зон с переводом часов они разные.
  const guess = new Date(naive);
  return new Date(naive - zoneOffsetMinutes(guess, timeZone) * 60_000);
}

/** Выполняется ли расписание в этот местный день. */
function runsOn(plan: SchedulePlan, dateOnly: string): boolean {
  if (plan.excludedDates?.includes(dateOnly)) return false;
  const days = plan.runWeekdays?.length ? plan.runWeekdays : [1, 2, 3, 4, 5, 6, 7];
  return days.includes(isoWeekday(dateOnly));
}

/**
 * Ближайший момент срабатывания строго после `after`.
 *
 * Строго после — чтобы посчитанное после запуска время не совпало с только что отработавшим и
 * рассылка не ушла второй раз. Горизонт поиска — 370 дней: недельное расписание с годом
 * исключённых дат существовать может, а бесконечный цикл в планировщике — нет.
 */
export function nextRunAt(plan: SchedulePlan, after: Date, timeZone: string): Date | null {
  let dateOnly = localDate(after, timeZone);
  for (let i = 0; i < 370; i += 1) {
    if (runsOn(plan, dateOnly)) {
      const moment = momentOf(dateOnly, plan.sendAt, timeZone);
      if (moment.getTime() > after.getTime()) return moment;
    }
    dateOnly = addDays(dateOnly, 1);
  }
  return null;
}

/**
 * Окно данных запуска: с какого дня относительно дня рассылки и на сколько дней.
 *
 * Считается от даты запуска, а не от «сегодня» сервера: повтор упавшего вечернего запуска обязан
 * взять те же дни, что и он. Длительностью, а не второй границей: «конец раньше начала» так
 * невыразимо — минимум окна один день, и это его же первый день.
 */
export function windowOf(
  plannedAt: Date,
  windowFromDays: number,
  windowDays: number,
  timeZone: string,
): { from: string; to: string } {
  const base = localDate(plannedAt, timeZone);
  const from = addDays(base, windowFromDays);
  return { from, to: addDays(from, Math.max(1, windowDays) - 1) };
}
