/**
 * Wording of the two commands that reverse an applied week. The server computes the same plan for
 * both (ADR 0218 annulment, ADR 0219 return for re-approval), and the window is the same window;
 * what differs is what the person is told the week becomes afterwards.
 */
export type WeeklyReversalIntent = 'annul' | 'return';

interface ReversalTexts {
  /** Button on the action bar. */
  action: string;
  /** Window title after the request number. */
  title: string;
  /** Window title while no request is open. */
  emptyTitle: string;
  okText: string;
  refusedTitle: string;
  /** Branch notice when every consequence was already rolled back by hand. */
  nothingLeft: string;
  /** What the week becomes; `null` — the branch notice says enough. */
  outcome: string | null;
  reasonLabel: string;
  /** Where the reason stays when no journal operation is needed. */
  reasonStays: string;
  /** Where the reason stays when the command writes a correction-journal operation. */
  reasonStaysOperation: string;
  /** Refusal of an unnamed worked sheet, at the end of the sheet-list hint. */
  unnamedSheet: string;
  done: string;
}

export const WEEKLY_REVERSAL_TEXTS: Record<WeeklyReversalIntent, ReversalTexts> = {
  annul: {
    action: 'Аннулировать неделю',
    title: 'аннулировать неделю',
    emptyTitle: 'Аннулирование недельной заявки',
    okText: 'Аннулировать',
    refusedTitle: 'Аннулировать нельзя',
    nothingLeft: 'Следствия уже развёрнуты — аннулирование только закроет документ',
    outcome: null,
    reasonLabel: 'Причина аннулирования',
    reasonStays: 'Останется в шапке заявки и в её истории',
    reasonStaysOperation:
      'Останется в шапке заявки и в журнале коррекций, а также в листах, переоформленных этой операцией',
    unnamedSheet: 'Неотмеченный лист запирает свои дни, и неделя не аннулируется',
    done: 'Неделя аннулирована',
  },
  return: {
    action: 'Вернуть на согласование',
    title: 'вернуть на согласование',
    emptyTitle: 'Возврат недельной заявки на согласование',
    okText: 'Вернуть на согласование',
    refusedTitle: 'Вернуть на согласование нельзя',
    nothingLeft:
      'Следствия уже развёрнуты — возврат снимет визу и уберёт развёрнутые строки из состава',
    outcome:
      'Заявка вернётся в «Ждёт визы» без визы: площадка дополнит состав, руководитель ' +
      'строительства завизирует неделю заново — сроки продлятся и листы выпишутся снова, с новыми номерами.',
    reasonLabel: 'Причина возврата',
    reasonStays: 'Будет видна сверху в заявке и останется в её истории',
    reasonStaysOperation:
      'Будет видна сверху в заявке, останется в её истории и в журнале коррекций, а также в листах, переоформленных этой операцией',
    unnamedSheet: 'Неотмеченный лист запирает свои дни, и неделя не возвращается',
    done: 'Неделя возвращена на согласование',
  },
};
