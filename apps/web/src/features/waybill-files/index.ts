/**
 * Scans attached to a waybill (migration 0087): the paperwork comes back from the site filled in,
 * and the journal keeps it next to the number it was issued under. Outside the slice it is taken as
 * `@features/waybill-files`.
 *
 * A FEATURE, THOUGH BOTH THE PLANS AND THE SLICE HEADER PROMISED IT TO `entities/waybill`. That
 * address is impossible, and not for reasons of taste: the cell needs the waybill (`waybillsApi`,
 * `waybillKeys` — attach, detach, invalidate the journal) AND the file (`filesApi` to put the object
 * in storage, `FileLinkList` to show what is already attached), and one entity may not import
 * another on its own layer. Split in two it would be worse than wrong: the upload and the attach are
 * one action to the person, and a half of it left in the waybill slice would either duplicate the
 * file cycle or reach across the layer anyway. A feature sees both slices, so the pair lives here —
 * which is also what makes this a scenario and not an entity: the cell knows about the right
 * `waybills.files` (its `canEdit`), and the entity layer knows nothing about who is looking.
 */
export { WaybillFilesCell } from './ui/WaybillFilesCell';
