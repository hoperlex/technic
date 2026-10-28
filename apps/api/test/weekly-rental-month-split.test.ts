import { describe, expect, it } from 'vitest';
import {
  rentalMonthSplit,
  rentalMonthSplitText,
  weeklyAnnulItemState,
  type WeeklyAnnulItem,
  type WeeklyAnnulOrder,
} from '@technic/contracts';

/**
 * The month cut of a rental extension (ADR 0238): the predicate the form's note, the save check
 * and the visa ask. The cases are the real weeks of the autumn: 30 Nov – 6 Dec 2026 holds the
 * border of November, 28 Dec – 3 Jan the border of the year.
 */
describe('аренда: разрез продления границей месяца', () => {
  it('собственная машина и заказ без машины не режутся вовсе', () => {
    expect(rentalMonthSplit('own', '2026-11-30', '2026-12-06')).toEqual({
      extendTo: '2026-12-06',
      continuation: null,
    });
    expect(rentalMonthSplit(null, '2026-11-30', '2026-12-06')).toEqual({
      extendTo: '2026-12-06',
      continuation: null,
    });
  });

  it('продление внутри месяца заказа идёт как раньше, в том числе до самой границы', () => {
    expect(rentalMonthSplit('rental', '2026-11-26', '2026-11-29')).toEqual({
      extendTo: '2026-11-29',
      continuation: null,
    });
    expect(rentalMonthSplit('rental', '2026-11-26', '2026-11-30')).toEqual({
      extendTo: '2026-11-30',
      continuation: null,
    });
  });

  it('продление через границу: старый заказ — до границы, дальше новый заказ с 1-го числа', () => {
    expect(rentalMonthSplit('rental', '2026-11-29', '2026-12-06')).toEqual({
      extendTo: '2026-11-30',
      continuation: { dateFrom: '2026-12-01', dateTo: '2026-12-06' },
    });
  });

  it('заказ, кончающийся в последний день месяца, не трогается: всё продление — новому заказу', () => {
    expect(rentalMonthSplit('rental', '2026-11-30', '2026-12-06')).toEqual({
      extendTo: null,
      continuation: { dateFrom: '2026-12-01', dateTo: '2026-12-06' },
    });
    // Одного дня достаточно: «продление с 1 числа» — самый частый случай.
    expect(rentalMonthSplit('rental', '2026-11-30', '2026-12-01')).toEqual({
      extendTo: null,
      continuation: { dateFrom: '2026-12-01', dateTo: '2026-12-01' },
    });
  });

  it('граница года — частный случай границы месяца', () => {
    expect(rentalMonthSplit('rental', '2026-12-30', '2027-01-03')).toEqual({
      extendTo: '2026-12-31',
      continuation: { dateFrom: '2027-01-01', dateTo: '2027-01-03' },
    });
  });

  it('високосный февраль считает календарь, а не таблица длин месяцев', () => {
    expect(rentalMonthSplit('rental', '2028-02-27', '2028-03-02')).toEqual({
      extendTo: '2028-02-29',
      continuation: { dateFrom: '2028-03-01', dateTo: '2028-03-02' },
    });
  });

  it('месяц — тот, в котором заказ кончается: старый переходный заказ назад не режется', () => {
    // Заказ завели с 28.10 по 02.11 до правила; его конец стоит в ноябре, и продление в ноябре
    // идёт как есть — резать назад нечего.
    expect(rentalMonthSplit('rental', '2026-11-02', '2026-11-08')).toEqual({
      extendTo: '2026-11-08',
      continuation: null,
    });
  });

  it('текст разреза называет обе части и одинаков для формы и для итога визы', () => {
    const cut = rentalMonthSplit('rental', '2026-11-29', '2026-12-06');
    expect(rentalMonthSplitText(cut)).toBe(
      'Аренда не идёт за границу месяца: заказ продлится до 30.11, а на 01.12–06.12 откроется новый заказ той же машины',
    );
    const whole = rentalMonthSplit('rental', '2026-11-30', '2026-12-01');
    expect(rentalMonthSplitText(whole)).toBe(
      'Аренда не идёт за границу месяца: заказ остаётся как есть, а на 01.12 откроется новый заказ той же машины',
    );
    expect(rentalMonthSplitText(rentalMonthSplit('own', '2026-11-30', '2026-12-06'))).toBeNull();
  });
});

