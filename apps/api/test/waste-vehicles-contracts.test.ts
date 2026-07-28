import { describe, expect, it } from 'vitest';
import {
  changeWasteRequestStatusSchema,
  checkVehicleVolume,
  type FileDto,
  requiresWasteVehicles,
  sumVehicleVolume,
  updateWasteRequestSchema,
  type WasteRequestVehicleDto,
  wasteRequestVehicleInputSchema,
  vehiclesWithoutTickets,
} from '@technic/contracts';

const TYPE_ID = '11111111-1111-4111-8111-111111111111';
const VEHICLE_ID = '22222222-2222-4222-8222-222222222222';
const FILE_ID_A = '77777777-7777-4777-8777-777777777777';

const ticket = (id: string): FileDto => ({
  id,
  filename: 'Талон.pdf',
  contentType: 'application/pdf',
  size: 1024,
  status: 'active',
  createdAt: '2026-07-27T10:00:00.000Z',
});

const vehicle = (
  volumeM3: number,
  isDeleted = false,
  files: FileDto[] = [],
): WasteRequestVehicleDto => ({
  id: VEHICLE_ID,
  containerTypeId: TYPE_ID,
  containerTypeName: 'Самосвал 25 м³',
  volumeM3,
  files,
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
  // Талон обязателен к моменту закрытия (ADR 0020), но проверяет это сервер: машину заводят и
  // до закрытия — правкой заявки, которую ещё выполняют, и там бумаги на руках может не быть.
  it('требует только тип: обязательность талона схема не решает', () => {
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

  // Талон обязателен (ADR 0020), но требует его сервер: он считает не тело запроса, а состояние
  // заявки — бумага могла прийти ещё с прошлым закрытием, и просить её второй раз незачем.
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

// Догрузка талонов к машинам прошлого закрытия (ADR 0020): после отката администратором машины
// у заявки уже есть, и талон к ним прикладывается по id — заводить рейс заново незачем.
describe('талоны уже заведённых машин', () => {
  const FILE_ID = '55555555-5555-4555-8555-555555555555';
  const OTHER_FILE_ID = '66666666-6666-4666-8666-666666666666';

  it('принимаются только при закрытии заявки', () => {
    const vehicleTickets = [{ vehicleId: VEHICLE_ID, fileIds: [FILE_ID] }];
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'done', version: 1, vehicleTickets }),
    ).not.toThrow();
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'confirmed', version: 1, vehicleTickets }),
    ).toThrow();
  });

  it('запись без файлов бессмысленна — машину без талона так не «подтвердить»', () => {
    expect(() =>
      changeWasteRequestStatusSchema.parse({
        status: 'done',
        version: 1,
        vehicleTickets: [{ vehicleId: VEHICLE_ID, fileIds: [] }],
      }),
    ).toThrow();
  });

  it('одна машина — одна запись: лимит талонов иначе считался бы по частям', () => {
    expect(() =>
      changeWasteRequestStatusSchema.parse({
        status: 'done',
        version: 1,
        vehicleTickets: [
          { vehicleId: VEHICLE_ID, fileIds: [FILE_ID] },
          { vehicleId: VEHICLE_ID, fileIds: [OTHER_FILE_ID] },
        ],
      }),
    ).toThrow();
  });
});

describe('машины без талона', () => {
  it('видны все активные без единого талона — с ними заявку не закрыть', () => {
    const missing = vehiclesWithoutTickets([
      vehicle(25, false, [ticket(FILE_ID_A)]),
      vehicle(20),
      vehicle(8, true),
    ]);
    expect(missing).toHaveLength(1);
    expect(missing[0]!.volumeM3).toBe(20);
  });

  it('помеченная на удаление машина талона не требует — она вне факта вывоза', () => {
    expect(vehiclesWithoutTickets([vehicle(8, true)])).toEqual([]);
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
