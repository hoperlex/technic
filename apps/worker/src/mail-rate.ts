/**
 * Потолок обращений наружу: столько-то за минуту, не больше.
 *
 * Появился ради почты (тариф провайдера: транзакционные сервисы режут отправку по частоте, и
 * упёршись в лимит, портал получил бы не задержку, а отказы по всей пачке разом), а теперь тем же
 * считаются обращения к LLM-прокси — очередь там общая с чужими сервисами, и лимит называет
 * оператор. Скользящее окно, а не «сколько за календарную минуту»: иначе на стыке минут пролетал
 * бы двойной лимит.
 *
 * Счётчик живёт в процессе. Двум worker'ам он даст два потолка — это осознанно: точный общий
 * лимит потребовал бы состояния в БД на каждое обращение, а сейчас worker в проде один, и запас
 * задаётся значением ниже тарифного (`MAIL_MAX_PER_MINUTE`, `TICKET_OCR_MAX_PER_MINUTE`).
 */
export class RateLimiter {
  private readonly sentAt: number[] = [];

  constructor(private readonly maxPerMinute: number) {}

  /** Забрать разрешение на одно обращение. `false` — квота на минуту исчерпана. */
  take(now = Date.now()): boolean {
    this.forget(now);
    if (this.sentAt.length >= this.maxPerMinute) return false;
    this.sentAt.push(now);
    return true;
  }

  /** Когда освободится место под следующее обращение: по нему откладывается задача. */
  freeAt(now = Date.now()): Date {
    this.forget(now);
    if (this.sentAt.length < this.maxPerMinute) return new Date(now);
    // Место освободит самое старое обращение, вышедшее из окна.
    return new Date(this.sentAt[0]! + 60_000);
  }

  private forget(now: number): void {
    const edge = now - 60_000;
    while (this.sentAt.length > 0 && this.sentAt[0]! <= edge) this.sentAt.shift();
  }
}
