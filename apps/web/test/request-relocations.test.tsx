import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleRouteDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { vehicleRequest } from './factories/vehicle';
import { RequestRelocationsField } from '../src/pages/vehicle/RequestRelocationsField';

/**
 * Перегоны 4-П в правке заявки на площадке: доставка техники на объект и вывоз с него.
 *
 * Их ровно два — по одному на назначение, — и ноль тоже норма: технику везут тралом, и тогда
 * листа не бывает вовсе. Проверяется, что портал предлагает завести только недостающее (второй
 * доставки сервер и не примет) и что убрать можно лишь перегон без выписанного листа: рейс, по
 * которому уходил бланк строгой отчётности, остаётся в журнале навсегда.
 */

const REQUEST = vehicleRequest({
  id: 'vr-7',
  status: 'confirmed',
  objectAddress: 'Химки, ул. Победы, 10',
  assignment: { vehicleId: 'v-1', ownership: 'own' },
} as never);

function relocation(over: Partial<VehicleRouteDto> = {}): VehicleRouteDto {
  return {
    id: 'route-d',
    displayNumber: 'Р-31',
    purpose: 'delivery',
    formCode: '4p',
    sourceRequest: {
      requestId: 'vr-7',
      displayNumber: 'ТС-7',
      status: 'confirmed',
      customerName: 'Объект',
    },
    moveFrom: 'База',
    moveTo: 'Химки, ул. Победы, 10',
    routeDate: '2026-08-10',
    vehicleId: 'v-1',
    vehicleLabel: 'JCB 3CX · У777УУ177',
    vehicleKindId: 'kind-special',
    vehicleTypeId: 'type-excavator',
    vehicleTypeName: 'Экскаваторы',
    vehicleCategoryId: null,
    vehicleCategorySpecs: null,
    driverPersonId: 'p-1',
    driverName: 'Иванов Иван Иванович',
    driverGaps: [],
    withTrailer: false,
    trailerLabel: '',
    trailer1Model: '',
    trailer1RegNumber: '',
    trailer2Model: '',
    trailer2RegNumber: '',
    garageNumber: '',
    communicationKind: 'городское',
    transportationKind: '',
    comment: '',
    requests: [],
    waybill: null,
    createdByName: 'Диспетчер',
    createdAt: '2026-08-09T09:00:00.000Z',
    version: 1,
    ...over,
  };
}

function renderField(relocations: VehicleRouteDto[]) {
  const http = mockHttp({
    'GET /vehicle-requests/:id/relocations': () => json(relocations),
    'DELETE /vehicle-routes/:id': () => json({ ok: true }),
  });
  renderWithUser(<RequestRelocationsField request={REQUEST} />, {
    user: authUser({ role: 'admin' }),
  });
  return http;
}

describe('перегоны 4-П в правке заявки', () => {
  it('предлагает завести только то назначение, которого ещё нет', async () => {
    renderField([relocation()]);

    await screen.findByText('Р-31');
    // Доставка уже заведена — второй такой не бывает; вывоз предложить есть смысл.
    expect(screen.getByText('Вывоз техники с объекта')).toBeDefined();
    expect(screen.queryByText('Доставка техники на объект')).toBeNull();
  });

  it('без перегонов предлагает оба и говорит, что их может не быть вовсе', async () => {
    renderField([]);

    expect(await screen.findByText('Перегонов нет')).toBeDefined();
    expect(screen.getByText('Доставка техники на объект')).toBeDefined();
    expect(screen.getByText('Вывоз техники с объекта')).toBeDefined();
  });

  it('перегон без листа убирается — с подтверждением', async () => {
    const http = renderField([relocation()]);
    await screen.findByText('Р-31');

    fireEvent.click(screen.getByLabelText('Убрать перегон Р-31'));
    fireEvent.click(await screen.findByText('Убрать'));

    await waitFor(() => expect(http.countOf('DELETE /vehicle-routes/:id')).toBe(1));
  });

  it('перегон с выписанным листом не убирается: рейс остаётся в журнале бланков', async () => {
    renderField([
      relocation({
        waybill: {
          id: 'w-1',
          number: '260604-646-00000004897',
          status: 'issued',
          issuedForDate: '2026-08-10',
        },
      }),
    ]);
    await screen.findByText('Р-31');

    expect(screen.getByLabelText<HTMLButtonElement>('Убрать перегон Р-31').disabled).toBe(true);
  });
});
