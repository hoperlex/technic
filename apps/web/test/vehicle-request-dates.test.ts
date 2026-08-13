import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import { vehicleRequestDateRules } from '../src/utils/date';

/**
 * Календарь формы заявки на технику (ADR 0104). Проверяется здесь именно то, что видит человек:
 * какие дни дейтпикер запирает и какие открывает — правило-то живёт в контрактах и проверено там,
 * а разойтись форма с сервером может как раз на переводе правила в `disabledDate`.
 *
 * Часы фиктивные: граница считается от «сейчас» по МСК, и без фиксации момента тест ломался бы
 * дважды в сутки — в 15:00 и в полночь.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** «Сейчас» — моментом UTC; 12.08.2026 остаётся сегодняшним днём по Москве во всех случаях. */
const at = (utc: string) => vi.setSystemTime(new Date(utc));
const day = (key: string) => dayjs(key).startOf('day');

const SHTAB = { role: 'shtab' } as const;
const DISPATCHER = { role: 'dispatcher' } as const;

describe('календарь заявки на технику — заявитель', () => {
  it('до 15:00 МСК открыто завтра, сегодня заперто', () => {
    at('2026-08-12T11:59:00.000Z'); // 14:59 МСК
    const { minDate, disabledDate, leadTimeHint } = vehicleRequestDateRules(SHTAB);
    expect(minDate.format('YYYY-MM-DD')).toBe('2026-08-13');
    expect(disabledDate(day('2026-08-12'))).toBe(true);
    expect(disabledDate(day('2026-08-13'))).toBe(false);
    // Причина запертых дней объяснена у самого поля, а не только отказом сервера.
    expect(leadTimeHint).toBeTruthy();
  });

  it('с 15:00 МСК заперто и завтра — ближайший день послезавтрашний', () => {
    at('2026-08-12T12:00:00.000Z'); // ровно 15:00 МСК — отсечка уже прошла
    const { minDate, disabledDate } = vehicleRequestDateRules(SHTAB);
    expect(minDate.format('YYYY-MM-DD')).toBe('2026-08-14');
    expect(disabledDate(day('2026-08-13'))).toBe(true);
    expect(disabledDate(day('2026-08-14'))).toBe(false);
  });

  it('прошлое заперто целиком: права на коррекцию у заявителя нет', () => {
    at('2026-08-12T11:00:00.000Z');
    const { disabledDate } = vehicleRequestDateRules(SHTAB);
    expect(disabledDate(day('2026-08-11'))).toBe(true);
    expect(disabledDate(day('2026-07-20'))).toBe(true);
  });
});

describe('календарь заявки на технику — тот, кто ведёт заказы', () => {
  it('сегодня открыто и вечером: заблаговременность его не касается', () => {
    at('2026-08-12T20:30:00.000Z'); // 23:30 МСК
    const { minDate, disabledDate, leadTimeHint } = vehicleRequestDateRules(DISPATCHER);
    expect(minDate.format('YYYY-MM-DD')).toBe('2026-08-12');
    expect(disabledDate(day('2026-08-12'))).toBe(false);
    // Объяснять нечего: ближние дни у него не заперты.
    expect(leadTimeHint).toBeUndefined();
  });

  /**
   * Два правила делят календарь по сегодняшнему дню и не спорят: заблаговременность запирает
   * ближние будущие дни, право на коррекцию (ADR 0101) открывает прошлые. У диспетчера открыты
   * тридцать дней назад, у администратора — всё прошлое.
   */
  it('прошлое открыто ровно на глубину права на коррекцию', () => {
    at('2026-08-12T11:00:00.000Z');
    const dispatcher = vehicleRequestDateRules(DISPATCHER);
    expect(dispatcher.disabledDate(day('2026-07-13'))).toBe(false); // 30 дней назад
    expect(dispatcher.disabledDate(day('2026-07-12'))).toBe(true); // глубже предела
    const admin = vehicleRequestDateRules({ role: 'admin' });
    expect(admin.disabledDate(day('2025-01-01'))).toBe(false);
  });
});
