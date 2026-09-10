import { describe, expect, it } from 'vitest';
import { shiftRangeAfterActualEnd } from '@technic/contracts';
import { type RequestShiftDay, splitShiftDaysByRange } from '../src/services/assignment-shifts';

/**
 * Смены за фактической датой закрытия (`docs/vehicle-request-actual-end-date-plan.md`, Р10; Э7).
 *
 * Проверяются две половины одной механики, и обе новые: контрактный диапазон `(endedOn,
 * previousDateTo]` и разделение прочитанных дней на «нельзя» и «будет стёрто». Первым их
 * потребителем становится дверь закрытия — она по этим множествам откажет 422 и удалит строки, —
 * поэтому ошибка здесь не падает, а тихо стирает работу: смещённая на день левая граница снимает
 * часы последнего рабочего дня, за который заказчику выставлен счёт, а перепутанные множества
 * удаляют день, подписанный объектом.
 */

/** Заказ на неделю: пять дней сверху, чтобы «после факта» и «внутри факта» не совпали случайно. */
const WEEK = { dateFrom: '2026-08-03', dateTo: '2026-08-09' };

function day(date: string, approved: boolean, hours = 8): RequestShiftDay {
  return { date, hours, approved };
}

describe('диапазон смен за фактической датой', () => {
  it('начинается со следующего за фактом дня и кончается прежним концом срока', () => {
    // День факта — рабочий: его часы предъявляются самим фактом выполнения и не снимаются.
    expect(shiftRangeAfterActualEnd(WEEK, '2026-08-05')).toEqual({
      from: '2026-08-06',
      to: '2026-08-09',
    });
  });

  it('закрытие ровно по концу срока не снимает ничего', () => {
    expect(shiftRangeAfterActualEnd(WEEK, '2026-08-09')).toBeNull();
  });

  it('факт позже конца срока диапазона не даёт: снимать нечего и в этом случае', () => {
    // Дверь такой факт не пропускает (`факт ≤ min(date_to, сегодня)`), но расчёт не вправе
    // отвечать перевёрнутым отрезком — он молча прошёл бы в `BETWEEN`.
    expect(shiftRangeAfterActualEnd(WEEK, '2026-08-11')).toBeNull();
  });

  it('факт в первый день срока снимает весь остаток недели', () => {
    expect(shiftRangeAfterActualEnd(WEEK, '2026-08-03')).toEqual({
      from: '2026-08-04',
      to: '2026-08-09',
    });
  });

  it('однодневный срок: пустая dateTo — конец в dateFrom, и снимать нечего', () => {
    // Единственный день заказа и есть фактический: диапазон пуст при любом допустимом факте.
    expect(
      shiftRangeAfterActualEnd({ dateFrom: '2026-08-03', dateTo: null }, '2026-08-03'),
    ).toBeNull();
    expect(shiftRangeAfterActualEnd({ dateFrom: '2026-08-03' }, '2026-08-03')).toBeNull();
  });

  it('однодневный срок с фактом раньше начала не обещает дней до срока', () => {
    // Факт вне срока дверь отвергает, но начало отрезка всё равно не опускается ниже `dateFrom`:
    // смен до начала заказа не бывает, и показывать окну такие дни нечестно.
    expect(
      shiftRangeAfterActualEnd({ dateFrom: '2026-08-03', dateTo: '2026-08-09' }, '2026-07-30'),
    ).toEqual({ from: '2026-08-03', to: '2026-08-09' });
  });

  it('переход через конец месяца считается календарём, а не строкой', () => {
    expect(
      shiftRangeAfterActualEnd({ dateFrom: '2026-08-28', dateTo: '2026-09-02' }, '2026-08-31'),
    ).toEqual({ from: '2026-09-01', to: '2026-09-02' });
  });

  it('без даты начала диапазона нет вовсе', () => {
    expect(shiftRangeAfterActualEnd({ dateTo: '2026-08-09' }, '2026-08-05')).toBeNull();
  });
});

describe('разделение смен диапазона на два множества', () => {
  const days: RequestShiftDay[] = [
    day('2026-08-04', true, 10), // внутри факта, подписан — закрытия не касается
    day('2026-08-05', false, 9), // внутри факта, без подписи — тоже не касается
    day('2026-08-07', true, 8), // за фактом, подписан — «нельзя»
    day('2026-08-08', false, 7.5), // за фактом, без подписи — «будет стёрто»
  ];

  it('подписанные дни диапазона запирают, неподписанные снимают, часы едут с датой', () => {
    const range = shiftRangeAfterActualEnd(WEEK, '2026-08-05');
    expect(splitShiftDaysByRange(days, range)).toEqual({
      blockedShiftDays: [{ date: '2026-08-07', hours: 8 }],
      clearedShiftDays: [{ date: '2026-08-08', hours: 7.5 }],
    });
  });

  it('дни внутри факта не попадают ни в одно множество, даже подписанные', () => {
    const split = splitShiftDaysByRange(days, shiftRangeAfterActualEnd(WEEK, '2026-08-05'));
    const named = [...split.blockedShiftDays, ...split.clearedShiftDays].map((d) => d.date);
    expect(named).not.toContain('2026-08-04');
    expect(named).not.toContain('2026-08-05');
  });

  it('пустой диапазон — оба множества пусты: дверь ничего не спрашивает и ничего не стирает', () => {
    expect(splitShiftDaysByRange(days, null)).toEqual({
      blockedShiftDays: [],
      clearedShiftDays: [],
    });
  });
});
