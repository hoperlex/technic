import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleRouteDto, VehicleRouteRequestDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { selectOption } from './antd';
import { VehicleRouteTransferCorrectionModal } from '../src/pages/vehicle/VehicleRouteTransferCorrectionModal';

/**
 * Окно переноса заявки между рейсами прошедших дней (ADR 0101, Р30).
 *
 * Проверяется здесь главное обещание окна: **оба сгорающих номера названы до нажатия** (§5 п. 2
 * плана). Перенос — единственная команда портала, которая жжёт два номера строгой отчётности сразу,
 * и человек, нажимающий кнопку, обязан прочитать это заранее: после нажатия исправлять уже нечего.
 *
 * Второе — что уходит на сервер: обе версии рейсов и ключ идемпотентности, придуманный до отправки
 * (Р31). Тело, пересобранное со свежей версией, сервер повтором не признает, поэтому версии
 * фиксируются на открытие окна.
 */

const REQUEST: VehicleRouteRequestDto = {
  requestId: 'r-move',
  displayNumber: 'ТС-501',
  position: 2,
  workDate: null,
  status: 'confirmed',
  customerName: 'Объект А',
  loadingLocation: 'Карьер',
  unloadingLocation: 'Площадка 1',
  scheduledAt: '2026-08-07T06:00:00.000Z',
  scheduledTimeUnspecified: false,
  cargoLabel: '12 м³',
};

const SOURCE: VehicleRouteDto = {
  id: 'route-source',
  displayNumber: 'Р-12',
  purpose: 'freight',
  formCode: '4p',
  sourceRequest: null,
  moveFrom: '',
  moveTo: '',
  routeDate: '2026-08-07',
  vehicleId: 'v-own',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  vehicleKindId: 'kind-freight',
  vehicleTypeId: 'type-dump',
  vehicleTypeName: 'Самосвалы',
  vehicleCategoryId: null,
  vehicleCategorySpecs: null,
  driverPersonId: 'p-1',
  driverName: 'Тестовый Водитель Первый',
  driverGaps: [],
  withTrailer: false,
  trailerLabel: '',
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '00000389',
  communicationKind: 'городское',
  transportationKind: 'коммерческая',
  comment: '',
  requests: [{ ...REQUEST, requestId: 'r-stay', displayNumber: 'ТС-500', position: 1 }, REQUEST],
  // Порядок объезда сценарию не нужен: он проверяет не сборку дня, а рейс целиком.
  points: [],
  waybill: {
    id: 'w-source',
    number: '260604-646-00000004897',
    status: 'issued',
    issuedForDate: '2026-08-07',
  },
  createdByName: 'Диспетчер',
  createdAt: '2026-08-06T09:00:00.000Z',
  version: 3,
};

/** Приёмник — другой день и другая машина: заявка поедет ею (ADR 0052 п. 4). */
const TARGET: VehicleRouteDto = {
  ...SOURCE,
  id: 'route-target',
  displayNumber: 'Р-9',
  routeDate: '2026-08-06',
  vehicleId: 'v-other',
  vehicleLabel: 'МАЗ 5516 · А777АА797',
  requests: [{ ...REQUEST, requestId: 'r-other', displayNumber: 'ТС-499', position: 1 }],
  // Порядок объезда сценарию не нужен: он проверяет не сборку дня, а рейс целиком.
  points: [],
  waybill: {
    id: 'w-target',
    number: '260604-646-00000004890',
    status: 'issued',
    issuedForDate: '2026-08-06',
  },
  version: 5,
};

/** Последствия считает сервер — окно только показывает их (Р36). */
const preview = (route: VehicleRouteDto) => ({
  routeDate: route.routeDate,
  today: '2026-08-12',
  blocking: null,
  waybill: route.waybill,
  requests: route.requests.map((r) => ({
    requestId: r.requestId,
    displayNumber: r.displayNumber,
    position: r.position,
    workDate: r.workDate,
    status: r.status,
    assignedVehicleId: route.vehicleId,
  })),
  shifts: [],
});

