import dayjs, { type Dayjs } from 'dayjs';
import { minRequestDateKey } from '@technic/contracts';

// Правило форм заявок: новую заявку назначают не раньше чем на сегодня — тем же правилом
// сервер проверяет создание (`minRequestDateKey` в контрактах). Отсчёт ведётся по Москве, а не
// по поясу браузера: у диспетчера из другого региона своя граница суток, и «сегодня» у него
// разошлось бы с ответом API. Сравниваем календарные дни как `YYYY-MM-DD` — DatePicker отдаёт
// локальный Dayjs, но день в нём тот самый, который человек выбрал в календаре.
//
// Редактирования правило не касается: у заведённой заявки дата бывает и вчерашней, запрет на
// её выбор мешал бы правкам — там остаётся прежнее «не в прошлое».

/** Минимальная дата новой заявки: сегодня по МСК. Она же — значение по умолчанию. */
export function minRequestDate(): Dayjs {
  return dayjs(minRequestDateKey()).startOf('day');
}

/** Начало сегодняшнего дня в поясе браузера. */
export function startOfToday(): Dayjs {
  return dayjs().startOf('day');
}

/**
 * Дата раньше сегодняшней по МСК — для `DatePicker.disabledDate` в форме создания заявки.
 * Запрещает только выбор: уже сохранённое значение при редактировании остаётся видимым в поле.
 */
export function isBeforeMinRequestDate(d: Dayjs): boolean {
  return d.format('YYYY-MM-DD') < minRequestDateKey();
}

/**
 * Прошедшая дата — для `DatePicker.disabledDate` при редактировании заявки:
 * перенести её на сегодня можно, назад в прошлое — нет.
 */
export function isPastDate(d: Dayjs): boolean {
  return d.isBefore(startOfToday(), 'day');
}

/**
 * Число календарных дней периода, включая обе границы: с 01.08 по 03.08 — три дня, а не два.
 * Пустая дата окончания — однодневный срок: тем же `coalesce(date_to, date_from)` считает
 * период сервер, когда ищет пересечения заявок.
 *
 * Границы разбираются как календарные ключи `YYYY-MM-DD` в UTC: в поясе браузера с переводом
 * часов сутки бывают короче 24 часов, и разница дат теряла бы день. `null` — период не
 * складывается (конец раньше начала); подсказывать в этом случае нечего.
 */
export function calendarDayCount(fromKey: string, toKey?: string | null): number | null {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey || fromKey}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * Длина периода словами — «5 календарных дней». Считать дни по календарю в уме легко
 * ошибиться (особенно через границу месяца), а заказывают технику и считают аренду именно
 * в днях, поэтому подсказка стоит и в форме заявки, и в её карточке.
 */
export function calendarDaysLabel(fromKey: string, toKey?: string | null): string | null {
  const days = calendarDayCount(fromKey, toKey);
  if (days === null) return null;
  // Русское склонение: 1 день, 2–4 дня, 5–20 дней; 11–14 — всегда «дней».
  const tail = days % 100;
  const last = days % 10;
  const form =
    tail >= 11 && tail <= 14
      ? 'календарных дней'
      : last === 1
        ? 'календарный день'
        : last >= 2 && last <= 4
          ? 'календарных дня'
          : 'календарных дней';
  return `${days} ${form}`;
}
