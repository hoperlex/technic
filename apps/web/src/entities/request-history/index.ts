/**
 * История заявки как предмет показа (ADR 0012): чем называется событие, каким баблом оно
 * начинается и как выглядит весь список.
 *
 * Слайс сущности, а не файл рядом с таблицей: словари общие для всех трёх модулей заявок — вывоза
 * мусора, заказа ТС и обслуживания оргтехники, — и растут они от каждого нового решения в любом из
 * них, тогда как сама таблица меняется от вёрстки. Разъехаться им нельзя: событие без подписи
 * показывается пустым баблом.
 *
 * THE TABLE LIVES HERE AND NOT IN `entities/request`, although the history is common ground of the
 * two kinds of request as well: the table reads the labels above, and from inside `request` that
 * same import would be a reach at a neighbour of its own layer — the one direction the lint refuses.
 * Here it is an inner import. The third reader settles it anyway: servicing office equipment has a
 * cycle of its own (ADR 0085), passes its own status dictionary in, and has no business depending on
 * a slice built for the two kinds.
 *
 * `HistoryStatusDict` IS DELIBERATELY NOT PUBLISHED, though it is the declared type of a public
 * prop: a caller builds that dictionary out of its module's own labels and colours, and the shape is
 * checked at the call. Published, it would become part of the slice's contract for no reader — the
 * same reason five names of `entities/file` were made file-local when they moved into a slice.
 */
export { HISTORY_TITLES, KIND_TAGS } from './model/labels';
export { RequestHistoryTable } from './ui/RequestHistory';
export type { HistoryRow } from './ui/RequestHistory';
