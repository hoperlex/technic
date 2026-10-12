import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { MailingScheduleDto } from '@technic/contracts';
import { mailLogKeys } from '@entities/mail-log';
import { MailingSchedulesBlock } from '../src/pages/admin/MailingSchedulesBlock';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { expectCarriersRefetched, primeCarriers } from './carrierRefresh';

/**
 * A manual run of a mailing schedule queues one letter per recipient (`queueMail` in the run
 * service), and the mail log lists them under the «Аудит» tab of the same section. The run
 * refreshed its runs and schedules but not the log, and a log tab already visited kept the list
 * as it was before the run: a plain tab pane stays mounted and nothing refetched it.
 */

const schedule: MailingScheduleDto = {
  id: '11111111-1111-1111-1111-111111111111',
  type: 'role_digest',
  name: 'Диспетчерская сводка',
  isEnabled: true,
  sendAt: '18:00',
  runWeekdays: [1, 2, 3, 4, 5],
  windowFromDays: 1,
  windowDays: 1,
  nextRunAt: null,
  version: 3,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  excludedRunDates: [],
  excludedRouteDates: [],
  excludedPersonIds: [],
  permissions: ['waybills.read'],
  requestScope: 'scope',
  showTrips: true,
  showOnsite: true,
  scopeMode: 'all',
  objectIds: [],
  departmentIds: [],
  recipientMode: 'all',
  recipientUserIds: [],
};

describe('mail log carried from a manual mailing run', () => {
  it('refreshes the mail log after the run queued its letters', async () => {
    const http = mockHttp({
      'GET /admin/mail/schedules': () => json([schedule]),
      'GET /admin/mail/runs': () => json(list([])),
      'POST /admin/mail/schedules/:id/run': () =>
        json({
          ok: true,
          runId: 'run-1',
          stats: { sent: 2, withoutEmail: 0, excluded: 0, empty: 0 },
        }),
    });
    const { queryClient } = renderWithUser(<MailingSchedulesBlock />, {
      user: authUser({ role: 'admin' }),
    });
    const carriers = [mailLogKeys.list({})];
    primeCarriers(queryClient, carriers);

    fireEvent.click(await screen.findByRole('button', { name: 'Запустить сейчас' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Запустить' }));

    await waitFor(() => expect(http.countOf('POST /admin/mail/schedules/:id/run')).toBe(1));
    await waitFor(() => expect(queryClient.getQueryState(carriers[0]!)?.isInvalidated).toBe(true));
    await expectCarriersRefetched(queryClient, carriers);
  });
});
