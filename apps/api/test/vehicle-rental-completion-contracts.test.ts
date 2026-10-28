import { describe, expect, it } from 'vitest';
import {
  addVehicleRequestDocumentSchema,
  canAddVehicleRequestDocument,
  canRemoveVehicleRequestDocument,
  completeVehicleRequestSchema,
  completionAsksRentalFacts,
  completionCountsIssue,
  completionFactSchema,
  completionWorkedLabel,
  hoursPerShift,
  hoursPerShiftLabel,
  type Permission,
  type RequestStatus,
  vehicleRequestDocumentDate,
  vehicleRequestDocumentTypeLabel,
} from '@technic/contracts';

/**
 * Rental closing facts and request documents (plan `docs/vehicle-rental-completion-documents-plan.md`):
 * the rules the closing window, the card and the server all ask. The wiring on the live schema is in
 * `vehicle-rental-completion.db.test.ts`.
 */

describe('rental closing body', () => {
  it('accepts both counts and a delivery cost, and an old body without them', () => {
    const full = {
      workedUnit: 'shifts',
      workedAmount: 3,
      totalCost: 54000,
      workedHours: 27,
      workedShifts: 3,
      deliveryCost: 12000,
    };
    expect(completeVehicleRequestSchema.parse(full)).toMatchObject(full);
    expect(completionFactSchema.parse({ ...full, endedOn: '2026-10-14' })).toMatchObject(full);
    // A tab opened before the release sends neither: the body stays valid.
    expect(
      completeVehicleRequestSchema.safeParse({ workedUnit: 'hours', workedAmount: 8 }).success,
    ).toBe(true);
  });

  it('refuses a zero delivery: no delivery is null, not zero', () => {
    const parsed = completeVehicleRequestSchema.safeParse({
      workedUnit: 'shifts',
      workedAmount: 1,
      deliveryCost: 0,
    });
    expect(parsed.success).toBe(false);
    expect(
      completeVehicleRequestSchema.safeParse({
        workedUnit: 'shifts',
        workedAmount: 1,
        deliveryCost: null,
      }).success,
    ).toBe(true);
  });

  it('names the count that contradicts the billed amount', () => {
    expect(
      completionCountsIssue({ workedUnit: 'hours', workedAmount: 27, workedHours: 26 }),
    ).toHaveProperty('workedHours');
    expect(
      completionCountsIssue({ workedUnit: 'shifts', workedAmount: 3, workedShifts: 2.5 }),
    ).toHaveProperty('workedShifts');
    // The other count is a second fact, never compared with the billed one.
    expect(
      completionCountsIssue({
        workedUnit: 'shifts',
        workedAmount: 3,
        workedShifts: 3,
        workedHours: 27,
      }),
    ).toBeNull();
    // An old tab sends neither count.
    expect(completionCountsIssue({ workedUnit: 'hours', workedAmount: 8 })).toBeNull();
  });

  it('asks the rental facts of a rented vehicle only', () => {
    expect(completionAsksRentalFacts({ ownership: 'rental' })).toBe(true);
    expect(completionAsksRentalFacts({ ownership: 'own' })).toBe(false);
    expect(completionAsksRentalFacts(null)).toBe(false);
  });
});

describe('hours per shift', () => {
  it('divides the hours between the shifts to one decimal', () => {
    expect(hoursPerShift(27, 3)).toBe(9);
    expect(hoursPerShift(26, 3)).toBe(8.7);
    expect(hoursPerShift(12, 2.5)).toBe(4.8);
    expect(hoursPerShiftLabel(26, 3)).toBe('по 8,7 ч на смену');
  });

  it('says nothing when a count is missing', () => {
    expect(hoursPerShift(null, 3)).toBeNull();
    expect(hoursPerShift(27, undefined)).toBeNull();
    expect(hoursPerShiftLabel(27, 0)).toBeNull();
  });

  it('labels the billed count first and the other one after it', () => {
    const base = { workedHours: null, workedShifts: null };
    expect(completionWorkedLabel({ ...base, workedUnit: 'shifts', workedAmount: 3 })).toBe(
      '3 смены',
    );
    expect(
      completionWorkedLabel({
        workedUnit: 'shifts',
        workedAmount: 3,
        workedShifts: 3,
        workedHours: 27,
      }),
    ).toBe('3 смены · 27 ч, по 9 ч на смену');
    expect(
      completionWorkedLabel({
        workedUnit: 'hours',
        workedAmount: 27,
        workedHours: 27,
        workedShifts: 3,
      }),
    ).toBe('27 ч · 3 смены, по 9 ч на смену');
  });
});

