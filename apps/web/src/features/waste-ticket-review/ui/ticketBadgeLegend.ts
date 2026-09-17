import type { WasteTicketBadgeDto } from '@technic/contracts';

/**
 * Пять состояний разбора талонов одним списком: значок, число и краткая расшифровка (ADR 0114,
 * Р24; ADR 0195).
 *
 * Список появился, когда числа ушли со строки списка в подсказку крестика: расшифровка значков
 * жила пятью копиями внутри разметки, и подсказке пришлось бы стать шестой. Расхождение такой
 * копии не падает тестом — оно просто называет одно и то же состояние в двух местах по-разному.
 *
 * Порядок здесь — порядок срочности, в котором состояния читают: сперва то, что зовёт разбирать
 * сейчас, следом законные расхождения и очередь, в конце — бумага, до которой разбор не дошёл.
 */
export interface TicketBadgeState {
  /** Поле значка: оно же ключ строки подсказки. */
  key: 'errors' | 'warnings' | 'pendingConfirmation' | 'failures' | 'unreviewedPaper';
  icon: string;
  /** Одна строка: что это значит и чего от человека ждут. */
  label: string;
}

export const TICKET_BADGE_STATES: readonly TicketBadgeState[] = [
  { key: 'errors', icon: '⛔', label: 'цифры не сошлись — нужен разбор' },
  { key: 'warnings', icon: '⚠️', label: 'похоже на расхождение, но бывает законно' },
  { key: 'pendingConfirmation', icon: '⏳', label: 'прочитано, ждёт подтверждения' },
  { key: 'failures', icon: '🚫', label: 'прочитать не удалось — нужен скан или ручной ввод' },
  { key: 'unreviewedPaper', icon: '📄', label: 'талон приложен, но не разобран' },
];

/** Строка подсказки на каждое ненулевое состояние; нули не показываются — они молчат. */
export function ticketBadgeLines(
  badge: WasteTicketBadgeDto,
): { state: TicketBadgeState; count: number }[] {
  return TICKET_BADGE_STATES.map((state) => ({ state, count: badge[state.key] })).filter(
    (line) => line.count > 0,
  );
}

/**
 * Сколько всего поводов для разбора числится за заявкой. Число нигде не показывается — оно
 * отвечает на вопрос «есть ли вообще повод» и озвучивает кнопку для читалки экрана.
 */
export function ticketBadgeTotal(badge: WasteTicketBadgeDto): number {
  return TICKET_BADGE_STATES.reduce((sum, state) => sum + badge[state.key], 0);
}