describe('аннулирование: строка аренды с заказом за границей месяца', () => {
  const extend = (over: Partial<WeeklyAnnulItem> = {}): WeeklyAnnulItem => ({
    id: 'i1',
    kind: 'extend',
    result: 'extended',
    dateTo: '2026-12-06',
    previousDateTo: '2026-11-29',
    laterWeekRefs: [],
    continuationOrder: { num: 501, status: 'confirmed', deletedAt: null },
    ...over,
  });
  const order = (over: Partial<WeeklyAnnulOrder> = {}): WeeklyAnnulOrder => ({
    status: 'confirmed',
    deletedAt: null,
    dateFrom: '2026-11-02',
    dateTo: '2026-11-30',
    pickupRoute: null,
    pendingEarlyEndDate: null,
    ...over,
  });

  it('пока заказ-продолжение в работе, разворот заблокирован и называет заказ', () => {
    const verdict = weeklyAnnulItemState(extend(), order());
    expect(verdict.state).toBe('blocked');
    expect(verdict.reverse).toBe('none');
    expect(verdict.reason).toContain('ТС-501');
    expect(verdict.reason).toContain('откатите его в «Новую» и отмените');
  });

  it('откатанный в «Новую» заказ-продолжение просят только отменить', () => {
    const verdict = weeklyAnnulItemState(
      extend({ continuationOrder: { num: 501, status: 'new', deletedAt: null } }),
      order(),
    );
    expect(verdict.state).toBe('blocked');
    expect(verdict.reason).toContain('сначала отмените его');
  });

  it('отменённый или убранный в архив заказ-продолжение разворот не держит', () => {
    const cancelled = weeklyAnnulItemState(
      extend({ continuationOrder: { num: 501, status: 'cancelled', deletedAt: null } }),
      order(),
    );
    expect(cancelled.state).toBe('reversible');
    expect(cancelled.reverse).toBe('shorten_to');

    const archived = weeklyAnnulItemState(
      extend({
        continuationOrder: { num: 501, status: 'confirmed', deletedAt: '2026-12-02T09:00:00Z' },
      }),
      order(),
    );
    expect(archived.state).toBe('reversible');
  });

  it('срок, до которого неделя продлила разрезанную строку, — граница месяца, а не выбранная дата', () => {
    // Неделя выбрала 06.12, но заказ получил 30.11: сравнение с 06.12 назвало бы срок «изменённым».
    const cancelled = { continuationOrder: { num: 501, status: 'cancelled' as const, deletedAt: null } };
    expect(weeklyAnnulItemState(extend(cancelled), order()).state).toBe('reversible');
    const moved = weeklyAnnulItemState(extend(cancelled), order({ dateTo: '2026-11-25' }));
    expect(moved.state).toBe('reverted');
  });

  it('заказ, который неделя не двигала (кончался в последний день месяца), после отмены продолжения «уже возвращён»', () => {
    const verdict = weeklyAnnulItemState(
      extend({
        previousDateTo: '2026-11-30',
        continuationOrder: { num: 501, status: 'cancelled', deletedAt: null },
      }),
      order(),
    );
    expect(verdict.state).toBe('reverted');
  });

  it('строка без разреза ведёт себя как раньше', () => {
    const plain = extend({ continuationOrder: null, dateTo: '2026-11-30' });
    expect(weeklyAnnulItemState(plain, order()).state).toBe('reversible');
  });
});
