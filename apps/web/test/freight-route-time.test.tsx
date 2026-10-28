import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { FreightTransportRequestDto, RequestRouteTimeDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { freightRequest, ownAssignment } from './factories/vehicle';
import { VehicleRequestViewModal } from '../src/pages/vehicle/VehicleRequestViewModal';
import { VehicleCompleteModal } from '../src/pages/vehicle/VehicleCompleteModal';

/**
 * The driver's times in a freight request (readings-shifts-merge plan §8, D6, D7, D10, D12): the
 * card's «Факт по точкам» and the completion window's proposal.
 *
 * Both read one server answer (`GET /vehicle-requests/:id/route-time`) and do no arithmetic of their
 * own: the share is split on the server from the stop snapshot, the rounding up to a whole hour is
 * the contracts' (`routeTimePrefill`). So the scenarios check what the person is shown and what the
 * window proposes, not how the share is computed — that is `request-driver-times.db.test.ts`.
 */

/** A freight request in work on an own vehicle with a shift rate: its default unit is shifts. */
const IN_WORK: FreightTransportRequestDto = freightRequest({
  id: 'vr-2',
  status: 'confirmed',
  assignment: ownAssignment({ pricePerHour: 2500, pricePerShift: 18000 }),
});

/** 2 h 10 min recorded: the quarry is shared with another request, the unloading is its own. */
const RECORDED: RequestRouteTimeDto = {
  readings: [
    {
      readingId: 'reading-1',
      reportDate: '2026-08-06',
      seconds: 7800,
      issue: null,
      stops: [
        {
          position: 1,
          location: 'г Москва, ул Карьерная, д 11',
          arrivedAt: '07:00',
          segmentFrom: '07:00',
          departedAt: '08:10',
          sharedBy: 2,
        },
        {
          position: 2,
          location: 'г Москва, ул Северная, д 1',
          arrivedAt: null,
          segmentFrom: '08:10',
          departedAt: '09:45',
          sharedBy: 1,
        },
      ],
    },
  ],
  seconds: 7800,
  issues: [],
};

/** The same reading as a principal with `vehicleReadings.read` receives it (D10). */
const WITH_DIAGNOSTICS: RequestRouteTimeDto = {
  ...RECORDED,
  driver: {
    readings: [
      {
        readingId: 'reading-1',
        personName: 'Грузов Пётр Иванович',
        reportState: 'accepted',
        kind: 'values',
        noDataReason: '',
        comment: '',
      },
    ],
  },
};

function renderCard(request: FreightTransportRequestDto, time?: RequestRouteTimeDto) {
  const http = mockHttp({
    'GET /vehicle-requests/:id/history': () => json([]),
    'GET /vehicle-requests/:id/documents': () => json({ items: [] }),
    'GET /vehicle-requests/:id/waybills': () => json([]),
    'GET /vehicle-requests/:id/driver': () =>
      json({ personId: 'p-1', fullName: 'Грузов Пётр Иванович', phone: '' }),
    ...(time ? { 'GET /vehicle-requests/:id/route-time': () => json(time) } : {}),
  });
  renderWithUser(<VehicleRequestViewModal request={request} onClose={() => {}} />, {
    user: authUser({ role: 'dispatcher' }),
  });
  return http;
}

function renderCompletion(request: FreightTransportRequestDto, time: RequestRouteTimeDto) {
  mockHttp({ 'GET /vehicle-requests/:id/route-time': () => json(time) });
  const onSubmit = vi.fn();
  renderWithUser(
    <VehicleCompleteModal
      request={request}
      onDate="2026-08-06"
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={onSubmit}
      onCompleted={() => {}}
    />,
    { user: authUser({ role: 'dispatcher' }) },
  );
  return onSubmit;
}

describe('«Факт по точкам» в карточке грузоперевозки', () => {
  it('показывает время по заявке и отрезки её точек, общая точка делится поровну', async () => {
    renderCard(IN_WORK, RECORDED);

    expect(await screen.findByText('Факт по точкам')).toBeDefined();
    expect(screen.getAllByText('2 ч 10 мин').length).toBeGreaterThan(0);
    expect(screen.getByText('1. г Москва, ул Карьерная, д 11')).toBeDefined();
    expect(screen.getByText('2. г Москва, ул Северная, д 1')).toBeDefined();
    // The segment of a stop runs from the previous departure; a shared stop says so.
    expect(screen.getByText('08:10 – 09:45')).toBeDefined();
    expect(screen.getByText('поровну на 2 заявки')).toBeDefined();
    // Without `vehicleReadings.read` the server sends no diagnostics, and none is shown.
    expect(screen.queryByText(/Грузов Пётр Иванович · отчёт/)).toBeNull();
  });

  it('держателю права на показания называет, кто сдал и в каком состоянии отчёт (D10)', async () => {
    renderCard(IN_WORK, WITH_DIAGNOSTICS);
    expect(await screen.findByText('Грузов Пётр Иванович · отчёт: принят')).toBeDefined();
  });

  it('без времени говорит, почему его нет', async () => {
    renderCard(IN_WORK, {
      readings: [
        {
          readingId: 'reading-2',
          reportDate: '2026-08-06',
          seconds: null,
          issue: 'no_data',
          stops: [],
        },
      ],
      seconds: null,
      issues: ['no_data'],
    });
    expect(await screen.findByText('нет — смена рейса закрыта без показаний')).toBeDefined();
  });

  it('у новой заявки блока нет и запроса за ним тоже', async () => {
    const http = renderCard(freightRequest({ id: 'vr-2', status: 'new' }));
    await screen.findByText('История');
    expect(screen.queryByText('Факт по точкам')).toBeNull();
    expect(http.countOf('GET /vehicle-requests/:id/route-time')).toBe(0);
  });
});

describe('закрытие грузоперевозки по времени рейса', () => {
  it('предлагает часы — долю по точкам, округлённую вверх до целого часа (D12)', async () => {
    const onSubmit = renderCompletion(IN_WORK, RECORDED);

    // The rate default would be shifts; the recorded time switches the window to hours.
    await waitFor(() =>
      expect(screen.getByLabelText('Отработано часов').getAttribute('value')).toBe('3.00'),
    );
    expect(screen.getByText('По точкам: 2 ч 10 мин → 3 ч, округлено вверх до часа')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Выполнена' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].completion).toMatchObject({
      workedUnit: 'hours',
      workedAmount: 3,
      totalCost: 7500,
    });
  });

  it('без полного времени ничего не подставляет и объясняет почему', async () => {
    renderCompletion(IN_WORK, {
      readings: [
        {
          readingId: 'reading-3',
          reportDate: '2026-08-06',
          seconds: null,
          issue: 'incomplete',
          stops: [],
        },
      ],
      seconds: null,
      issues: ['incomplete'],
    });

    expect(
      await screen.findByText(
        'Время по точкам не подставлено: время по точкам записано не полностью',
      ),
    ).toBeDefined();
    // The window keeps its old default: the rate's unit and one delivery.
    expect(screen.getByLabelText('Отработано смен').getAttribute('value')).toBe('1.00');
  });

  it('прежнее закрытие главнее времени по точкам: его правят, а не набирают заново', async () => {
    renderCompletion(
      {
        ...IN_WORK,
        completion: {
          workedUnit: 'hours',
          workedAmount: 5,
          rate: 2500,
          totalCost: 12500,
          completedBy: 'user-1',
          completedByName: 'Диспетчеров Д. П.',
          completedAt: '2026-08-06T15:00:00.000Z',
          endedOn: null,
          previousDateTo: null,
          workedHours: null,
          workedShifts: null,
          deliveryCost: null,
        },
      },
      RECORDED,
    );
    await screen.findByText('По точкам: 2 ч 10 мин → 3 ч, округлено вверх до часа');
    expect(screen.getByLabelText('Отработано часов').getAttribute('value')).toBe('5.00');
  });
});
