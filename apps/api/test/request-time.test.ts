import { describe, expect, it } from 'vitest';
import {
  createWasteRequestSchema,
  createVehicleRequestSchema,
  isWithinWorkTime,
  isWithinWorkTimeAt,
  minutesToTime,
  moscowTimeOf,
  normalizeTimeInput,
  timeToMinutes,
  updateWasteRequestSchema,
} from '@technic/contracts';

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
