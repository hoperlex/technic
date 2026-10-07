import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import {
  selectableWeeks,
  weeklyWeekBounds,
  weeklyWeekLabel,
  type UpdateWeeklyRequestBody,
  type WeeklySuggestionDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { weeklyRequestKeys, weeklyToday } from '@entities/weekly-request';
import { WeeklyRequestPage } from '@pages/vehicle';
import { MaintenanceFormModal } from '../src/features/vehicle-maintenance/ui/MaintenanceFormModal';
import { json, mockHttp, type HttpMock, type MockResponse } from './http';
import { renderWithUser } from './render';
import { renderWithProps } from './propsDriver';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { weeklyRequest } from './factories/vehicle';

/**
 * Group "R1" of appendix A4 (stage 5 plan §4.5, wave 1): the forms that a reread on returning to
 * the browser tab would wipe, protected before decision R1 is taken.
 */

const NOTICE = 'Запись изменена другим пользователем';

describe('maintenance act form', () => {
  it('a reread of the summary with a new odometer does not touch the open form', async () => {
    const { update } = renderWithProps(MaintenanceFormModal, {
      vehicleId: 'v-1',
      vehicleLabel: 'А123АА77',
      record: null,
      history: [],
      lastOdometer: { km: 128400, measuredOn: '2026-10-01' } as { km: number; measuredOn: string },
      open: true,
      onClose: () => {},
    });
    const odometer = () => screen.getByLabelText('Пробег на момент ТО, км') as HTMLInputElement;
    const act_ = () => screen.getByLabelText('Номер документа') as HTMLInputElement;
    await waitFor(() => expect(odometer().value).toBe('128400'));
    fireEvent.change(act_(), { target: { value: 'Акт № 7' } });

    // A colleague's reading arrives with the summary reread: before, the hint was a reset dependency.
    update({ lastOdometer: { km: 129000, measuredOn: '2026-10-07' } });
    expect(odometer().value).toBe('128400');
    expect(act_().value).toBe('Акт № 7');

    // A new opening takes the fresh hint and starts empty.
    update({ open: false });
    update({ open: true });
    await waitFor(() => expect(odometer().value).toBe('129000'));
    expect(act_().value).toBe('');
  });
});

describe('weekly composition', () => {
  const shtab = authUser({ id: 'user-shtab', role: 'shtab', constructionObjectIds: ['obj-1'] });
  const WEEK = selectableWeeks(weeklyToday())[0]!;
  const WEEK_END = weeklyWeekBounds(WEEK).to;
  const SUGGESTION: WeeklySuggestionDto = {
    objectId: 'obj-1',
    weekStart: WEEK,
    weekEnd: WEEK_END,
    weekLabel: weeklyWeekLabel(WEEK),
    extend: [],
    leaving: [],
    beyond: [],
    blocked: [],
    previous: null,
    existingRequestId: 'wr-1',
  };
  const draft = (over: Partial<WeeklyVehicleRequestDto> = {}): WeeklyVehicleRequestDto =>
    weeklyRequest({
      id: 'wr-1',
      status: 'draft',
      // Not empty: the textarea shows it only once the composition is built from the request and
      // the suggestion — typing before that would race the first fill, not test a reread.
      comment: 'исходный',
      objectId: 'obj-1',
      weekStart: WEEK,
      weekEnd: WEEK_END,
      weekLabel: weeklyWeekLabel(WEEK),
      items: [],
      version: 3,
      ...over,
    });
  const SAVE = 'PATCH /weekly-vehicle-requests/:id';
  const DETAIL = 'GET /weekly-vehicle-requests/:id';

  function renderPage(save?: () => MockResponse) {
    let current = draft();
    const http = mockHttp({
      'GET /weekly-vehicle-requests/suggestion': () => json(SUGGESTION),
      [DETAIL]: () => json(current),
      'GET /weekly-vehicle-requests/:id/history': () => json([]),
      'GET /objects': () => json(emptyList()),
      'GET /vehicle-classifications': () => json(emptyList()),
      [SAVE]: ({ body }) => {
        if (save) return save();
        const sent = body as UpdateWeeklyRequestBody;
        current = draft({ comment: sent.comment, version: current.version + 1 });
        return json(current);
      },
    });
    const { queryClient } = renderWithUser(
      <Routes>
        <Route path="/vehicle-requests/weekly/:id" element={<WeeklyRequestPage />} />
      </Routes>,
      { user: shtab, route: '/vehicle-requests/weekly/wr-1' },
    );
    return {
      http,
      serve: (next: WeeklyVehicleRequestDto) => (current = next),
      reread: async () => {
        const before = http.countOf(DETAIL);
        await act(() => queryClient.invalidateQueries({ queryKey: weeklyRequestKeys.root }));
        await waitFor(() => expect(http.countOf(DETAIL)).toBeGreaterThan(before));
      },
    };
  }

  const comment = () =>
    screen.getByPlaceholderText('Что важно знать о неделе') as HTMLTextAreaElement;
  const built = () => waitFor(() => expect(comment().value).toBe('исходный'));
  const saveVersion = (http: HttpMock) =>
    (http.lastCall(SAVE)!.body as UpdateWeeklyRequestBody).version;

  it('a colleague’s save over the dispatcher’s edits: kept under the notice, saved with the old version', async () => {
    const { http, serve, reread } = renderPage(() =>
      json({ code: 'version_conflict', message: 'Версия устарела' }, 409),
    );
    await built();
    fireEvent.change(comment(), { target: { value: 'кран нужен с понедельника' } });

    serve(draft({ version: 4, comment: 'от коллеги' }));
    await reread();
    expect(await screen.findByText(NOTICE)).toBeDefined();
    expect(comment().value).toBe('кран нужен с понедельника');

    fireEvent.click(screen.getByText('Сохранить черновик'));
    await waitFor(() => expect(http.countOf(SAVE)).toBe(1));
    expect(saveVersion(http)).toBe(3);
  });

  it('«Перечитать» rebuilds the composition from the colleague’s version', async () => {
    const { serve, reread } = renderPage();
    await built();
    fireEvent.change(comment(), { target: { value: 'кран нужен с понедельника' } });
    serve(draft({ version: 4, comment: 'от коллеги' }));
    await reread();

    fireEvent.click(await screen.findByText('Перечитать'));
    await waitFor(() => expect(comment().value).toBe('от коллеги'));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('an untouched composition follows the colleague silently', async () => {
    const { http, serve, reread } = renderPage();
    await built();

    serve(draft({ version: 4, comment: 'от коллеги' }));
    await reread();
    await waitFor(() => expect(comment().value).toBe('от коллеги'));
    expect(screen.queryByText(NOTICE)).toBeNull();

    fireEvent.change(comment(), { target: { value: 'от коллеги и от меня' } });
    fireEvent.click(screen.getByText('Сохранить черновик'));
    await waitFor(() => expect(http.countOf(SAVE)).toBe(1));
    expect(saveVersion(http)).toBe(4);
  });

  it('the page’s own save moves the version: no notice, the next save goes on top of it', async () => {
    const { http } = renderPage();
    await built();
    fireEvent.change(comment(), { target: { value: 'первая правка' } });
    fireEvent.click(screen.getByText('Сохранить черновик'));
    await waitFor(() => expect(http.countOf(SAVE)).toBe(1));
    await waitFor(() => expect(http.countOf(DETAIL)).toBeGreaterThan(1));

    fireEvent.change(comment(), { target: { value: 'вторая правка' } });
    expect(screen.queryByText(NOTICE)).toBeNull();
    fireEvent.click(screen.getByText('Сохранить черновик'));
    await waitFor(() => expect(http.countOf(SAVE)).toBe(2));
    expect(saveVersion(http)).toBe(4);
  });
});
