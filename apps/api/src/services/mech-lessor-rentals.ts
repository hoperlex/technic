import { eq } from 'drizzle-orm';
import { formatMechRequestNumber, type MechLessorRentalDto } from '@technic/contracts';
import { constructionObjects, mechModels, mechRequests } from '../db/schema';
import type { Principal } from '../auth/principal';
import type { MechReader } from './mech-request-dto';
import { toNum } from './mech-request-dto';
import { mechLessorReceiptLessorState, type MechLessorReceiptRow } from './mech-lessor-receipt';

/*
 * The mechanization lessor's own view of his rentals (lessor receipt plan, P12, O7): an allow-list
 * read by its own query, not the office's card with fields blanked. The query selects only what the
 * lessor is shown, plus the three columns his predicate asks (`lessorId`, `status`, `deletedAt`) —
 * the department, the requester, the comment and files, the visa, the cancel reason, the worked
 * units, the final cost and the extension are never even read for him, so a mapper bug cannot leak
 * them.
 */

const rentalSelect = {
  id: mechRequests.id,
  num: mechRequests.num,
  version: mechRequests.version,
  status: mechRequests.status,
  lessorId: mechRequests.lessorId,
  deletedAt: mechRequests.deletedAt,
  mechModelName: mechModels.name,
  objectName: constructionObjects.name,
  objectAddress: constructionObjects.address,
  plannedFrom: mechRequests.plannedFrom,
  plannedTo: mechRequests.plannedTo,
  actualFrom: mechRequests.actualFrom,
  actualTo: mechRequests.actualTo,
  rate: mechRequests.rate,
  rateUnit: mechRequests.rateUnit,
  responsibleName: mechRequests.responsibleName,
  responsiblePhone: mechRequests.responsiblePhone,
  lessorReceiptRequired: mechRequests.lessorReceiptRequired,
};

/**
 * The lessor's rentals with the site and the model — the two joins the list's search and the count
 * use too, so the page and its total count the same rows. Neither multiplies rows: a request has
 * one site and at most one model.
 */
export function mechLessorRentalQuery(reader: MechReader) {
  return reader
    .select(rentalSelect)
    .from(mechRequests)
    .innerJoin(constructionObjects, eq(mechRequests.objectId, constructionObjects.id))
    .leftJoin(mechModels, eq(mechRequests.mechModelId, mechModels.id));
}

export type MechLessorRentalRow = Awaited<ReturnType<typeof mechLessorRentalQuery>>[number];

/**
 * One rental as the lessor sees it, field by field (P12): a field added to `MechRequestDto`
 * tomorrow does not reach the lessor unless someone writes it here. The receipt block is his
 * audience's (versions of the current deal, `MechLessorReceiptVersionView`).
 */
export function toMechLessorRentalDto(
  p: Principal,
  row: MechLessorRentalRow,
  versions: readonly MechLessorReceiptRow[],
): MechLessorRentalDto {
  return {
    id: row.id,
    num: row.num,
    displayNumber: formatMechRequestNumber(row.num),
    version: row.version,
    status: row.status,
    mechModelName: row.mechModelName,
    objectName: row.objectName,
    objectAddress: row.objectAddress,
    plannedFrom: row.plannedFrom,
    plannedTo: row.plannedTo,
    actualFrom: row.actualFrom,
    actualTo: row.actualTo,
    rate: toNum(row.rate),
    rateUnit: row.rateUnit,
    responsibleName: row.responsibleName,
    responsiblePhone: row.responsiblePhone,
    lessorReceipt: mechLessorReceiptLessorState(p, row.lessorReceiptRequired, versions),
  };
}
