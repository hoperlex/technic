import {
  isMechRentalRunning,
  mechDaysLeft,
  mechRateUnitRateLabels,
  mechRequesterOf,
  mechUnitsLabel,
  type MechRateUnit,
  type MechRentalState,
  type MechRequestDto,
} from '@technic/contracts';

/**
 * Как аренда механизации называет свои значения человеку: день, деньги, ставка, заявитель, срок.
 *
 * Форматирование здесь своё, а не общее с `utils/format.ts` и `utils/date.ts`, и это не
 * недосмотр: те каталоги остались от раскладки до FSD, слою сущностей они не видны разметкой
 * границ, и импорт из них не прошёл бы линт. Функции короткие, а расхождение с соседями здесь
 * ничем не грозит — формат «ДД.ММ.ГГГГ» и «15 000,00 ₽» задан не модулем, а языком.
 */

/**
 * Календарный день человеку: `2026-09-04` → «04.09.2026».
 *
 * Разбором строки, а не через `dayjs`: ключ уже календарный, часа в нём нет, и пересчёт пояса
 * сдвинул бы день на сутки назад у того, кто смотрит портал восточнее Москвы.
 */
export function mechDayLabel(key: string | null | undefined): string {
  if (!key) return '—';
  const [yyyy, mm, dd] = key.split('-');
  return dd && mm && yyyy ? `${dd}.${mm}.${yyyy}` : key;
}

/** Денежная сумма в рублях: «15 000,00 ₽». `null` — суммы нет, а не ноль. */
export function mechMoney(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Денежный итог, пришедший строкой: так отвечает сводка журнала (`cost`).
 *
 * Строкой он приходит потому, что суммы складывает `numeric` базы, и по дороге через `double`
 * итог за год терял бы копейки. Показывается тем же `mechMoney`, что и ставка: два формата денег
 * в одном модуле читались бы как две разные валюты.
 *
 * Не число — прочерк, а не ноль: «0,00 ₽» означает «за отбор не потратили ничего», и подставлять
 * его вместо неприехавшего ответа нельзя.
 */
export function mechMoneySum(raw: string | null | undefined): string {
  if (raw == null || raw === '') return mechMoney(null);
  const value = Number(raw);
  return Number.isFinite(value) ? mechMoney(value) : mechMoney(null);
}

/**
 * Ставка договорённости: «1 200,00 ₽ за час». Единица названа словами общего словаря
 * (`mechRateUnitRateLabels`), а не своим текстом: ставка показывается в списке, в карточке и в
 * трёх окнах, и «за час» с «в час» разошлись бы уже между ними.
 */
export function mechRateLabel(
  rate: number | null | undefined,
  unit: MechRateUnit | null | undefined,
): string {
  if (rate == null || !unit) return '—';
  return `${mechMoney(rate)} ${mechRateUnitRateLabels[unit]}`;
}

/** Отработанное с единицей: «26 ч», «3 смены». Общим склонением контрактов (Р7). */
export function mechWorkedLabel(
  units: number | null | undefined,
  unit: MechRateUnit | null | undefined,
): string {
  if (units == null || !unit) return '—';
  return mechUnitsLabel(unit, units);
}

/**
 * Заявитель заявки: отдел, если он заполнен, иначе сама площадка (Р20).
 *
 * Через `mechRequesterOf` контрактов, а не своим разбором пары колонок: у механизации площадка
 * заполнена **всегда**, и порядок проверки здесь обратный привычному — сначала отдел. Своя копия
 * этого правила однажды назвала бы заявку отдела заявкой площадки, то есть отнесла бы расходы не
 * на того.
 */
export function mechRequesterLabel(row: MechRequestDto): string {
  const requester = mechRequesterOf(row);
  if (!requester) return '—';
  return requester.code ? `${requester.code} — ${requester.name}` : requester.name;
}

/** Заявитель — отдел, а не сама площадка: этим различаются два вида заявки на одном объекте. */
export function isDepartmentRequester(row: MechRequestDto): boolean {
  return !!row.departmentId;
}

/** Срок одной строкой: «04.09.2026 — 18.09.2026». */
export function mechTermLabel(row: { plannedFrom: string; plannedTo: string }): string {
  return `${mechDayLabel(row.plannedFrom)} — ${mechDayLabel(row.plannedTo)}`;
}

/**
 * Сколько осталось до планового возврата — словами, с русским склонением дней.
 *
 * `null` — считать нечего: аренда не идёт (техника не выдана либо уже возвращена), и «осталось 5
 * дней» у невыданной заявки обещало бы срок, который ещё не начался.
 *
 * «Сегодня» приходит параметром, а не берётся здесь из часов: список, отрисованный в 00:00,
 * иначе показал бы часть строк по вчерашнему дню — каждая ячейка спрашивала бы своё «сейчас».
 *
 * Присутствие спрашивается предикатом контрактов целиком (`isMechRentalRunning`), а не одним
 * непустым `actualFrom`: после отката «Выполнена» → «В работе» факт остаётся, и возвращённая
 * техника снова показалась бы действующей арендой с «осталось N дней».
 */
export function mechDaysLeftLabel(
  row: MechRentalState & { plannedTo: string },
  today: string,
): { text: string; overdue: boolean } | null {
  if (!isMechRentalRunning(row)) return null;
  const left = mechDaysLeft(row.plannedTo, today);
  if (left < 0) return { text: `просрочено на ${daysWord(-left)}`, overdue: true };
  if (left === 0) return { text: 'возврат сегодня', overdue: false };
  return { text: `осталось ${daysWord(left)}`, overdue: false };
}

/** «1 день», «2 дня», «5 дней»: 11–14 всегда «дней». */
function daysWord(days: number): string {
  const tail = days % 100;
  const last = days % 10;
  const word =
    tail >= 11 && tail <= 14
      ? 'дней'
      : last === 1
        ? 'день'
        : last >= 2 && last <= 4
          ? 'дня'
          : 'дней';
  return `${days} ${word}`;
}
