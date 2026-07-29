import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addressMetaSchema,
  allowedVehicleRequestTransitions,
  assignmentRateLabel,
  changeVehicleRequestStatusSchema,
  createVehicleRequestSchema,
  formatVehicleRequestNumber,
  FREIGHT_VEHICLE_KIND_CODE,
  isAddressVerified,
  isApprovalChangeable,
  isVehicleKindAllowedForRequest,
  parseVehicleRequestNumberSearch,
  setVehicleRequestApprovalSchema,
  transitionRequiresApproval,
  transitionRequiresAssignment,
  updateVehicleRequestSchema,
  vehicleRequestListQuerySchema,
  vehicleRequestSummaryQuerySchema,
} from '@technic/contracts';

const OBJ = '11111111-1111-4111-8111-111111111111';
const TYPE = '33333333-3333-4333-8333-333333333333';

// Создание заявки проверяет минимальную дату (не раньше сегодня по МСК), поэтому «сейчас»
// фиксируем: даты в фикстурах календарные, и без фиксации тесты зависели бы от дня запуска.
// 24.07.2026 12:00 МСК → минимальная дата заявки 25.07.2026.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-24T09:00:00.000Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

// Верифицированный адрес (resolved + ФИАС) — обязателен для грузоперевозки (ADR 0006).
const resolvedMeta = {
  source: 'resolved' as const,
  fiasId: '0c5b2444-70a0-4932-980c-b4dc0d3f02b5',
  fiasLevel: 8,
  geoLat: 55.75,
  geoLon: 37.61,
};

const special = {
  requestType: 'special_equipment' as const,
  objectId: OBJ,
  vehicleTypeId: TYPE,
  dateFrom: '2026-07-25',
};
const freight = {
  requestType: 'freight_transport' as const,
  objectId: OBJ,
  vehicleTypeId: TYPE,
  scheduledAt: '2026-07-25T14:30:00+03:00',
  volumeM3: 12.5,
  loadingLocation: 'Склад А',
  unloadingLocation: 'Объект Б',
  loadingAddress: resolvedMeta,
  unloadingAddress: resolvedMeta,
};

describe('vehicle-requests: создание — discriminator', () => {
  it('без requestType union не проходит', () => {
    expect(() =>
      createVehicleRequestSchema.parse({ objectId: OBJ, vehicleTypeId: TYPE }),
    ).toThrow();
  });

  it('спецтехника: базовый парсинг + дефолты', () => {
    const v = createVehicleRequestSchema.parse(special);
    if (v.requestType !== 'special_equipment') throw new Error('unreachable');
    expect(v.comment).toBe('');
    expect(v.fileIds).toEqual([]);
    expect(v.dateTo ?? null).toBeNull();
  });

  it('грузоперевозка: базовый парсинг', () => {
    const v = createVehicleRequestSchema.parse(freight);
    if (v.requestType !== 'freight_transport') throw new Error('unreachable');
    expect(v.volumeM3).toBe(12.5);
    expect(v.loadingLocation).toBe('Склад А');
  });
});

describe('vehicle-requests: тип ТС (плоская модель, ADR 0005)', () => {
  it('vehicleTypeId обязателен при создании', () => {
    const { vehicleTypeId: _t, ...noType } = special;
    expect(() => createVehicleRequestSchema.parse(noType)).toThrow();
  });

  it('устаревший vehicleSubtypeId отклоняется (strict)', () => {
    const { vehicleTypeId: _t, ...noType } = special;
    expect(() => createVehicleRequestSchema.parse({ ...noType, vehicleSubtypeId: TYPE })).toThrow();
  });
});

