import { describe, expect, it } from 'vitest';
import {
  approvedMachineHours,
  approvedShiftsBlocker,
  approveVehicleRequestShiftSchema,
  canEditShiftDay,
  canReassignVehicle,
  isShiftDayInTerm,
  isShiftFilled,
  pastShiftDaysCount,
  refuelLabel,
  saveVehicleRequestShiftSchema,
  SHIFT_IDLE_COMMENT_MESSAGE,
  shiftDayBlocker,
  shiftDaysDroppedByTerm,
  shiftDaysOf,
  shiftsBlocker,
  shiftsCompletionWarning,
  shiftSourceOf,
  shiftSpanHours,
  unapprovedPastShiftDays,
  onSitePresence,
  vehicleOnSitePresenceLabels,
  type ShiftSubject,
  type VehicleRequestShiftDto,
} from '@technic/contracts';

// Подтверждение смен по заказу спецтехники: правила живут в контрактах, потому что портал обязан
// не предлагать того, что сервер отклонит, и объяснять недоступное теми же словами.

const ON_DATE = '2026-08-05';

function request(over: Partial<ShiftSubject> = {}): ShiftSubject {
  return {
    requestType: 'special_equipment',
    status: 'confirmed',
    deletedAt: null,
    dateFrom: '2026-08-03',
    dateTo: '2026-08-07',
    ...over,
  };
}

function shift(over: Partial<VehicleRequestShiftDto> = {}): VehicleRequestShiftDto {
  return {
    date: '2026-08-03',
    startedAt: '08:00',
    endedAt: '20:00',
    machineHours: 11.5,
    refuel: '120 л',
    comment: '',
    filledBy: 'user-1',
    filledByName: 'Петров П. П.',
    filledAt: '2026-08-03T17:00:00.000Z',
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    ...over,
  };
}

describe('дни заказа', () => {
  it('таблица строится по сроку заявки, а не по заполненным строкам', () => {
    expect(shiftDaysOf({ dateFrom: '2026-08-03', dateTo: '2026-08-05' })).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
    ]);
  });

  it('пустая дата окончания — однодневный срок (так же его читает весь модуль)', () => {
    expect(shiftDaysOf({ dateFrom: '2026-08-03', dateTo: null })).toEqual(['2026-08-03']);
  });

  it('день принадлежит сроку — по этому же правилу сервер отклоняет чужой день', () => {
    const r = request();
    expect(isShiftDayInTerm(r, '2026-08-03')).toBe(true);
    expect(isShiftDayInTerm(r, '2026-08-07')).toBe(true);
    expect(isShiftDayInTerm(r, '2026-08-02')).toBe(false);
    expect(isShiftDayInTerm(r, '2026-08-08')).toBe(false);
  });

  it('прошедшие дни считаются по сегодняшний включительно', () => {
    // Срок 03–07 августа, сегодня 5-е: прошли три дня — 3, 4 и 5-й.
    expect(pastShiftDaysCount({ dateFrom: '2026-08-03', dateTo: '2026-08-07' }, ON_DATE)).toBe(3);
    // Срок целиком в прошлом — прошли все его дни.
    expect(pastShiftDaysCount({ dateFrom: '2026-07-30', dateTo: '2026-08-01' }, ON_DATE)).toBe(3);
    // Работы ещё не начались: считать нечего.
    expect(pastShiftDaysCount({ dateFrom: '2026-08-10', dateTo: '2026-08-12' }, ON_DATE)).toBe(0);
  });
});

/**
 * The rule both term doors refuse by (ADR 0184, 2026-10-12): which filled days a new term drops.
 * The server helper only reads the rows and words the refusal, so the cases of the rule live here.
 */
