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