// Тип заявки выбирают в форме явно, из вида ТС он не выводится: на объект вызывают технику
// любого вида, грузоперевозку выполняют только грузовым. Тем же предикатом сужен список типов
// ТС в форме и проверен `vehicleTypeId` на сервере.
describe('vehicle-requests: вид ТС, доступный типу заявки', () => {
  it('на объект — техника любого вида', () => {
    expect(isVehicleKindAllowedForRequest('special_equipment', 'special_equipment')).toBe(true);
    expect(isVehicleKindAllowedForRequest('special_equipment', FREIGHT_VEHICLE_KIND_CODE)).toBe(
      true,
    );
    // Вид ТС — управляемый справочник: заведённый позже вид тоже можно заказать на объект.
    expect(isVehicleKindAllowedForRequest('special_equipment', 'passenger_transport')).toBe(true);
  });

  it('грузоперевозка — только грузовым видом', () => {
    expect(isVehicleKindAllowedForRequest('freight_transport', FREIGHT_VEHICLE_KIND_CODE)).toBe(
      true,
    );
    expect(isVehicleKindAllowedForRequest('freight_transport', 'special_equipment')).toBe(false);
    expect(isVehicleKindAllowedForRequest('freight_transport', 'passenger_transport')).toBe(false);
  });
});

describe('vehicle-requests: строгость схем (.strict)', () => {
  it('спецтехника отклоняет freight-поля', () => {
    expect(() =>
      createVehicleRequestSchema.parse({ ...special, scheduledAt: '2026-07-25T14:30:00+03:00' }),
    ).toThrow();
    expect(() => createVehicleRequestSchema.parse({ ...special, volumeM3: 5 })).toThrow();
    expect(() => createVehicleRequestSchema.parse({ ...special, loadingLocation: 'x' })).toThrow();
  });

  it('грузоперевозка отклоняет special-поля', () => {
    expect(() =>
      createVehicleRequestSchema.parse({ ...freight, dateFrom: '2026-07-25' }),
    ).toThrow();
    expect(() => createVehicleRequestSchema.parse({ ...freight, dateTo: '2026-07-26' })).toThrow();
  });
});

describe('vehicle-requests: кросс-поля и валидация значений', () => {
  it('dateTo не раньше dateFrom', () => {
    expect(() =>
      createVehicleRequestSchema.parse({
        ...special,
        dateFrom: '2026-07-25',
        dateTo: '2026-07-24',
      }),
    ).toThrow();
    const ok = createVehicleRequestSchema.parse({
      ...special,
      dateFrom: '2026-07-25',
      dateTo: '2026-07-25',
    });
    expect(ok.requestType).toBe('special_equipment');
  });

  it('спецтехника: некорректная дата отклоняется', () => {
    expect(() =>
      createVehicleRequestSchema.parse({ ...special, dateFrom: '2026-13-40' }),
    ).toThrow();
    expect(() =>
      createVehicleRequestSchema.parse({ ...special, dateFrom: '25-07-2026' }),
    ).toThrow();
  });

  it('грузоперевозка требует объём или массу', () => {
    const { volumeM3: _v, ...noAmount } = freight;
    expect(() => createVehicleRequestSchema.parse(noAmount)).toThrow();
    const byWeight = createVehicleRequestSchema.parse({ ...noAmount, weightTons: 3.2 });
    expect(byWeight.requestType).toBe('freight_transport');
  });

  it('объём/масса: >0 и не более 3 знаков', () => {
    expect(() => createVehicleRequestSchema.parse({ ...freight, volumeM3: 0 })).toThrow();
    expect(() => createVehicleRequestSchema.parse({ ...freight, volumeM3: -1 })).toThrow();
    expect(() => createVehicleRequestSchema.parse({ ...freight, volumeM3: 1.2345 })).toThrow();
    expect(createVehicleRequestSchema.parse({ ...freight, volumeM3: 1.234 }).requestType).toBe(
      'freight_transport',
    );
  });

  it('scheduledAt требует offset', () => {
    expect(() =>
      createVehicleRequestSchema.parse({ ...freight, scheduledAt: '2026-07-25T14:30:00' }),
    ).toThrow();
  });
});

