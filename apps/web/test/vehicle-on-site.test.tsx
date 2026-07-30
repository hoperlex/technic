import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import type { SpecialEquipmentRequestDto, VehicleOnSiteListDto } from '@technic/contracts';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, setViewport } from './viewport';

/**
 * Вкладка «На объекте» (ADR 0036): техника, которая работает на объектах сегодня.
 *
 * Проверяется то, ради чего вкладку открывают: строка отвечает, что за машина стоит на площадке
 * и что для неё значит сегодняшний день — вышла, стоит или уезжает. День среза берётся из ответа
 * API (`onDate`), а не из часов браузера, поэтому подписи присутствия проверяются на фиксированном
 * дне без подмены системного времени.
 */

const ON_DATE = '2026-07-24';

function request(
  over: Partial<SpecialEquipmentRequestDto> & { id: string; num: number; dateFrom: string },
): SpecialEquipmentRequestDto {
  return {
    requestType: 'special_equipment',
    displayNumber: `ТС-${over.num}`,
    objectId: 'obj-1',
    objectCode: 'OBJ-A',
    objectName: 'Альфа-объект',
    vehicleTypeId: 'type-1',
    vehicleTypeName: 'Автокраны',
    vehicleCategoryId: null,
    vehicleCategoryName: null,
    status: 'confirmed',
    comment: '',
    cancelReason: null,
    approvedBy: 'user-1',
    approvedByName: 'Руков Р. Р.',
    approvedAt: '2026-07-20T09:00:00.000Z',
    assignment: null,
    completion: null,
    files: [],
    version: 1,
    createdBy: 'user-1',
    createdByName: 'Иванов И. И.',
    createdAt: '2026-07-19T09:00:00.000Z',
    updatedAt: '2026-07-19T09:00:00.000Z',
    deletedAt: null,
    dateTo: null,
    responsibleName: 'Петров П. П.',
    responsiblePhone: '+7 926 000-00-01',
    ...over,
  };
}

const items: SpecialEquipmentRequestDto[] = [
  request({
    id: 'r1',
    num: 101,
    dateFrom: ON_DATE,
    dateTo: '2026-07-28',
    comment: 'разработка котлована',
    assignment: {
      vehicleId: 'v1',
      ownership: 'rental',
      typeName: 'Автокраны',
      categoryName: 'Автокран, г/п 130 т',
      modelName: null,
      registrationNumber: null,
      description: 'Автокран 70 тн',
      lessorId: 'c1',
      lessorName: 'ООО «Арендатех»',
      pricePerHour: null,
      pricePerShift: 18000,
      shiftHours: 8,
      assignedBy: 'user-2',
      assignedByName: 'Петров П. П.',
      assignedAt: '2026-07-23T09:00:00.000Z',
    },
  }),
  request({ id: 'r2', num: 102, dateFrom: '2026-07-22', dateTo: '2026-07-26' }),
  request({ id: 'r3', num: 103, dateFrom: '2026-07-20', dateTo: ON_DATE }),
];

const list: VehicleOnSiteListDto = { items, total: 3, page: 1, pageSize: 50, onDate: ON_DATE };

vi.mock('../src/api/resources', () => ({
  vehicleRequestsApi: {
    onSite: async () => list,
    onSiteSummary: async () => ({ total: 3, objects: 1, arrivedToday: 1, leavingToday: 1 }),
    history: async () => [],
  },
  objectsApi: { list: async () => ({ items: [], total: 0, page: 1, pageSize: 500 }) },
  vehicleClassificationsApi: {
    list: async () => ({ items: [], total: 0, page: 1, pageSize: 500 }),
  },
  filesApi: {},
}));

vi.mock('../src/auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', role: 'dispatcher', constructionObjectId: null },
    can: () => true,
    hasRole: () => false,
  }),
}));

const { VehicleRequestsOnSiteTab } = await import('../src/pages/vehicle/VehicleRequestsOnSiteTab');

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App>
        <VehicleRequestsOnSiteTab />
      </App>
    </QueryClientProvider>,
  );
}

describe('вкладка «На объекте»', () => {
  it('строка отвечает, что за машина стоит и что для неё значит сегодня', async () => {
    setViewport(DESKTOP_VIEWPORT);
    renderTab();

    // Машина из назначения (ADR 0027) с арендодателем — по нему и звонят про простой.
    expect(await screen.findByText('ООО «Арендатех»')).toBeDefined();
    expect(screen.getAllByText('Альфа-объект').length).toBeGreaterThan(0);

    // Присутствие в сегодняшнем дне: вышла, стоит, уезжает — по датам и `onDate` из ответа.
    expect(screen.getByText('вышла сегодня')).toBeDefined();
    expect(screen.getByText('на объекте')).toBeDefined();
    expect(screen.getByText('уезжает сегодня')).toBeDefined();
    // Который день из заказанных идёт: у периода 22–26 июля на 24-е это третий из пяти.
    expect(screen.getByText('день 3 из 5')).toBeDefined();
  });

  it('на телефоне тот же срез читается карточками', async () => {
    setViewport(MOBILE_VIEWPORT);
    renderTab();

    expect(await screen.findByText('ООО «Арендатех»')).toBeDefined();
    expect(document.querySelector('.ant-table')).toBeNull();
    expect(document.querySelectorAll('.list-card')).toHaveLength(3);
    expect(screen.getByText('вышла сегодня')).toBeDefined();
  });

  it('действий у среза нет: заявку только открывают карточкой', async () => {
    setViewport(DESKTOP_VIEWPORT);
    renderTab();

    expect(await screen.findByText('ООО «Арендатех»')).toBeDefined();
    // Ни статусов, ни визы, ни правки — их ведут в списке заказов.
    expect(screen.queryByText('Согласовать')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Изменить статус' })).toBeNull();
    expect(screen.getAllByText('Карточка')).toHaveLength(3);
  });
});
