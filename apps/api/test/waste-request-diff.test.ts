import { describe, expect, it } from 'vitest';
import type { WasteRequestDto, WasteRequestVehicleDto } from '@technic/contracts';
import { diffWasteRequests } from '../src/services/waste-request-diff';

// Дифф правки заявки — то, из чего складывается история в карточке (ADR 0012).

const BASE: WasteRequestDto = {
  id: '11111111-1111-4111-8111-111111111111',
  num: 42,
  objectId: '22222222-2222-4222-8222-222222222222',
  objectCode: 'ОБ-1',
  objectName: 'Жилой комплекс',
  requestType: 'waste_removal',
  containerTypeId: '33333333-3333-4333-8333-333333333333',
  containerTypeName: 'Самосвал 20 м³',
  wasteTypeId: '44444444-4444-4444-8444-444444444444',
  wasteTypeName: 'Строительный мусор',
  volumeM3: 20,
  pricePerM3: 900,
  amount: 18000,
  operatorCounterpartyId: null,
  operatorName: null,
  deliveryAt: '2026-08-01T07:00:00.000Z',
  deliveryTimeUnspecified: false,
  comment: 'Заезд со двора',
  status: 'new',
  cancelReason: null,
  files: [],
  vehicles: [],
  version: 1,
  createdBy: '55555555-5555-4555-8555-555555555555',
  createdByName: 'Иванов И. И.',
  createdAt: '2026-07-28T09:00:00.000Z',
  updatedAt: '2026-07-28T09:00:00.000Z',
  deletedAt: null,
};

const vehicle = (id: string, isDeleted = false): WasteRequestVehicleDto => ({
  id,
  containerTypeId: '33333333-3333-4333-8333-333333333333',
  containerTypeName: 'Самосвал 20 м³',
  volumeM3: 20,
  files: [],
  isDeleted,
  createdAt: '2026-07-28T10:00:00.000Z',
});

const file = (id: string, filename: string) => ({
  id,
  filename,
  contentType: 'application/pdf',
  size: 1024,
  status: 'active' as const,
  createdAt: '2026-07-28T10:00:00.000Z',
});

const byField = (changes: { field: string }[]) => changes.map((c) => c.field);

describe('дифф правки заявки', () => {
  it('без изменений — пустой список', () => {
    expect(diffWasteRequests(BASE, { ...BASE, version: 2 })).toEqual([]);
  });

  it('объём и пересчитанная сумма показываются готовым текстом', () => {
    const changes = diffWasteRequests(BASE, {
      ...BASE,
      volumeM3: 40,
      amount: 36000,
    });
    expect(changes).toContainEqual({ field: 'volumeM3', from: '20 м³', to: '40 м³' });
    const amount = changes.find((c) => c.field === 'amount');
    // Пробел в «18 000,00 ₽» — неразрывный (ru-RU), поэтому сверяем по цифрам и знаку.
    expect(amount?.from).toMatch(/^18.000,00 ₽$/);
    expect(amount?.to).toMatch(/^36.000,00 ₽$/);
  });

  it('дата доставки — в МСК, а «время не задано» показывает только дату', () => {
    const withTime = diffWasteRequests(BASE, {
      ...BASE,
      deliveryAt: '2026-08-02T11:30:00.000Z',
    });
    expect(withTime).toContainEqual({
      field: 'deliveryAt',
      from: '01.08.2026 10:00',
      to: '02.08.2026 14:30',
    });
    const withoutTime = diffWasteRequests(BASE, { ...BASE, deliveryTimeUnspecified: true });
    expect(withoutTime).toContainEqual({
      field: 'deliveryAt',
      from: '01.08.2026 10:00',
      to: '01.08.2026',
    });
  });

  it('снятый оператор и пустой комментарий читаются как «—»', () => {
    const assigned = { ...BASE, operatorCounterpartyId: 'x', operatorName: 'ООО «Вывоз»' };
    expect(diffWasteRequests(assigned, { ...assigned, operatorName: null })).toContainEqual({
      field: 'operator',
      from: 'ООО «Вывоз»',
      to: '—',
    });
    expect(diffWasteRequests(BASE, { ...BASE, comment: '' })).toContainEqual({
      field: 'comment',
      from: 'Заезд со двора',
      to: '—',
    });
  });

  it('длинный комментарий обрезается', () => {
    const long = 'а'.repeat(400);
    const change = diffWasteRequests(BASE, { ...BASE, comment: long }).find(
      (c) => c.field === 'comment',
    );
    expect(change?.to).toHaveLength(301);
    expect(change?.to?.endsWith('…')).toBe(true);
  });

  it('файлы сравниваются по составу, а не по количеству', () => {
    const before = { ...BASE, files: [file('f1', 'акт.pdf')] };
    const after = { ...BASE, files: [file('f2', 'талон.pdf')] };
    const changes = diffWasteRequests(before, after);
    expect(changes).toContainEqual({ field: 'filesAdded', from: null, to: 'талон.pdf' });
    expect(changes).toContainEqual({ field: 'filesRemoved', from: null, to: 'акт.pdf' });
  });

  it('машины: добавление, пометка, возврат и удаление насовсем — разные события', () => {
    const before = {
      ...BASE,
      vehicles: [vehicle('v1'), vehicle('v2', true), vehicle('v3')],
    };
    const after = {
      ...BASE,
      vehicles: [vehicle('v1', true), vehicle('v2'), vehicle('v4')],
    };
    expect(byField(diffWasteRequests(before, after))).toEqual([
      'vehiclesAdded',
      'vehiclesMarkedDeleted',
      'vehiclesRestored',
      'vehiclesRemoved',
    ]);
  });
});