describe('vehicle-requests: обновление', () => {
  it('требует version и requestType', () => {
    expect(() =>
      updateVehicleRequestSchema.parse({
        requestType: 'special_equipment',
        dateFrom: '2026-07-25',
      }),
    ).toThrow();
    const ok = updateVehicleRequestSchema.parse({
      requestType: 'special_equipment',
      version: 0,
      comment: 'правка',
    });
    expect(ok.requestType).toBe('special_equipment');
  });

  it('запрещённые поля не игнорируются (strict)', () => {
    expect(() =>
      updateVehicleRequestSchema.parse({
        requestType: 'special_equipment',
        version: 1,
        scheduledAt: '2026-07-25T14:30:00+03:00',
      }),
    ).toThrow();
  });

  it('status change требует version', () => {
    expect(() => changeVehicleRequestStatusSchema.parse({ status: 'confirmed' })).toThrow();
    expect(changeVehicleRequestStatusSchema.parse({ status: 'confirmed', version: 2 }).status).toBe(
      'confirmed',
    );
  });

  it('отмена требует причины', () => {
    expect(() =>
      changeVehicleRequestStatusSchema.parse({ status: 'cancelled', version: 2 }),
    ).toThrow();
    expect(
      changeVehicleRequestStatusSchema.parse({
        status: 'cancelled',
        comment: 'Техника не нужна',
        version: 2,
      }).comment,
    ).toBe('Техника не нужна');
  });
});

// ── Назначение техники при переводе в работу (ADR 0027) ──
describe('vehicle-requests: техника и ставки (ADR 0027)', () => {
  const VEHICLE = '44444444-4444-4444-8444-444444444444';

  it('технику назначают только при переводе в работу', () => {
    expect(transitionRequiresAssignment('confirmed')).toBe(true);
    expect(transitionRequiresAssignment('done')).toBe(false);
    expect(transitionRequiresAssignment('cancelled')).toBe(false);
    expect(transitionRequiresAssignment('new')).toBe(false);
  });

  it('ставки идут вместе с техникой и остаются необязательными', () => {
    const parsed = changeVehicleRequestStatusSchema.parse({
      status: 'confirmed',
      version: 2,
      assignment: { vehicleId: VEHICLE, pricePerHour: 2500, pricePerShift: 18000, shiftHours: 8 },
    });
    expect(parsed.assignment).toEqual({
      vehicleId: VEHICLE,
      pricePerHour: 2500,
      pricePerShift: 18000,
      shiftHours: 8,
    });
    // Своя машина может работать без ставки — «хотя бы одна цена» требует только аренда,
    // и требует её сервер: чья это машина, схема не знает.
    expect(
      changeVehicleRequestStatusSchema.parse({
        status: 'confirmed',
        version: 2,
        assignment: { vehicleId: VEHICLE },
      }).assignment?.pricePerHour,
    ).toBeUndefined();
  });

  it('назначение не прикладывается к другим переходам', () => {
    expect(() =>
      changeVehicleRequestStatusSchema.parse({
        status: 'done',
        version: 3,
        assignment: { vehicleId: VEHICLE },
      }),
    ).toThrow();
  });

  it('ставка — положительная сумма с копейками, смена — от часа до суток', () => {
    const withAssignment = (assignment: unknown) =>
      changeVehicleRequestStatusSchema.parse({ status: 'confirmed', version: 2, assignment });
    expect(() => withAssignment({ vehicleId: VEHICLE, pricePerHour: 0 })).toThrow();
    expect(() => withAssignment({ vehicleId: VEHICLE, pricePerHour: -100 })).toThrow();
    expect(() => withAssignment({ vehicleId: VEHICLE, pricePerHour: 1000.555 })).toThrow();
    expect(() => withAssignment({ vehicleId: VEHICLE, shiftHours: 25 })).toThrow();
    expect(() => withAssignment({ vehicleId: VEHICLE, shiftHours: 0 })).toThrow();
    // Ставку снимают явным null — «поле не пришло» и «ставки нет» это разные вещи.
    expect(withAssignment({ vehicleId: VEHICLE, pricePerHour: null }).assignment?.pricePerHour).toBe(
      null,
    );
  });

  it('лишние поля назначения не проходят (strict)', () => {
    expect(() =>
      changeVehicleRequestStatusSchema.parse({
        status: 'confirmed',
        version: 2,
        assignment: { vehicleId: VEHICLE, lessorId: OBJ },
      }),
    ).toThrow();
  });

  it('ставки одной строкой: час, смена и её длительность', () => {
    expect(
      assignmentRateLabel({ pricePerHour: 2500, pricePerShift: 18000, shiftHours: 8 }),
    ).toContain('₽/час');
    expect(
      assignmentRateLabel({ pricePerHour: null, pricePerShift: 18000, shiftHours: 8 }),
    ).toContain('(8 ч)');
    // Ставок нет — строка пустая: показывать «—» решает интерфейс, а не контракт.
    expect(assignmentRateLabel({ pricePerHour: null, pricePerShift: null, shiftHours: null })).toBe(
      '',
    );
  });
});

