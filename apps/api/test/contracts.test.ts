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

  it('запрещает переходы из терминальных статусов', () => {
    expect(requestStatusTransitions.done).toEqual([]);
    expect(requestStatusTransitions.cancelled).toEqual([]);
    expect(canTransitionStatus('done', 'new')).toBe(false);
    expect(canTransitionStatus('new', 'done')).toBe(false);
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
      requestType: 'onetime',
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
});