function renderModal(options: { source?: VehicleRouteDto; blocking?: unknown } = {}) {
  const source = options.source ?? SOURCE;
  const http = mockHttp({
    'GET /vehicle-routes': () =>
      json({ items: [source, TARGET], total: 2, page: 1, pageSize: 200 }),
    'GET /vehicle-routes/:id/correction': ({ params }) =>
      json({
        ...preview(params.id === TARGET.id ? TARGET : source),
        ...(options.blocking && params.id === TARGET.id ? { blocking: options.blocking } : {}),
      }),
    'POST /vehicle-routes/:id/correction/transfer': () =>
      json({
        target: { ...TARGET, waybill: { ...TARGET.waybill!, number: 'НОВЫЙ-ПРИЁМНИК' } },
        source: { ...source, waybill: { ...source.waybill!, number: 'НОВЫЙ-ИСТОЧНИК' } },
      }),
  });
  renderWithUser(
    <VehicleRouteTransferCorrectionModal
      route={source}
      request={REQUEST}
      onClose={() => {}}
      onDone={() => {}}
    />,
    { user: authUser({ role: 'dispatcher' }) },
  );
  return http;
}

describe('перенос между рейсами задним числом: окно', () => {
  it('называет оба сгорающих номера — второй появляется вместе с выбором приёмника', async () => {
    renderModal();
    // Номер источника известен сразу: он сгорит при любом приёмнике.
    expect(await screen.findByText(/Номер 260604-646-00000004897 рейса Р-12/)).toBeDefined();
    expect(screen.getByText(/его номер сгорит вторым/)).toBeDefined();

    // Список приёмников приезжает запросом: пока он не пришёл, поле заперто.
    await screen.findByText('Куда ехала на самом деле');
    await selectOption('Рейс-приёмник', /Р-9/);

    // Второй номер назван до нажатия (§5 п. 2 плана).
    expect(await screen.findByText(/Номер 260604-646-00000004890 рейса Р-9/)).toBeDefined();
    // И то, что заявка поедет машиной приёмника, — тоже до нажатия.
    expect(screen.getByText(/поедет машиной приёмника/)).toBeDefined();
    expect(screen.getByText(/День рейса сменится/)).toBeDefined();
  });

  it('опустевший источник назван отдельно: второго листа ему не выпишут', async () => {
    // В источнике остаётся один талон — тот самый, который переносят.
    renderModal({ source: { ...SOURCE, requests: [REQUEST] } });
    expect(await screen.findByText(/рейс останется пустым/)).toBeDefined();
  });

  it('без причины на сервер ничего не уходит, а с причиной уходят обе версии и ключ операции', async () => {
    const http = renderModal();
    await screen.findByText('Куда ехала на самом деле');
    await selectOption('Рейс-приёмник', /Р-9/);

    fireEvent.click(screen.getByText('Перенести и перевыписать листы'));
    await screen.findByText('Укажите причину');
    expect(http.countOf('POST /vehicle-routes/:id/correction/transfer')).toBe(0);

    fireEvent.change(screen.getByPlaceholderText(/заявку оформили средой/), {
      target: { value: 'Ехала вторничным рейсом' },
    });
    fireEvent.click(screen.getByText('Перенести и перевыписать листы'));

    await waitFor(() =>
      expect(http.countOf('POST /vehicle-routes/:id/correction/transfer')).toBe(1),
    );
    const call = http.lastCall('POST /vehicle-routes/:id/correction/transfer')!;
    const body = call.body as Record<string, unknown>;
    // Приёмник — в пути, источник — в теле вместе со своей версией: сервер жжёт оба номера и
    // сверяет обе версии (Р24).
    expect(call.path).toContain(TARGET.id);
    expect(body.version).toBe(TARGET.version);
    expect(body.source).toEqual({ routeId: SOURCE.id, version: SOURCE.version });
    expect(body.requestId).toBe(REQUEST.requestId);
    expect(body.reason).toBe('Ехала вторничным рейсом');
    // Ключ идемпотентности придуман до отправки (Р31).
    expect(String(body.operationId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('состав приёмника не в работе — окно называет заявки и не даёт отправить', async () => {
    const http = renderModal({
      blocking: {
        reason: 'Лист печатает задание по всему составу, поэтому рейс исправляется только целиком.',
        requests: ['ТС-499'],
        // Порядок объезда сценарию не нужен: он проверяет не сборку дня, а рейс целиком.
        points: [],
      },
    });
    await screen.findByText('Куда ехала на самом деле');
    await selectOption('Рейс-приёмник', /Р-9/);
    await screen.findByText('Перенести сейчас нельзя');
    expect(screen.getByText(/Заявки: ТС-499/)).toBeDefined();

    fireEvent.change(screen.getByPlaceholderText(/заявку оформили средой/), {
      target: { value: 'Ехала вторничным рейсом' },
    });
    fireEvent.click(screen.getByText('Перенести и перевыписать листы'));

    await waitFor(() =>
      expect(screen.getAllByText(/исправляется только целиком/).length).toBeGreaterThan(0),
    );
    expect(http.countOf('POST /vehicle-routes/:id/correction/transfer')).toBe(0);
  });
});
