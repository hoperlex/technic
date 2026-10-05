import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  ContainerTypeDto,
  CounterpartyDto,
  WasteTariffDto,
  WasteTypeDto,
} from '@technic/contracts';
import { WasteTariffsTab } from '../src/pages/directories/WasteTariffsTab';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';

const NOW = '2026-01-01T00:00:00.000Z';

const wasteType: WasteTypeDto = {
  id: 'waste-soil',
  code: 'soil',
  name: 'Чистый грунт',
  description: '',
  sortOrder: 10,
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
};

const containerType: ContainerTypeDto = {
  id: 'container-truck',
  code: 'dump_truck',
  name: 'Самосвал',
  type: 'truck',
  volumeM3: 20,
  sortOrder: 10,
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
};

function operator(id: string, name: string): CounterpartyDto {
  return {
    id,
    type: 'operator',
    name,
    inn: id === 'operator-main' ? '7707083893' : '7710140679',
    email: '',
    comment: '',
    synonyms: [],
    objects: [],
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

const mainOperator = operator('operator-main', 'Транс Инвест');
const secondOperator = operator('operator-second', 'Тринити');

function tariff(overrides: Partial<WasteTariffDto> = {}): WasteTariffDto {
  return {
    id: 'tariff-soil-truck',
    operatorCounterpartyId: mainOperator.id,
    operatorName: mainOperator.name,
    wasteTypeId: wasteType.id,
    wasteTypeName: wasteType.name,
    containerTypeId: containerType.id,
    containerTypeName: containerType.name,
    containerVolumeM3: containerType.volumeM3,
    containerKind: null,
    pricePerM3: 900,
    pricePerContainer: null,
    isPerContainer: false,
    note: 'Базовая ставка',
    isActive: true,
    ...overrides,
  };
}

function renderTab(currentTariff = tariff()): HttpMock {
  const http = mockHttp({
    'GET /waste-tariffs': () => json(list([currentTariff])),
    'GET /waste-types': () => json(list([wasteType])),
    'GET /container-types': () => json(list([containerType])),
    'GET /counterparties': () => json(list([mainOperator, secondOperator])),
    'PATCH /waste-tariffs/:id': ({ body }) =>
      json({ ...currentTariff, ...(body as Partial<WasteTariffDto>) }),
    'PATCH /waste-types/:id': ({ body }) =>
      json({ ...wasteType, ...(body as Partial<WasteTypeDto>) }),
  });
  renderWithUser(<WasteTariffsTab />, {
    user: authUser({ id: 'user-admin', role: 'admin' }),
  });
  return http;
}

async function waitForGrid(http: HttpMock): Promise<void> {
  await screen.findByRole('button', { name: /900/ });
  await waitFor(() => {
    expect(http.countOf('GET /waste-tariffs')).toBe(1);
    expect(http.countOf('GET /waste-types')).toBe(1);
  });
}

function modalBody(): HTMLElement {
  const body = document.querySelector('.ant-modal-body');
  if (!body) throw new Error('modal is not open');
  return body as HTMLElement;
}

function saveButton(): HTMLElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.ant-modal button')].find(
    (candidate) => candidate.textContent === 'Сохранить',
  );
  if (!button) throw new Error('save button is missing');
  return button;
}

function tariffSwitch(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('tbody button[role="switch"]');
  if (!button) throw new Error('tariff switch is missing');
  return button;
}

describe('waste tariff directory', () => {
  it('renders the pair-by-operator grid and exposes an empty operator cell for creation', async () => {
    const http = renderTab();

    await waitForGrid(http);
    expect(screen.getByText(wasteType.name)).toBeTruthy();
    expect(screen.getByText(containerType.name)).toBeTruthy();
    expect(screen.getAllByText(mainOperator.name).length).toBeGreaterThan(0);
    expect(screen.getAllByText(secondOperator.name).length).toBeGreaterThan(0);
    expect(screen.getByTitle(`Задать цену — ${secondOperator.name}`)).toBeTruthy();
  });

  it('updates a price and refreshes both tariff and waste-type query families', async () => {
    const http = renderTab();
    await waitForGrid(http);

    fireEvent.click(screen.getByRole('button', { name: /900/ }));
    const body = modalBody();
    const price = within(body).getByLabelText('Цена за м³');
    fireEvent.change(price, { target: { value: '975' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(http.countOf('PATCH /waste-tariffs/:id')).toBe(1));
    expect(http.lastCall('PATCH /waste-tariffs/:id')!.body).toMatchObject({
      wasteTypeId: wasteType.id,
      pricePerM3: 975,
      pricePerContainer: null,
      isActive: true,
    });
    await waitFor(() => {
      expect(http.countOf('GET /waste-tariffs')).toBeGreaterThan(1);
      expect(http.countOf('GET /waste-types')).toBeGreaterThan(1);
    });
  });

  it('edits the waste type from its grid row and refreshes both affected query families', async () => {
    const http = renderTab();
    await waitForGrid(http);

    fireEvent.click(screen.getByTitle('Переименовать тип мусора'));
    const body = modalBody();
    fireEvent.change(within(body).getByLabelText('Название'), {
      target: { value: 'Грунт без примесей' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => expect(http.countOf('PATCH /waste-types/:id')).toBe(1));
    expect(http.lastCall('PATCH /waste-types/:id')!.body).toEqual({
      name: 'Грунт без примесей',
      isActive: true,
    });
    await waitFor(() => {
      expect(http.countOf('GET /waste-types')).toBeGreaterThan(1);
      expect(http.countOf('GET /waste-tariffs')).toBeGreaterThan(1);
    });
  });

  it('enables an inactive price without confirmation and refreshes the tariff grid', async () => {
    const http = renderTab(tariff({ isActive: false }));
    await waitForGrid(http);

    fireEvent.click(tariffSwitch());

    await waitFor(() => expect(http.countOf('PATCH /waste-tariffs/:id')).toBe(1));
    expect(http.lastCall('PATCH /waste-tariffs/:id')!.body).toEqual({ isActive: true });
    await waitFor(() => expect(http.countOf('GET /waste-tariffs')).toBeGreaterThan(1));
  });

  it('confirms before disabling an active price and refreshes the tariff grid', async () => {
    const http = renderTab();
    await waitForGrid(http);

    fireEvent.click(tariffSwitch());
    expect(http.countOf('PATCH /waste-tariffs/:id')).toBe(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Отключить' }));

    await waitFor(() => expect(http.countOf('PATCH /waste-tariffs/:id')).toBe(1));
    expect(http.lastCall('PATCH /waste-tariffs/:id')!.body).toEqual({ isActive: false });
    await waitFor(() => expect(http.countOf('GET /waste-tariffs')).toBeGreaterThan(1));
  });
});
