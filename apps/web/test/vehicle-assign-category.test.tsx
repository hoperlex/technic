import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { vehicleRequest } from './factories/vehicle';
import { VehicleAssignModal } from '../src/pages/vehicle/VehicleAssignModal';

/**
 * Подбор техники в форме перевода в работу идёт по типу ТС, а не по заказанной категории
 * (ADR 0045): в списке весь тип, включая соседние позиции классификатора. Заказанная категория
 * при этом не забыта — расхождение названо пометкой в строке и предупреждением под полем, но
 * назначение не отменяет: заявку закрывают тем, что есть в парке.
 *
 * Заявка здесь — заказ техники на объект: путевого листа у неё нет (ADR 0041), и форма сводится
 * ровно к тому, что проверяется, — к выбору машины.
 */

const CRANE_130: VehicleDto = {
  id: 'v-130',
  ownership: 'own',
  vehicleTypeId: 'type-crane',
  typeName: 'Автокраны',
  vehicleCategoryId: 'cat-130',
  categoryName: 'Автокраны, г/п 130 т',
  vehicleModelId: 'm-1',
  modelName: 'Liebherr LTM 1130',
  registrationNumber: 'Е646СК799',
  passportNumber: null,
  lessorId: null,
  lessorName: null,
  lessorIsActive: null,
  deactivatedWithLessor: false,
  description: '',
  pricePerHour: null,
  pricePerShift: null,
  shiftHours: null,
  status: 'active',
  note: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

/** Тот же тип, соседняя позиция классификатора: раньше в список не попадала вовсе. */
const CRANE_25: VehicleDto = {
  ...CRANE_130,
  id: 'v-25',
  vehicleCategoryId: 'cat-25',
  categoryName: 'Автокраны, г/п 25 т',
  vehicleModelId: 'm-2',
  modelName: 'Ивановец КС-45717',
  registrationNumber: 'Х001ХХ199',
};

/** Аренда без разнесённой категории: «не разнесли» — не то же самое, что «не подходит». */
const CRANE_UNKNOWN: VehicleDto = {
  ...CRANE_130,
  id: 'v-none',
  ownership: 'rental',
  vehicleCategoryId: null,
  categoryName: null,
  vehicleModelId: null,
  modelName: null,
  registrationNumber: null,
  lessorId: 'c-1',
  lessorName: 'ООО «Арендатех»',
  description: 'Автокран Zoomlion',
  pricePerShift: 42000,
};

/** Заказан 130-тонник: с этой позицией классификатора и сверяется выбранная машина. */
const REQUEST = vehicleRequest({
  vehicleTypeId: 'type-crane',
  vehicleTypeName: 'Автокраны',
  vehicleCategoryId: 'cat-130',
  vehicleCategoryName: 'Автокраны, г/п 130 т',
});

/** Окно открывается на уже назначенной машине — так проверяется выбор без возни со списком. */
function assignment(v: VehicleDto) {
  return {
    vehicleId: v.id,
    ownership: v.ownership,
    typeName: v.typeName,
    categoryName: v.categoryName,
    modelName: v.modelName,
    registrationNumber: v.registrationNumber,
    description: v.description,
    lessorId: v.lessorId,
    lessorName: v.lessorName,
    pricePerHour: null,
    pricePerShift: v.pricePerShift,
    shiftHours: null,
    assignedBy: 'user-1',
    assignedByName: 'Петров П. П.',
    assignedAt: '2026-08-01T10:00:00.000Z',
  };
}

function renderModal(selected?: VehicleDto, onSubmit: (v: unknown) => void = () => {}) {
  // Парк приезжает ответом справочника техники — тем же запросом, каким его берёт портал.
  // Весь тип одним списком: сузить его до заказанной категории — забота не сервера, а того,
  // кто читает ответ, и проверяется это здесь же, по ушедшему запросу.
  const http = mockHttp({
    'GET /vehicles': () => json(list([CRANE_130, CRANE_25, CRANE_UNKNOWN])),
  });
  renderWithUser(
    <VehicleAssignModal
      request={{ ...REQUEST, assignment: selected ? assignment(selected) : null }}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />,
  );
  return http;
}

/**
 * Пункты открытого списка «Конкретная техника» — то, из чего выбирают на самом деле. Окно живёт
 * в портале, поэтому поле ищется в документе, а не в поддереве рендера.
 */
async function openVehicleList(): Promise<string[]> {
  const field = document.querySelector('#vehicleId')!.closest('.ant-select')!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  // Список приезжает запросом: открытым он может побыть и пустым, пока техника не загрузилась.
  return waitFor(() => {
    const items = [...document.querySelectorAll('.ant-select-item-option')].map(
      (o) => o.textContent ?? '',
    );
    expect(items.length).toBeGreaterThan(0);
    return items;
  });
}

describe('подбор техники по типу, категория — предупреждением', () => {
  it('в списке весь тип: машина соседней категории видна и помечена', async () => {
    const http = renderModal();
    await waitFor(() => expect(screen.getByText('Конкретная техника')).toBeDefined());

    const options = await openVehicleList();
    expect(options).toHaveLength(2); // обе собственные: заказанная категория и соседняя
    expect(options.some((o) => o.includes('Liebherr LTM 1130'))).toBe(true);
    const other = options.find((o) => o.includes('Ивановец КС-45717'));
    expect(other).toBeDefined();
    expect(other).toContain('Автокраны, г/п 25 т');
    expect(other).toContain('другая категория');

    // Соседняя категория дошла до списка не по недосмотру фильтра на экране: за технику
    // спрашивают типом, а категорию сервер не сужает вовсе.
    const asked = http.lastCall('GET /vehicles')?.query;
    expect(asked?.get('vehicleTypeId')).toBe('type-crane');
    expect(asked?.get('vehicleCategoryId')).toBeNull();
  });

  it('переключатель принадлежности считает весь тип, а не одну категорию', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('Собственная · 2')).toBeDefined());
    expect(screen.getByText('Аренда · 1')).toBeDefined();
  });

  it('выбрана соседняя категория — предупреждение под полем, а не отказ', async () => {
    const onSubmit = vi.fn();
    renderModal(CRANE_25, onSubmit);
    await waitFor(() =>
      expect(
        screen.getByText(/Заказано «Автокраны, г\/п 130 т», а у выбранной машины категория/),
      ).toBeDefined(),
    );

    // Предупреждение ничего не блокирует: заявка уходит в работу с выбранной машиной.
    fireEvent.click(screen.getByText('Взять в работу'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]![0] as { assignment: { vehicleId: string } };
    expect(body.assignment.vehicleId).toBe('v-25');
  });

  it('заказанная категория — без предупреждения', async () => {
    renderModal(CRANE_130);
    await waitFor(() => expect(screen.getByText('Автокраны, г/п 130 т')).toBeDefined());
    expect(screen.queryByText(/а у выбранной машины категория/)).toBeNull();
  });

  it('незаполненная категория расхождением не считается', async () => {
    renderModal(CRANE_UNKNOWN);
    await waitFor(() => expect(screen.getByText('Конкретная техника')).toBeDefined());

    expect(screen.queryByText(/а у выбранной машины категория/)).toBeNull();
    // Но в строке списка это проговаривается: «неизвестно» — не «подходит».
    expect((await openVehicleList())[0]).toContain('категория не указана');
  });
});