describe('vehicle-requests: адрес (DaData, ADR 0006 — жёсткая модель)', () => {
  it('freight требует верифицированный адрес: без адреса — отклоняется', () => {
    const { loadingAddress: _l, unloadingAddress: _u, ...noAddr } = freight;
    expect(() => createVehicleRequestSchema.parse(noAddr)).toThrow();
    // задана только погрузка — разгрузка тоже обязательна
    expect(() =>
      createVehicleRequestSchema.parse({ ...noAddr, loadingAddress: resolvedMeta }),
    ).toThrow();
  });

  it('freight отклоняет неверифицированный адрес (manual / resolved без ФИАС)', () => {
    expect(() =>
      createVehicleRequestSchema.parse({ ...freight, loadingAddress: { source: 'manual' } }),
    ).toThrow();
    expect(() =>
      createVehicleRequestSchema.parse({
        ...freight,
        loadingAddress: { source: 'resolved', fiasId: null },
      }),
    ).toThrow();
  });

  it('freight принимает верифицированный адрес (resolved + ФИАС)', () => {
    const v = createVehicleRequestSchema.parse(freight);
    if (v.requestType !== 'freight_transport') throw new Error('unreachable');
    expect(v.loadingAddress?.fiasId).toBe(resolvedMeta.fiasId);
    expect(v.unloadingAddress?.fiasId).toBe(resolvedMeta.fiasId);
  });

  it('update: строка адреса и метаданные передаются вместе', () => {
    const base = { requestType: 'freight_transport' as const, version: 1 };
    expect(() =>
      updateVehicleRequestSchema.parse({ ...base, loadingLocation: 'Новый склад' }),
    ).toThrow();
    const ok = updateVehicleRequestSchema.parse({
      ...base,
      loadingLocation: 'Новый склад',
      loadingAddress: resolvedMeta,
    });
    expect(ok.requestType).toBe('freight_transport');
  });

  it('addressMeta strict: лишние поля отклоняются', () => {
    expect(() => addressMetaSchema.parse({ ...resolvedMeta, city: 'Москва' })).toThrow();
    expect(() => addressMetaSchema.parse({ source: 'bogus' })).toThrow();
  });

  it('isAddressVerified: resolved+fiasId и object — верифицированы; manual и null — нет', () => {
    expect(isAddressVerified(resolvedMeta)).toBe(true);
    expect(isAddressVerified({ source: 'object' })).toBe(true);
    expect(isAddressVerified({ source: 'resolved', fiasId: null })).toBe(false);
    expect(isAddressVerified({ source: 'manual' })).toBe(false);
    expect(isAddressVerified(null)).toBe(false);
  });
});

