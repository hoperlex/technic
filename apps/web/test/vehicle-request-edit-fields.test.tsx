import { describe, expect, it } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import type { VehicleRequestDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { vehicleRequest, vehicleSummary } from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * Форма правки заявки на ТС обязана показывать то, что у заявки есть, а не то, что бывает у роли
 * редактора: скрытое поле — это молчаливая потеря значения при сохранении, и заметить её в списке
 * нечем. Проверяются оба места, где формы это правило нарушали:
 *
 *  - заказчик грузоперевозки (ADR 0040): у заявки отдела форма спрашивала «Объект» — поле
 *    редактора, а не заявки, — и сохранение переносило заявку с отдела на площадку;
 *  - назначенная машина (ADR 0048): её в форме правки нет и быть не должно — подбор техники это
 *    не правка заказа, — но действие для неё обязано существовать, иначе поле «Техника» в карточке
 *    видно, а изменить его нечем.
 */

const ASSIGNMENT = {
  vehicleId: 'v-1',
  ownership: 'own' as const,
  vehicleKindId: 'vk-freight',
  vehicleTypeId: 'vt-dump',
  typeName: 'Самосвалы',
  vehicleCategoryId: null,
  categoryName: null,
  categorySpecs: null,
  modelName: 'КамАЗ-6520',
  registrationNumber: 'Е646СК799',
  description: '',
  lessorId: null,
  lessorName: null,
  pricePerHour: null,
  pricePerShift: null,
  shiftHours: null,
  assignedBy: 'user-1',
  assignedByName: 'Диспетчеров Дмитрий',
  assignedAt: '2026-08-01T10:00:00.000Z',
};

/** Заказ техники на объект — «Новая»: машины нет, менять нечего. */
const SPECIAL = vehicleRequest({
  id: 'r-1',
  num: 601,
  displayNumber: 'ТС-601',
  objectId: 'obj-1',
  objectCode: 'OBJ-A',
  objectName: 'Объект Химки',
  objectAddress: 'Химки, ул. Победы, 10',
  vehicleTypeId: 'type-crane',
  vehicleTypeName: 'Автокраны',
  vehicleCategoryId: 'cat-130',
  vehicleCategoryName: 'Автокраны, г/п 130 т',
  comment: 'котлован',
  dateFrom: '2026-08-10',
  dateTo: null,
});

/**
 * Грузоперевозка отдела, уже в работе: и заказчик-отдел, и назначенная машина. Поля подачи и
 * концов маршрута дописаны к фабрике вручную — она отдаёт заказ техники на объект, а второго
 * типа заявки в ней нет.
 */
const FREIGHT = {
  ...vehicleRequest({
    id: 'r-2',
    num: 602,
    displayNumber: 'ТС-602',
    objectId: null,
    objectCode: null,
    objectName: null,
    objectAddress: null,
    departmentId: 'dep-1',
    departmentCode: 'SNAB',
    departmentName: 'Снабжение',
    vehicleTypeId: 'type-truck',
    vehicleTypeName: 'Самосвалы',
    vehicleCategoryId: null,
    vehicleCategoryName: null,
    status: 'confirmed',
    comment: 'плиты',
    approvedBy: 'user-1',
    approvedByName: 'Руков Р. Р.',
    approvedAt: '2026-08-01T09:30:00.000Z',
    assignment: ASSIGNMENT,
  }),
  requestType: 'freight_transport',
  scheduledAt: '2026-08-10T09:00:00.000Z',
  scheduledTimeUnspecified: false,
  volumeM3: null,
  weightTons: 14,
  loadingLocation: 'Москва, ул. Ленина, 1',
  unloadingLocation: 'Химки, ул. Победы, 10',
  loadingAddress: { source: 'dadata', fiasId: 'a', fiasLevel: '8', qc: 0, lat: 55, lon: 37 },
  unloadingAddress: { source: 'dadata', fiasId: 'b', fiasLevel: '8', qc: 0, lat: 55, lon: 37 },
  loadingResponsibleName: 'Сидоров С. С.',
  loadingResponsiblePhone: '+7 926 000-00-02',
  unloadingResponsibleName: 'Петров П. П.',
  unloadingResponsiblePhone: '+7 926 000-00-03',
} as unknown as VehicleRequestDto;

function renderTab() {
  const http = mockHttp({
    // Сводка описана до списка не для порядка: у обеих ручек общее начало пути, и «/summary»
    // должно разобраться раньше, чем список.
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: 1, confirmed: 1 })),
    'GET /vehicle-requests': () => json(list([SPECIAL, FREIGHT])),
    // Справочники заказчика: по ним форма подставляет объект и отдел заявки — без них поле
    // осталось бы пустым, и проверка «заказчик подставлен» ничего бы не значила.
    'GET /objects': () => json(list([{ id: 'obj-1', code: 'OBJ-A', name: 'Объект Химки' }])),
    'GET /departments': () => json(list([{ id: 'dep-1', code: 'SNAB', name: 'Снабжение' }])),
    // Классификатор и парк проверяемому не нужны: спрашивается состав полей формы, а не то,
    // из чего в них выбирают.
    'GET /vehicle-classifications': () => json(emptyList()),
    'GET /vehicles': () => json(emptyList()),
    // Смена техники у грузоперевозки спрашивает рейс. `formCode: null` — рейс этой заявке не
    // ведётся, и окно сводится к выбору машины: водителя и графы шапки оно не спрашивает.
    'GET /vehicle-requests/:id/route-prefill': () =>
      json({
        required: false,
        formCode: null,
        formLabel: null,
        reason: 'Рейс не ведётся',
        tripDate: '2026-08-10',
        routes: [],
        trip: null,
      }),
  });
  // Смотрит диспетчер: он и правит заявки, и меняет технику, но сам не роль отдела — именно на
  // такого редактора форма показывала свою ось заказчика вместо оси заявки.
  renderWithUser(<VehicleRequestsTab />, { user: authUser() });
  return http;
}

