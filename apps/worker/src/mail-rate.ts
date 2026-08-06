/**
 * Потолок отправки: столько-то писем в минуту, не больше.
 *
 * Нужен из-за тарифа провайдера: рассылка на несколько сотен водителей уходит одной пачкой, а
 * транзакционные сервисы режут отправку по частоте — и упёршись в лимит, портал получил бы не
 * задержку, а отказы по всей пачке разом. Скользящее окно, а не «сколько за календарную минуту»:
 * иначе на стыке минут пролетал бы двойной лимит.
 *
 * Счётчик живёт в процессе. Двум worker'ам он даст два потолка — это осознанно: точный общий
 * лимит потребовал бы состояния в БД на каждое письмо, а сейчас worker в проде один, и запас
 * задаётся значением `MAIL_MAX_PER_MINUTE` ниже тарифного.
 */
export class MailRateLimiter {
  private readonly sentAt: number[] = [];

  constructor(private readonly maxPerMinute: number) {}

  /** Забрать разрешение на одно письмо. `false` — квота на минуту исчерпана. */
  take(now = Date.now()): boolean {
    this.forget(now);
    if (this.sentAt.length >= this.maxPerMinute) return false;
    this.sentAt.push(now);
    return true;
  }

  /** Когда освободится место под следующее письмо: по нему откладывается задача. */
  freeAt(now = Date.now()): Date {
    this.forget(now);
    if (this.sentAt.length < this.maxPerMinute) return new Date(now);
    // Место освободит самая старая отправка, вышедшая из окна.
    return new Date(this.sentAt[0]! + 60_000);
  }

  private forget(now: number): void {
    const edge = now - 60_000;
    while (this.sentAt.length > 0 && this.sentAt[0]! <= edge) this.sentAt.shift();
  }
}
