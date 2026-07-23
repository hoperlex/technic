import { describe, expect, it } from 'vitest';
import {
  baseListQuery,
  canTransitionStatus,
  createWasteRequestSchema,
  requestStatusTransitions,
} from '@technic/contracts';

describe('статусы заявок', () => {
  it('разрешает корректные переходы', () => {
    expect(canTransitionStatus('new', 'confirmed')).toBe(true);
    expect(canTransitionStatus('new', 'cancelled')).toBe(true);
    expect(canTransitionStatus('confirmed', 'done')).toBe(true);
    expect(canTransitionStatus('confirmed', 'cancelled')).toBe(true);
  });

  it('«Отменена» неизменна, остальные переходят в любой статус', () => {
    // отменённую заявку нельзя переоткрыть
    expect(requestStatusTransitions.cancelled).toEqual([]);
    expect(canTransitionStatus('cancelled', 'new')).toBe(false);
    // из прочих статусов — в любой другой, в т.ч. с нарушением хронологии
    expect(canTransitionStatus('done', 'new')).toBe(true);
    expect(canTransitionStatus('new', 'done')).toBe(true);
    expect(canTransitionStatus('done', 'cancelled')).toBe(true);
  });
});

describe('baseListQuery', () => {
  const schema = baseListQuery(['createdAt', 'name']);

  it('дефолты страницы и размера', () => {
    const parsed = schema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(100);
  });

  it('допускает только 100/200/500', () => {
    expect(schema.parse({ pageSize: '200' }).pageSize).toBe(200);
    expect(() => schema.parse({ pageSize: '50' })).toThrow();
  });

  it('отклоняет поле сортировки вне allowlist', () => {
    expect(() => schema.parse({ sortBy: 'password' })).toThrow();
    expect(schema.parse({ sortBy: 'name' }).sortBy).toBe('name');
  });
});

describe('createWasteRequestSchema', () => {
  it('парсит корректную заявку и приводит дату', () => {
    const parsed = createWasteRequestSchema.parse({
      objectId: '11111111-1111-4111-8111-111111111111',
      containerTypeId: '22222222-2222-4222-8222-222222222222',
      requestType: 'container_install',
      deliveryAt: '2026-08-01T10:00:00.000Z',
    });
    expect(parsed.deliveryAt).toBeInstanceOf(Date);
    expect(parsed.comment).toBe('');
    expect(parsed.fileIds).toEqual([]);
  });

  it('требует валидный тип заявки', () => {
    expect(() =>
      createWasteRequestSchema.parse({
        objectId: '11111111-1111-1111-1111-111111111111',
        containerTypeId: '22222222-2222-2222-2222-222222222222',
        requestType: 'monthly',
        deliveryAt: '2026-08-01T10:00:00.000Z',
      }),
    ).toThrow();
  });

  it('замена требует containerTypeId', () => {
    expect(() =>
      createWasteRequestSchema.parse({
        objectId: '11111111-1111-4111-8111-111111111111',
        requestType: 'container_replace',
        deliveryAt: '2026-08-01T10:00:00.000Z',
      }),
    ).toThrow();
  });

  it('снятие требует containerTypeId', () => {
    expect(() =>
      createWasteRequestSchema.parse({
        objectId: '11111111-1111-4111-8111-111111111111',
        requestType: 'container_removal',
        deliveryAt: '2026-08-01T10:00:00.000Z',
      }),
    ).toThrow();
    const parsed = createWasteRequestSchema.parse({
      objectId: '11111111-1111-4111-8111-111111111111',
      requestType: 'container_removal',
      containerTypeId: '22222222-2222-4222-8222-222222222222',
      deliveryAt: '2026-08-01T10:00:00.000Z',
    });
    expect(parsed.requestType).toBe('container_removal');
  });

  it('вывоз требует тип машины и объём', () => {
    const ok = createWasteRequestSchema.parse({
      objectId: '11111111-1111-4111-8111-111111111111',
      requestType: 'waste_removal',
      containerTypeId: '22222222-2222-4222-8222-222222222222',
      volumeM3: 20,
      deliveryAt: '2026-08-01T10:00:00.000Z',
    });
    expect(ok.volumeM3).toBe(20);
    expect(() =>
      createWasteRequestSchema.parse({
        objectId: '11111111-1111-4111-8111-111111111111',
        requestType: 'waste_removal',
        containerTypeId: '22222222-2222-4222-8222-222222222222',
        deliveryAt: '2026-08-01T10:00:00.000Z',
      }),
    ).toThrow();
  });
});
