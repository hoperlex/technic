import { describe, expect, it } from 'vitest';
import {
  changeWasteRequestStatusSchema,
  checkVehicleVolume,
  requiresWasteVehicles,
  sumVehicleAmount,
  sumVehicleVolume,
  updateWasteRequestSchema,
  vehicleVolume,
  type WasteRequestVehicleDto,
  wasteRequestVehicleInputSchema,
} from '@technic/contracts';

const TYPE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TYPE_ID = '99999999-9999-4999-8999-999999999999';
const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_VEHICLE_ID = '88888888-8888-4888-8888-888888888888';

/** Строка факта: тип, вместимость одной машины, количество и снимок цены (ADR 0024). */
const vehicle = (
  volumeM3: number,
  count = 1,
  opts: { isDeleted?: boolean; pricePerM3?: number | null; id?: string } = {},
): WasteRequestVehicleDto => {
  const pricePerM3 = opts.pricePerM3 === undefined ? 850 : opts.pricePerM3;
  return {
    id: opts.id ?? VEHICLE_ID,
    containerTypeId: TYPE_ID,
    containerTypeName: 'Самосвал 25 м³',
    containerKind: 'truck',
    volumeM3,
    count,
    pricePerM3,
    // Сумму строки считает БД; в DTO она приходит уже посчитанной.
    amount: pricePerM3 == null ? null : Math.round(volumeM3 * count * pricePerM3 * 100) / 100,
    isDeleted: opts.isDeleted ?? false,
    createdAt: '2026-07-27T10:00:00.000Z',
  };
};

describe('какие заявки отчитываются машинами', () => {
  it('только вывоз мусора — контейнерные операции закрываются одним талоном', () => {
    expect(requiresWasteVehicles('waste_removal')).toBe(true);
    expect(requiresWasteVehicles('container_install')).toBe(false);
    expect(requiresWasteVehicles('container_replace')).toBe(false);
    expect(requiresWasteVehicles('container_removal')).toBe(false);
  });
});

describe('строка факта вывоза', () => {
  it('требует тип; количество по умолчанию — одна машина', () => {
    const parsed = wasteRequestVehicleInputSchema.parse({ containerTypeId: TYPE_ID });
    expect(parsed.count).toBe(1);
    expect(() => wasteRequestVehicleInputSchema.parse({})).toThrow();
  });

  it('количество — целое и не меньше одной машины', () => {
    expect(wasteRequestVehicleInputSchema.parse({ containerTypeId: TYPE_ID, count: 3 }).count).toBe(
      3,
    );
    expect(() =>
      wasteRequestVehicleInputSchema.parse({ containerTypeId: TYPE_ID, count: 0 }),
    ).toThrow();
    expect(() =>
      wasteRequestVehicleInputSchema.parse({ containerTypeId: TYPE_ID, count: 1.5 }),
    ).toThrow();
  });

  it('объём с клиента не принимается — его берут из вместимости типа', () => {
    const parsed = wasteRequestVehicleInputSchema.parse({
      containerTypeId: TYPE_ID,
      volumeM3: 999,
    }) as Record<string, unknown>;
    expect(parsed.volumeM3).toBeUndefined();
  });

  it('объём строки — вместимость × количество', () => {
    expect(vehicleVolume({ volumeM3: 25, count: 2 })).toBe(50);
  });
});

describe('машины при смене статуса', () => {
  it('принимаются только при закрытии заявки', () => {
    const vehicles = [{ containerTypeId: TYPE_ID }];
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'done', version: 1, vehicles }),
    ).not.toThrow();
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'confirmed', version: 1, vehicles }),
    ).toThrow();
  });

  it('закрытие без машин схемой не запрещено — их наличие проверяет сервер по заявке', () => {
    expect(changeWasteRequestStatusSchema.parse({ status: 'done', version: 1 }).vehicles).toEqual(
      [],
    );
  });

  // Один тип — одна строка (ADR 0024): две строки того же типа сложились бы в расчёте как
  // разные машины и вернули бы перечень рейсов, от которого уходим.
  it('один тип дважды не передаётся — это одна строка с количеством', () => {
    expect(() =>
      changeWasteRequestStatusSchema.parse({
        status: 'done',
        version: 1,
        vehicles: [{ containerTypeId: TYPE_ID }, { containerTypeId: TYPE_ID, count: 2 }],
      }),
    ).toThrow();
    expect(() =>
      changeWasteRequestStatusSchema.parse({
        status: 'done',
        version: 1,
        vehicles: [{ containerTypeId: TYPE_ID }, { containerTypeId: OTHER_TYPE_ID }],
      }),
    ).not.toThrow();
  });
});

