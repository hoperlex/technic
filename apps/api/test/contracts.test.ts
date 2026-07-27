import { describe, expect, it } from 'vitest';
import {
  allowedStatusTransitions,
  baseListQuery,
  canTransitionStatus,
  changeWasteRequestStatusSchema,
  createWasteRequestSchema,
  requestStatusTransitions,
} from '@technic/contracts';

describe('статусы заявок', () => {
  it('линейный цикл доступен ролям, ведущим заявки', () => {
    expect(canTransitionStatus('new', 'confirmed', 'dispatcher')).toBe(true);
    expect(canTransitionStatus('confirmed', 'done', 'dispatcher')).toBe(true);
    expect(canTransitionStatus('new', 'cancelled', 'dispatcher')).toBe(true);
    expect(canTransitionStatus('confirmed', 'cancelled', 'manager')).toBe(true);
  });

  it('хронологию нарушать нельзя, закрытые статусы терминальны', () => {
    expect(canTransitionStatus('new', 'done', 'dispatcher')).toBe(false);
    expect(canTransitionStatus('confirmed', 'new', 'manager')).toBe(false);
    expect(requestStatusTransitions.done).toEqual([]);
    expect(requestStatusTransitions.cancelled).toEqual([]);
  });

  it('откат закрытой заявки — только администратору', () => {
    expect(canTransitionStatus('done', 'confirmed', 'admin')).toBe(true);
    expect(canTransitionStatus('cancelled', 'new', 'admin')).toBe(true);
    expect(canTransitionStatus('done', 'confirmed', 'manager')).toBe(false);
    expect(canTransitionStatus('cancelled', 'new', 'dispatcher')).toBe(false);
  });

  it('роли без ведения заявок статусы не меняют', () => {
    expect(allowedStatusTransitions('new', 'shtab')).toEqual([]);
    expect(canTransitionStatus('new', 'confirmed', 'shtab')).toBe(false);
  });

  it('отмена требует причины, прочие переходы — нет', () => {
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'cancelled', version: 1 }),
    ).toThrow();
    // пробелы причиной не считаются (comment проходит trim)
    expect(() =>
      changeWasteRequestStatusSchema.parse({ status: 'cancelled', comment: '   ', version: 1 }),
    ).toThrow();
    expect(
      changeWasteRequestStatusSchema.parse({
        status: 'cancelled',
        comment: 'Объект закрыт',
        version: 1,
      }).comment,
    ).toBe('Объект закрыт');
    expect(changeWasteRequestStatusSchema.parse({ status: 'confirmed', version: 1 }).comment).toBe(
      '',
    );
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
    // Снятие тарифицируется (ADR 0009): кроме типа контейнера нужны тип мусора и объём.
    const parsed = createWasteRequestSchema.parse({
      objectId: '11111111-1111-4111-8111-111111111111',
      requestType: 'container_removal',
      containerTypeId: '22222222-2222-4222-8222-222222222222',
      wasteTypeId: '44444444-4444-4444-8444-444444444444',
      volumeM3: 8,
      deliveryAt: '2026-08-01T10:00:00.000Z',
    });
    expect(parsed.requestType).toBe('container_removal');
  });

  it('вывоз требует тип машины и объём', () => {
    const ok = createWasteRequestSchema.parse({
      objectId: '11111111-1111-4111-8111-111111111111',
      requestType: 'waste_removal',
      containerTypeId: '22222222-2222-4222-8222-222222222222',
      wasteTypeId: '44444444-4444-4444-8444-444444444444',
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
