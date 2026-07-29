import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWasteRequestSchema,
  createVehicleRequestSchema,
  isAllowedRequestDate,
  isAllowedRequestDateAt,
  isWithinWorkTime,
  isWithinWorkTimeAt,
  minRequestDateKey,
  minutesToTime,
  moscowDateKeyOf,
  moscowTimeOf,
  normalizeTimeInput,
  timeToMinutes,
  updateVehicleRequestSchema,
  updateWasteRequestSchema,
} from '@technic/contracts';

// Создание заявки сверяет дату с текущим днём, а даты в фикстурах календарные — «сейчас»
// фиксируем на 27.07.2026 12:00 МСК: 27-е тогда сегодняшний день, 26-е — прошлое. Тесты самой
// границы переводят часы дальше (`at`), возврат к реальному времени делает общий afterEach.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-27T09:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('нормализация ручного ввода времени', () => {
  it('добивает нулями незаполненные знаки', () => {
    expect(normalizeTimeInput('7')).toBe('07:00');
    expect(normalizeTimeInput('07')).toBe('07:00');
    expect(normalizeTimeInput('21')).toBe('21:00');
    expect(normalizeTimeInput('730')).toBe('07:30');
    expect(normalizeTimeInput('0730')).toBe('07:30');
    expect(normalizeTimeInput('1945')).toBe('19:45');
  });

  it('уважает явный разделитель: «7:5» — это 07:05, а не 07:50', () => {
    expect(normalizeTimeInput('7:5')).toBe('07:05');
    expect(normalizeTimeInput('7:30')).toBe('07:30');
    expect(normalizeTimeInput('19:45')).toBe('19:45');
  });

  it('игнорирует посторонние символы и пробелы', () => {
    expect(normalizeTimeInput('  8  ')).toBe('08:00');
    expect(normalizeTimeInput('8.30')).toBe('08:30');
  });

  it('пустой ввод и несуществующее время не распознаются', () => {
    expect(normalizeTimeInput('')).toBeUndefined();
    expect(normalizeTimeInput('   ')).toBeUndefined();
    expect(normalizeTimeInput('25')).toBeUndefined();
    expect(normalizeTimeInput('0790')).toBeUndefined();
    expect(normalizeTimeInput('12345')).toBeUndefined();
  });

  it('полночь — валидное время суток (её несёт заявка без указанного времени)', () => {
    expect(normalizeTimeInput('0')).toBe('00:00');
    expect(normalizeTimeInput('00:00')).toBe('00:00');
  });
});

describe('минуты ↔ время', () => {
  it('преобразует в обе стороны', () => {
    expect(timeToMinutes('07:30')).toBe(450);
    expect(minutesToTime(450)).toBe('07:30');
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('23:59')).toBe(1439);
  });

  it('не разбирает ненормализованный ввод', () => {
    expect(timeToMinutes('7:30')).toBeUndefined();
    expect(timeToMinutes('24:00')).toBeUndefined();
  });
});

describe('рабочее окно 07:00–21:00', () => {
  it('включает границы', () => {
    expect(isWithinWorkTime('07:00')).toBe(true);
    expect(isWithinWorkTime('21:00')).toBe(true);
  });

  it('отсекает время вне окна', () => {
    expect(isWithinWorkTime('06:59')).toBe(false);
    expect(isWithinWorkTime('21:01')).toBe(false);
    expect(isWithinWorkTime('00:00')).toBe(false);
  });

  it('момент времени оценивается по МСК, а не по UTC', () => {
    // 05:00 UTC = 08:00 МСК — внутри окна, хотя по UTC это раннее утро.
    expect(moscowTimeOf(new Date('2026-07-28T05:00:00.000Z'))).toBe('08:00');
    expect(isWithinWorkTimeAt(new Date('2026-07-28T05:00:00.000Z'))).toBe(true);
    // 21:00 МСК = 18:00 UTC — граница включена.
    expect(isWithinWorkTimeAt(new Date('2026-07-28T18:00:00.000Z'))).toBe(true);
    // 22:00 МСК — уже вне окна.
    expect(isWithinWorkTimeAt(new Date('2026-07-28T19:00:00.000Z'))).toBe(false);
  });
});

