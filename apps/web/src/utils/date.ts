import dayjs, { type Dayjs } from 'dayjs';
import {
  type AccessSubject,
  can,
  minRequestDateKey,
  minVehicleRequestDateKey,
  moscowDateKeyOf,
  VEHICLE_REQUEST_LEAD_TIME_MESSAGE,
} from '@technic/contracts';

// Правило форм заявок: новую заявку назначают не раньше чем на сегодня — тем же правилом
// сервер проверяет создание (`minRequestDateKey` в контрактах). Отсчёт ведётся по Москве, а не
// по поясу браузера: у диспетчера из другого региона своя граница суток, и «сегодня» у него
// разошлось бы с ответом API. Сравниваем календарные дни как `YYYY-MM-DD` — DatePicker отдаёт
// локальный Dayjs, но день в нём тот самый, который человек выбрал в календаре.
//
// Редактирования правило не касается: у заведённой заявки дата бывает и вчерашней, запрет на
// её выбор мешал бы правкам — там остаётся прежнее «не в прошлое».

/*
 * What is left of a directory that stands outside the FSD layers. Day parsing and period length
 * have moved to `@shared/lib` — they carry no portal rule. What stayed is domain: the boundary «not
 * earlier than today» and the lead time of an equipment request, and both wait for a slice of their
 * own. The whole file exists for one reason: that boundary is drawn in Moscow, not in the browser's
 * timezone, and a dispatcher in another region would otherwise have a different «today» from the
 * server's.
 */

/** Минимальная дата новой заявки: сегодня по МСК. Она же — значение по умолчанию. */
export function minRequestDate(): Dayjs {
  return dayjs(minRequestDateKey()).startOf('day');
}

/**
 * Start of today in the browser's timezone. Deliberately not exported: nothing outside ever called
 * it, and a public name with no caller is an invitation to compare against «today» while bypassing
 * the Moscow day boundary this file exists for.
 */
function startOfToday(): Dayjs {
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
 * Календарь формы заявки на технику: ближайший доступный день, запрет на всё, что ближе, и
 * подсказка о том, почему он такой (ADR 0104).
 *
 * Границу считает контракт (`minVehicleRequestDateKey`) — одной функцией на портал и сервер:
 * заявителю она отдаёт завтра, а после отсечки 15:00 послезавтра, тому, кто ведёт заказы, —
 * сегодня по МСК. Здесь только перевод её в вид, который понимает `DatePicker`.
 *
 * Правку заведённой заявки запирает то же правило, а не прежнее «лишь бы не в прошлое»: сервер
 * спрашивает его на всякой правке, двигающей календарь, и предлагать дату, которую он отклонит,
 * портал не должен. Уже сохранённое значение поле показывает как есть — правку телефона или
 * комментария запертый календарь не трогает.
 */
export function vehicleRequestDateRules(subject: AccessSubject | null | undefined): {
  minDate: Dayjs;
  disabledDate: (d: Dayjs) => boolean;
  leadTimeHint?: string;
} {
  const minKey = minVehicleRequestDateKey(subject);
  const today = moscowDateKeyOf(new Date());
  /*
   * Прошлое живёт по своему правилу (ADR 0101, Р37) — три режима: без права на коррекцию его нет
   * вовсе (граница = сегодня), с `waybills.correct` открыты тридцать дней, с
   * `waybills.correctBeyondLimit` границы нет и `minRequestDateKey` возвращает `null`.
   *
   * Два правила не спорят, потому что делят календарь по сегодняшнему дню, а не борются за одну
   * границу: заблаговременность запирает **ближние будущие** дни, задний ход открывает **прошлые**.
   * Тем же порядком их спрашивает сервер — на дате в прошлом заблаговременность не спрашивается
   * вовсе (`backdated ? null : vehicleRequestLeadTimeBlocker`), и предикат ниже повторяет это
   * буквально: иначе календарь запирал бы вчерашний день тому, кому ручка его откроет.
   */
  const backdateFloor = minRequestDateKey(undefined, {
    correct: can(subject, 'waybills.correct'),
    beyondLimit: can(subject, 'waybills.correctBeyondLimit'),
  });
  return {
    minDate: dayjs(minKey).startOf('day'),
    disabledDate: (d) => {
      const key = d.format('YYYY-MM-DD');
      if (key < today) return backdateFloor !== null && key < backdateFloor;
      return key < minKey;
    },
    // Подсказка появляется ровно там, где заперты ближние дни: у того, кто ведёт заказы, доступно
    // и сегодня, и объяснять ему нечего, а заявитель иначе узнал бы причину только из отказа.
    leadTimeHint:
      minKey > moscowDateKeyOf(new Date()) ? VEHICLE_REQUEST_LEAD_TIME_MESSAGE : undefined,
  };
}
