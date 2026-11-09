import type {
  MechLessorReceiptVersionView,
  MechLessorRentalDto,
  MechRequestDto,
  MechRequestSummaryDto,
} from '@technic/contracts';

/**
 * A mechanization rental request (`GET /mech-requests`). The default is a new request of a site
 * with a model and no deal yet: the state every request starts in, so a scenario about approval,
 * issue or completion has to say so.
 */
export function mechRequest(overrides: Partial<MechRequestDto> = {}): MechRequestDto {
  return {
    id: 'mech-1',
    num: 42,
    displayNumber: 'МХ-42',
    objectId: 'obj-1',
    objectCode: 'ОБ-1',
    objectName: 'ЖК Северный',
    objectAddress: 'г. Москва, ул. Северная, 1',
    departmentId: null,
    departmentCode: null,
    departmentName: null,
    mechModelId: 'model-1',
    mechModelName: 'Виброплита реверсивная Wacker DPU 3070Н',
    plannedFrom: '2026-08-03',
    plannedTo: '2026-08-17',
    responsibleName: 'Петров П. П.',
    responsiblePhone: '9000000000',
    comment: '',
    status: 'new',
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    cancelReason: null,
    lessorId: null,
    lessorName: null,
    lessorType: null,
    rate: null,
    rateUnit: null,
    actualFrom: null,
    actualTo: null,
    actualUnits: null,
    finalCost: null,
    files: [],
    version: 1,
    createdBy: 'user-1',
    createdByName: 'Диспетчеров Д. П.',
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-01T08:00:00.000Z',
    deletedAt: null,
    deletedByName: null,
    // No extension request: the state every rental starts in (ADR 0171, stage 3).
    extension: null,
    // No lessor receipt, not required: a «Новая» before take-in-work (lessor receipt plan, P3).
    lessorReceiptRequired: false,
    lessorReceipt: null,
    lessorReceiptVersionCount: 0,
    lessorReceiptRetired: null,
    ...overrides,
  };
}

/** `GET /mech-requests/summary`: the counters above the list, everything zero by default. */
export function mechSummary(overrides: Partial<MechRequestSummaryDto> = {}): MechRequestSummaryDto {
  return { pending: 0, awaitingIssue: 0, rental: 0, overdue: 0, ...overrides };
}

/**
 * A receipt version as the mechanization lessor sees it (lessor receipt plan, P12): his own upload,
 * waiting for the visa — no names and no reason but a rejection's are in this shape at all.
 */
export function mechLessorReceiptView(
  overrides: Partial<MechLessorReceiptVersionView> = {},
): MechLessorReceiptVersionView {
  return {
    id: 'lrv-1',
    versionNo: 1,
    status: 'pending',
    file: { id: 'f-lr-1', filename: 'чек-1.pdf', contentType: 'application/pdf', size: 1024 },
    createdAs: 'lessor',
    createdAt: '2026-11-05T08:00:00.000Z',
    decidedAt: null,
    rejectionReason: null,
    retiredAt: null,
    retiredReason: null,
    ...overrides,
  };
}

/**
 * `GET /mech-requests/lessor-rentals[/:id]`: a running rental of the lessor taken into work after the
 * receipt's release, no receipt yet — the state in which his page asks him to act.
 */
export function mechLessorRental(
  overrides: Partial<MechLessorRentalDto> = {},
): MechLessorRentalDto {
  return {
    id: 'mech-1',
    num: 42,
    displayNumber: 'МХ-42',
    version: 7,
    status: 'confirmed',
    mechModelName: 'Виброплита реверсивная Wacker DPU 3070Н',
    objectName: 'ЖК Северный',
    objectAddress: 'г. Москва, ул. Северная, 1',
    plannedFrom: '2026-11-02',
    plannedTo: '2026-11-20',
    actualFrom: '2026-11-02',
    actualTo: null,
    rate: 1500,
    rateUnit: 'shift',
    responsibleName: 'Петров П. П.',
    responsiblePhone: '9000000000',
    lessorReceipt: {
      audience: 'lessor',
      required: true,
      current: null,
      retired: [],
      ownVersionCount: 0,
    },
    ...overrides,
  };
}