describe('минимальная дата новой заявки — сегодня по МСК', () => {
  /** Переводит «сейчас» на указанный момент UTC (таймеры уже фиктивные — см. хуки файла). */
  const at = (utc: string) => vi.setSystemTime(new Date(utc));

  it('минимальная дата — текущий календарный день по МСК', () => {
    at('2026-07-28T09:00:00.000Z'); // 12:00 МСК 28-го
    expect(minRequestDateKey()).toBe('2026-07-28');
  });

  it('после 21:00 UTC в Москве уже следующие сутки — граница сдвигается вместе с ними', () => {
    // 23:30 МСК 28-го: по UTC ещё 28-е, и московское «сегодня» — тоже 28-е.
    at('2026-07-28T20:30:00.000Z');
    expect(moscowDateKeyOf(new Date())).toBe('2026-07-28');
    expect(minRequestDateKey()).toBe('2026-07-28');
    // 00:30 МСК 29-го (21:30 UTC 28-го) — сутки в Москве уже сменились, граница ушла на 29-е.
    at('2026-07-28T21:30:00.000Z');
    expect(moscowDateKeyOf(new Date())).toBe('2026-07-29');
    expect(minRequestDateKey()).toBe('2026-07-29');
  });

  it('прошлое не проходит, сегодня и позже — проходят', () => {
    at('2026-07-28T09:00:00.000Z');
    expect(isAllowedRequestDate('2026-07-26')).toBe(false);
    expect(isAllowedRequestDate('2026-07-27')).toBe(false);
    expect(isAllowedRequestDate('2026-07-28')).toBe(true);
    expect(isAllowedRequestDate('2026-08-15')).toBe(true);
  });

  it('момент времени оценивается по календарю МСК, а не по UTC', () => {
    at('2026-07-28T09:00:00.000Z');
    // 20:30 UTC 27-го = 23:30 МСК того же дня — вчера по Москве, значит уже поздно.
    expect(isAllowedRequestDateAt(new Date('2026-07-27T20:30:00.000Z'))).toBe(false);
    // 21:30 UTC 27-го = 00:30 МСК 28-го — это уже сегодня по Москве, значит допустимо.
    expect(isAllowedRequestDateAt(new Date('2026-07-27T21:30:00.000Z'))).toBe(true);
  });
});

// ── Схемы заявок ──

const OBJ = '11111111-1111-4111-8111-111111111111';
const TYPE = '33333333-3333-4333-8333-333333333333';

const wasteBase = {
  objectId: OBJ,
  requestType: 'container_install' as const,
  containerTypeId: TYPE,
};

describe('createWasteRequestSchema: рабочее окно доставки', () => {
  it('принимает время внутри окна', () => {
    const r = createWasteRequestSchema.safeParse({
      ...wasteBase,
      deliveryAt: '2026-07-28T08:00:00.000+03:00',
    });
    expect(r.success).toBe(true);
  });

  it('отклоняет время вне окна', () => {
    const r = createWasteRequestSchema.safeParse({
      ...wasteBase,
      deliveryAt: '2026-07-28T06:30:00.000+03:00',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'deliveryAt')).toBe(true);
  });

  it('полночь допустима, когда время явно не задано', () => {
    const r = createWasteRequestSchema.safeParse({
      ...wasteBase,
      deliveryAt: '2026-07-28T00:00:00.000+03:00',
      deliveryTimeUnspecified: true,
    });
    expect(r.success).toBe(true);
    expect(r.data?.deliveryTimeUnspecified).toBe(true);
  });

  it('без признака время считается заданным', () => {
    const r = createWasteRequestSchema.safeParse({
      ...wasteBase,
      deliveryAt: '2026-07-28T09:15:00.000+03:00',
    });
    expect(r.success).toBe(true);
    expect(r.data?.deliveryTimeUnspecified).toBe(false);
  });
});

describe('createWasteRequestSchema: минимальная дата доставки', () => {
  const parseAt = (deliveryAt: string) =>
    createWasteRequestSchema.safeParse({ ...wasteBase, deliveryAt });

  it('отклоняет вчерашнюю дату', () => {
    const r = parseAt('2026-07-26T10:00:00.000+03:00');
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'deliveryAt')).toBe(true);
  });

  it('принимает сегодня — вывоз заказывают и день в день', () => {
    expect(parseAt('2026-07-27T10:00:00.000+03:00').success).toBe(true);
  });

  it('принимает завтра и более поздние даты', () => {
    expect(parseAt('2026-07-28T10:00:00.000+03:00').success).toBe(true);
    expect(parseAt('2026-09-01T10:00:00.000+03:00').success).toBe(true);
  });

  it('правку заявки правило не касается: дату можно оставить прежней', () => {
    const r = updateWasteRequestSchema.safeParse({
      version: 1,
      deliveryAt: '2026-07-20T10:00:00.000+03:00',
    });
    expect(r.success).toBe(true);
  });
});

