import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleDto, VehicleRouteDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { VehicleRoutesTab } from '../src/pages/vehicle/VehicleRoutesTab';

/**
 * Фильтры вкладки маршрутов: полоса полей над таблицей, а не выпадашки в заголовках столбцов.
 *
 * Проверяется главное свойство такого отбора — он серверный: рейсов за день десятки, и «найти
 * машину» глазами по загруженной странице не то же самое, что спросить её у сервера. Отдельно —
 * что смена фильтра возвращает список на первую страницу: та же страница при другом отборе
 * означала бы уже другие рейсы.
 */

const VEHICLE: VehicleDto = {
  id: 'v-own',
  ownership: 'own',
  description: '',
  registrationNumber: 'Е646СК799',
  modelName: 'КамАЗ 65201',
  typeName: 'Самосвалы',
  categoryName: null,
} as VehicleDto;

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
  driverName: 'Иванов Иван Иванович',
  driverGaps: [],
  withTrailer: false,
  trailerLabel: '',
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '',
  communicationKind: '',
  transportationKind: '',
  comment: '',
  requests: [],
  // Порядок объезда сценарию не нужен: он проверяет не сборку дня, а рейс целиком.
  points: [],
  waybill: null,
  createdByName: 'Диспетчер',
  createdAt: '2026-08-06T09:00:00.000Z',
  version: 1,
};

function renderTab() {
  const http = mockHttp({
    'GET /vehicle-routes': () => json(list([ROUTE])),
    'GET /vehicles': () => json(list([VEHICLE])),
    'GET /drivers': () => json(list([{ id: 'p-1', fullName: 'Иванов Иван Иванович' } as never])),
  });
  renderWithUser(<VehicleRoutesTab />, { user: authUser({ role: 'admin' }) });
  return http;
}

/** Поле панели опознаётся своей подсказкой: подписи у фильтров нет, её место занимает placeholder. */
async function pickFilter(placeholder: string, option: string | RegExp) {
  const field = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('.ant-select')].find(
      (el) => el.textContent?.trim() === placeholder,
    );
    if (!found) throw new Error(`фильтра «${placeholder}» на экране нет`);
    return found;
  });
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  await waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
      (o) =>
        typeof option === 'string'
          ? o.textContent?.includes(option)
          : option.test(o.textContent ?? ''),
    );
    expect(match).toBeTruthy();
    fireEvent.click(match!);
  });
}

describe('маршруты: фильтры панелью над таблицей', () => {
  it('в заголовках столбцов фильтров не осталось', async () => {
    renderTab();
    await screen.findByText('Р-12');
    expect(document.querySelectorAll('.ant-table-filter-trigger').length).toBe(0);
  });

  it('техника отбирается сервером, а не загруженной страницей', async () => {
    const http = renderTab();
    await waitFor(() => expect(http.countOf('GET /vehicle-routes')).toBe(1));
    expect(http.lastCall('GET /vehicle-routes')!.query.get('vehicleId')).toBeNull();

    // Машина названа парой «госномер — марка/модель» (ADR 0098): по одному номеру её узнают не
    // всегда, и в справочнике техники она представлена этими же двумя графами.
    await pickFilter('Вся техника', 'Е646СК799 — КамАЗ 65201');

    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-routes')!.query.get('vehicleId')).toBe('v-own'),
    );
  });

  it('состояние листа уходит своим параметром', async () => {
    const http = renderTab();
    await waitFor(() => expect(http.countOf('GET /vehicle-routes')).toBe(1));

    await pickFilter('Лист: любой', 'Без листа');

    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-routes')!.query.get('waybill')).toBe('none'),
    );
  });

  it('поиск ищет рейс по номеру, госномеру и водителю одним полем', async () => {
    const http = renderTab();
    await waitFor(() => expect(http.countOf('GET /vehicle-routes')).toBe(1));

    const input = screen.getByPlaceholderText('Р-12, госномер или водитель');
    fireEvent.change(input, { target: { value: 'Е646СК799' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-routes')!.query.get('search')).toBe('Е646СК799'),
    );
  });

  it('смена фильтра возвращает список на первую страницу', async () => {
    const http = renderTab();
    await waitFor(() => expect(http.countOf('GET /vehicle-routes')).toBe(1));

    await pickFilter('Лист: любой', 'Лист выписан');

    await waitFor(() => expect(http.lastCall('GET /vehicle-routes')!.query.get('page')).toBe('1'));
  });
});
