import { describe, expect, it } from 'vitest';
import type { FreightTransportRequestDto, SpecialEquipmentRequestDto } from '@technic/contracts';
import { diffVehicleRequests } from '../src/services/vehicle-request-diff';

// Дифф правки заявки на технику — то, из чего складывается история в карточке (ADR 0015).

const BASE = {
  id: '11111111-1111-4111-8111-111111111111',
  num: 7,
  displayNumber: 'ТС-000007',
  objectId: '22222222-2222-4222-8222-222222222222',
  objectCode: 'ОБ-1',
  objectName: 'Жилой комплекс',
  vehicleTypeId: '33333333-3333-4333-8333-333333333333',
  vehicleTypeName: 'Экскаватор',
  status: 'new' as const,
  comment: 'Заезд со двора',
  cancelReason: null,
  files: [],
  version: 1,
  createdBy: '55555555-5555-4555-8555-555555555555',
  createdByName: 'Иванов И. И.',
  createdAt: '2026-07-28T09:00:00.000Z',
  updatedAt: '2026-07-28T09:00:00.000Z',
  deletedAt: null,
};

const SPECIAL: SpecialEquipmentRequestDto = {
  ...BASE,
  requestType: 'special_equipment',
  dateFrom: '2026-08-01',
  dateTo: null,
};

const FREIGHT: FreightTransportRequestDto = {
  ...BASE,
  requestType: 'freight_transport',
  vehicleTypeName: 'Тентованный',
  scheduledAt: '2026-08-01T07:00:00.000Z',
  scheduledTimeUnspecified: false,
  volumeM3: 20,
  weightTons: null,
  loadingLocation: 'г Москва, ул Тверская, д 1',
  unloadingLocation: 'г Москва, ул Арбат, д 2',
  loadingAddress: { source: 'resolved', fiasId: 'a1' },
  unloadingAddress: { source: 'resolved', fiasId: 'a2' },
};

const file = (id: string, filename: string) => ({
  id,
  filename,
  contentType: 'application/pdf',
  size: 1024,
  status: 'active' as const,
  createdAt: '2026-07-28T10:00:00.000Z',
});

describe('дифф правки заявки на технику', () => {
  it('без изменений — пустой список', () => {
    expect(diffVehicleRequests(SPECIAL, { ...SPECIAL, version: 2 })).toEqual([]);
    expect(diffVehicleRequests(FREIGHT, { ...FREIGHT, version: 2 })).toEqual([]);
  });

  it('объект и тип ТС показываются названиями, а не идентификаторами', () => {
    const changes = diffVehicleRequests(SPECIAL, {
      ...SPECIAL,
      objectCode: 'ОБ-2',
      objectName: 'Школа',
      vehicleTypeId: 'x',
      vehicleTypeName: 'Автокран',
    });
    expect(changes).toContainEqual({
      field: 'object',
      from: 'ОБ-1 — Жилой комплекс',
      to: 'ОБ-2 — Школа',
    });
    expect(changes).toContainEqual({
      field: 'vehicleType',
      from: 'Экскаватор',
      to: 'Автокран',
    });
  });

  it('период спецтехники — датами без времени, снятая дата окончания читается как «—»', () => {
    const withEnd = { ...SPECIAL, dateTo: '2026-08-05' };
    expect(diffVehicleRequests(SPECIAL, withEnd)).toContainEqual({
      field: 'dateTo',
      from: '—',
      to: '05.08.2026',
    });
    expect(diffVehicleRequests(withEnd, SPECIAL)).toContainEqual({
      field: 'dateTo',
      from: '05.08.2026',
      to: '—',
    });
    expect(diffVehicleRequests(SPECIAL, { ...SPECIAL, dateFrom: '2026-08-02' })).toContainEqual({
      field: 'dateFrom',
      from: '01.08.2026',
      to: '02.08.2026',
    });
  });

  it('подача грузоперевозки — в МСК, а «время не задано» показывает только дату', () => {
    expect(
      diffVehicleRequests(FREIGHT, { ...FREIGHT, scheduledAt: '2026-08-02T11:30:00.000Z' }),
    ).toContainEqual({ field: 'scheduledAt', from: '01.08.2026 10:00', to: '02.08.2026 14:30' });
    expect(
      diffVehicleRequests(FREIGHT, { ...FREIGHT, scheduledTimeUnspecified: true }),
    ).toContainEqual({ field: 'scheduledAt', from: '01.08.2026 10:00', to: '01.08.2026' });
  });

  it('объём, масса и адреса грузоперевозки', () => {
    const changes = diffVehicleRequests(FREIGHT, {
      ...FREIGHT,
      volumeM3: null,
      weightTons: 12,
      unloadingLocation: 'г Москва, ул Полянка, д 3',
    });
    expect(changes).toContainEqual({ field: 'volumeM3', from: '20 м³', to: '—' });
    expect(changes).toContainEqual({ field: 'weightTons', from: '—', to: '12 т' });
    expect(changes).toContainEqual({
      field: 'unloadingLocation',
      from: 'г Москва, ул Арбат, д 2',
      to: 'г Москва, ул Полянка, д 3',
    });
    // Адрес погрузки не трогали — события о нём быть не должно.
    expect(changes.some((c) => c.field === 'loadingLocation')).toBe(false);
  });

  it('длинный комментарий обрезается', () => {
    const change = diffVehicleRequests(SPECIAL, { ...SPECIAL, comment: 'а'.repeat(400) }).find(
      (c) => c.field === 'comment',
    );
    expect(change?.to).toHaveLength(301);
    expect(change?.to?.endsWith('…')).toBe(true);
  });

  it('файлы сравниваются по составу, а не по количеству', () => {
    const changes = diffVehicleRequests(
      { ...SPECIAL, files: [file('f1', 'заявка.pdf')] },
      { ...SPECIAL, files: [file('f2', 'путевой.pdf')] },
    );
    expect(changes).toContainEqual({ field: 'filesAdded', from: null, to: 'путевой.pdf' });
    expect(changes).toContainEqual({ field: 'filesRemoved', from: null, to: 'заявка.pdf' });
  });
});