describe('filled days a term edit drops', () => {
  const term = { dateFrom: '2026-08-03', dateTo: '2026-08-07' };

  it('a start moved forward drops the filled days before it, in date order', () => {
    expect(
      shiftDaysDroppedByTerm(term, { dateFrom: '2026-08-05', dateTo: '2026-08-07' }, [
        '2026-08-06',
        '2026-08-04',
        '2026-08-03',
      ]),
    ).toEqual(['2026-08-03', '2026-08-04']);
  });

  it('an end moved back drops the filled days after it', () => {
    expect(
      shiftDaysDroppedByTerm(term, { dateFrom: '2026-08-03', dateTo: '2026-08-04' }, [
        '2026-08-04',
        '2026-08-05',
      ]),
    ).toEqual(['2026-08-05']);
  });

  it('a term moved whole drops the days it leaves behind and keeps those it still covers', () => {
    expect(
      shiftDaysDroppedByTerm(term, { dateFrom: '2026-08-05', dateTo: '2026-08-12' }, [
        '2026-08-03',
        '2026-08-05',
      ]),
    ).toEqual(['2026-08-03']);
  });

  it('an empty end is a one-day term on both sides', () => {
    // Removing the end of 03–07 makes the term the 3rd alone: the 4th falls out.
    expect(
      shiftDaysDroppedByTerm(term, { dateFrom: '2026-08-03', dateTo: null }, [
        '2026-08-03',
        '2026-08-04',
      ]),
    ).toEqual(['2026-08-04']);
    // A one-day term extended keeps its day.
    expect(
      shiftDaysDroppedByTerm(
        { dateFrom: '2026-08-03', dateTo: null },
        { dateFrom: '2026-08-03', dateTo: '2026-08-05' },
        ['2026-08-03'],
      ),
    ).toEqual([]);
  });

  it('a growing term and an untouched one drop nothing', () => {
    expect(
      shiftDaysDroppedByTerm(term, { dateFrom: '2026-08-01', dateTo: '2026-08-10' }, [
        '2026-08-03',
        '2026-08-07',
      ]),
    ).toEqual([]);
    expect(shiftDaysDroppedByTerm(term, term, ['2026-08-03'])).toEqual([]);
  });

  it("a row already outside the current term is not this edit's drop", () => {
    // Left by an edit made before the rule: refusing for it would lock every later term edit,
    // and the shift window cannot reach a day outside the term to delete it.
    expect(
      shiftDaysDroppedByTerm(term, { dateFrom: '2026-08-04', dateTo: '2026-08-07' }, [
        '2026-08-01',
        '2026-08-09',
      ]),
    ).toEqual([]);
  });

  it('days without a filled shift do not count, whatever the new term', () => {
    expect(
      shiftDaysDroppedByTerm(term, { dateFrom: '2026-08-06', dateTo: '2026-08-06' }, []),
    ).toEqual([]);
  });
});

describe('где смены ведут', () => {
  it('только у заказа спецтехники в работе', () => {
    expect(shiftsBlocker(request())).toBeNull();
    expect(shiftsBlocker(request({ requestType: 'freight_transport' }))).toMatch(/грузоперевозк/i);
    expect(shiftsBlocker(request({ status: 'new' }))).toMatch(/В работе/);
    expect(shiftsBlocker(request({ status: 'done' }))).toMatch(/В работе/);
    expect(shiftsBlocker(request({ deletedAt: '2026-08-04T00:00:00.000Z' }))).toMatch(/архив/i);
  });

  it('будущий день не ведут и не подтверждают — смену пишут по факту', () => {
    const r = request();
    expect(shiftDayBlocker(r, ON_DATE, ON_DATE)).toBeNull();
    expect(shiftDayBlocker(r, '2026-08-04', ON_DATE)).toBeNull();
    expect(shiftDayBlocker(r, '2026-08-06', ON_DATE)).toMatch(/не наступил/);
    expect(canEditShiftDay(r, '2026-08-06', ON_DATE)).toBe(false);
  });

  it('день вне срока заявки недоступен', () => {
    expect(shiftDayBlocker(request(), '2026-08-01', ON_DATE)).toMatch(/вне срока/);
  });
});

