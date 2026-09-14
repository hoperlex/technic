/**
 * Рабочее задание агенту: формальный пакет вместо длинного письма.
 *
 * ЗАЧЕМ ФОРМА. Свободный запрос каждый раз разный, и разными получаются ответы: сегодня модель
 * вернула пять находок и правку, завтра — эссе. Пакет фиксирует пять вещей, от которых зависит
 * повторяемость: роль, цель, границы, запреты и форму ответа. Всё остальное — контекст, и он
 * приходит фактами.
 *
 * РАЗДЕЛЕНИЕ РОЛЕЙ — не украшение. Ревьюер ищет и не правит; исполнитель правит ровно
 * утверждённое и не ищет; проверяющий смотрит на результат и не делает ни того, ни другого.
 * Смешать их — значит получить агента, который нашёл проблему, сам решил, что она важна, сам её
 * починил и сам подтвердил, что всё хорошо.
 */
export type PacketRole = 'reviewer' | 'fixer' | 'verifier';

export interface PacketSection {
  readonly title: string;
  readonly body: string;
}

export interface WorkPacket {
  readonly role: PacketRole;
  readonly goal: string;
  /** Файлы и области, за которые выходить нельзя. */
  readonly scope: readonly string[];
  /** Что агенту дано: факты, правила, решения. Каждый вход — заголовок и текст. */
  readonly inputs: readonly PacketSection[];
  readonly constraints: readonly string[];
  readonly forbidden: readonly string[];
  readonly expectedOutput: string;
  /** Схема ответа в виде примера: модель повторяет форму надёжнее, чем читает описание. */
  readonly outputSchema: string;
  /** Куда положить ответ. Путь относительно корня репозитория. */
  readonly outputFile: string;
}
