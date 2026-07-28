import { describe, expect, it } from 'vitest';
import {
  changeWasteRequestStatusSchema,
  checkVehicleVolume,
  requiresWasteVehicles,
  sumVehicleVolume,
  updateWasteRequestSchema,
  type WasteRequestVehicleDto,
  wasteRequestVehicleInputSchema,
} from '@technic/contracts';

const TYPE_ID = '11111111-1111-4111-8111-111111111111';

const vehicle = (volumeM3: number, isDeleted = false): WasteRequestVehicleDto => ({
  id: '22222222-2222-4222-8222-222222222222',
  containerTypeId: TYPE_ID,
  containerTypeName: 'Самосвал 25 м³',
  volumeM3,
  files: [],
  isDeleted,
  createdAt: '2026-07-27T10:00:00.000Z',
});

describe('какие заявки отчитываются машинами', () => {
  it('только вывоз самосвалами — контейнерные операции закрываются без талонов', () => {
    expect(requiresWasteVehicles('waste_removal')).toBe(true);
    expect(requiresWasteVehicles('container_install')).toBe(false);
    expect(requiresWasteVehicles('container_replace')).toBe(false);
    expect(requiresWasteVehicles('container_removal')).toBe(false);
  });
});

describe('машина заявки', () => {
  it('требует только тип; талоны необязательны', () => {
    const parsed = wasteRequestVehicleInputSchema.parse({ containerTypeId: TYPE_ID });
    expect(parsed.fileIds).toEqual([]);
    expect(() => wasteRequestVehicleInputSchema.parse({})).toThrow();
  });

  it('объём с клиента не принимается — его берут из вместимости типа', () => {
    const parsed = wasteRequestVehicleInputSchema.parse({
      containerTypeId: TYPE_ID,
      volumeM3: 999,
    }) as Record<string, unknown>;
    expect(parsed.volumeM3).toBeUndefined();
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
});

// Талоны заявок без машин (ADR 0013): контейнерная операция — одна ходка, делить талоны не по
// чему, поэтому они крепятся к самой заявке. Какой из двух способов предъявления допустим для
// конкретной заявки, знает только сервер (он видит её тип) — схема разделяет их по времени.
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

  it('закрытие без талонов проходит — талон могут донести позже', () => {
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
  it('помеченные на удаление машины в сумму не входят', () => {
    expect(sumVehicleVolume([vehicle(25), vehicle(20), vehicle(8, true)])).toBe(45);
  });

  it('расхождение с заявкой считается, но не делает результат ошибкой', () => {
    const under = checkVehicleVolume(40, [vehicle(25)]);
    expect(under.diff).toBe(-15);
    expect(under.matches).toBe(false);
    expect(checkVehicleVolume(40, [vehicle(25), vehicle(15)]).matches).toBe(true);
  });

  it('у заявки без объёма (установка контейнера) сравнивать не с чем', () => {
    const check = checkVehicleVolume(null, [vehicle(25)]);
    expect(check.planned).toBeNull();
    expect(check.diff).toBeNull();
    expect(check.actual).toBe(25);
  });
});

describe('машины при редактировании заявки', () => {
  it('операции над машинами передаются отдельными списками', () => {
    const parsed = updateWasteRequestSchema.parse({
      version: 3,
      addVehicles: [{ containerTypeId: TYPE_ID }],
      markDeletedVehicleIds: ['33333333-3333-4333-8333-333333333333'],
      deleteVehicleIds: ['44444444-4444-4444-8444-444444444444'],
    });
    expect(parsed.addVehicles).toHaveLength(1);
    expect(parsed.markDeletedVehicleIds).toHaveLength(1);
    // Право на полное удаление проверяет сервер: схема сама роль не знает.
    expect(parsed.deleteVehicleIds).toHaveLength(1);
  });

  it('отсутствие полей означает «машины не трогать»', () => {
    const parsed = updateWasteRequestSchema.parse({ version: 1 });
    expect(parsed.addVehicles).toBeUndefined();
    expect(parsed.markDeletedVehicleIds).toBeUndefined();
  });
});