describe('подтверждённые дни: что запирают и о чём предупреждают', () => {
  it('закрытие без подписей предупреждает, но не запрещается', () => {
    const r = request({ shifts: { approvedDays: 1, unapprovedPastDays: 2 } });
    expect(shiftsCompletionWarning(r)).toMatch(/2 смены без согласования/);
    expect(shiftsCompletionWarning(r)).toMatch(/без подписи объекта/);
    expect(
      shiftsCompletionWarning(request({ shifts: { approvedDays: 3, unapprovedPastDays: 0 } })),
    ).toBeNull();
  });

  it('у грузоперевозки закрытие смены не спрашивает — там не период, а момент подачи', () => {
    const freight = request({
      requestType: 'freight_transport',
      shifts: { approvedDays: 0, unapprovedPastDays: 5 },
    });
    expect(shiftsCompletionWarning(freight)).toBeNull();
  });

  it('предупреждение перечисляет наступившие дни без подписи — будущие в него не идут', () => {
    const days = unapprovedPastShiftDays(
      [
        shift({ date: '2026-08-03', approvedAt: '2026-08-03T18:00:00.000Z', approvedBy: 'u-2' }),
        shift({ date: '2026-08-04' }),
        shift({ date: '2026-08-05' }),
        shift({ date: '2026-08-06' }),
      ],
      ON_DATE,
    );
    expect(days).toEqual(['2026-08-04', '2026-08-05']);
  });

  it('машину не меняют и заявку не откатывают, пока подпись стоит', () => {
    expect(
      approvedShiftsBlocker(request({ shifts: { approvedDays: 2, unapprovedPastDays: 0 } })),
    ).toMatch(/согласовано смен: 2/i);
    expect(
      approvedShiftsBlocker(request({ shifts: { approvedDays: 0, unapprovedPastDays: 3 } })),
    ).toBeNull();
  });

  it('предикат смены машины знает про подтверждённые дни — кнопка не ведёт в 422', () => {
    const assignment = { vehicleId: 'v-1' } as never;
    const inWork = { status: 'confirmed' as const, assignment, deletedAt: null };
    expect(canReassignVehicle(inWork)).toBe(true);
    expect(
      canReassignVehicle({ ...inWork, shifts: { approvedDays: 1, unapprovedPastDays: 0 } }),
    ).toBe(false);
    // Незаполненные дни машину не запирают: подпись объекта под ними ещё не стоит.
    expect(
      canReassignVehicle({ ...inWork, shifts: { approvedDays: 0, unapprovedPastDays: 4 } }),
    ).toBe(true);
  });
});

describe('срез «На объекте»', () => {
  it('заявка с истёкшим сроком остаётся в срезе с отдельной подписью', () => {
    // Отбор такой строки ведёт сервер (`hasUnapprovedPastShiftsSql`); подпись обязана отличаться
    // от «на объекте» — техника уехала, а работа не принята.
    expect(onSitePresence({ dateFrom: '2026-07-30', dateTo: '2026-08-01' }, ON_DATE)).toBe(
      'awaiting',
    );
    expect(vehicleOnSitePresenceLabels.awaiting).toMatch(/не согласован/i);
  });

  it('дни внутри срока читаются как прежде', () => {
    expect(onSitePresence({ dateFrom: ON_DATE, dateTo: ON_DATE }, ON_DATE)).toBe('single');
    expect(onSitePresence({ dateFrom: ON_DATE, dateTo: '2026-08-07' }, ON_DATE)).toBe('arrives');
    expect(onSitePresence({ dateFrom: '2026-08-03', dateTo: ON_DATE }, ON_DATE)).toBe('leaves');
    expect(onSitePresence({ dateFrom: '2026-08-03', dateTo: '2026-08-07' }, ON_DATE)).toBe(
      'ongoing',
    );
  });
});

