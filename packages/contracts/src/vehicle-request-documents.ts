import { z } from 'zod';
import { dateOnlySchema, uuidSchema } from './common';
import type { RequestStatus } from './enums';
import type { FileDto } from './files';
import { can, type AccessSubject, type Permission } from './permissions';

/**
 * Documents of a vehicle request (plan `docs/vehicle-rental-completion-documents-plan.md`, D5–D8).
 *
 * One link table holds both kinds (`vehicle_request_files.kind`): the requester's attachments,
 * owned by the request editor, and typed, dated paper added from «В работе» on — invoices, УПД,
 * acts, for the order and its delivery alike (D6). The card shows them as one table (D8); who may
 * add and remove is decided here, by the server and the portal asking the same functions.
 */

export const VEHICLE_REQUEST_FILE_KINDS = ['attachment', 'document'] as const;
export type VehicleRequestFileKind = (typeof VEHICLE_REQUEST_FILE_KINDS)[number];

/**
 * Statuses a document may be added in: «В работе» up to and including the terminal ones. Paper
 * comes with work, and a request that never went to work has none — a «Новая» keeps the editor's
 * attachments only. A cancelled request is in the list as the owner worded it: a vehicle that came
 * and was sent back still bills the call-out.
 */
export const VEHICLE_REQUEST_DOCUMENT_STATUSES = [
  'confirmed',
  'done',
  'cancelled',
] as const satisfies readonly RequestStatus[];

/**
 * Documents per request (P7), counted apart from the editor's attachment limit: a month-long rental
 * collects more paper than the requester's handful of photos.
 */
export const VEHICLE_REQUEST_DOCUMENT_LIMIT = 50;

/** Type length: a name of a paper, not its description. */
export const VEHICLE_REQUEST_DOCUMENT_TYPE_MAX = 100;

/**
 * Suggestions for the free-text type (P11). Not a dictionary (D5): anything else may be typed, and
 * the server does not compare the type with this list.
 */
export const VEHICLE_REQUEST_DOCUMENT_TYPE_SUGGESTIONS = [
  'Счёт',
  'УПД',
  'Акт',
  'Счёт-фактура',
  'Договор',
] as const;

/** How a requester attachment reads in the type column of the merged table (D8). */
export const VEHICLE_REQUEST_ATTACHMENT_TYPE_LABEL = 'Вложение заявителя';

/**
 * A document added to a request: an uploaded file, its type and its date, both typed by hand. The
 * date may be any date (owner correction to P4): paper is dated by whoever wrote it, and a contract
 * signed ahead of the work is as legal as an act signed after it.
 */
export const addVehicleRequestDocumentSchema = z
  .object({
    fileId: uuidSchema,
    docType: z
      .string()
      .trim()
      .min(1, 'Укажите тип документа')
      .max(
        VEHICLE_REQUEST_DOCUMENT_TYPE_MAX,
        `Тип — не длиннее ${VEHICLE_REQUEST_DOCUMENT_TYPE_MAX} символов`,
      ),
    docDate: dateOnlySchema,
  })
  .strict();
export type AddVehicleRequestDocumentInput = z.infer<typeof addVehicleRequestDocumentSchema>;

/** A row of the merged documents table of the card. */
export interface VehicleRequestDocumentDto {
  kind: VehicleRequestFileKind;
  file: FileDto;
  /** Typed by hand; `null` on an attachment, which reads as «Вложение заявителя». */
  docType: string | null;
  /** Typed by hand; `null` on an attachment, which is dated by its upload. */
  docDate: string | null;
  addedAt: string;
  /** Who uploaded the file — for a document, who added it; `null` when the account is gone. */
  uploadedBy: string | null;
  uploadedByName: string;
}

/** Type column of the table: the typed type, or what an attachment is. */
export function vehicleRequestDocumentTypeLabel(
  doc: Pick<VehicleRequestDocumentDto, 'docType'>,
): string {
  return doc.docType ?? VEHICLE_REQUEST_ATTACHMENT_TYPE_LABEL;
}

/** Date column of the table (`YYYY-MM-DD` or an ISO moment): the typed date, or the upload. */
export function vehicleRequestDocumentDate(
  doc: Pick<VehicleRequestDocumentDto, 'docDate' | 'addedAt'>,
): string {
  return doc.docDate ?? doc.addedAt;
}

/**
 * Whether the subject may add a document to the request (D7): whoever runs vehicle requests
 * (`vehicleRequests.status` — dispatcher, manager, administrator, and the lessor through its
 * counterparty type), while the request is in the document corridor. The request's visibility —
 * the lessor's own requests only — is the server's part: it is a query, not a predicate.
 *
 * `has` answers the permission: the server leaves the default, the matrix over its principal; the
 * portal passes its `can` over the list the server computed (ADR 0223).
 */
export function canAddVehicleRequestDocument(
  subject: AccessSubject | null | undefined,
  request: { status: RequestStatus },
  has: (permission: Permission) => boolean = (permission) => can(subject, permission),
): boolean {
  return (
    has('vehicleRequests.status') &&
    (VEHICLE_REQUEST_DOCUMENT_STATUSES as readonly RequestStatus[]).includes(request.status)
  );
}

/**
 * Whether the subject may remove the row from the request (D7, P5): a document only — attachments
 * belong to the request editor; by the person who added it while they still may add one, or by an
 * administrator at any time. The uploader alone cannot take paper off a request rolled back to
 * «Новая»: it waits there for the work to resume, and the closing it backed may come back.
 */
export function canRemoveVehicleRequestDocument(
  subject: (AccessSubject & { id: string }) | null | undefined,
  request: { status: RequestStatus },
  doc: Pick<VehicleRequestDocumentDto, 'kind' | 'uploadedBy'>,
  has: (permission: Permission) => boolean = (permission) => can(subject, permission),
): boolean {
  if (doc.kind !== 'document' || !subject) return false;
  if (subject.role === 'admin') return true;
  return doc.uploadedBy === subject.id && canAddVehicleRequestDocument(subject, request, has);
}