describe('request documents', () => {
  const leads = (permission: Permission) => permission === 'vehicleRequests.status';
  const reads = (_permission: Permission) => false;
  const dispatcher = { id: 'u-1', role: 'dispatcher' as const };
  const admin = { id: 'u-9', role: 'admin' as const };
  const at = (status: RequestStatus) => ({ status });

  it('takes a free-text type and any date', () => {
    const ok = addVehicleRequestDocumentSchema.parse({
      fileId: '6f1f0f2e-5b8a-4a7e-9a55-1c7d8a2f9b10',
      docType: '  УПД доставки  ',
      docDate: '2027-03-01',
    });
    expect(ok.docType).toBe('УПД доставки');
    expect(
      addVehicleRequestDocumentSchema.safeParse({
        fileId: '6f1f0f2e-5b8a-4a7e-9a55-1c7d8a2f9b10',
        docType: '   ',
        docDate: '2026-10-14',
      }).success,
    ).toBe(false);
    expect(
      addVehicleRequestDocumentSchema.safeParse({
        fileId: '6f1f0f2e-5b8a-4a7e-9a55-1c7d8a2f9b10',
        docType: 'Акт',
      }).success,
    ).toBe(false);
  });

  it('opens adding from «В работе» to the terminal statuses for whoever runs requests', () => {
    expect(canAddVehicleRequestDocument(dispatcher, at('confirmed'), leads)).toBe(true);
    expect(canAddVehicleRequestDocument(dispatcher, at('done'), leads)).toBe(true);
    expect(canAddVehicleRequestDocument(dispatcher, at('cancelled'), leads)).toBe(true);
    expect(canAddVehicleRequestDocument(dispatcher, at('new'), leads)).toBe(false);
    expect(canAddVehicleRequestDocument(dispatcher, at('done'), reads)).toBe(false);
  });

  it('lets the uploader or an administrator remove a document, never an attachment', () => {
    const own = { kind: 'document' as const, uploadedBy: 'u-1' };
    const foreign = { kind: 'document' as const, uploadedBy: 'u-2' };
    const attachment = { kind: 'attachment' as const, uploadedBy: 'u-1' };
    expect(canRemoveVehicleRequestDocument(dispatcher, at('done'), own, leads)).toBe(true);
    expect(canRemoveVehicleRequestDocument(dispatcher, at('done'), foreign, leads)).toBe(false);
    expect(canRemoveVehicleRequestDocument(dispatcher, at('done'), attachment, leads)).toBe(false);
    // Rolled back to «Новая»: the uploader waits for the work, the administrator does not.
    expect(canRemoveVehicleRequestDocument(dispatcher, at('new'), own, leads)).toBe(false);
    expect(canRemoveVehicleRequestDocument(admin, at('new'), foreign, reads)).toBe(true);
    expect(canRemoveVehicleRequestDocument(admin, at('done'), attachment, leads)).toBe(false);
    expect(canRemoveVehicleRequestDocument(null, at('done'), own, leads)).toBe(false);
  });

  it('reads an attachment as the requester’s file dated by its upload', () => {
    const attachment = { docType: null, docDate: null, addedAt: '2026-10-12T09:00:00.000Z' };
    expect(vehicleRequestDocumentTypeLabel(attachment)).toBe('Вложение заявителя');
    expect(vehicleRequestDocumentDate(attachment)).toBe('2026-10-12T09:00:00.000Z');
    const doc = { docType: 'УПД', docDate: '2026-10-14', addedAt: '2026-10-15T09:00:00.000Z' };
    expect(vehicleRequestDocumentTypeLabel(doc)).toBe('УПД');
    expect(vehicleRequestDocumentDate(doc)).toBe('2026-10-14');
  });
});
