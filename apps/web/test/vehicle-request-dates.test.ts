import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import type { AuthUser } from '@technic/contracts';
import { permissionChecks } from '@entities/session';
import { vehicleRequestDateRules } from '@entities/vehicle-request';
import { authUser } from './factories/auth';

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

const SHTAB = authUser({ role: 'shtab' });
const DISPATCHER = authUser({ role: 'dispatcher' });
const ADMIN = authUser({ role: 'admin' });

/** The calendar as the editor builds it: permissions come from the account's server list. */
const rulesFor = (user: AuthUser) => vehicleRequestDateRules(user, permissionChecks(user).can);

describe('календарь заявки на технику — заявитель', () => {
  it('до 15:00 МСК открыто завтра, сегодня заперто', () => {
    at('2026-08-12T11:59:00.000Z'); // 14:59 МСК
    const { minDate, disabledDate, leadTimeHint } = rulesFor(SHTAB);
    expect(minDate.format('YYYY-MM-DD')).toBe('2026-08-13');
    expect(disabledDate(day('2026-08-12'))).toBe(true);
    expect(disabledDate(day('2026-08-13'))).toBe(false);
    // Причина запертых дней объяснена у самого поля, а не только отказом сервера.
    expect(leadTimeHint).toBeTruthy();
  });

  it('с 15:00 МСК заперто и завтра — ближайший день послезавтрашний', () => {
    at('2026-08-12T12:00:00.000Z'); // ровно 15:00 МСК — отсечка уже прошла
    const { minDate, disabledDate } = rulesFor(SHTAB);
    expect(minDate.format('YYYY-MM-DD')).toBe('2026-08-14');
    expect(disabledDate(day('2026-08-13'))).toBe(true);
    expect(disabledDate(day('2026-08-14'))).toBe(false);
  });

  it('прошлое заперто целиком: права на коррекцию у заявителя нет', () => {
    at('2026-08-12T11:00:00.000Z');
    const { disabledDate } = rulesFor(SHTAB);
    expect(disabledDate(day('2026-08-11'))).toBe(true);
    expect(disabledDate(day('2026-07-20'))).toBe(true);
  });
});

describe('календарь заявки на технику — тот, кто ведёт заказы', () => {
  it('сегодня открыто и вечером: заблаговременность его не касается', () => {
    at('2026-08-12T20:30:00.000Z'); // 23:30 МСК
    const { minDate, disabledDate, leadTimeHint } = rulesFor(DISPATCHER);
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
    const dispatcher = rulesFor(DISPATCHER);
    expect(dispatcher.disabledDate(day('2026-07-13'))).toBe(false); // 30 дней назад
    expect(dispatcher.disabledDate(day('2026-07-12'))).toBe(true); // глубже предела
    const admin = rulesFor(ADMIN);
    expect(admin.disabledDate(day('2025-01-01'))).toBe(false);
  });
});

/*
 * ADR 0223: the calendar follows the server's list, not the role's matrix. A requester role holding
 * `waybills.correct` through an assembled grant gets thirty days of the past, and a dispatcher whose
 * list lacks `vehicleRequests.status` (a deploy window, a revoked grant) gets the lead time.
 */
describe('vehicle request calendar — permissions from the server list', () => {
  it('a correction permission in the list opens the past for a role without it', () => {
    at('2026-08-12T11:00:00.000Z');
    const site = authUser({
      role: 'shtab',
      permissions: [...SHTAB.permissions, 'waybills.correct'],
    });
    expect(rulesFor(site).disabledDate(day('2026-07-13'))).toBe(false);
    expect(rulesFor(site).disabledDate(day('2026-07-12'))).toBe(true);
  });

  it('a dispatcher whose list lacks the status permission orders ahead like a requester', () => {
    at('2026-08-12T11:59:00.000Z'); // 14:59 Moscow time
    const dispatcher = authUser({
      role: 'dispatcher',
      permissions: DISPATCHER.permissions.filter((p) => p !== 'vehicleRequests.status'),
    });
    const { minDate, leadTimeHint } = rulesFor(dispatcher);
    expect(minDate.format('YYYY-MM-DD')).toBe('2026-08-13');
    expect(leadTimeHint).toBeTruthy();
  });
});
