import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  shiftDateKey,
  weekStartKey,
  type AnnulWeeklyRequestBody,
  type FuelNormSettingsDto,
  type MechRequestDto,
  type WeeklyAnnulPreviewDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { weeklyToday } from '@entities/weekly-request';
import { FuelNormSettingsModal } from '../src/features/fuel-norm-management/ui/FuelNormSettingsModal';
import { MechCompleteModal } from '../src/features/mech-complete';
import { MechIssueModal } from '../src/features/mech-issue';
import { WeeklyRequestReversalModal } from '../src/widgets/weekly-request-workspace/ui/WeeklyRequestReversalModal';
import { dateInput } from './antd';
import { json, mockHttp } from './http';
import { renderWithProps } from './propsDriver';
import { mechRequest } from './factories/mech';
import { weeklyRequest } from './factories/vehicle';

/**
 * Windows without an optimistic-lock version against rereads (stage 5 plan §4.5 and appendix A4,
 * wave 1): they are filled once per window session, and a reread of the record does not touch the
 * fields; the default date is taken when the window opens and does not jump at midnight.
 */

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe('fuel norm settings', () => {
  const SETTINGS: FuelNormSettingsDto = {
    winterFromMd: '11-01',
    winterToMd: '03-31',
    tolerancePercent: 5,
    updatedAt: '2026-09-01T09:00:00.000Z',
    updatedByName: null,
  };

  it('settings loaded before opening fill the window; a reread does not touch it; reopening fills anew', async () => {
    const { update } = renderWithProps(FuelNormSettingsModal, {
      open: false,
      settings: SETTINGS as FuelNormSettingsDto | null,
      onCancel: () => {},
    });

    update({ open: true });
    await waitFor(() => expect(field('Допуск, %').value).toBe('5.0'));
    fireEvent.change(field('Допуск, %'), { target: { value: '7' } });

    update({ settings: { ...SETTINGS, tolerancePercent: 9 } });
    expect(field('Допуск, %').value).toBe('7.0');

    update({ open: false });
    update({ open: true });
    await waitFor(() => expect(field('Допуск, %').value).toBe('9.0'));
  });
});

describe('reversal of an applied week', () => {
  const WEEK = shiftDateKey(weekStartKey(weeklyToday()), 7);
  const REQUEST: WeeklyVehicleRequestDto = weeklyRequest({
    id: 'wr-1',
    status: 'applied',
    weekStart: WEEK,
    version: 7,
  });
  const PREVIEW = {
    weeklyRequestId: 'wr-1',
    weekStart: WEEK,
    weekLabel: '',
    today: weeklyToday(),
    effectiveDate: WEEK,
    backdated: true,
    requiresOperation: true,
    correctionFloor: shiftDateKey(weeklyToday(), -30),
    allowed: true,
    blockedReason: null,
    items: [],
    blockers: [],
    paper: { cancel: 0, trim: 0, reissue: 0, trimmedTo: null },
    unlockable: [],
    unlockableCount: 0,
    cancelGroups: [],
    cancelGroupsFingerprint: null,
    issues: [],
    linearDays: { detachable: [], frozen: [] },
    shifts: [],
    pendingWeeks: [],
    fingerprint: 'fp-annul',
    asOf: weeklyToday(),
  } as WeeklyAnnulPreviewDto;

  it('a reread keeps the reason and the operation key; only a new opening invents a new key', async () => {
    mockHttp({ 'GET /weekly-vehicle-requests/:id/annul': () => json(PREVIEW) });
    const sent: AnnulWeeklyRequestBody[] = [];
    const { update } = renderWithProps(WeeklyRequestReversalModal, {
      intent: 'annul',
      request: REQUEST as WeeklyVehicleRequestDto | null,
      onClose: () => {},
      onSubmit: (body: AnnulWeeklyRequestBody) => sent.push(body),
      pending: false,
    });
    const reason = await screen.findByLabelText('Причина аннулирования');
    fireEvent.change(reason, { target: { value: 'неделю завели дважды' } });

    // The page rereads the week after a neighbouring action: a new object of the same request.
    update({ request: { ...REQUEST } });
    expect(field('Причина аннулирования').value).toBe('неделю завели дважды');
    fireEvent.click(screen.getByText('Аннулировать'));
    await waitFor(() => expect(sent).toHaveLength(1));

    // A repeat after a dropped connection goes with the same key — the server answers "repeated".
    update({ request: { ...REQUEST } });
    fireEvent.click(screen.getByText('Аннулировать'));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.correction!.operationId).toBe(sent[0]!.correction!.operationId);

    update({ request: null });
    update({ request: REQUEST });
    await waitFor(() => expect(field('Причина аннулирования').value).toBe(''));
    fireEvent.change(field('Причина аннулирования'), { target: { value: 'снова' } });
    fireEvent.click(screen.getByText('Аннулировать'));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]!.correction!.operationId).not.toBe(sent[0]!.correction!.operationId);
  });
});

describe('mechanization windows keep the date of their opening', () => {
  afterEach(() => vi.useRealTimers());

  /** 23:59 Moscow time on 7 October, then two minutes later. */
  const beforeMidnight = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T20:59:00.000Z'));
  };
  const afterMidnight = () => vi.setSystemTime(new Date('2026-10-07T21:01:00.000Z'));

  it('issue: opened before midnight, the window keeps yesterday; a new opening takes today', async () => {
    beforeMidnight();
    const request = mechRequest({ status: 'confirmed', actualFrom: null });
    const { update } = renderWithProps(MechIssueModal, {
      request: request as MechRequestDto | null,
      onClose: () => {},
    });
    await waitFor(() => expect(dateInput('Дата фактической выдачи').value).toBe('07.10.2026'));

    afterMidnight();
    update({ request: { ...request } });
    expect(dateInput('Дата фактической выдачи').value).toBe('07.10.2026');

    update({ request: null });
    update({ request });
    await waitFor(() => expect(dateInput('Дата фактической выдачи').value).toBe('08.10.2026'));
  });

  it('completion: the numbers being typed survive a re-render past midnight', async () => {
    beforeMidnight();
    const request = mechRequest({ status: 'confirmed', actualFrom: '2026-10-01', actualTo: null });
    const { update } = renderWithProps(MechCompleteModal, {
      request: request as MechRequestDto | null,
      onClose: () => {},
    });
    await waitFor(() => expect(dateInput('Фактический возврат').value).toBe('07.10.2026'));
    fireEvent.change(field('Итоговая стоимость, ₽'), { target: { value: '45000' } });

    afterMidnight();
    update({ request: { ...request } });
    expect(dateInput('Фактический возврат').value).toBe('07.10.2026');
    expect(field('Итоговая стоимость, ₽').value).toContain('45');
  });
});
