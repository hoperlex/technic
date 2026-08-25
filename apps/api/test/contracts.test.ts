import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  allowedStatusTransitions,
  baseListQuery,
  canTransitionStatus,
  changeWasteRequestStatusSchema,
  createWasteRequestSchema,
  fileDownloadQuerySchema,
  formatWasteRequestNumber,
  isInlineViewable,
  parseWasteRequestNumberSearch,
  REQUEST_MODULES,
  REQUEST_STATUSES,
  requestStatusTransitions,
  statusChangeRequiresReason,
  transitionResetsWork,
} from '@technic/contracts';

describe('статусы заявок', () => {
  it('линейный цикл доступен ролям, ведущим заявки', () => {
    expect(canTransitionStatus('new', 'confirmed', { role: 'dispatcher' }, 'waste')).toBe(true);
    expect(canTransitionStatus('confirmed', 'done', { role: 'dispatcher' }, 'waste')).toBe(true);
    expect(canTransitionStatus('new', 'cancelled', { role: 'dispatcher' }, 'waste')).toBe(true);
    expect(canTransitionStatus('confirmed', 'cancelled', { role: 'manager' }, 'vehicle')).toBe(
      true,
    );
  });

  it('хронологию нарушать нельзя, закрытые статусы терминальны', () => {
    expect(canTransitionStatus('new', 'done', { role: 'dispatcher' }, 'waste')).toBe(false);
    // Назад заявку двигает только откат, и он приходит правом, а не рабочим циклом: у менеджера
    // права нет, поэтому «В работе» → «Новая» для него закрыто по-прежнему.
    expect(canTransitionStatus('confirmed', 'new', { role: 'manager' }, 'waste')).toBe(false);
    for (const module of REQUEST_MODULES) {
      expect(requestStatusTransitions[module].confirmed).not.toContain('new');
      expect(requestStatusTransitions[module].completed).toEqual([]);
      expect(requestStatusTransitions[module].cancelled).toEqual([]);
    }
    // «Выполнена» терминальна только у техники: у вывоза за ней идёт разбор бумаги (ADR 0135).
    expect(requestStatusTransitions.vehicle.done).toEqual([]);
    expect(requestStatusTransitions.waste.done).toEqual(['completed']);
  });

  it('откат — администратору и диспетчеру, и снятие заявки с работы тоже', () => {
    expect(canTransitionStatus('done', 'confirmed', { role: 'admin' }, 'waste')).toBe(true);
    expect(canTransitionStatus('cancelled', 'new', { role: 'admin' }, 'waste')).toBe(true);
    expect(canTransitionStatus('confirmed', 'new', { role: 'admin' }, 'waste')).toBe(true);
    // Завершённая заявка вывоза откатывается в «Выполнена» — разбор бумаги открывается заново.
    expect(canTransitionStatus('completed', 'done', { role: 'admin' }, 'waste')).toBe(true);
    // Диспетчеру откат отдан вместе с коррекцией: чинит тот, кому звонят. Менеджер, у которого
    // прав на заявку не меньше, назад её не двигает — откат приходит правом, а не должностью.
    expect(canTransitionStatus('done', 'confirmed', { role: 'dispatcher' }, 'waste')).toBe(true);
    expect(canTransitionStatus('cancelled', 'new', { role: 'dispatcher' }, 'waste')).toBe(true);
    expect(canTransitionStatus('confirmed', 'new', { role: 'dispatcher' }, 'waste')).toBe(true);
    expect(canTransitionStatus('done', 'confirmed', { role: 'manager' }, 'waste')).toBe(false);
    expect(canTransitionStatus('cancelled', 'new', { role: 'manager' }, 'waste')).toBe(false);
  });

  /**
   * «Стирает работу» — про сброс назначенной техники, факта, рейса и визы, и переход с таким
   * последствием ровно один. Перебором всех пар, а не парой проверок: второй такой переход,
   * заведённый по недосмотру, обязан уронить проверку, а не тихо очистить чужую заявку.
   */
  it('работу стирает единственный переход — возврат «В работе» → «Новая»', () => {
    const resetting = REQUEST_STATUSES.flatMap((from) =>
      REQUEST_STATUSES.filter((to) => transitionResetsWork(from, to)).map((to) => `${from}→${to}`),
    );
    expect(resetting).toEqual(['confirmed→new']);
  });

  it('причины требуют отмена и возврат в «Новую» из работы', () => {
    expect(statusChangeRequiresReason('cancelled')).toBe(true);
    expect(statusChangeRequiresReason('new', 'confirmed')).toBe(true);
    // Откат отменённой заявки ведёт в тот же статус, но ничего не стирает: объяснять нечего.
    expect(statusChangeRequiresReason('new', 'cancelled')).toBe(false);
    expect(statusChangeRequiresReason('confirmed', 'new')).toBe(false);
    expect(statusChangeRequiresReason('done', 'confirmed')).toBe(false);
  });

  /**
   * Причину при откате схема не спрашивает, и это не пробел: в теле запроса лежит только целевой
   * статус, а «стирает ли переход работу» решает пара «откуда → куда». Исходный статус знает
   * сервер — он и требует причину, поэтому проверка здесь фиксирует именно молчание схемы.
   */
  it('схема причину при откате не требует: исходного статуса она не знает', () => {
    expect(changeWasteRequestStatusSchema.parse({ status: 'new', version: 1 }).comment).toBe('');
    expect(statusChangeRequiresReason('new')).toBe(false);
  });

  it('роли без ведения заявок статусы не меняют', () => {
    expect(allowedStatusTransitions('new', { role: 'shtab' }, 'waste')).toEqual([]);
    expect(canTransitionStatus('new', 'confirmed', { role: 'shtab' }, 'waste')).toBe(false);
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
      responsibleName: 'Петров П. П.',
      responsiblePhone: '+7 926 000-00-01',
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
        responsibleName: 'Петров П. П.',
        responsiblePhone: '+7 926 000-00-01',
      }),
    ).toThrow();
  });

  it('замена требует containerTypeId', () => {
    expect(() =>
      createWasteRequestSchema.parse({
        objectId: '11111111-1111-4111-8111-111111111111',
        requestType: 'container_replace',
        deliveryAt: '2026-08-01T10:00:00.000Z',
        responsibleName: 'Петров П. П.',
        responsiblePhone: '+7 926 000-00-01',
      }),
    ).toThrow();
  });

  it('снятие требует containerTypeId', () => {
    expect(() =>
      createWasteRequestSchema.parse({
        objectId: '11111111-1111-4111-8111-111111111111',
        requestType: 'container_removal',
        deliveryAt: '2026-08-01T10:00:00.000Z',
        responsibleName: 'Петров П. П.',
        responsiblePhone: '+7 926 000-00-01',
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
      responsibleName: 'Петров П. П.',
      responsiblePhone: '+7 926 000-00-01',
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
      responsibleName: 'Петров П. П.',
      responsiblePhone: '+7 926 000-00-01',
    });
    expect(ok.volumeM3).toBe(20);
    expect(ok.containerTypeId).toBeUndefined();
    expect(() =>
      createWasteRequestSchema.parse({
        objectId: '11111111-1111-4111-8111-111111111111',
        requestType: 'waste_removal',
        wasteTypeId: '44444444-4444-4444-8444-444444444444',
        deliveryAt: '2026-08-01T10:00:00.000Z',
        responsibleName: 'Петров П. П.',
        responsiblePhone: '+7 926 000-00-01',
      }),
    ).toThrow();
  });

  // Контакт ответственного (миграция 0062): оператор приезжает к человеку, а не к адресу.
  it('требует ответственного и телефон', () => {
    const base = {
      objectId: '11111111-1111-4111-8111-111111111111',
      requestType: 'waste_removal' as const,
      wasteTypeId: '44444444-4444-4444-8444-444444444444',
      volumeM3: 20,
      deliveryAt: '2026-08-01T10:00:00.000Z',
      responsibleName: 'Петров П. П.',
      responsiblePhone: '+7 926 000-00-01',
    };
    expect(createWasteRequestSchema.parse(base).responsibleName).toBe('Петров П. П.');
    const { responsibleName: _n, ...noName } = base;
    const { responsiblePhone: _p, ...noPhone } = base;
    expect(() => createWasteRequestSchema.parse(noName)).toThrow();
    expect(() => createWasteRequestSchema.parse(noPhone)).toThrow();
    expect(() => createWasteRequestSchema.parse({ ...base, responsiblePhone: '123' })).toThrow();
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

describe('номер заявки на мусор', () => {
  it('новые заявки нумеруются с префиксом «М-»', () => {
    expect(formatWasteRequestNumber(128, 'waste_removal', false)).toBe('М-128');
    // Префикс не зависит от типа: буква типа из номера ушла, тип стоит отдельной колонкой.
    expect(formatWasteRequestNumber(1, 'container_install', false)).toBe('М-1');
  });

  it('заведённые до префикса показываются прежним номером', () => {
    expect(formatWasteRequestNumber(128, 'waste_removal', true)).toBe('128-ВМ');
    expect(formatWasteRequestNumber(128, 'container_install', true)).toBe('128-У');
    expect(formatWasteRequestNumber(128, 'container_removal', true)).toBe('128-Сн');
  });

  it('поиск понимает оба формата и мусор во вводе', () => {
    expect(parseWasteRequestNumberSearch('М-128')).toBe(128);
    expect(parseWasteRequestNumberSearch('128-ВМ')).toBe(128);
    expect(parseWasteRequestNumberSearch(' 128 ')).toBe(128);
    expect(parseWasteRequestNumberSearch('М-')).toBeUndefined();
    expect(parseWasteRequestNumberSearch('')).toBeUndefined();
  });
});
