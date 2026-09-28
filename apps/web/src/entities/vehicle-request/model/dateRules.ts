import dayjs, { type Dayjs } from 'dayjs';
import {
  type AccessSubject,
  can,
  minRequestDateKey,
  minVehicleRequestDateKey,
  moscowDateKeyOf,
  VEHICLE_REQUEST_LEAD_TIME_MESSAGE,
} from '@technic/contracts';

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
