/**
 * Documents of a vehicle request (plan `docs/vehicle-rental-completion-documents-plan.md`): the card's
 * table of the requester's attachments and typed, dated paper, with adding and removing. Outside the
 * slice it is taken as `@features/vehicle-request-documents`.
 *
 * A feature, not part of `entities/vehicle-request`: adding a document is one action to the person —
 * the file goes to storage (`entities/file`) and is linked to the request (`entities/vehicle-request`)
 * — and one entity may not import another on its own layer. The same reason put `waybill-files` here.
 */
export { VehicleRequestDocuments } from './ui/VehicleRequestDocuments';
