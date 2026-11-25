import type { WasteTicketFileDto } from '@technic/contracts';

/**
 * What a ticket file amounts to for the person settling the paper, with no ticket found in it.
 *
 * "Талоны не найдены" is true only of a file that was READ (snow-removal plan, §3.2): there a
 * manual ticket is the way out. A file that failed, never reached recognition or whose attempt
 * died without a result is UNREAD — a manual ticket does not settle it, reading it does
 * («Перераспознать», or a reset to «Новая» and a re-close with a usable scan). One rule for the
 * review panel and the completion window, so the two never call the same file differently.
 */
export function ticketFileOutcome(file: Pick<WasteTicketFileDto, 'status' | 'activeJob'>): {
  text: string;
  unread: boolean;
} {
  if (file.status === 'done') return { text: 'талоны не найдены', unread: false };
  if (file.status === 'pending' && file.activeJob) return { text: 'распознаётся…', unread: false };
  if (file.status === 'not_queued') return { text: 'не распознавался', unread: true };
  return { text: 'не прочитан', unread: true };
}
