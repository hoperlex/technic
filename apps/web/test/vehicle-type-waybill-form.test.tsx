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
    isLinear: false,
    maintenanceBasis: 'none',
    frozenRequests: 0,
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
function checkboxByLabel(text: string): HTMLInputElement | undefined {
  const label = [...document.querySelectorAll('.ant-checkbox-wrapper')].find(
    (el) => el.textContent?.trim() === text,
  );
  return label?.querySelector('input[type="checkbox"]') as HTMLInputElement | undefined;
}

const passengerCheckbox = () => checkboxByLabel('Легковой транспорт');
const linearCheckbox = () => checkboxByLabel('Линейная техника');
const maintenanceCheckbox = () => checkboxByLabel('ТО по пробегу');

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

/**
 * Линейная техника в справочнике типов.
 *
 * Признак отвечает не на вопрос о бланке, а на вопрос о том, как ведётся заказ на объект: машина
 * вечером возвращается на базу, за день работает на нескольких площадках, и документы у неё
 * дневные — 4-П на каждый день, ЭСМ-2 только по требованию. Поэтому чекбокс стоит у типов любого
 * вида (заказать на объект можно и самосвал), а соседний «Легковой транспорт» остаётся у
 * грузового: он про форму листа.
 */
describe('линейная техника в справочнике типов', () => {
  it('чекбокс есть и у спецтехники — заказ по дням не про бланк, а про режим заявки', async () => {
    const http = mockDirectory([vehicleType()]);
    renderWithUser(<VehicleTypesTab />);
    await openCreateForm();

    await selectOption('Вид', 'Спецтехника');
    await waitFor(() => expect(linearCheckbox()).toBeTruthy());
    // Бланк спецтехнике не задаётся, а признак — задаётся: это разные вопросы.
    expect(passengerCheckbox()).toBeUndefined();
    expect(linearCheckbox()!.checked).toBe(false);
    fireEvent.click(linearCheckbox()!);

    fireEvent.change(screen.getByLabelText('Код'), { target: { value: 'excavators' } });
    fireEvent.change(screen.getByLabelText('Наименование типа'), {
      target: { value: 'Экскаваторы' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('POST /vehicle-types')).toBe(1));
    expect(http.lastCall('POST /vehicle-types')!.body).toMatchObject({
      code: 'excavators',
      isLinear: true,
    });
  });

  it('новый тип со снятым чекбоксом уходит нелинейным, а не без признака', async () => {
    const http = mockDirectory([vehicleType()]);
    renderWithUser(<VehicleTypesTab />);
    await openCreateForm();

    await selectOption('Вид', 'Грузоперевозки');
    await waitFor(() => expect(linearCheckbox()).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Код'), { target: { value: 'tippers' } });
    fireEvent.change(screen.getByLabelText('Наименование типа'), { target: { value: 'Тонары' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('POST /vehicle-types')).toBe(1));
    expect(http.lastCall('POST /vehicle-types')!.body).toMatchObject({ isLinear: false });
  });

  it('отмеченный признак меняет подпись о путевом листе: ЭСМ-2 сам не выписывается', async () => {
    mockDirectory([vehicleType()]);
    renderWithUser(<VehicleTypesTab />);
    await openCreateForm();

    await selectOption('Вид', 'Спецтехника');
    await screen.findByText(/ЭСМ-2 портал выписывает сам/);

    fireEvent.click(linearCheckbox()!);
    // Обещание «выписывает сам» у линейного типа портал не сдержит — подпись обязана уехать.
    await screen.findByText(/ЭСМ-2 по заявке на технику выписывается по требованию/);
    expect(screen.queryByText(/ЭСМ-2 портал выписывает сам/)).toBeNull();
  });

  it('линейный тип помечен в списке и открывается в правке отмеченным', async () => {
    const linearType = vehicleType({
      id: 'vt-excavators',
      kindId: SPECIAL_KIND.id,
      kindCode: SPECIAL_KIND.code,
      kindName: SPECIAL_KIND.name,
      code: 'excavators',
      name: 'Экскаваторы',
      isLinear: true,
    });
    const http = mockDirectory([linearType]);
    renderWithUser(<VehicleTypesTab />);

    // Столбец списка: без него признак виден только через открытую форму правки.
    await screen.findByText('Экскаваторы');
    await waitFor(() => expect(screen.getAllByText('по дням').length).toBeGreaterThan(0));

    const edit = [...document.querySelectorAll('tbody button')].find((b) =>
      b.getAttribute('title')?.startsWith('Редактировать тип'),
    );
    fireEvent.click(edit!);

    await waitFor(() => expect(linearCheckbox()).toBeTruthy());
    expect(linearCheckbox()!.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf('PATCH /vehicle-types/:id')).toBe(1));
    /*
     * Признак в теле правки не едет вовсе — и это не потеря, а условие: у переключения свой
     * протокол с предпросмотром и подтверждением (ADR 0107), а `PATCH` на такое поле отвечает
     * `422`. Раньше форма слала его всегда, и правка описания молча несла с собой признак;
     * теперь она несёт только описательные поля, а признак остаётся тем, что стоит в справочнике.
     */
    const body = http.lastCall('PATCH /vehicle-types/:id')!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('isLinear');
    expect(body).toMatchObject({ name: 'Экскаваторы' });
  });
});

/**
 * Разметка ТО в справочнике типов (план «Показания техники», Р13; миграция 0147).
 *
 * Колонка `vehicle_types.maintenance_basis` появилась вместе с расчётом обслуживания, но задать её
 * было неоткуда: ни в DTO, ни в схемах, ни в форме. У всех типов навсегда стояло `none`, а значит у
 * каждой машины — «ТО по пробегу не ведётся»: журнал, подсветка и сводка механика считались по
 * признаку, которого никто не мог включить.
 *
 * Поэтому вопрос стоит галочкой и рядом с линейностью: отвечает на него тот же человек и в тот же
 * заход, а пояснение обязано называть последствие снятой — умолчание справочника «не ведётся», и
 * пустая колонка ТО в гараже иначе читается как поломка портала.
 */
describe('разметка ТО в справочнике типов', () => {
  it('новый тип со снятой галочкой уходит с basis = none, а не без признака', async () => {
    const http = mockDirectory([vehicleType()]);
    renderWithUser(<VehicleTypesTab />);
    await openCreateForm();

    await selectOption('Вид', 'Спецтехника');
    await waitFor(() => expect(maintenanceCheckbox()).toBeTruthy());
    expect(maintenanceCheckbox()!.checked).toBe(false);
    // Последствие снятой галочки названо прямо в форме: иначе про неразмеченный тип узнают из
    // пустой колонки гаража, которая молчит.
    expect(screen.getByText(/обслуживание техники этого типа портал не считает/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Код'), { target: { value: 'trailers' } });
    fireEvent.change(screen.getByLabelText('Наименование типа'), { target: { value: 'Прицепы' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('POST /vehicle-types')).toBe(1));
    expect(http.lastCall('POST /vehicle-types')!.body).toMatchObject({ maintenanceBasis: 'none' });
  });

  it('отмеченная галочка заводит тип с ТО по пробегу', async () => {
    const http = mockDirectory([vehicleType()]);
    renderWithUser(<VehicleTypesTab />);
    await openCreateForm();

    await selectOption('Вид', 'Спецтехника');
    await waitFor(() => expect(maintenanceCheckbox()).toBeTruthy());
    fireEvent.click(maintenanceCheckbox()!);

    fireEvent.change(screen.getByLabelText('Код'), { target: { value: 'excavators' } });
    fireEvent.change(screen.getByLabelText('Наименование типа'), {
      target: { value: 'Экскаваторы' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('POST /vehicle-types')).toBe(1));
    expect(http.lastCall('POST /vehicle-types')!.body).toMatchObject({
      code: 'excavators',
      maintenanceBasis: 'odometer',
    });
  });

  it('размеченный тип помечен в списке и открывается в правке отмеченным', async () => {
    const tracked = vehicleType({
      id: 'vt-excavators',
      code: 'excavators',
      name: 'Экскаваторы',
      maintenanceBasis: 'odometer',
    });
    const http = mockDirectory([tracked]);
    renderWithUser(<VehicleTypesTab />);

    // Колонка списка: без неё «какие типы размечены» собирается открыванием карточек по одной.
    await screen.findByText('Экскаваторы');
    await waitFor(() => expect(screen.getAllByText('по пробегу').length).toBeGreaterThan(0));

    const edit = [...document.querySelectorAll('tbody button')].find((b) =>
      b.getAttribute('title')?.startsWith('Редактировать тип'),
    );
    fireEvent.click(edit!);

    await waitFor(() => expect(maintenanceCheckbox()).toBeTruthy());
    expect(maintenanceCheckbox()!.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf('PATCH /vehicle-types/:id')).toBe(1));
    // Правка соседнего поля признак не роняет: форма шлёт его тем, что стоит в справочнике.
    expect(http.lastCall('PATCH /vehicle-types/:id')!.body).toMatchObject({
      maintenanceBasis: 'odometer',
    });
  });

  it('снятая в правке галочка выключает ТО: своего протокола у признака нет', async () => {
    const tracked = vehicleType({
      id: 'vt-excavators',
      code: 'excavators',
      name: 'Экскаваторы',
      maintenanceBasis: 'odometer',
    });
    const http = mockDirectory([tracked]);
    renderWithUser(<VehicleTypesTab />);

    await screen.findByText('Экскаваторы');
    const edit = [...document.querySelectorAll('tbody button')].find((b) =>
      b.getAttribute('title')?.startsWith('Редактировать тип'),
    );
    fireEvent.click(edit!);

    await waitFor(() => expect(maintenanceCheckbox()).toBeTruthy());
    fireEvent.click(maintenanceCheckbox()!);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    // В отличие от линейности, выключение идёт обычным `PATCH`: оно ничего не переписывает у
    // заявок в работе — только перестаёт считать, и записи ТО остаются на месте.
    await waitFor(() => expect(http.countOf('PATCH /vehicle-types/:id')).toBe(1));
    expect(http.lastCall('PATCH /vehicle-types/:id')!.body).toMatchObject({
      maintenanceBasis: 'none',
    });
    expect(http.countOf('GET /vehicle-types/:id/linear-switch-preview')).toBe(0);
  });
});
