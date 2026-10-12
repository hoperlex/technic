import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import type { PeriodPreviewDto } from '@technic/contracts';
import {
  silentTermApplyBody,
  termCommandOf,
  termPreviewIsSilent,
  termRidesWideEdit,
  type FormValues,
} from '@features/vehicle-request-editor';

/**
 * The term step of the editor as pure rules (K3a, S-21 and S-22 of 12.10.2026): when the term door
 * is asked at all, when the term rides the wide PATCH instead, when the door's preview may be
 * applied without the window, and what goes back to it. The screen
 * scenarios live in `vehicle-period-door.test.tsx`; here the boundaries are pinned one by one.
 */

const TERM = { version: 4, dateFrom: '2026-10-12', dateTo: '2026-10-16' };

const form = (dateFrom: string, dateTo: string | null): FormValues =>
  ({
    requestType: 'special_equipment',
    classificationKey: 'vt-1:',
    dateFrom: dayjs(dateFrom),
    dateTo: dateTo ? dayjs(dateTo) : null,
  }) as FormValues;

const SILENT: PeriodPreviewDto = {
  plan: { cancel: [], issue: [] },
  requiredAnchors: [],
  requiredVehicleResolution: null,
  blockedShiftDays: [],
  clearedShiftDays: [],
  clearedShiftsFingerprint: null,
  requiredUnlocks: [],
  unlockFingerprint: null,
  issues: [],
  operationRequirement: null,
  asOf: '2026-10-12',
  fingerprint: 'fp',
  cancelGroups: [],
  cancelGroupsFingerprint: null,
} as PeriodPreviewDto;

describe('правка срока в форме заявки (K3a)', () => {
  it('неизменённый срок дверь не спрашивает: пустую команду она отвергает', () => {
    expect(termCommandOf(form('2026-10-12', '2026-10-16'), TERM)).toBeNull();
    // Freight has no work term at all.
    expect(
      termCommandOf({ ...form('2026-10-12', null), requestType: 'freight_transport' }, TERM),
    ).toBeNull();
  });

  it('изменённый срок уходит обеими границами, снятая дата окончания — null', () => {
    expect(termCommandOf(form('2026-10-12', '2026-10-20'), TERM)).toEqual({
      dateFrom: '2026-10-12',
      dateTo: '2026-10-20',
    });
    expect(termCommandOf(form('2026-10-12', null), TERM)).toEqual({
      dateFrom: '2026-10-12',
      dateTo: null,
    });
  });

  it('срок в широком PATCH — только «Новая» заявка учётки без журнала листов (S-22)', () => {
    expect(termRidesWideEdit('new', false)).toBe(true);
    // A paper reader keeps the door even for a «Новая» order.
    expect(termRidesWideEdit('new', true)).toBe(false);
    // An order in work never: R2 removes the dates from the wide PATCH there.
    expect(termRidesWideEdit('confirmed', false)).toBe(false);
    expect(termRidesWideEdit('confirmed', true)).toBe(false);
  });

  it('молчаливый предпросмотр — только когда показывать и подтверждать нечего', () => {
    expect(termPreviewIsSilent(SILENT, '')).toBe(true);
    const sheet = { waybillId: 'w-1', displayNumber: 'ЭСМ-2 № 1', from: 'a', to: 'b' };
    expect(termPreviewIsSilent({ ...SILENT, plan: { cancel: [sheet], issue: [] } }, '')).toBe(
      false,
    );
    expect(termPreviewIsSilent({ ...SILENT, requiredUnlocks: [sheet] }, '')).toBe(false);
    expect(
      termPreviewIsSilent(
        { ...SILENT, cancelGroups: [{}] as never, cancelGroupsFingerprint: 'fp-g' },
        '',
      ),
    ).toBe(false);
    // A backdated move needs a reason: typed in the form — still silent; missing — the window asks.
    const backdated = {
      ...SILENT,
      operationRequirement: { kind: 'crew', reasonRequired: true, operationIdRequired: true },
      unlockFingerprint: 'fp-empty',
    } as PeriodPreviewDto;
    expect(termPreviewIsSilent(backdated, 'техника вышла вчера')).toBe(true);
    expect(termPreviewIsSilent(backdated, '')).toBe(false);
  });

  it('молчаливое применение везёт ровно те подтверждения, что спросил сервер', () => {
    const command = { dateFrom: '2026-10-12', dateTo: '2026-10-20' };
    const operation = { operationId: 'op-1', reason: 'причина' };
    expect(silentTermApplyBody(TERM, command, SILENT, operation)).toEqual({
      version: 4,
      ...command,
      previewFingerprint: 'fp',
    });
    const backdated = {
      ...SILENT,
      operationRequirement: { kind: 'crew', reasonRequired: true, operationIdRequired: true },
      unlockFingerprint: 'fp-empty',
    } as PeriodPreviewDto;
    expect(silentTermApplyBody(TERM, command, backdated, operation)).toEqual({
      version: 4,
      ...command,
      previewFingerprint: 'fp',
      unlockFingerprint: 'fp-empty',
      operation,
    });
  });
});