// Количество у машин прошлого закрытия правится, а не дублируется новой строкой (ADR 0024).
describe('количество заведённых машин', () => {
  it('принимается только при закрытии заявки', () => {
    const vehicleCounts = [{ vehicleId: VEHICLE_ID, count: 2 }];
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'done', version: 1, vehicleCounts }),
    ).not.toThrow();
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'confirmed', version: 1, vehicleCounts }),
    ).toThrow();
  });

  it('одна машина — одна запись: два значения разошлись бы молча', () => {
    expect(() =>
      changeWasteRequestStatusSchema.parse({
        status: 'done',
        version: 1,
        vehicleCounts: [
          { vehicleId: VEHICLE_ID, count: 2 },
          { vehicleId: VEHICLE_ID, count: 3 },
        ],
      }),
    ).toThrow();
  });
});

// Талоны — общий пул заявки у любого типа (ADR 0024). Обязательность считает сервер: он видит
// состояние заявки, а бумага могла прийти ещё с прошлым закрытием.
describe('талоны заявки при смене статуса', () => {
  const FILE_ID = '55555555-5555-4555-8555-555555555555';

  it('принимаются только при закрытии заявки', () => {
    const ticketFileIds = [FILE_ID];
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'done', version: 1, ticketFileIds }),
    ).not.toThrow();
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'confirmed', version: 1, ticketFileIds }),
    ).toThrow();
  });

  it('пустой список схема пропускает — обязательность талона считает сервер', () => {
    expect(
      changeWasteRequestStatusSchema.parse({ status: 'done', version: 1 }).ticketFileIds,
    ).toEqual([]);
  });

  it('комментарий к выполнению необязателен и уходит в историю', () => {
    const parsed = changeWasteRequestStatusSchema.parse({
      status: 'done',
      version: 1,
      comment: '  вывезли не полностью  ',
    });
    expect(parsed.comment).toBe('вывезли не полностью');
    expect(changeWasteRequestStatusSchema.parse({ status: 'done', version: 1 }).comment).toBe('');
  });
});

describe('сверка объёма', () => {
  it('количество учитывается, помеченные на удаление в сумму не входят', () => {
    expect(
      sumVehicleVolume([
        vehicle(25, 2),
        vehicle(20),
        vehicle(8, 1, { isDeleted: true, id: OTHER_VEHICLE_ID }),
      ]),
    ).toBe(70);
  });

  it('расхождение с заявкой считается, но не делает результат ошибкой', () => {
    const under = checkVehicleVolume(40, [vehicle(25)]);
    expect(under.diff).toBe(-15);
    expect(under.matches).toBe(false);
    expect(checkVehicleVolume(40, [vehicle(20, 2)]).matches).toBe(true);
  });

  it('у заявки без объёма (установка контейнера) сравнивать не с чем', () => {
    const check = checkVehicleVolume(null, [vehicle(25)]);
    expect(check.planned).toBeNull();
    expect(check.diff).toBeNull();
    expect(check.actual).toBe(25);
  });
});

// Сумма по факту (ADR 0024) и есть стоимость закрытой заявки: считается по снимкам цен в строках.
describe('стоимость по факту', () => {
  it('складывает активные строки', () => {
    expect(
      sumVehicleAmount([
        vehicle(25, 2), // 50 м³ × 850 = 42 500
        vehicle(8, 1, { pricePerM3: 1875, id: OTHER_VEHICLE_ID }), // 8 м³ × 1875 = 15 000
      ]),
    ).toBe(57_500);
  });

  it('помеченная на удаление строка в сумму не входит', () => {
    expect(sumVehicleAmount([vehicle(25), vehicle(20, 1, { isDeleted: true })])).toBe(21_250);
  });

  // Строки заявок, закрытых до ADR 0024, снимка цены не несут: неполная сумма выглядела бы как
  // полная, поэтому её не показывают вовсе.
  it('строка без цены обнуляет весь итог', () => {
    expect(sumVehicleAmount([vehicle(25), vehicle(20, 1, { pricePerM3: null })])).toBeNull();
    expect(sumVehicleAmount([])).toBeNull();
  });
});

describe('машины при редактировании заявки', () => {
  it('операции над машинами передаются отдельными списками', () => {
    const parsed = updateWasteRequestSchema.parse({
      version: 3,
      addVehicles: [{ containerTypeId: TYPE_ID, count: 2 }],
      vehicleCounts: [{ vehicleId: VEHICLE_ID, count: 4 }],
      markDeletedVehicleIds: ['33333333-3333-4333-8333-333333333333'],
      deleteVehicleIds: ['44444444-4444-4444-8444-444444444444'],
    });
    expect(parsed.addVehicles).toHaveLength(1);
    expect(parsed.addVehicles![0]!.count).toBe(2);
    expect(parsed.vehicleCounts).toHaveLength(1);
    expect(parsed.markDeletedVehicleIds).toHaveLength(1);
    // Право на полное удаление проверяет сервер: схема сама роль не знает.
    expect(parsed.deleteVehicleIds).toHaveLength(1);
  });

  it('отсутствие полей означает «машины не трогать»', () => {
    const parsed = updateWasteRequestSchema.parse({ version: 1 });
    expect(parsed.addVehicles).toBeUndefined();
    expect(parsed.vehicleCounts).toBeUndefined();
    expect(parsed.markDeletedVehicleIds).toBeUndefined();
  });
});
