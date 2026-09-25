import { wasteTicketFieldLabels } from '@technic/contracts';

/*
 * Field labels for server validation errors about waste tickets. The rule itself lives in
 * `shared/lib/errors.ts`: the parser and the text are shared, the dictionary is domain knowledge and
 * arrives as an argument, so the slice that owns the fields is the slice that names them.
 *
 * TWO DICTIONARIES, NOT ONE, because the slice answers two different requests. The ticket is what a
 * person copied off the blank; the audit is a read-only report over someone else's tickets. Merged,
 * the ticket form would be handed labels for `promptVersion` and the report labels for `workKind` —
 * keys neither request can return — and the next reader would have no way to tell which of them a
 * caller actually risks seeing.
 *
 * MACHINE KEYS ARE DELIBERATELY ABSENT: `pageId`, `fingerprint`, `editSource`, `page`, `pageSize`.
 * Nobody types them — the portal fills them from the row it is looking at — so a rejection on them
 * is a portal defect, not a mistake in a form, and the person who reports it needs the name the
 * server used, not a caption invented for a screen. A label here would dress a bug as bad input.
 */

/**
 * Fields of the ticket bodies: manual entry and correction send the five blank fields, blind check
 * sends three of them, arbitration adds the list of fields it declares resolved.
 *
 * The five blank fields are not re-listed: `wasteTicketFieldLabels` in the contracts already holds
 * them, and both sides read from it — the audit tables, the filter panel and the server's own
 * refusal texts quote those very words. A copy here would drift from the message it stands next to.
 */
export const wasteTicketErrorLabels: Record<string, string> = {
  ...wasteTicketFieldLabels,
  duplicateOverrideReason: 'Это разные бумаги — почему',
  resolvedFields: 'Разобранные поля',
};

/**
 * Fields of the recognition audit queries (ADR 0137).
 *
 * `from` earns this dictionary on its own: the period limit is refused with `fields: { from }` and a
 * message that names the limit in words, so without a label the screen used to end that sentence
 * with the bare word `from`. The rest are the event feed filters, worded as their own controls are.
 */
export const ticketAuditErrorLabels: Record<string, string> = {
  from: 'Начало периода',
  to: 'Конец периода',
  field: 'Поле бланка',
  event: 'Тип события',
  model: 'Модель чтения',
  promptVersion: 'Версия промпта',
  preprocessingVersion: 'Версия подготовки',
  requestNum: 'Номер заявки',
};
