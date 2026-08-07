import {
  isServiceRequestClosed,
  type ServiceRequestDto,
  type ServiceRequestStatus,
  warrantyToday,
} from '@technic/contracts';

/**
 * Возраст ожидания и просрочка — то, чем список заявок на обслуживание отличается от соседних
 * модулей (Р36). Заявка здесь не «висит вообще», а висит **в текущем статусе**: три стороны
 * передают её друг другу, и вопрос «кто тянет» — это вопрос «сколько дней заявка стоит там, где
 * стоит», а не «сколько прошло с заведения».
 *
 * Считается по `statusChangedAt`, который сервер обновляет и при переназначении исполнителя без
 * смены статуса: новый сервис не наследует чужое ожидание.
 */

const DAY = 86_400_000;

/** Сколько полных суток заявка стоит в текущем статусе. */
export function statusAgeDays(statusChangedAt: string, now: Date = new Date()): number {
  const at = Date.parse(statusChangedAt);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((now.getTime() - at) / DAY));
}

/**
 * Возраст словами: «сегодня», «3 дня», «12 дней». Русское склонение — 1 день, 2–4 дня, 5–20
 * дней; 11–14 всегда «дней».
 */
export function statusAgeLabel(statusChangedAt: string, now: Date = new Date()): string {
  const days = statusAgeDays(statusChangedAt, now);
  if (days === 0) return 'сегодня';
  const tail = days % 100;
  const last = days % 10;
  const form =
    tail >= 11 && tail <= 14
      ? 'дней'
      : last === 1
        ? 'день'
        : last >= 2 && last <= 4
          ? 'дня'
          : 'дней';
  return `${days} ${form}`;
}

/**
 * Просрочена ли заявка: желаемый срок прошёл, а работы не закрыты. Закрытая (принятая либо
 * отменённая) просроченной не считается — срок к ней больше не относится, и красная строка в
 * списке говорила бы о работе, которой уже нет.
 *
 * «Сегодня» берётся по Москве той же функцией, что и подсветка гарантий: у пользователя из
 * другого региона своя граница суток, и просрочка разошлась бы с ответом сервера.
 */
export function isServiceRequestOverdue(
  request: Pick<ServiceRequestDto, 'dueDate' | 'status'>,
  today: string = warrantyToday(),
): boolean {
  if (!request.dueDate || isServiceRequestClosed(request.status)) return false;
  return request.dueDate < today;
}

/**
 * Что сейчас требуется от исполнителя — короткой строкой для его набора колонок (§9.2).
 *
 * Своя подпись, а не статус второй раз: сервис открывает список вопросом «что мне делать», и
 * «Диагностика» на этот вопрос не отвечает. Пусто — ход не за ним: заявка ждёт решения
 * оператора либо закрыта.
 */
export function serviceTodoLabel(status: ServiceRequestStatus): string {
  switch (status) {
    case 'assigned':
      return 'Принять в работу';
    case 'diagnostics':
      return 'Собрать и предъявить смету';
    case 'in_work':
      return 'Выполнить и закрыть работы';
    default:
      return '';
  }
}
