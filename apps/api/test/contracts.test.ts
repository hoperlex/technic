import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  allowedStatusTransitions,
  baseListQuery,
  canTransitionStatus,
  changeWasteRequestStatusSchema,
  createWasteRequestSchema,
  fileDownloadQuerySchema,
  isInlineViewable,
  requestStatusTransitions,
} from '@technic/contracts';

describe('статусы заявок', () => {
  it('линейный цикл доступен ролям, ведущим заявки', () => {
    expect(canTransitionStatus('new', 'confirmed', { role: 'dispatcher' })).toBe(true);
    expect(canTransitionStatus('confirmed', 'done', { role: 'dispatcher' })).toBe(true);
    expect(canTransitionStatus('new', 'cancelled', { role: 'dispatcher' })).toBe(true);
    expect(canTransitionStatus('confirmed', 'cancelled', { role: 'manager' })).toBe(true);
  });

  it('хронологию нарушать нельзя, закрытые статусы терминальны', () => {
    expect(canTransitionStatus('new', 'done', { role: 'dispatcher' })).toBe(false);
    expect(canTransitionStatus('confirmed', 'new', { role: 'manager' })).toBe(false);
    expect(requestStatusTransitions.done).toEqual([]);
    expect(requestStatusTransitions.cancelled).toEqual([]);
  });

  it('откат закрытой заявки — только администратору', () => {
    expect(canTransitionStatus('done', 'confirmed', { role: 'admin' })).toBe(true);
    expect(canTransitionStatus('cancelled', 'new', { role: 'admin' })).toBe(true);
    expect(canTransitionStatus('done', 'confirmed', { role: 'manager' })).toBe(false);
    expect(canTransitionStatus('cancelled', 'new', { role: 'dispatcher' })).toBe(false);
  });

  it('роли без ведения заявок статусы не меняют', () => {
    expect(allowedStatusTransitions('new', { role: 'shtab' })).toEqual([]);
    expect(canTransitionStatus('new', 'confirmed', { role: 'shtab' })).toBe(false);
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

  it('допускает только 50/100/200/500', () => {
    expect(schema.parse({ pageSize: '50' }).pageSize).toBe(50);
    expect(schema.parse({ pageSize: '200' }).pageSize).toBe(200);
    expect(() => schema.parse({ pageSize: '25' })).toThrow();
  });

  it('отклоняет поле сортировки вне allowlist', () => {
    expect(() => schema.parse({ sortBy: 'password' })).toThrow();
    expect(schema.parse({ sortBy: 'name' }).sortBy).toBe('name');
  });
});

describe('createWasteRequestSchema', () => {
  // Создание проверяет минимальную дату (не раньше сегодня по МСК): без фиксации «сейчас»
  // фикстура с датой доставки протухла бы вместе с календарём.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-31T09:00:00.000Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

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
    // Снятие тарифицируется (ADR 0009): кроме типа контейнера нужен тип мусора. Объём не
    // передаётся — он равен вместимости контейнера и подставляется сервером.
    const parsed = createWasteRequestSchema.parse({
      objectId: '11111111-1111-4111-8111-111111111111',
      requestType: 'container_removal',
      containerTypeId: '22222222-2222-4222-8222-222222222222',
      wasteTypeId: '44444444-4444-4444-8444-444444444444',
      deliveryAt: '2026-08-01T10:00:00.000Z',
    });
    expect(parsed.requestType).toBe('container_removal');
  });

  it('вывоз требует тип мусора и объём, а техники не спрашивает (ADR 0022)', () => {
    const ok = createWasteRequestSchema.parse({
      objectId: '11111111-1111-4111-8111-111111111111',
      requestType: 'waste_removal',
      wasteTypeId: '44444444-4444-4444-8444-444444444444',
      volumeM3: 20,
      deliveryAt: '2026-08-01T10:00:00.000Z',
    });
    expect(ok.volumeM3).toBe(20);
    expect(ok.containerTypeId).toBeUndefined();
    expect(() =>
      createWasteRequestSchema.parse({
        objectId: '11111111-1111-4111-8111-111111111111',
        requestType: 'waste_removal',
        wasteTypeId: '44444444-4444-4444-8444-444444444444',
        deliveryAt: '2026-08-01T10:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('просмотр файлов во вкладке', () => {
  it('фото и PDF смотрят в браузере', () => {
    expect(isInlineViewable('image/jpeg')).toBe(true);
    expect(isInlineViewable('image/png')).toBe(true);
    expect(isInlineViewable('application/pdf')).toBe(true);
    // Заголовок из хранилища приходит с параметрами — разбор не должен на них спотыкаться.
    expect(isInlineViewable('TEXT/PLAIN; charset=utf-8')).toBe(true);
  });

  it('исполняемое и неизвестное уходит вложением', () => {
    // svg и html исполняют скрипты — открывать их на домене хранилища незачем.
    expect(isInlineViewable('image/svg+xml')).toBe(false);
    expect(isInlineViewable('text/html')).toBe(false);
    expect(isInlineViewable('application/octet-stream')).toBe(false);
    expect(isInlineViewable('')).toBe(false);
  });

  it('по умолчанию ссылка ведёт на скачивание', () => {
    expect(fileDownloadQuerySchema.parse({}).disposition).toBe('attachment');
    expect(fileDownloadQuerySchema.parse({ disposition: 'inline' }).disposition).toBe('inline');
    expect(() => fileDownloadQuerySchema.parse({ disposition: 'что-то' })).toThrow();
  });
});
