import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleClassificationDto, VehicleKindDto, VehicleTypeDto } from '@technic/contracts';
import { VehicleTypesTab } from '../src/pages/directories/VehicleTypesTab';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { selectOption } from './antd';

/**
 * Бланк путевого листа в справочнике типов ТС (ADR 0065).
 *
 * До этого `waybill_form_code` не было ни в форме заведения типа, ни в схеме правки, ни в DTO:
 * проставить его можно было только миграцией. Тип, заведённый администратором через портал,
 * оставался с пустым значением и молча выпадал из документа целиком — форма перевода в работу не
 * поднимала блок «Маршрут», рейс не заводился, лист выписывать было не с чего. Софтлок на уровне
 * интерфейса, поправимый только разработчиком.
 *
 * Поэтому вопрос в форме стоит не «какой бланк», а «легковой ли это транспорт»: так его задаёт
 * тот, кто ведёт справочник, а умолчание — 4-П, потому что у собственной техники лист есть всегда.
 */

const FREIGHT_KIND: VehicleKindDto = {
  id: 'kind-freight',
  code: 'freight_transport',
  name: 'Грузоперевозки',
  sortOrder: 20,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const SPECIAL_KIND: VehicleKindDto = {
  ...FREIGHT_KIND,
  id: 'kind-special',
  code: 'special_equipment',
  name: 'Спецтехника',
  sortOrder: 10,
};

function vehicleType(over: Partial<VehicleTypeDto> = {}): VehicleTypeDto {
  return {
    id: 'vt-1',
    kindId: FREIGHT_KIND.id,
    kindCode: FREIGHT_KIND.code,
    kindName: FREIGHT_KIND.name,
    code: 'dump_trucks',
    name: 'Самосвалы',
    description: '',
    isActive: true,
    sortOrder: 20,
    waybillFormCode: '4p',
    specCount: 0,
    categoryCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function classificationRow(type: VehicleTypeDto): VehicleClassificationDto {
  return {
    key: `${type.id}:`,
    vehicleTypeId: type.id,
    vehicleCategoryId: null,
    kindId: type.kindId,
    kindCode: type.kindCode,
    kindName: type.kindName,
    typeCode: type.code,
    typeName: type.name,
    categoryName: null,
    label: type.name,
    specCount: 0,
    waybillFormCode: type.waybillFormCode,
    avgPricePerHour: null,
    avgPricePerShift: null,
    isActive: type.isActive,
    typeIsActive: type.isActive,
    categoryIsActive: null,
    sortOrder: type.sortOrder,
    categorySortOrder: null,
  };
}

function mockDirectory(types: VehicleTypeDto[]) {
  return mockHttp({
    'GET /vehicle-classifications': () => json(list(types.map(classificationRow))),
    'GET /vehicle-types': () => json(list(types)),
    'GET /vehicle-kinds': () => json(list([SPECIAL_KIND, FREIGHT_KIND])),
    'POST /vehicle-types': () => json(vehicleType(), 201),
    'PATCH /vehicle-types/:id': () => json(vehicleType()),
  });
}

/** Чекбокс формы: у antd подпись стоит рядом с самим полем, поэтому ищем по тексту. */
function passengerCheckbox(): HTMLInputElement | undefined {
  const label = [...document.querySelectorAll('.ant-checkbox-wrapper')].find(
    (el) => el.textContent?.trim() === 'Легковой транспорт',
  );
  return label?.querySelector('input[type="checkbox"]') as HTMLInputElement | undefined;
}

async function openCreateForm(): Promise<void> {
  const add = await waitFor(() => {
    const found = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Добавить',
    );
    if (!found) throw new Error('кнопки «Добавить» на экране нет');
    return found;
  });
  fireEvent.click(add);
}

describe('бланк путевого листа в справочнике типов', () => {
  it('новый грузовой тип уходит с 4-П: бланк не спрашивают, его подставляют', async () => {
    const http = mockDirectory([vehicleType()]);
    renderWithUser(<VehicleTypesTab />);
    await openCreateForm();

    await selectOption('Вид', 'Грузоперевозки');
    // Чекбокс есть и снят — это и есть умолчание «не легковой, значит 4-П».
    await waitFor(() => expect(passengerCheckbox()).toBeTruthy());
    expect(passengerCheckbox()!.checked).toBe(false);

    fireEvent.change(screen.getByLabelText('Код'), { target: { value: 'lowbed_semi_trailers' } });
    fireEvent.change(screen.getByLabelText('Наименование типа'), {
      target: { value: 'Полуприцеп низкорамный' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('POST /vehicle-types')).toBe(1));
    expect(http.lastCall('POST /vehicle-types')!.body).toMatchObject({
      code: 'lowbed_semi_trailers',
      waybillFormCode: '4p',
    });
  });

  it('отмеченный «Легковой транспорт» переводит тип на форму № 3', async () => {
    const http = mockDirectory([vehicleType()]);
    renderWithUser(<VehicleTypesTab />);
    await openCreateForm();

    await selectOption('Вид', 'Грузоперевозки');
    await waitFor(() => expect(passengerCheckbox()).toBeTruthy());
    fireEvent.click(passengerCheckbox()!);

    fireEvent.change(screen.getByLabelText('Код'), { target: { value: 'passenger_cars' } });
    fireEvent.change(screen.getByLabelText('Наименование типа'), {
      target: { value: 'Легковые автомобили' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('POST /vehicle-types')).toBe(1));
    expect(http.lastCall('POST /vehicle-types')!.body).toMatchObject({ waybillFormCode: 'leg3' });
  });

  it('у спецтехники чекбокса нет: её ЭСМ-2 портал выписывает сам по заявке', async () => {
    mockDirectory([vehicleType()]);
    renderWithUser(<VehicleTypesTab />);
    await openCreateForm();

    await selectOption('Вид', 'Спецтехника');
    // Вместо поля — объяснение: пустое место читалось бы как «бланка у типа нет».
    await screen.findByText(/ЭСМ-2 портал выписывает сам/);
    expect(passengerCheckbox()).toBeUndefined();
  });

  it('правка легкового типа открывает чекбокс отмеченным и не сбрасывает бланк', async () => {
    const legType = vehicleType({
      id: 'vt-legacy',
      code: 'passenger_cars',
      name: 'Легковые автомобили',
      waybillFormCode: 'leg3',
    });
    const http = mockDirectory([legType]);
    renderWithUser(<VehicleTypesTab />);

    await screen.findByText('Легковые автомобили');
    const edit = [...document.querySelectorAll('tbody button')].find((b) =>
      b.getAttribute('title')?.startsWith('Редактировать тип'),
    );
    fireEvent.click(edit!);

    await waitFor(() => expect(passengerCheckbox()).toBeTruthy());
    expect(passengerCheckbox()!.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf('PATCH /vehicle-types/:id')).toBe(1));
    expect(http.lastCall('PATCH /vehicle-types/:id')!.body).toMatchObject({
      waybillFormCode: 'leg3',
    });
  });
});
