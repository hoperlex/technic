import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleRouteDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { selectOption } from './antd';
import { VehicleRouteCorrectionModal } from '../src/pages/vehicle/VehicleRouteCorrectionModal';

/**
 * Окно коррекции рейса задним числом (ADR 0101, Р18/Р34/Р36).
 *
 * Проверяется здесь не форма, а её главное обещание: **цена операции названа до нажатия**. Номер,
 * который сгорит; заявки, которые сменят машину; подписи смен, которые снимутся; бумага, которая
 * уже уходила; файлы, которые не переедут. Человек, нажимающий «Исправить», должен знать это
 * заранее — узнать после уже нечего исправлять, номер израсходован.
 *
 * Второе — линейные дни (ADR 0100 п. 4): их назначение коррекция не трогает, и окно обязано
 * сказать это отдельной строкой, иначе перечень «сменят машину» прочтётся и про них.
 */

const ROUTE: VehicleRouteDto = {
  id: 'route-1',
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
  requests: [
    {
      requestId: 'r-1',
      displayNumber: 'ТС-501',
      position: 1,
      status: 'confirmed',
      customerName: 'Объект А',
      loadingLocation: 'Карьер',
      unloadingLocation: 'Площадка 1',
      scheduledAt: '2026-08-07T06:00:00.000Z',
      scheduledTimeUnspecified: false,
      cargoLabel: '12 м³',
    },
  ],
  // Порядок объезда сценарию не нужен: он проверяет рейс целиком, а не сборку дня.
  points: [],
  waybill: {
    id: 'w-1',
    number: '260604-646-00000004897',
    status: 'issued',
    issuedForDate: '2026-08-07',
  },
  createdByName: 'Диспетчер',
  createdAt: '2026-08-06T09:00:00.000Z',
  version: 3,
};

/** Последствия считает сервер — окно только показывает их (Р36). */
const PREVIEW = {
  routeDate: '2026-08-07',
  today: '2026-08-12',
  blocking: null,
  waybill: ROUTE.waybill,
  requests: [
    {
      requestId: 'r-1',
      displayNumber: 'ТС-501',
      position: 1,
      workDate: null,
      status: 'confirmed',
      assignedVehicleId: 'v-own',
    },
    // День линейного заказа: его назначение не переписывается (ADR 0100 п. 4).
    {
      requestId: 'r-2',
      displayNumber: 'ТС-777',
      position: 2,
      workDate: '2026-08-07',
      status: 'confirmed',
      assignedVehicleId: 'v-own',
    },
  ],
  shifts: [
    {
      requestId: 'r-2',
      displayNumber: 'ТС-777',
      date: '2026-08-07',
      approvedByName: 'Прорабов Иван',
      approvedAt: '2026-08-08T09:00:00.000Z',
    },
  ],
};

/** Карточка листа: отметки печати и подшитые файлы приходят из журнала (Р18, Р34). */
const SHEET = {
  id: 'w-1',
  number: '260604-646-00000004897',
  status: 'issued',
  printedAt: '2026-08-07T05:30:00.000Z',
  exportedAt: null,
  files: [{ id: 'f-1', filename: 'оборот.pdf', contentType: 'application/pdf', size: 10 }],
};

const FLEET = {
  items: [
    {
      id: 'v-own',
      ownership: 'own',
      status: 'active',
      description: '',
      categoryName: null,
      typeName: 'Самосвалы',
      registrationNumber: 'Е646СК799',
      modelName: 'КамАЗ 65201',
    },
    // Списанная машина в списке остаётся (Р17): исправляют задним числом как раз такую.
    {
      id: 'v-other',
      ownership: 'own',
      status: 'retired',
      description: '',
      categoryName: null,
      typeName: 'Самосвалы',
      registrationNumber: 'А777АА797',
      modelName: 'МАЗ 5516',
    },
  ],
  total: 2,
  page: 1,
  pageSize: 500,
};

const SELECTION = {
  requiredCategory: 'C',
  requiredCategoryType: 'driver_license',
  drivers: [
    {
      personId: 'p-1',
      fullName: 'Тестовый Водитель Первый',
      personnelNo: 'Т-001',
      credentialTypeCode: 'driver_license',
      licenseNumber: '00 00 000001',
      licenseExpiresOn: '2031-03-12',
      verificationStatus: 'verified',
      categories: ['C'],
      gaps: [],
      matchesRequiredCategory: true,
      workedRoutes: 0,
      lastWorkedOn: null,
    },
    {
      personId: 'p-2',
      fullName: 'Тестовый Водитель Второй',
      personnelNo: 'Т-002',
      credentialTypeCode: 'driver_license',
      licenseNumber: '00 00 000002',
      licenseExpiresOn: '2031-03-12',
      verificationStatus: 'verified',
      categories: ['C'],
      gaps: [],
      matchesRequiredCategory: true,
      workedRoutes: 0,
      lastWorkedOn: null,
    },
  ],
};

