import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  VehicleCategoryDto,
  VehicleClassificationDto,
  VehicleKindDto,
  VehicleSpecDto,
  VehicleTypeDto,
  VehicleTypeSpecDto,
} from '@technic/contracts';
import { VehicleSpecsTab } from '../src/pages/directories/VehicleSpecsTab';
import { VehicleTypesTab } from '../src/pages/directories/VehicleTypesTab';
import { selectOption } from './antd';
import { list } from './factories/common';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';

const kind: VehicleKindDto = {
  id: 'kind-1',
  code: 'special_equipment',
  name: 'Спецтехника',
  sortOrder: 10,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const type: VehicleTypeDto = {
  id: 'type-1',
  kindId: kind.id,
  kindCode: kind.code,
  kindName: kind.name,
  code: 'cranes',
  name: 'Автокраны',
  description: '',
  isActive: true,
  sortOrder: 10,
  waybillFormCode: '4p',
  isLinear: false,
  maintenanceBasis: 'none',
  frozenRequests: 0,
  specCount: 1,
  categoryCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const classification: VehicleClassificationDto = {
  key: `${type.id}:category-1`,
  vehicleTypeId: type.id,
  vehicleCategoryId: 'category-1',
  kindId: kind.id,
  kindCode: kind.code,
  kindName: kind.name,
  typeCode: type.code,
  typeName: type.name,
  categoryName: 'Автокраны, г/п 25 т',
  label: 'Автокраны, г/п 25 т',
  specCount: 1,
  waybillFormCode: '4p',
  avgPricePerHour: null,
  avgPricePerShift: null,
  isActive: true,
  typeIsActive: true,
  categoryIsActive: true,
  sortOrder: 10,
  categorySortOrder: 10,
};

const attachedSpec: VehicleTypeSpecDto = {
  specId: 'spec-capacity',
  code: 'lift_capacity',
  name: 'Грузоподъёмность',
  shortName: 'г/п',
  unit: 'т',
  decimals: 0,
  minValue: 1,
  maxValue: 100,
  sortOrder: 10,
  isActive: true,
};

function directorySpec(overrides: Partial<VehicleSpecDto> = {}): VehicleSpecDto {
  return {
    id: 'spec-boom',
    code: 'boom_length',
    name: 'Длина стрелы',
    shortName: 'стрела',
    unit: 'м',
    decimals: 0,
    minValue: 1,
    maxValue: 100,
    description: '',
    sortOrder: 20,
    isActive: true,
    usedInTypes: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const category: VehicleCategoryDto = {
  id: 'category-1',
  vehicleTypeId: type.id,
  typeName: type.name,
  kindName: kind.name,
  name: classification.label,
  isAutoName: true,
  specSignature: 'lift_capacity=25',
  values: [
    {
      specId: attachedSpec.specId,
      code: attachedSpec.code,
      name: attachedSpec.name,
      shortName: attachedSpec.shortName,
      unit: attachedSpec.unit,
      decimals: attachedSpec.decimals,
      sortOrder: attachedSpec.sortOrder,
      value: 25,
    },
  ],
  sortOrder: 10,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('vehicle classifier slices', () => {
  it('backfills existing categories when a spec is attached from the type card', async () => {
    const available = directorySpec();
    const http = mockHttp({
      'GET /vehicle-classifications': () => json(list([classification])),
      'GET /vehicle-types': () => json(list([type])),
      'GET /vehicle-kinds': () => json(list([kind])),
      'GET /vehicle-types/:id/specs': () => json([attachedSpec]),
      'GET /vehicle-categories': () => json(list([category])),
      'GET /vehicle-specs': () => json(list([available])),
      'POST /vehicle-types/:id/specs': () => json([attachedSpec]),
    });
    renderWithUser(<VehicleTypesTab />);

    await screen.findByText(classification.label);
    const cardButton = [...document.querySelectorAll('tbody button')].find(
      (button) => button.getAttribute('title') === 'ТТХ и категории типа',
    );
    fireEvent.click(cardButton!);
    await screen.findByText('ТТХ типа');
    await screen.findByText(attachedSpec.name);
    fireEvent.click(screen.getByRole('button', { name: /Добавить ТТХ/ }));
    await selectOption('Характеристика', 'Длина стрелы, м');
    fireEvent.change(screen.getByLabelText('Значение для существующих категорий'), {
      target: { value: '21' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));

    await waitFor(() => expect(http.countOf('POST /vehicle-types/:id/specs')).toBe(1));
    expect(http.lastCall('POST /vehicle-types/:id/specs')!.body).toEqual({
      specId: available.id,
      sortOrder: 20,
      backfillValue: 21,
    });
  });

  it('omits frozen unit and precision when an attached spec is edited', async () => {
    const used = directorySpec({ usedInTypes: 2 });
    const http = mockHttp({
      'GET /vehicle-specs': () => json(list([used])),
      'PATCH /vehicle-specs/:id': () => json(used),
    });
    renderWithUser(<VehicleSpecsTab />);

    await screen.findByText(used.name);
    const editButton = document.querySelector('[aria-label="edit"]')?.closest('button');
    fireEvent.click(editButton!);
    await screen.findByText('Редактирование ТТХ');
    expect((screen.getByLabelText('Единица измерения') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Знаков после запятой') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Наименование'), {
      target: { value: 'Длина основной стрелы' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('PATCH /vehicle-specs/:id')).toBe(1));
    const body = http.lastCall('PATCH /vehicle-specs/:id')!.body as Record<string, unknown>;
    expect(body).toMatchObject({ name: 'Длина основной стрелы' });
    expect(body).not.toHaveProperty('unit');
    expect(body).not.toHaveProperty('decimals');
  });
});
