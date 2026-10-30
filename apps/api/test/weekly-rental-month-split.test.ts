import { describe, expect, it } from 'vitest';
import {
  itemWarnings,
  rentalMonthSplit,
  rentalMonthSplitText,
  weeklyAnnulItemState,
  type WeeklyAnnulItem,
  type WeeklyAnnulOrder,
  type WeeklyRequestScope,
  type WeeklyWarningOrder,
} from '@technic/contracts';

/**
 * The month cut of a rental extension (ADR 0238): the predicate the form's note, the save check
 * and the visa ask. The cases are the real weeks of the autumn: 30 Nov – 6 Dec 2026 holds the
 * border of November, 28 Dec – 3 Jan the border of the year.
 */
describe('аренда: разрез продления границей месяца', () => {
  it('собственная машина и заказ без машины не режутся вовсе', () => {
    expect(rentalMonthSplit('own', '2026-11-30', '2026-12-06', '2026-11-30')).toEqual({
      extendTo: '2026-12-06',
      continuation: null,
    });
    expect(rentalMonthSplit(null, '2026-11-30', '2026-12-06', '2026-11-30')).toEqual({
      extendTo: '2026-12-06',
      continuation: null,
    });
  });

  it('продление внутри месяца заказа идёт как раньше, в том числе до самой границы', () => {
    expect(rentalMonthSplit('rental', '2026-11-26', '2026-11-29', '2026-11-26')).toEqual({
      extendTo: '2026-11-29',
      continuation: null,
    });
    expect(rentalMonthSplit('rental', '2026-11-26', '2026-11-30', '2026-11-26')).toEqual({
      extendTo: '2026-11-30',
      continuation: null,
    });
  });

  it('продление через границу: старый заказ — до границы, дальше новый заказ с 1-го числа', () => {
    expect(rentalMonthSplit('rental', '2026-11-29', '2026-12-06', '2026-11-29')).toEqual({
      extendTo: '2026-11-30',
      continuation: { dateFrom: '2026-12-01', dateTo: '2026-12-06' },
    });
  });

  it('заказ, кончающийся в последний день месяца, не трогается: всё продление — новому заказу', () => {
    expect(rentalMonthSplit('rental', '2026-11-30', '2026-12-06', '2026-11-30')).toEqual({
      extendTo: null,
      continuation: { dateFrom: '2026-12-01', dateTo: '2026-12-06' },
    });
    // Одного дня достаточно: «продление с 1 числа» — самый частый случай.
    expect(rentalMonthSplit('rental', '2026-11-30', '2026-12-01', '2026-11-30')).toEqual({
      extendTo: null,
      continuation: { dateFrom: '2026-12-01', dateTo: '2026-12-01' },
    });
  });

  it('граница года — частный случай границы месяца', () => {
    expect(rentalMonthSplit('rental', '2026-12-30', '2027-01-03', '2026-12-30')).toEqual({
      extendTo: '2026-12-31',
      continuation: { dateFrom: '2027-01-01', dateTo: '2027-01-03' },
    });
  });

  it('високосный февраль считает календарь, а не таблица длин месяцев', () => {
    expect(rentalMonthSplit('rental', '2028-02-27', '2028-03-02', '2028-02-27')).toEqual({
      extendTo: '2028-02-29',
      continuation: { dateFrom: '2028-03-01', dateTo: '2028-03-02' },
    });
  });

  it('старый октябрьский заказ с концом 1 ноября разделяется при продлении НЗ-604', () => {
    expect(rentalMonthSplit('rental', '2026-11-01', '2026-11-08', '2026-10-23')).toEqual({
      extendTo: '2026-10-31',
      continuation: { dateFrom: '2026-11-02', dateTo: '2026-11-08' },
    });
  });

  it('выходной хвост на границе не создаёт пустой ноябрьский заказ', () => {
    expect(rentalMonthSplit('rental', '2026-10-30', '2026-11-01', '2026-10-23')).toEqual({
      extendTo: '2026-10-31',
      continuation: null,
    });
  });

  it('сохраняет выбранную субботу и обычное воскресенье внутри месяца', () => {
    expect(
      rentalMonthSplit('rental', '2026-11-01', '2026-11-07', '2026-10-23').continuation,
    ).toEqual({ dateFrom: '2026-11-02', dateTo: '2026-11-07' });
    expect(rentalMonthSplit('rental', '2026-11-06', '2026-11-15', '2026-11-02')).toEqual({
      extendTo: '2026-11-15',
      continuation: null,
    });
  });

  it('текст разреза называет обе части и одинаков для формы и для итога визы', () => {
    const cut = rentalMonthSplit('rental', '2026-11-29', '2026-12-06', '2026-11-29');
    expect(rentalMonthSplitText(cut)).toBe(
      'Аренда не идёт за границу месяца: срок заказа будет до 30.11, а на 01.12–06.12 откроется новый заказ той же машины',
    );
    const whole = rentalMonthSplit('rental', '2026-11-30', '2026-12-01', '2026-11-30');
    expect(rentalMonthSplitText(whole)).toBe(
      'Аренда не идёт за границу месяца: заказ остаётся как есть, а на 01.12 откроется новый заказ той же машины',
    );
    expect(
      rentalMonthSplitText(rentalMonthSplit('own', '2026-11-30', '2026-12-06', '2026-11-30')),
    ).toBeNull();
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

  it('отмена продолжения позволяет восстановить старый срок 1 ноября после нормализации к 31 октября', () => {
    const item = extend({
      previousDateTo: '2026-11-01',
      appliedDateTo: '2026-10-31',
      dateTo: '2026-11-08',
      continuationOrder: { num: 501, status: 'cancelled', deletedAt: null },
    });
    expect(
      weeklyAnnulItemState(item, order({ dateFrom: '2026-10-23', dateTo: '2026-10-31' })).state,
    ).toBe('reversible');
    expect(
      weeklyAnnulItemState(item, order({ dateFrom: '2026-10-23', dateTo: '2026-11-01' })).state,
    ).toBe('reverted');
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
    const cancelled = {
      continuationOrder: { num: 501, status: 'cancelled' as const, deletedAt: null },
    };
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

describe('аренда: предупреждение строки о разрезе по границе месяца', () => {
  const week: WeeklyRequestScope = {
    objectId: 'obj',
    weekStart: '2026-11-30',
    weekEnd: '2026-12-06',
    objectIsActive: true,
    today: '2026-11-23',
  };
  const order = (patch: Partial<WeeklyWarningOrder>): WeeklyWarningOrder => ({
    id: 'vr-1',
    objectId: 'obj',
    requestType: 'special_equipment',
    status: 'confirmed',
    deletedAt: null,
    dateFrom: '2026-11-02',
    dateTo: '2026-11-29',
    hasAssignment: true,
    pickupRoute: null,
    leftBy: null,
    pendingEarlyEndDate: null,
    machinistCardRemoved: false,
    ownership: 'rental',
    otherWeekly: null,
    ...patch,
  });
  const cut = (o: WeeklyWarningOrder, to: string | null, scope = week) =>
    itemWarnings(o, scope, to).find((w) => w.kind === 'rental_month_cut');

  it('арендной единице в неделе с границей сказано, что продление после неё откроется новым заказом', () => {
    expect(cut(order({}), '2026-12-06')?.text).toBe(
      'Аренда не идёт за границу месяца: продление после 30.11 откроется новым заказом той же машины',
    );
  });

  it('текст не называет выбранную дату: форма показывает его для предложенной, а человек выберет другую', () => {
    expect(cut(order({}), '2026-12-02')?.text).toBe(cut(order({}), '2026-12-06')?.text);
  });

  it('предупреждения нет там, где разрезать нечего: собственная машина, строка «уезжает», неделя до границы', () => {
    expect(cut(order({ ownership: 'own' }), '2026-12-06')).toBeUndefined();
    expect(cut(order({}), null)).toBeUndefined();
    const early: WeeklyRequestScope = { ...week, weekStart: '2026-11-23', weekEnd: '2026-11-29' };
    expect(cut(order({ dateTo: '2026-11-25' }), '2026-11-29', early)).toBeUndefined();
  });

  it('заказ, кончающийся в последний день месяца, получает то же предупреждение', () => {
    expect(cut(order({ dateTo: '2026-11-30' }), '2026-12-06')).toBeDefined();
  });
});