describe('updateWasteRequestSchema: рабочее окно доставки', () => {
  it('проверяет окно, когда дата передана', () => {
    const bad = updateWasteRequestSchema.safeParse({
      version: 1,
      deliveryAt: '2026-07-28T22:00:00.000+03:00',
    });
    expect(bad.success).toBe(false);
  });

  it('пропускает проверку при снятом времени', () => {
    const ok = updateWasteRequestSchema.safeParse({
      version: 1,
      deliveryAt: '2026-07-28T00:00:00.000+03:00',
      deliveryTimeUnspecified: true,
    });
    expect(ok.success).toBe(true);
  });

  it('не трогает окно, если дата не передана', () => {
    const ok = updateWasteRequestSchema.safeParse({ version: 1, comment: 'без даты' });
    expect(ok.success).toBe(true);
  });
});

const resolvedMeta = {
  source: 'resolved' as const,
  fiasId: '0c5b2444-70a0-4932-980c-b4dc0d3f02b5',
  fiasLevel: 8,
};

const freightBase = {
  requestType: 'freight_transport' as const,
  objectId: OBJ,
  vehicleTypeId: TYPE,
  volumeM3: 10,
  loadingLocation: 'г Москва, ул Тверская, д 1',
  unloadingLocation: 'г Москва, ул Арбат, д 2',
  loadingAddress: resolvedMeta,
  unloadingAddress: resolvedMeta,
};

describe('createVehicleRequestSchema: рабочее окно подачи', () => {
  it('принимает время внутри окна', () => {
    const r = createVehicleRequestSchema.safeParse({
      ...freightBase,
      scheduledAt: '2026-07-28T10:00:00+03:00',
    });
    expect(r.success).toBe(true);
  });

  it('отклоняет время вне окна', () => {
    const r = createVehicleRequestSchema.safeParse({
      ...freightBase,
      scheduledAt: '2026-07-28T05:00:00+03:00',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.path.join('.') === 'scheduledAt')).toBe(true);
  });

  it('полночь допустима, когда время явно не задано', () => {
    const r = createVehicleRequestSchema.safeParse({
      ...freightBase,
      scheduledAt: '2026-07-28T00:00:00+03:00',
      scheduledTimeUnspecified: true,
    });
    expect(r.success).toBe(true);
  });
});

describe('createVehicleRequestSchema: минимальная дата', () => {
  const specialBase = {
    requestType: 'special_equipment' as const,
    objectId: OBJ,
    vehicleTypeId: TYPE,
  };

  it('грузоперевозка: подача вчера отклоняется, сегодня — принимается', () => {
    const yesterday = createVehicleRequestSchema.safeParse({
      ...freightBase,
      scheduledAt: '2026-07-26T10:00:00+03:00',
    });
    expect(yesterday.success).toBe(false);
    expect(yesterday.error?.issues.some((i) => i.path.join('.') === 'scheduledAt')).toBe(true);
    expect(
      createVehicleRequestSchema.safeParse({
        ...freightBase,
        scheduledAt: '2026-07-27T10:00:00+03:00',
      }).success,
    ).toBe(true);
  });

  it('спецтехника: начало периода не раньше сегодня', () => {
    const yesterday = createVehicleRequestSchema.safeParse({
      ...specialBase,
      dateFrom: '2026-07-26',
      dateTo: '2026-07-30',
    });
    expect(yesterday.success).toBe(false);
    expect(yesterday.error?.issues.some((i) => i.path.join('.') === 'dateFrom')).toBe(true);
    expect(
      createVehicleRequestSchema.safeParse({ ...specialBase, dateFrom: '2026-07-27' }).success,
    ).toBe(true);
  });

  it('правку заявки правило не касается', () => {
    const r = updateVehicleRequestSchema.safeParse({
      requestType: 'special_equipment',
      version: 1,
      dateFrom: '2026-07-20',
    });
    expect(r.success).toBe(true);
  });
});
