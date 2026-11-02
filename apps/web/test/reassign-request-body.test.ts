import { describe, expect, it } from 'vitest';
import { reassignRequestBody } from '@features/vehicle-assignment';

/**
 * The body of the vehicle change (`PATCH /vehicle-requests/:id/assignment`) as the requests list
 * sends it: the window's command plus the version, and every handshake only when the window has
 * one — the server rejects a superfluous handshake as strictly as a missing one.
 */
describe('тело смены техники', () => {
  const command = {
    assignment: { vehicleId: 'v-2', pricePerHour: null, pricePerShift: 20000, shiftHours: null },
    schedule: null,
  };

  it('без показанных последствий — одно назначение и версия', () => {
    expect(reassignRequestBody(command, 5)).toEqual({ ...command.assignment, version: 5 });
  });

  it('дата смены и причина заднего числа уезжают в тело только когда окно их назвало', () => {
    expect(reassignRequestBody({ ...command, effectiveDate: '2026-11-04' }, 5)).toEqual({
      ...command.assignment,
      version: 5,
      effectiveDate: '2026-11-04',
    });
    expect(
      reassignRequestBody(
        { ...command, effectiveDate: '2026-10-30', backdateReason: 'ехала другая машина' },
        5,
      ),
    ).toEqual({
      ...command.assignment,
      version: 5,
      effectiveDate: '2026-10-30',
      backdateReason: 'ехала другая машина',
    });
  });

  it('после подтверждения несёт отпечаток и подписи по листам', () => {
    expect(
      reassignRequestBody(
        { ...command, previewFingerprint: 'fp-1', acknowledgements: { '0': 'fp-warn-1' } },
        5,
      ),
    ).toEqual({
      ...command.assignment,
      version: 5,
      previewFingerprint: 'fp-1',
      acknowledgements: { '0': 'fp-warn-1' },
    });
  });
});
