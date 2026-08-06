import { describe, expect, it } from 'vitest';
import {
  approvedMachineHours,
  approvedShiftsBlocker,
  approveVehicleRequestShiftSchema,
  canEditShiftDay,
  canReassignVehicle,
  isShiftDayInTerm,
  pastShiftDaysCount,
  saveVehicleRequestShiftSchema,
  SHIFT_IDLE_COMMENT_MESSAGE,
  shiftDayBlocker,
  shiftDaysOf,
  shiftsBlocker,
  shiftsCompletionWarning,
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
