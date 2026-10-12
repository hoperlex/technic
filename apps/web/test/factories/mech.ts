import type { MechRequestDto, MechRequestSummaryDto } from '@technic/contracts';

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
    ...overrides,
  };
}

/** `GET /mech-requests/summary`: the counters above the list, everything zero by default. */
export function mechSummary(overrides: Partial<MechRequestSummaryDto> = {}): MechRequestSummaryDto {
  return { pending: 0, awaitingIssue: 0, rental: 0, overdue: 0, ...overrides };
}