function renderModal(preview: Record<string, unknown> = PREVIEW) {
  const http = mockHttp({
    'GET /vehicle-routes/:id/correction': () => json(preview),
    'GET /waybills/:id': () => json(SHEET),
    'GET /vehicles': () => json(FLEET),
    'GET /drivers/available': () => json(SELECTION),
    'POST /vehicle-routes/:id/correction': ({ body }) =>
      json({ ...ROUTE, ...(body as object), waybill: { ...ROUTE.waybill, number: 'НОВЫЙ-НОМЕР' } }),
  });
  renderWithUser(
    <VehicleRouteCorrectionModal route={ROUTE} onClose={() => {}} onSaved={() => {}} />,
    { user: authUser({ role: 'dispatcher' }) },
  );
  return http;
}

describe('коррекция рейса: окно', () => {
  it('называет цену операции до нажатия', async () => {
    renderModal();
    await screen.findByText('Причина коррекции');

    // Какой номер сгорит (Р10).
    expect(await screen.findByText(/260604-646-00000004897 будет аннулирован/)).toBeDefined();
    // Подпись смены, которая снимется (Р5) — с тем, кто её ставил.
    expect(await screen.findByText(/Снимется подпись смены ТС-777/)).toBeDefined();
    expect(screen.getByText(/принял Прорабов Иван/)).toBeDefined();
    // Бумага уже уходила (Р18) и подшитые файлы не переедут (Р34).
    expect(screen.getByText(/Лист уже печатали/)).toBeDefined();
    expect(screen.getByText(/подшито файлов: 1/)).toBeDefined();
    // Линейный день назван отдельно: его назначение остаётся прежним (ADR 0100 п. 4).
    expect(screen.getByText(/Дни линейных заказов \(ТС-777\)/)).toBeDefined();
  });

  it('без причины на сервер ничего не уходит, а с причиной уходит ключ операции и версия', async () => {
    const http = renderModal();
    await screen.findByText('Причина коррекции');

    await selectOption('Машина рейса', /А777АА797/);
    fireEvent.click(screen.getByText('Исправить и выписать лист'));
    await screen.findByText('Укажите причину');
    expect(http.countOf('POST /vehicle-routes/:id/correction')).toBe(0);

    fireEvent.change(screen.getByPlaceholderText(/На рейс выехала другая машина/), {
      target: { value: 'Ехала другая машина' },
    });
    fireEvent.click(screen.getByText('Исправить и выписать лист'));

    await waitFor(() => expect(http.countOf('POST /vehicle-routes/:id/correction')).toBe(1));
    const body = http.lastCall('POST /vehicle-routes/:id/correction')!.body as Record<
      string,
      unknown
    >;
    expect(body.vehicleId).toBe('v-other');
    expect(body.reason).toBe('Ехала другая машина');
    expect(body.version).toBe(3);
    // Ключ идемпотентности придуман до отправки (Р31): без него повтор после обрыва связи сжёг бы
    // второй номер бланка.
    expect(String(body.operationId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('тело, ничего не меняющее, на сервер не уходит — номер бланка не жгут впустую', async () => {
    const http = renderModal();
    await screen.findByText('Причина коррекции');

    fireEvent.change(screen.getByPlaceholderText(/На рейс выехала другая машина/), {
      target: { value: 'Ошиблись окном' },
    });
    fireEvent.click(screen.getByText('Исправить и выписать лист'));

    await screen.findByText(/Коррекция должна что-то менять/);
    expect(http.countOf('POST /vehicle-routes/:id/correction')).toBe(0);
  });

  it('состав не в работе — окно называет заявки и не даёт отправить', async () => {
    const http = renderModal({
      ...PREVIEW,
      blocking: {
        reason: 'Лист печатает задание по всему составу, поэтому рейс исправляется только целиком.',
        requests: ['ТС-501'],
        // Порядок объезда сценарию не нужен: он проверяет не сборку дня, а рейс целиком.
        points: [],
      },
    });
    await screen.findByText('Рейс сейчас не исправить');
    expect(screen.getByText(/Заявки: ТС-501/)).toBeDefined();

    fireEvent.change(screen.getByPlaceholderText(/На рейс выехала другая машина/), {
      target: { value: 'Ехала другая машина' },
    });
    fireEvent.click(screen.getByText('Исправить и выписать лист'));

    await waitFor(() =>
      expect(screen.getAllByText(/исправляется только целиком/).length).toBeGreaterThan(0),
    );
    expect(http.countOf('POST /vehicle-routes/:id/correction')).toBe(0);
  });
});