describe('тело смены', () => {
  it('время передаётся парой: половина смены не описывает ничего', () => {
    expect(
      saveVehicleRequestShiftSchema.safeParse({
        startedAt: '08:00',
        endedAt: '20:00',
        machineHours: 11.5,
      }).success,
    ).toBe(true);
    const half = saveVehicleRequestShiftSchema.safeParse({ startedAt: '08:00', machineHours: 8 });
    expect(half.success).toBe(false);
  });

  it('нулевые машиночасы требуют объяснения — простой тоже часть учёта', () => {
    const idle = saveVehicleRequestShiftSchema.safeParse({ machineHours: 0 });
    expect(idle.success).toBe(false);
    expect(idle.error?.issues[0]?.message).toBe(SHIFT_IDLE_COMMENT_MESSAGE);
    expect(
      saveVehicleRequestShiftSchema.safeParse({ machineHours: 0, comment: 'дождь, простой' })
        .success,
    ).toBe(true);
  });

  it('машиночасов за день не больше суток', () => {
    expect(saveVehicleRequestShiftSchema.safeParse({ machineHours: 24 }).success).toBe(true);
    expect(saveVehicleRequestShiftSchema.safeParse({ machineHours: 24.5 }).success).toBe(false);
    expect(saveVehicleRequestShiftSchema.safeParse({ machineHours: -1 }).success).toBe(false);
  });

  it('заправка — свободный текст: формат ещё не устоялся', () => {
    const parsed = saveVehicleRequestShiftSchema.parse({
      machineHours: 8,
      refuel: 'АИ-95, 80 л по талону',
    });
    expect(parsed.refuel).toBe('АИ-95, 80 л по талону');
  });

  it('согласование и снятие — одно тело', () => {
    expect(approveVehicleRequestShiftSchema.parse({ approved: true })).toEqual({ approved: true });
    expect(approveVehicleRequestShiftSchema.parse({ approved: false })).toEqual({
      approved: false,
    });
  });

  it('the driver fingerprint is an optional key of both strict bodies', () => {
    expect(
      approveVehicleRequestShiftSchema.parse({ approved: true, expectedDriverFingerprint: 'v1:a' }),
    ).toEqual({ approved: true, expectedDriverFingerprint: 'v1:a' });
    expect(
      approveVehicleRequestShiftSchema.safeParse({ approved: true, expectedDriverFingerprint: '' })
        .success,
    ).toBe(false);
    // Still strict: any other unknown key is refused, as an old server refuses this one.
    expect(approveVehicleRequestShiftSchema.safeParse({ approved: true, other: 1 }).success).toBe(
      false,
    );
    expect(
      saveVehicleRequestShiftSchema.parse({ machineHours: 8, expectedDriverFingerprint: 'v1:a' })
        .expectedDriverFingerprint,
    ).toBe('v1:a');
  });

  it('an idle driver day may leave the reason to the door: the driver comment can carry it', () => {
    expect(saveVehicleRequestShiftSchema.safeParse({ machineHours: 0 }).success).toBe(false);
    expect(
      saveVehicleRequestShiftSchema.safeParse({
        machineHours: 0,
        expectedDriverFingerprint: 'v1:a',
      }).success,
    ).toBe(true);
  });
});

describe('источник дня (план слияния смен и показаний, §6.4)', () => {
  /** A day the site never wrote: the row of the table without a row in the database. */
  const unwritten = (): VehicleRequestShiftDto =>
    shift({ filledAt: null, filledBy: null, filledByName: null });

  it('shiftSourceOf trusts the server and falls back to filledAt for an older one', () => {
    // An older server sends no `source`: a written row is the site's, an unwritten day is nothing.
    expect(shiftSourceOf(shift())).toBe('site');
    expect(shiftSourceOf(unwritten())).toBeNull();
    // A newer one answers itself, and a driver day has no site row behind it.
    expect(shiftSourceOf({ ...unwritten(), source: 'driver' })).toBe('driver');
    expect(shiftSourceOf({ ...shift(), source: null })).toBeNull();
    expect(shiftSourceOf({ ...shift(), source: 'site' })).toBe('site');
  });

  it('isShiftFilled is "a source exists": a driver-only day has numbers to sign', () => {
    expect(isShiftFilled(unwritten())).toBe(false);
    expect(isShiftFilled({ ...unwritten(), source: 'driver' })).toBe(true);
    expect(isShiftFilled(shift())).toBe(true);
    expect(isShiftFilled({ ...unwritten(), source: null })).toBe(false);
  });

  it('refuelLabel: liters as the site writes them, nothing refilled as an empty field', () => {
    expect(refuelLabel(120)).toBe('120 л');
    expect(refuelLabel(80.5)).toBe('80,5 л');
    expect(refuelLabel(0)).toBe('');
    expect(refuelLabel(null)).toBe('');
    expect(refuelLabel(undefined)).toBe('');
  });
});

describe('итоги', () => {
  it('в факт выполнения идут только подтверждённые часы', () => {
    const shifts = [
      shift({ approvedAt: '2026-08-03T18:00:00.000Z', machineHours: 11.5 }),
      shift({ date: '2026-08-04', approvedAt: '2026-08-04T18:00:00.000Z', machineHours: 8 }),
      // Внесён, но не подтверждён: о часах этого дня ещё не договорились.
      shift({ date: '2026-08-05', machineHours: 6 }),
    ];
    expect(approvedMachineHours(shifts)).toBe(19.5);
  });

  it('длительность смены считается и через полночь', () => {
    expect(shiftSpanHours('08:00', '20:00')).toBe(12);
    expect(shiftSpanHours('20:00', '08:00')).toBe(12);
    expect(shiftSpanHours('08:00', null)).toBeNull();
  });
});
