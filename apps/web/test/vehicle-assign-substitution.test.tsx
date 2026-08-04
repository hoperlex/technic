import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { machinist, vehicleRequest } from './factories/vehicle';
import { VehicleAssignModal } from '../src/pages/vehicle/VehicleAssignModal';

/**
 * Подбор техники в форме перевода в работу идёт по **виду** ТС, а не по заказанной позиции
 * классификатора (ADR 0045, ADR 0059): в списке весь вид — и соседние категории заказанного типа,
 * и машины других типов. Заказ при этом не забыт: расхождение названо пометкой в строке и
 * предупреждением под полем, а направление — «крупнее» или «меньше заказанного» — считается по
 * ТТХ. Назначения это не отменяет: заявку закрывают тем, что есть в парке.
 *
 * Заявка здесь — заказ техники на объект: путевого листа у неё нет (ADR 0041), и форма сводится
 * ровно к тому, что проверяется, — к выбору машины.
 */

const CRANE_130: VehicleDto = {
  id: 'v-130',
  ownership: 'own',
  vehicleTypeId: 'type-crane',
  typeName: 'Автокраны',
  waybillFormCode: null,
  vehicleCategoryId: 'cat-130',
  categoryName: 'Автокраны, г/п 130 т',
  categorySpecs: { lift_capacity: 130 },
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

/** Тот же тип, соседняя позиция классификатора — и она мельче заказанной. */
const CRANE_25: VehicleDto = {
  ...CRANE_130,
  id: 'v-25',
  vehicleCategoryId: 'cat-25',
  categoryName: 'Автокраны, г/п 25 т',
  categorySpecs: { lift_capacity: 25 },
  vehicleModelId: 'm-2',
  modelName: 'Ивановец КС-45717',
  registrationNumber: 'Х001ХХ199',
};

/** Другой тип того же вида и крупнее заказанного: раньше в список не попадал вовсе (ADR 0059). */
const MOBILE_CRANE_200: VehicleDto = {
  ...CRANE_130,
  id: 'v-200',
  vehicleTypeId: 'type-mobile-crane',
  typeName: 'Кран самоходный',
  vehicleCategoryId: 'cat-200',
  categoryName: 'Кран самоходный, г/п 200 т',
  categorySpecs: { lift_capacity: 200 },
  vehicleModelId: 'm-3',
  modelName: 'Liebherr LTM 1200',
  registrationNumber: 'У777УУ177',
};

/** Аренда без разнесённой категории: «не разнесли» — не то же самое, что «не подходит». */
const CRANE_UNKNOWN: VehicleDto = {
  ...CRANE_130,
  id: 'v-none',
  ownership: 'rental',
  vehicleCategoryId: null,
  categoryName: null,
  categorySpecs: null,
  vehicleModelId: null,
  modelName: null,
  registrationNumber: null,
  lessorId: 'c-1',
  lessorName: 'ООО «Арендатех»',
  description: 'Автокран Zoomlion',
  pricePerShift: 42000,
};

/** Машинист: на него выписываются недельные листы ЭСМ-2, и без него заявку в работу не берут. */
const MACHINIST = machinist();

/** Заказан 130-тонник: с этой позицией классификатора и сверяется выбранная машина. */
const REQUEST = vehicleRequest({
  vehicleTypeId: 'type-crane',
  vehicleTypeName: 'Автокраны',
  vehicleKindId: 'kind-special',
  vehicleCategoryId: 'cat-130',
  vehicleCategoryName: 'Автокраны, г/п 130 т',
  vehicleCategorySpecs: { lift_capacity: 130 },
});

/** Окно открывается на уже назначенной машине — так проверяется выбор без возни со списком. */
function assignment(v: VehicleDto) {
  return {
    vehicleId: v.id,
    ownership: v.ownership,
    vehicleTypeId: v.vehicleTypeId,
    typeName: v.typeName,
    vehicleCategoryId: v.vehicleCategoryId,
    categoryName: v.categoryName,
    categorySpecs: v.categorySpecs,
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
  // Весь вид одним списком: разложить его на «заказанный тип», «крупнее» и «прочее» — забота не
  // сервера, а того, кто читает ответ, и проверяется это здесь же, по ушедшему запросу.
  const http = mockHttp({
    'GET /vehicles': () => json(list([CRANE_130, CRANE_25, MOBILE_CRANE_200, CRANE_UNKNOWN])),
    // Машинист заказа техники на объект: на него выписываются недельные листы ЭСМ-2 (миграция
    // 0087). Список — весь справочник водителей, без отбора по документам и без привязки к машине.
    'GET /drivers': () => json(list([MACHINIST])),
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

/**
 * Машинист — обязательное поле заказа техники на объект: на него выписываются недельные листы
 * ЭСМ-2 (миграция 0087), и без него заявка в работу не уходит. К подбору техники отношения не
 * имеет, но без него не проверить, что предупреждение о расхождении ничего не блокирует.
 */
async function chooseMachinist(): Promise<void> {
  const field = document.querySelector('#machinistId')!.closest('.ant-select')!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  const option = await waitFor(() => {
    const found = [...document.querySelectorAll('.ant-select-item-option')].find((o) =>
      (o.textContent ?? '').includes(MACHINIST.fullName),
    );
    expect(found).toBeDefined();
    return found!;
  });
  fireEvent.click(option);
}

describe('подбор техники по виду, расхождение — предупреждением', () => {
  it('в списке весь вид: машина другого типа видна и помечена направлением', async () => {
    const http = renderModal();
    await waitFor(() => expect(screen.getByText('Конкретная техника')).toBeDefined());

    const options = await openVehicleList();
    expect(options).toHaveLength(3); // три собственные: заказанная, соседняя категория и другой тип

    const smaller = options.find((o) => o.includes('Ивановец КС-45717'));
    expect(smaller).toContain('Автокраны, г/п 25 т');
    expect(smaller).toContain('меньше заказанного');

    const bigger = options.find((o) => o.includes('Liebherr LTM 1200'));
    expect(bigger).toContain('Кран самоходный, г/п 200 т');
    expect(bigger).toContain('другой тип, крупнее');

    // Другой тип дошёл до списка не по недосмотру фильтра на экране: за технику спрашивают видом,
    // а тип и категорию сервер не сужает вовсе.
    const asked = http.lastCall('GET /vehicles')?.query;
    expect(asked?.get('vehicleKindId')).toBe('kind-special');
    expect(asked?.get('vehicleTypeId')).toBeNull();
    expect(asked?.get('vehicleCategoryId')).toBeNull();
  });

  it('группы идут по пригодности, и свой тип на них не дробится', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('Конкретная техника')).toBeDefined());
    await openVehicleList();

    const groups = [...document.querySelectorAll('.ant-select-item-group')].map(
      (g) => g.textContent ?? '',
    );
    // Обе машины заказанного типа — в одной группе, хотя 25-тонник мельче заказанного: внутри
    // типа расхождение помечается в строке (ADR 0045), и дробить привычный список незачем.
    expect(groups).toEqual(['Заказанный тип', 'Крупнее заказанного']);
  });

  it('переключатель принадлежности считает весь вид, а не один тип', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('Собственная · 3')).toBeDefined());
    expect(screen.getByText('Аренда · 1')).toBeDefined();
  });

  it('выбрана машина меньше заказанной — предупреждение под полем, а не отказ', async () => {
    const onSubmit = vi.fn();
    renderModal(CRANE_25, onSubmit);
    await waitFor(() => expect(screen.getByText(/Техника меньше заказанной/)).toBeDefined());
    // Названы обе стороны: что заказывали и что берут.
    expect(screen.getByText(/Заказано «Автокраны, г\/п 130 т»/)).toBeDefined();

    // Предупреждение ничего не блокирует: заявка уходит в работу с выбранной машиной.
    await chooseMachinist();
    fireEvent.click(screen.getByText('Взять в работу'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]![0] as { assignment: { vehicleId: string } };
    expect(body.assignment.vehicleId).toBe('v-25');
  });

  it('машина другого типа крупнее — справка, а не предупреждение', async () => {
    renderModal(MOBILE_CRANE_200);
    await waitFor(() => expect(screen.getByText(/Техника крупнее заказанной/)).toBeDefined());
    expect(screen.getByText(/выбрана «Кран самоходный, г\/п 200 т»/)).toBeDefined();
  });

  it('заказанная позиция — без предупреждения', async () => {
    renderModal(CRANE_130);
    await waitFor(() => expect(screen.getByText('Автокраны, г/п 130 т')).toBeDefined());
    expect(screen.queryByText(/а выбрана/)).toBeNull();
  });

  it('незаполненная категория расхождением не считается', async () => {
    renderModal(CRANE_UNKNOWN);
    await waitFor(() => expect(screen.getByText('Конкретная техника')).toBeDefined());

    expect(screen.queryByText(/а выбрана/)).toBeNull();
    // Но в строке списка это проговаривается: «неизвестно» — не «подходит».
    const options = await openVehicleList();
    expect(options.find((o) => o.includes('Автокран Zoomlion'))).toContain('категория не указана');
  });
});
