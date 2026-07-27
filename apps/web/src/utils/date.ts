import dayjs, { type Dayjs } from 'dayjs';

// Правило форм заявок: дата по умолчанию — сегодня, прошедшие даты выбрать нельзя
// (заявку не оформляют задним числом). Считаем в часовом поясе браузера: DatePicker
// возвращает именно локальные Dayjs, а приложение работает по МСК (dayjs.tz.setDefault
// в main.tsx), поэтому сравнение с «сегодня» совпадает с тем, что видит диспетчер.

/** Начало сегодняшнего дня — значение по умолчанию для полей даты в заявках. */
export function startOfToday(): Dayjs {
  return dayjs().startOf('day');
}

/**
 * Прошедшая дата — для `DatePicker.disabledDate`.
 * Запрещает только выбор: уже сохранённое прошедшее значение при редактировании
 * заявки остаётся видимым в поле.
 */
export function isPastDate(d: Dayjs): boolean {
  return d.isBefore(startOfToday(), 'day');
}