/** Подписи полей открытого окна — то, что человек в нём действительно видит. */
function formLabels(): string[] {
  return [...document.querySelectorAll('.ant-modal label')].map((l) => l.textContent ?? '');
}

/** Кнопка в строке заявки: строки различаются по номеру, а иконки внутри — по aria-label. */
async function rowButton(displayNumber: string, label: string): Promise<HTMLButtonElement | null> {
  const row = (await screen.findByText(displayNumber)).closest('tr')!;
  return row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

describe('форма правки заявки на ТС: поля заявки, а не роли', () => {
  it('заказ техники на объект открывается со всеми своими полями', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('ТС-601')).toBeDefined());
    fireEvent.click(document.querySelectorAll('.anticon-edit')[0]!.closest('button')!);

    await waitFor(() => expect(screen.getByText('Заявка ТС-601')).toBeDefined());
    expect(formLabels()).toEqual(
      expect.arrayContaining([
        'Объект',
        'Тип заявки',
        'Тип/категория ТС',
        'Дата начала',
        'Дата окончания',
        'Ответственный на объекте',
      ]),
    );
  });

  it('у грузоперевозки отдела спрашивается отдел, а не пустой объект', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('ТС-602')).toBeDefined());
    fireEvent.click(document.querySelectorAll('.anticon-edit')[1]!.closest('button')!);

    await waitFor(() => expect(screen.getByText('Заявка ТС-602')).toBeDefined());
    const labels = formLabels();
    expect(labels).toContain('Отдел');
    // Диспетчер — не роль отдела, и раньше форма показывала ему свою ось: пустой «Объект».
    expect(labels).not.toContain('Объект');
    // Заказчик подставлен: пустое обязательное поле сохранением унесло бы заявку на площадку.
    expect(screen.getByTitle('SNAB — Снабжение')).toBeDefined();
  });
});

describe('смена назначенной техники (ADR 0048)', () => {
  it('у заявки в работе действие есть, у «Новой» — нет', async () => {
    renderTab();
    await screen.findByText('ТС-602');
    expect(await rowButton('ТС-602', 'Сменить технику')).not.toBeNull();
    // «Новой» машину назначает сам перевод в работу — менять нечего.
    expect(await rowButton('ТС-601', 'Сменить технику')).toBeNull();
  });

  it('окно открывается на текущей машине и не спрашивает срок', async () => {
    renderTab();
    await screen.findByText('ТС-602');
    fireEvent.click((await rowButton('ТС-602', 'Сменить технику'))!);

    await waitFor(() => expect(screen.getByText('Смена техники: заявка ТС-602')).toBeDefined());
    // Видно, с чего меняем: смена начинается с вопроса «на что», а ответ на «с чего» должен
    // стоять перед глазами.
    // Подпись машины та же, что в списке и карточке (`assignmentTitle`): у собственной это госномер.
    expect(screen.getByText(/Сейчас назначена: .*Е646СК799/)).toBeDefined();
    // Срок согласован при переводе в работу и здесь не правится (ADR 0048 п. 4).
    const labels = formLabels();
    expect(labels).not.toContain('Фактическая дата подачи');
    expect(labels).not.toContain('Фактическое время (МСК)');
    expect(labels).toContain('Конкретная техника');
    // Кнопка окна названа действием, а не «Сохранить»: она меняет исполнение заявки.
    expect(document.querySelector('.ant-modal-footer .ant-btn-primary')?.textContent).toBe(
      'Сменить технику',
    );
  });
});
