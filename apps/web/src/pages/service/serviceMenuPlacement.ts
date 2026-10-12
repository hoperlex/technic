import type { ServiceMenuItem } from './serviceStatusChoices';

/**
 * Where each service-request action item is shown — and which menu leaves it out (ADR 0162).
 *
 * One module for every place, because the question is one: "how many entries does an action
 * have". Kept next to where they apply — the list grid and the request card — the sets would drift
 * silently: an item struck from the card but forgotten in the list looks like a decision, not a
 * mistake.
 *
 * The rule both sets obey: **an item may be struck only where the action has another entry in the
 * same place**. Hiding it without a replacement takes work away instead of removing a duplicate.
 * The guard `service-request-entries.test.tsx` checks exactly that and reads the sets from here.
 *
 * The items themselves never go away: contract predicates decide availability, the action set
 * stays complete, and every entry outside the menu takes the **ready** item from it, with its
 * `onClick`, disabled state and reason. This module only decides placement.
 */

/**
 * Status arcs whose only entry is the status tag (ADR 0162 stage Э6, owner decision S-15 of
 * 2026-10-12): close the work, roll back the start, accept, send back for rework, undo the
 * acceptance, reopen a cancelled request.
 *
 * The tag is present in all four places — the «Статус» column of the list row, the badge of the
 * phone list card and the «Статус» field of the request card (the card's phone sheet shows the
 * same field) — and it lists the transitions as a projection of the FULL action set
 * (`serviceStatusChoices`, ADR 0161). So striking these items from every menu leaves each of them
 * exactly one entry per place, with the same `onClick`, disabled state and reason; the domain
 * commands, reason windows, closing-document bar, history, mail and executor rules are those of the
 * item itself, not of the tag.
 *
 * What breaks if a placement filter is ever applied to the tag's items: these six arcs vanish from
 * the portal altogether. «Отложить», «Возобновить» and «Отменить заявку» are not here on purpose:
 * the owner kept them in the menu as the primary entry, and the tag is their declared second one.
 */
export const STATUS_TAG_ONLY = new Set<string>([
  'complete',
  'rollback-start',
  'accept',
  'rework',
  'rollback-accept',
  'reopen-request',
]);

/**
 * Not in the LIST menu in either of its forms — neither the desktop row nor the phone list card.
 *
 * Moving equipment edits directory master data, and doing it without opening the request is the
 * very source of "recorded here, standing there" mismatches that have their own review (backlog
 * §12). Its one entry is in the request card: a button next to «Какой аппарат», where the
 * equipment details are read. The six status arcs live on the tag in both list forms.
 */
const HIDDEN_EVERYWHERE_IN_LIST = new Set<string>(['move-equipment', ...STATUS_TAG_ONLY]);

/**
 * Not in the desktop ROW menu — on top of the list-wide set above.
 *
 * Assignment is struck here and **only here**: the row has its own button (`AssignButton`), while
 * the phone list card has no buttons at all — its sheet is the row of actions, and the item stays
 * the primary entry there. Splitting the sets by list form looks inconsistent until one asks "where
 * will the person press": on the phone a struck item would mean reassignment taken away, not a
 * duplicate removed.
 */
export const HIDDEN_IN_ROW_MENU = new Set<string>([...HIDDEN_EVERYWHERE_IN_LIST, 'assign']);

/** Not in the phone LIST CARD menu: only the list-wide set — nothing has a button here. */
export const HIDDEN_IN_CARD_LIST_MENU = new Set<string>(HIDDEN_EVERYWHERE_IN_LIST);

/**
 * Not in the request CARD menu.
 *
 * Each of these has its own place in the card — where the answer the action is about is read
 * (ADR 0140): executors are edited at the «Исполнители» field, consumables on their tab, the
 * discussion opens with a counter button (it also shows unread replies, which the menu cannot),
 * estimate decisions are taken with the buttons under the estimate table — all three, including
 * the return for editing, — and so is the executor's estimate step itself («Работы выполнены»,
 * workflow-fixes plan Р10), editing opens with the main footer button, the move is recorded at the
 * equipment details, and the six status arcs are chosen on the tag of the «Статус» field. A second
 * handle to the same action in the same window would only make people choose between two
 * identical roads.
 *
 * The item and its card entry share the same conditions, and that is checked: editing uses the
 * same `isServiceRequestEditable` + `serviceRequests.update`, estimate decisions and the tag take
 * the items of the same action set. Were they to diverge, the struck item would be left without a
 * replacement and the guard (`service-request-entries.test.tsx`) would go red.
 *
 * `start` is deliberately absent: it has a footer button but stays in the menu — on the phone the
 * footer is narrow, and the sheet remains the only reliable address of the main step.
 */
export const HIDDEN_IN_CARD_MENU = new Set<string>([
  'assign',
  'chat',
  'consumables',
  'estimate',
  'approve',
  'reject',
  'reopen',
  'edit',
  'move-equipment',
  ...STATUS_TAG_ONLY,
]);

/** Desktop list row menu: without what has a button next to it or an entry in the card. */
export function rowMenuItems(items: ServiceMenuItem[]): ServiceMenuItem[] {
  return items.filter((item) => !HIDDEN_IN_ROW_MENU.has(item.key));
}

/** Phone list card menu: only what has its entry in the request card or on the tag is struck. */
export function cardListMenuItems(items: ServiceMenuItem[]): ServiceMenuItem[] {
  return items.filter((item) => !HIDDEN_IN_CARD_LIST_MENU.has(item.key));
}

/** Request card menu: the action set without what has its own place in the card itself. */
export function cardMenuItems(items: ServiceMenuItem[]): ServiceMenuItem[] {
  return items.filter((item) => !HIDDEN_IN_CARD_MENU.has(item.key));
}
