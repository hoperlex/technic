import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/mail-rate';

/**
 * Потолок отправки.
 *
 * Проверяется тестом, потому что упереться в лимит провайдера — это не «чуть медленнее»: у
 * транзакционных сервисов превышение частоты означает отказы по всей пачке, а рассылка заданий
 * уходит разом на сотню с лишним адресов. Время подаётся параметром: тест не должен ждать минуту,
 * чтобы проверить окно длиной в минуту.
 */

describe('потолок отправки писем в минуту', () => {
  it('пропускает ровно столько писем, сколько разрешено', () => {
    const limiter = new RateLimiter(3);
    const now = 1_000_000;

    expect(limiter.take(now)).toBe(true);
    expect(limiter.take(now)).toBe(true);
    expect(limiter.take(now)).toBe(true);
    expect(limiter.take(now)).toBe(false);
  });

  it('окно скользящее: место освобождает самая старая отправка, а не начало минуты', () => {
    const limiter = new RateLimiter(2);
    const start = 1_000_000;

    limiter.take(start);
    limiter.take(start + 30_000);
    expect(limiter.take(start + 40_000)).toBe(false);

    // Через минуту после первой отправки её место освободилось — второй ещё нет.
    expect(limiter.take(start + 60_001)).toBe(true);
    expect(limiter.take(start + 60_002)).toBe(false);
  });

  it('говорит, когда освободится место: по этому времени откладывается задача', () => {
    const limiter = new RateLimiter(1);
    const start = 1_000_000;

    limiter.take(start);
    expect(limiter.freeAt(start + 10_000).getTime()).toBe(start + 60_000);
  });

  it('пока квота не исчерпана, ждать нечего', () => {
    const limiter = new RateLimiter(2);
    const start = 1_000_000;

    limiter.take(start);
    expect(limiter.freeAt(start).getTime()).toBe(start);
  });
});
