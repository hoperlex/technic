import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import {
  shiftDateKey,
  weeklyWeekBounds,
  weeklyWeekLabel,
  weekStartKey,
  type ApproveWeeklyRequestBody,
  type WeeklyCorrectionPreviewDto,
  type WeeklySuggestionDto,
  type WeeklySuggestionOrderDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { weeklyItem, weeklyRequest } from './factories/vehicle';
import { WeeklyRequestPage } from '../src/pages/vehicle/WeeklyRequestPage';
import { weeklyToday } from '../src/pages/vehicle/weeklyShared';

/**
 * Просроченная недельная заявка на экране: черновик дожил до своей недели, техника эти дни
 * отработала, и провести неделю всё равно надо.
 *
 * До сих пор экран был тупиком — кнопки погашены, снять заявку нельзя было даже там, где API это
 * разрешал. Теперь просроченную неделю проводит тот, у кого право прошлого (`waybills.correct`),
 * и виза по ней становится операцией задним числом (ADR 0101): с причиной, ценой и записью в
 * журнал коррекций. Право визы у остальных при этом не отнято — отклонить заявку руководитель
 * площадки может по-прежнему: отказ прошлого не двигает.
 *
 * Проверяется здесь ровно то, что портал обещает серверу: кто какую кнопку видит, что уходит в
 * теле визы и что человеку сказано вместо отказа.
 */

/** Понедельник текущей недели: она уже началась, то есть просрочена по определению правила. */
const WEEK = weekStartKey(weeklyToday());
const WEEK_END = weeklyWeekBounds(WEEK).to;

/** Диспетчер: право прошлого есть, права визы недельных заявок нет вовсе. */
const dispatcher = authUser({ id: 'user-disp', role: 'dispatcher' });
/** Руководитель строительства: визирует свою площадку, прошлое ему закрыто. */
const rukstroy = authUser({
  id: 'user-ruk',
  role: 'rukstroy',
  constructionObjectIds: ['obj-1'],
});

/** Единица, стоящая на площадке: без неё экран считает состав пустым и гасит все решения. */
const ORDER: WeeklySuggestionOrderDto = {
  requestId: 'vr-1',
  num: 42,
  displayNumber: 'ТС-42',
  dateFrom: shiftDateKey(WEEK, -7),
  dateTo: WEEK_END,
  effectiveDateTo: WEEK_END,
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

/** Заявка, ждущая решения: состав уже сохранён, иначе решать нечего. */
function pending(overrides: Partial<WeeklyVehicleRequestDto> = {}): WeeklyVehicleRequestDto {
  return weeklyRequest({
    id: 'wr-1',
    status: 'pending',
    comment: '',
    weekStart: WEEK,
    weekEnd: WEEK_END,
    weekLabel: weeklyWeekLabel(WEEK),
    items: [weeklyItem({ kind: 'extend', sourceRequestId: 'vr-1', dateTo: WEEK_END })],
    version: 5,
    ...overrides,
  });
}

/** Предпросмотр проведения: что операция тронет в прошлом — считает сервер, экран его пересказывает. */
function preview(over: Partial<WeeklyCorrectionPreviewDto> = {}): WeeklyCorrectionPreviewDto {
  return {
    weeklyRequestId: 'wr-1',
    weekStart: WEEK,
    weekEnd: WEEK_END,
    weekLabel: weeklyWeekLabel(WEEK),
    today: weeklyToday(),
    overdue: true,
    effectiveDate: WEEK_END,
    backdated: true,
    correctionFloor: shiftDateKey(weeklyToday(), -30),
    allowed: true,
    blockedReason: null,
    unlockable: [
      {
        waybillId: 'wb-1',
        requestId: 'vr-1',
        displayNumber: 'ТС-42',
        number: '260604-646-00000004897',
        periodFrom: shiftDateKey(WEEK, -7),
        periodTo: shiftDateKey(WEEK, -1),
      },
    ],
    pastWeeks: [],
    ...over,
  };
}

function pageRoutes(
  initial: WeeklyVehicleRequestDto,
  correction: WeeklyCorrectionPreviewDto,
  over: RouteMap = {},
): RouteMap {
  let current = initial;
  return {
    // Порядок важен: `suggestion` совпал бы с шаблоном `:id`, стой он ниже.
    'GET /weekly-vehicle-requests/suggestion': () => json(SUGGESTION),
    'GET /weekly-vehicle-requests/:id/correction': () => json(correction),
    'GET /weekly-vehicle-requests/:id': () => json(current),
    'GET /weekly-vehicle-requests/:id/history': () => json([]),
    'POST /weekly-vehicle-requests/:id/approval': ({ body }) => {
      const sent = body as ApproveWeeklyRequestBody;
      current = weeklyRequest({
        ...current,
        status: sent.approved ? 'applied' : 'draft',
        version: current.version + 1,
      });
      return json({
        request: current,
        apply: sent.approved
          ? {
              weeklyRequestId: 'wr-1',
              status: 'applied',
              applied: 1,
              skipped: 0,
              items: [],
              esm2: [],
            }
          : null,
      });
    },
    'POST /weekly-vehicle-requests/:id/status': () => {
      current = weeklyRequest({ ...current, status: 'cancelled', version: current.version + 1 });
      return json({ request: current, apply: null });
    },
    // Чек-лист документов экран спрашивает у применённой заявки: проведённая неделя показывает,
    // что из бумаг по ней уже есть.
    'GET /weekly-vehicle-requests/:id/documents': () => json([]),
    'GET /objects': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(emptyList()),
    ...over,
  };
}

function renderPage(user: ReturnType<typeof authUser>) {
  return renderWithUser(
    <Routes>
      <Route path="/vehicle-requests/weekly/:id" element={<WeeklyRequestPage />} />
    </Routes>,
    { user, route: '/vehicle-requests/weekly/wr-1' },
  );
}

const button = (name: string | RegExp) => screen.findByRole<HTMLButtonElement>('button', { name });

describe('просроченная недельная заявка', () => {
  it('право прошлого открывает проведение, а обычной визы у диспетчера нет', async () => {
    mockHttp(pageRoutes(pending(), preview()));
    renderPage(dispatcher);

    // Виза просроченной недели называется тем, чем она является: операцией задним числом.
    await button(/Провести задним числом/);
    // Отклонение — решение о составе, и оно осталось у визирующего площадки.
    expect(screen.queryByRole('button', { name: 'Отклонить' })).toBeNull();
  });

  it('окно проведения спрашивает причину и отдаёт её вместе с ключом операции', async () => {
    const http = mockHttp(pageRoutes(pending(), preview()));
    renderPage(dispatcher);

    // Кнопка ждёт состава: он приезжает предложением, и до него решать нечего.
    const conduct = await button(/Провести задним числом/);
    await waitFor(() => expect(conduct.disabled).toBe(false));
    fireEvent.click(conduct);
    // Предпросмотр приходит с сервера: тем же расчётом, которым потом отработает проведение.
    await waitFor(() =>
      expect(http.countOf('GET /weekly-vehicle-requests/:id/correction')).toBeGreaterThan(0),
    );
    // Лист отработанной недели предложен поимённо — «все прошлые» сожгли бы не тот номер.
    await screen.findByText(/00000004897/);

    const confirm = await button(/Провести и завизировать/);
    fireEvent.click(confirm);
    // Без причины операция не уходит: разрыв нумерации бланков не объясняется ничем.
    await waitFor(() => expect(http.countOf('POST /weekly-vehicle-requests/:id/approval')).toBe(0));

    const reason = await screen.findByLabelText(/Причина/);
    fireEvent.change(reason, {
      target: { value: 'Техника отработала неделю, провели с опозданием' },
    });
    fireEvent.click(await button(/Провести и завизировать/));

    await waitFor(() => expect(http.countOf('POST /weekly-vehicle-requests/:id/approval')).toBe(1));
    const sent = http.lastCall('POST /weekly-vehicle-requests/:id/approval')
      ?.body as ApproveWeeklyRequestBody;
    expect(sent.approved).toBe(true);
    expect(sent.correction?.reason).toBe('Техника отработала неделю, провели с опозданием');
    // Ключ идемпотентности придумывает клиент до отправки: повтор после обрыва не жжёт номера.
    expect(sent.correction?.operationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('без права прошлого экран не тупик: отклонить и снять заявку по-прежнему можно', async () => {
    mockHttp(pageRoutes(pending(), preview({ allowed: false, blockedReason: 'Нет права' })));
    renderPage(rukstroy);

    // Провести неделю руководитель площадки не может — и экран называет того, кто может.
    expect(screen.queryByRole('button', { name: /Провести задним числом/ })).toBeNull();
    expect((await screen.findAllByText(/диспетчер или администратор/)).length).toBeGreaterThan(0);
    await button('Отклонить');
    // Дефект, закрытый вместе с задачей: снятие API разрешает всегда, а кнопка пряталась.
    await button('Снять заявку');
  });
});