describe('vehicle-requests: список и номер', () => {
  it('requestType в list-query необязателен: без него — единый список обоих типов', () => {
    const all = vehicleRequestListQuerySchema.parse({});
    expect(all.requestType).toBeUndefined();
    expect(all.includeDeleted).toBe(false);

    const one = vehicleRequestListQuerySchema.parse({ requestType: 'special_equipment' });
    expect(one.requestType).toBe('special_equipment');

    expect(() => vehicleRequestListQuerySchema.parse({ requestType: 'unknown' })).toThrow();
  });

  it('сводка сужается только объектом и типом заявки', () => {
    const all = vehicleRequestSummaryQuerySchema.parse({});
    expect(all.objectId).toBeUndefined();
    expect(all.requestType).toBeUndefined();

    // Статус и номер в сводку не входят: по статусу она свелась бы к самой себе, по номеру —
    // к одной заявке. Лишние ключи схема отбрасывает.
    const narrowed = vehicleRequestSummaryQuerySchema.parse({
      objectId: OBJ,
      requestType: 'freight_transport',
      status: 'new',
      num: 5,
    });
    expect(narrowed).toEqual({ objectId: OBJ, requestType: 'freight_transport' });

    expect(() => vehicleRequestSummaryQuerySchema.parse({ requestType: 'unknown' })).toThrow();
  });

  it('формат и разбор номера', () => {
    expect(formatVehicleRequestNumber(123)).toBe('ТС-123');
    expect(parseVehicleRequestNumberSearch('123')).toBe(123);
    expect(parseVehicleRequestNumberSearch('ТС-123')).toBe(123);
    expect(parseVehicleRequestNumberSearch('ТС-000123')).toBe(123);
    expect(parseVehicleRequestNumberSearch('  ')).toBeUndefined();
  });
});

describe('vehicle-requests: виза руководителя строительства (ADR 0025)', () => {
  it('визы требует только переход «в работу»', () => {
    expect(transitionRequiresApproval('confirmed')).toBe(true);
    // Отменить незавизированную заявку можно — иначе ей нечем закрыть путь.
    expect(transitionRequiresApproval('cancelled')).toBe(false);
    expect(transitionRequiresApproval('done')).toBe(false);
    expect(transitionRequiresApproval('new')).toBe(false);
  });

  it('без визы «в работу» не предлагается никому, отмена остаётся', () => {
    expect(allowedVehicleRequestTransitions('new', 'dispatcher', false)).toEqual(['cancelled']);
    expect(allowedVehicleRequestTransitions('new', 'dispatcher', true)).toEqual([
      'confirmed',
      'cancelled',
    ]);
    // Откат закрытой заявки — тоже переход в «В работе»: без визы его нет и у администратора.
    expect(allowedVehicleRequestTransitions('done', 'admin', false)).toEqual([]);
    expect(allowedVehicleRequestTransitions('done', 'admin', true)).toEqual(['confirmed']);
  });

  it('роль без права на статус визой ничего не приобретает', () => {
    expect(allowedVehicleRequestTransitions('new', 'rukstroy', true)).toEqual([]);
    expect(allowedVehicleRequestTransitions('new', 'shtab', true)).toEqual([]);
  });

  it('визу ставят и снимают, пока заявка «Новая»', () => {
    expect(isApprovalChangeable('new')).toBe(true);
    expect(isApprovalChangeable('confirmed')).toBe(false);
    expect(isApprovalChangeable('done')).toBe(false);
    expect(isApprovalChangeable('cancelled')).toBe(false);
  });

  it('в теле визы обязательны признак и версия, лишние поля отвергаются', () => {
    expect(setVehicleRequestApprovalSchema.parse({ approved: true, version: 3 })).toEqual({
      approved: true,
      version: 3,
    });
    expect(() => setVehicleRequestApprovalSchema.parse({ approved: true })).toThrow();
    expect(() => setVehicleRequestApprovalSchema.parse({ version: 1 })).toThrow();
    expect(() =>
      setVehicleRequestApprovalSchema.parse({ approved: true, version: 1, comment: 'ок' }),
    ).toThrow();
  });

  it('список сужается по наличию визы', () => {
    expect(vehicleRequestListQuerySchema.parse({ approved: 'false' }).approved).toBe(false);
    expect(vehicleRequestListQuerySchema.parse({ approved: 'true' }).approved).toBe(true);
    expect(vehicleRequestListQuerySchema.parse({}).approved).toBeUndefined();
    expect(() => vehicleRequestListQuerySchema.parse({ approved: 'maybe' })).toThrow();
  });
});
