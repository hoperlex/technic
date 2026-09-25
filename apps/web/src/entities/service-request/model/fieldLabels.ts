/*
 * Field labels for server validation errors about a service request. The rule lives in
 * `shared/lib/errors.ts`: the dictionary is domain knowledge and arrives as an argument, so the
 * slice that owns the fields names them.
 *
 * Only the chat reply is covered today, and that is the whole request body it sends. The list filter
 * set, which the same slice also posts (`markAllChatRead`), is NOT here on purpose: its captions are
 * decided by the filter registry of the service section (`pages/service/serviceRequestFilters.tsx`),
 * and a second set of the same words in the entity would drift from the panel the person is looking
 * at while nothing broke loudly enough to notice.
 */

/**
 * Fields of a chat reply — `body` and `addressees`.
 *
 * THREE KEYS FOR TWO CONTROLS, and that is the shape of the answer, not sloppiness. The contract
 * reports the addressee refusals at three different paths — `addressees`, `addressees.sides`,
 * `addressees.users` — because sides and named people are stored as two lists; only the last segment
 * of a path is looked up (`shared/lib/errors.ts`), so all three need an entry. They share one
 * caption because the composer has one control for them, and the shared text collapses repeats.
 */
export const serviceChatErrorLabels: Record<string, string> = {
  body: 'Сообщение',
  addressees: 'Кому',
  sides: 'Кому',
  users: 'Кому',
};
