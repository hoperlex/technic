import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import {
  shiftDateKey,
  weeklyWeekBounds,
  weeklyWeekLabel,
  weekStartKey,
  type AnnulWeeklyRequestBody,
  type WeeklyAnnulPreviewDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { weeklyItem, weeklyRequest } from './factories/vehicle';
import { weeklyToday } from '@entities/weekly-request';
import type { WeeklyRequestHistoryEntryDto } from '@entities/weekly-request';
import { WeeklyRequestPage } from '@pages/vehicle';

/**
 * Return of an applied week for re-approval (ADR 0219) on screen.
 *
 * The dispatcher finds a forgotten unit after the approval: the week goes back to "awaiting
 * approval", its consequences are reversed, the site adds the unit and the construction manager
 * approves again. Checked here is what the portal promises the server and the person: who sees the
 * button, what the command body carries, and that the returned week tells why it came back.
 */

/** Next week's Monday: the removed days are ahead, the ordinary branch. */
const WEEK = shiftDateKey(weekStartKey(weeklyToday()), 7);
const WEEK_END = weeklyWeekBounds(WEEK).to;

/** Dispatcher: holds `waybills.correct`, the right of the return. */
const dispatcher = authUser({ id: 'user-disp', role: 'dispatcher' });
/** Construction manager: approves and annuls the site's weeks, but does not return them. */
const rukstroy = authUser({ id: 'user-ruk', role: 'rukstroy', constructionObjectIds: ['obj-1'] });

function week(overrides: Partial<WeeklyVehicleRequestDto> = {}): WeeklyVehicleRequestDto {
  return weeklyRequest({
    id: 'wr-1',
    status: 'applied',
    comment: '',
    weekStart: WEEK,
    weekEnd: WEEK_END,
    weekLabel: weeklyWeekLabel(WEEK),
    items: [
      weeklyItem({ kind: 'extend', sourceRequestId: 'vr-1', dateTo: WEEK_END, result: 'extended' }),
    ],
    version: 7,
    ...overrides,
  });
}

/** The server's plan of the reversal; the window retells it and sends its fingerprint back. */
function preview(over: Partial<WeeklyAnnulPreviewDto> = {}): WeeklyAnnulPreviewDto {
  return {
    weeklyRequestId: 'wr-1',
    weekStart: WEEK,
    weekLabel: weeklyWeekLabel(WEEK),
    today: weeklyToday(),
    effectiveDate: WEEK,
    backdated: false,
    requiresOperation: false,
    correctionFloor: shiftDateKey(weeklyToday(), -30),
    allowed: true,
    blockedReason: null,
    items: [
      {
        itemId: 'wi-1',
        kind: 'extend',
        title: 'Экскаватор (продление)',
        requestId: 'vr-1',
        displayNumber: 'ТС-42',
        state: 'reversible',
        reason: '',
        reverse: 'shorten_to',
        shortenTo: shiftDateKey(WEEK, -1),
        hadEffect: true,
      },
    ],
    blockers: [],
    paper: { cancel: 1, trim: 0, reissue: 0, trimmedTo: null },
    unlockable: [],
    unlockableCount: 0,
    cancelGroups: [],
    cancelGroupsFingerprint: null,
    issues: [],
    linearDays: { detachable: [], frozen: [] },
    shifts: [],
    pendingWeeks: [],
    fingerprint: 'fp-return',
    asOf: weeklyToday(),
    ...over,
  };
}

function routes(initial: WeeklyVehicleRequestDto, history: WeeklyRequestHistoryEntryDto[] = []) {
  const map: RouteMap = {
    'GET /weekly-vehicle-requests/suggestion': () => json(null),
    'GET /weekly-vehicle-requests/:id/return': () => json(preview()),
    'GET /weekly-vehicle-requests/:id/annul': () => json(preview({ fingerprint: 'fp-annul' })),
    'GET /weekly-vehicle-requests/:id': () => json(initial),
    'GET /weekly-vehicle-requests/:id/history': () => json(history),
    'GET /weekly-vehicle-requests/:id/documents': () => json([]),
    'POST /weekly-vehicle-requests/:id/return': () =>
      json({
        weeklyRequestId: 'wr-1',
        status: 'pending',
        shortened: [{ requestId: 'vr-1', displayNumber: 'ТС-42', dateTo: shiftDateKey(WEEK, -1) }],
        cancelled: [],
        released: 0,
        esm2: { cancelled: 1, issued: 0 },
      }),
    'GET /objects': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(emptyList()),
  };
  return map;
}

function renderPage(user: ReturnType<typeof authUser>) {
  return renderWithUser(
    <Routes>
      <Route path="/vehicle-requests/weekly/:id" element={<WeeklyRequestPage />} />
    </Routes>,
    { user, route: '/vehicle-requests/weekly/wr-1' },
  );
}

describe('возврат применённой недели на согласование', () => {
  it('диспетчер возвращает неделю: окно спрашивает причину и отдаёт отпечаток и версию', async () => {
    const http = mockHttp(routes(week()));
    renderPage(dispatcher);

    fireEvent.click(await screen.findByRole('button', { name: 'Вернуть на согласование' }));
    const dialog = await screen.findByRole('dialog');
    // The window says what the week becomes, not only what burns.
    await within(dialog).findByText(/вернётся в «Ждёт визы» без визы/);
    expect(http.countOf('GET /weekly-vehicle-requests/:id/return')).toBe(1);
    expect(http.countOf('GET /weekly-vehicle-requests/:id/annul')).toBe(0);

    fireEvent.change(within(dialog).getByLabelText(/Причина возврата/), {
      target: { value: 'Забыли экскаватор' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Вернуть на согласование/ }));

    await waitFor(() => expect(http.countOf('POST /weekly-vehicle-requests/:id/return')).toBe(1));
    const sent = http.lastCall('POST /weekly-vehicle-requests/:id/return')
      ?.body as AnnulWeeklyRequestBody;
    expect(sent).toEqual({ reason: 'Забыли экскаватор', version: 7, fingerprint: 'fp-return' });
  });

  it('руководитель строительства возврата не видит, а аннулирование у него остаётся', async () => {
    mockHttp(routes(week()));
    renderPage(rukstroy);

    await screen.findByRole('button', { name: 'Аннулировать неделю' });
    expect(screen.queryByRole('button', { name: 'Вернуть на согласование' })).toBeNull();
  });

  it('возвращённая неделя говорит сверху, кто и зачем её вернул', async () => {
    const history: WeeklyRequestHistoryEntryDto[] = [
      {
        id: 'h-1',
        event: 'status',
        fromStatus: 'pending',
        toStatus: 'applied',
        payload: {},
        changedByName: 'Руководитель Р.Р.',
        changedAt: '2026-10-05T09:00:00.000Z',
        comment: '',
      },
      {
        id: 'h-2',
        event: 'status',
        fromStatus: 'applied',
        toStatus: 'pending',
        payload: {},
        changedByName: 'Диспетчер Д.Д.',
        changedAt: '2026-10-06T09:00:00.000Z',
        comment: 'Забыли экскаватор',
      },
    ];
    mockHttp(routes(week({ status: 'pending', items: [weeklyItem({ kind: 'extend' })] }), history));
    renderPage(rukstroy);

    const title = await screen.findByText(/Неделя возвращена на согласование — Диспетчер Д\.Д\./);
    // The reason sits in the banner itself, not only in the history below.
    expect(title.closest('.ant-alert')?.textContent).toContain('Забыли экскаватор');
  });
});
