import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import {
  selectableWeeks,
  weeklyWeekBounds,
  weeklyWeekLabel,
  type UpdateWeeklyRequestBody,
  type WeeklySuggestionDto,
  type WeeklySuggestionOrderDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { apiError, json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { weeklyItem, weeklyRequest } from './factories/vehicle';
import { WeeklyRequestPage } from '../src/pages/vehicle/WeeklyRequestPage';
import { weeklyToday } from '../src/pages/vehicle/weeklyShared';

/**
 * Подача недельной заявки: состав, показанный экраном, обязан доехать до сервера.
 *
 * Свежий черновик заводится **пустым** — состав человек собирает уже в нём, а умолчание «остаётся»
 * по каждой стоящей единице подставляет предложение портала. Отсюда и живой отказ: экран считал
 * умолчания «тем же, что на сервере», подача уходила без сохранения, и сервер отвечал 422
 * «Решение не принято ни по одной единице — состав пуст» по документу, который человек видел
 * заполненным. Поэтому мок повторяет серверное правило: подача пустого состава здесь отказывает
 * так же, как настоящая ручка.
 */

/** Штаб площадки: состав ведёт, визу не ставит — на экране кнопка «Подать», а не автовиза. */
const shtab = authUser({ id: 'user-shtab', role: 'shtab', constructionObjectIds: ['obj-1'] });

const WEEK = selectableWeeks(weeklyToday())[0]!;
const WEEK_END = weeklyWeekBounds(WEEK).to;

/** Стоящая на площадке единица, предложенная к продлению отмеченной (`included`). */
const ORDER: WeeklySuggestionOrderDto = {
  requestId: 'vr-1',
  num: 42,
  displayNumber: 'ТС-42',
  dateFrom: '2026-08-05',
  dateTo: '2026-08-14',
  effectiveDateTo: '2026-08-14',
  vehicleTypeName: 'Экскаваторы-погрузчики',
  vehicleCategoryName: null,
  vehicleId: 'v-1',
  vehicleLabel: 'JCB 3CX · А123АА77',
  ownership: 'own',
  suggestedDateTo: WEEK_END,
  extendBlockedReason: null,
  included: true,
  warnings: [],
};

const SUGGESTION: WeeklySuggestionDto = {
  objectId: 'obj-1',
  weekStart: WEEK,
  weekEnd: WEEK_END,
  weekLabel: weeklyWeekLabel(WEEK),
  extend: [ORDER],
  leaving: [],
  beyond: [],
  blocked: [],
  previous: null,
  existingRequestId: 'wr-1',
};

function draft(overrides: Partial<WeeklyVehicleRequestDto> = {}): WeeklyVehicleRequestDto {
  return weeklyRequest({
    id: 'wr-1',
    status: 'draft',
    comment: '',
    weekStart: WEEK,
    weekEnd: WEEK_END,
    weekLabel: weeklyWeekLabel(WEEK),
    items: [],
    version: 3,
    ...overrides,
  });
}

/**
 * Маршруты экрана вокруг заявки, живущей между запросами: PATCH переписывает её состав и поднимает
 * версию, а подача сверяет состав так же, как сервер, — по тому, что сохранено, а не по тому, что
 * прислано в теле перехода.
 */
function pageRoutes(initial: WeeklyVehicleRequestDto, over: RouteMap = {}): RouteMap {
  let current = initial;
  return {
    // Порядок важен: `suggestion` совпал бы с шаблоном `:id`, стой он ниже.
    'GET /weekly-vehicle-requests/suggestion': () => json(SUGGESTION),
    'GET /weekly-vehicle-requests/:id': () => json(current),
    'GET /weekly-vehicle-requests/:id/history': () => json([]),
    'PATCH /weekly-vehicle-requests/:id': ({ body }) => {
      const sent = body as UpdateWeeklyRequestBody;
      current = weeklyRequest({
        ...current,
        comment: sent.comment,
        version: current.version + 1,
        items: sent.items.map((item, index) =>
          weeklyItem({
            id: `wi-${index + 1}`,
            position: index,
            kind: item.kind,
            sourceRequestId: item.kind === 'new' ? null : item.sourceRequestId,
            dateTo: item.kind === 'leave' ? null : (item.dateTo ?? null),
          }),
        ),
      });
      return json(current);
    },
    'POST /weekly-vehicle-requests/:id/status': ({ body }) => {
      const sent = body as { status: string };
      if (sent.status === 'pending' && current.items.length === 0) {
        return apiError(422, {
          code: 'unprocessable_entity',
          message: 'Решение не принято ни по одной единице — состав пуст',
        });
      }
      current = weeklyRequest({ ...current, status: 'pending', version: current.version + 1 });
      return json({ request: current, apply: null });
    },
    'GET /objects': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(emptyList()),
    ...over,
  };
}

function renderPage() {
  return renderWithUser(
    <Routes>
      <Route path="/vehicle-requests/weekly/:id" element={<WeeklyRequestPage />} />
    </Routes>,
    { user: shtab, route: '/vehicle-requests/weekly/wr-1' },
  );
}

const button = (name: string) => screen.findByRole<HTMLButtonElement>('button', { name });

describe('подача недельной заявки', () => {
  it('сохраняет умолчания предложения перед подачей — состав пустым не уходит', async () => {
    const http = mockHttp(pageRoutes(draft()));
    renderPage();

    const submit = await button('Подать');
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await screen.findByText('Заявка подана на визу');
    const saved = http.lastCall('PATCH /weekly-vehicle-requests/:id')
      ?.body as UpdateWeeklyRequestBody;
    expect(saved.items).toEqual([{ kind: 'extend', sourceRequestId: 'vr-1', dateTo: WEEK_END }]);
    // Версия перехода — та, что вернул PATCH: подача по прежней разошлась бы с блокировкой сервера.
    expect(http.lastCall('POST /weekly-vehicle-requests/:id/status')?.body).toMatchObject({
      status: 'pending',
      version: 4,
    });
  });

  it('предложенный, но не сохранённый состав считается несохранённой правкой', async () => {
    mockHttp(pageRoutes(draft()));
    renderPage();

    const save = await button('Сохранить черновик');
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it('состав, уже лежащий на сервере, подача повторно не переписывает', async () => {
    const stored = draft({
      items: [weeklyItem({ kind: 'extend', sourceRequestId: 'vr-1', dateTo: WEEK_END })],
    });
    const http = mockHttp(pageRoutes(stored));
    renderPage();

    const submit = await button('Подать');
    await waitFor(() => expect(submit.disabled).toBe(false));
    expect((await button('Сохранить черновик')).disabled).toBe(true);
    fireEvent.click(submit);

    await screen.findByText('Заявка подана на визу');
    expect(http.countOf('PATCH /weekly-vehicle-requests/:id')).toBe(0);
  });
});
