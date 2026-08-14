import { describe, expect, it } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import type { VehicleClassificationDto, VehicleRequestDto } from '@technic/contracts';
import { FREIGHT_VEHICLE_KIND_CODE, vehicleClassificationKey } from '@technic/contracts';
import { selectOption } from './antd';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import {
  freightRequest,
  freightTrip,
  vehicleFeed,
  vehicleRequest,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * Переоформление заявки в другой тип (ADR 0091).
 *
 * Заказ заводят работой на объекте, а нужен рейс — или наоборот: самосвал под вывоз грунта
 * годится и туда и сюда, и ошибиться при заведении легко. До сих пор форма запирала тип навсегда,
 * и чинилось это отменой заявки с потерей номера, вложений и истории.
 *
 * Проверяется то, что человек видит и делает: где поле открыто, а где заперто и почему; что при
 * смене типа переносится, а что исчезает; и в какую ручку уходит сохранение — переоформление это
 * не правка, у него своя (`PATCH /vehicle-requests/:id/request-type`).
 */

/** Позиция классификатора грузового вида: она одна годится обоим типам заявки. */
const DUMP: VehicleClassificationDto = {
  key: vehicleClassificationKey('type-dump', null),
  vehicleTypeId: 'type-dump',
  vehicleCategoryId: null,
  kindId: 'kind-freight',
  kindCode: FREIGHT_VEHICLE_KIND_CODE,
  kindName: 'Грузовой транспорт',
  typeCode: 'dump',
  typeName: 'Самосвалы',
  categoryName: null,
  label: 'Самосвалы',
  specCount: 0,
  waybillFormCode: '4p',
} as unknown as VehicleClassificationDto;

/** Спецтехника: грузоперевозкой она не станет никогда — тип у такой заявки заперт. */
const CRANE: VehicleClassificationDto = {
  key: vehicleClassificationKey('type-crane', 'cat-25'),
  vehicleTypeId: 'type-crane',
  vehicleCategoryId: 'cat-25',
  kindId: 'kind-special',
  kindCode: 'special_equipment',
  kindName: 'Спецтехника',
  typeCode: 'crane',
  typeName: 'Автокраны',
  categoryName: 'Автокраны, г/п 25 т',
  label: 'Автокраны, г/п 25 т',
  specCount: 1,
  waybillFormCode: 'esm2',
} as unknown as VehicleClassificationDto;

/** Заказ техники на объект самосвалом — «Новая»: ровно та заявка, которую переоформляют. */
const ON_SITE = vehicleRequest({
  id: 'r-1',
  num: 701,
  displayNumber: 'ТС-701',
  vehicleTypeId: 'type-dump',
  vehicleTypeName: 'Самосвалы',
  vehicleKindId: 'kind-freight',
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  vehicleCategorySpecs: null,
  dateFrom: '2026-08-10',
  dateTo: null,
  responsibleName: 'Петров П. П.',
  responsiblePhone: '+7 900 000-00-02',
});

/** Заказ автокрана — тем же статусом, но другого вида техники: смена типа ему недоступна. */
const CRANE_REQUEST = vehicleRequest({
  id: 'r-2',
  num: 702,
  displayNumber: 'ТС-702',
  vehicleTypeId: 'type-crane',
  vehicleTypeName: 'Автокраны',
  vehicleKindId: 'kind-special',
  vehicleCategoryId: 'cat-25',
  vehicleCategoryName: 'Автокраны, г/п 25 т',
});

/**
 * Грузоперевозка тем же самосвалом — заявка, которую переоформляют в обратную сторону. У заказа
 * техники на объект обязательные поля все до одного заполняются переносом (день и контакт с
 * разгрузки), поэтому именно на ней проверяется весь путь сохранения.
 */
const FREIGHT_REQUEST = freightRequest({
  id: 'r-3',
  num: 703,
  displayNumber: 'ТС-703',
  vehicleTypeId: 'type-dump',
  vehicleTypeName: 'Самосвалы',
  vehicleKindId: 'kind-freight',
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  vehicleCategorySpecs: null,
  scheduledAt: '2026-08-12T06:00:00.000Z',
  trips: [
    freightTrip({ toResponsibleName: 'Кузнецов К. К.', toResponsiblePhone: '+7 900 000-00-04' }),
  ],
});

function renderTab(): ReturnType<typeof mockHttp> {
  const http = mockHttp({
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: 3 })),
    'GET /vehicle-requests/feed': () =>
      json(
        vehicleFeed([
          ON_SITE as VehicleRequestDto,
          CRANE_REQUEST as VehicleRequestDto,
          FREIGHT_REQUEST as VehicleRequestDto,
        ]),
      ),
    'GET /objects': () => json(list([{ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' }])),
    'GET /departments': () => json(emptyList()),
    // Классификатор нужен по существу: видом заказанной техники и решается, открыт ли тип.
    'GET /vehicle-classifications': () => json(list([DUMP, CRANE])),
    'GET /vehicles': () => json(emptyList()),
    'PATCH /vehicle-requests/:id/request-type': () => json(ON_SITE),
    'PATCH /vehicle-requests/:id': () => json(ON_SITE),
  });
  renderWithUser(<VehicleRequestsTab />, { user: authUser() });
  return http;
}

/** Открыть правку заявки по её номеру. */
async function openEdit(displayNumber: string): Promise<void> {
  const row = (await screen.findByText(displayNumber)).closest('tr')!;
  fireEvent.click(row.querySelector('.anticon-edit')!.closest('button')!);
  await waitFor(() => expect(screen.getByText(`Заявка ${displayNumber}`)).toBeDefined());
}

/** Поле формы по подписи — вместе со своим блоком: у него читается и состояние, и подсказка. */
function formItem(label: string): HTMLElement {
  const item = [...document.querySelectorAll('.ant-modal .ant-form-item')].find(
    (el) => el.querySelector('label')?.textContent === label,
  );
  if (!item) throw new Error(`Поле «${label}» в форме не найдено`);
  return item as HTMLElement;
}

function formLabels(): string[] {
  return [...document.querySelectorAll('.ant-modal label')].map((l) => l.textContent ?? '');
}

/** Значение текстового поля формы по его подписи. */
function fieldValue(label: string): string {
  return formItem(label).querySelector('input')?.value ?? '';
}

describe('смена типа заявки в форме правки (ADR 0091)', () => {
  it('у заказа грузовой техники тип открыт, у спецтехники — заперт с причиной', async () => {
    renderTab();

    await openEdit('ТС-701');
    expect(formItem('Тип заявки').querySelector('.ant-select-disabled')).toBeNull();
    fireEvent.click(document.querySelector('.ant-modal-close')!);

    await openEdit('ТС-702');
    expect(formItem('Тип заявки').querySelector('.ant-select-disabled')).not.toBeNull();
    // Запертое поле обязано объяснять себя: иначе непонятно, почему у соседней заявки можно.
    expect(formItem('Тип заявки').textContent).toContain('грузовой техники');
  });

  it('смена типа переносит день и контакт, а поля прежнего типа убирает', async () => {
    renderTab();
    await openEdit('ТС-701');

    await selectOption('Тип заявки', 'Грузоперевозка');

    await waitFor(() => expect(formLabels()).toContain('Дата подачи'));
    const labels = formLabels();
    // Срока работ у грузоперевозки нет — поля прежнего типа уходят из формы вместе с деталью.
    expect(labels).not.toContain('Дата начала');
    expect(labels).not.toContain('Дата окончания');
    expect(labels).toContain('Место погрузки');
    // День заказа однозначен в обе стороны и переносится: спрашивать его заново незачем.
    expect(fieldValue('Дата подачи')).toBe('10.08.2026');
    // Ответственный на объекте — тот же человек, что примет машину на разгрузке.
    expect(fieldValue('Ответственный за разгрузку')).toBe('Петров П. П.');
  });

  it('сохранение переоформления спрашивает подтверждение и уходит в свою ручку', async () => {
    const http = renderTab();
    await openEdit('ТС-703');

    await selectOption('Тип заявки', 'Техника для работы на объекте');
    await waitFor(() => expect(formLabels()).toContain('Дата начала'));
    // Обязательные поля заказа на объект заполнены переносом — переспрашивать их незачем.
    expect(fieldValue('Дата начала')).toBe('12.08.2026');
    expect(fieldValue('Ответственный на объекте')).toBe('Кузнецов К. К.');

    fireEvent.click(screen.getByText('Сохранить').closest('button')!);

    await screen.findAllByText(/Переоформить заявку ТС-703/);
    // В подтверждении перечислено то, чего у заявки не станет, — по её собственным данным.
    expect(document.body.textContent).toContain('Место погрузки: г. Москва, ул. Складская, 4');
    expect(document.body.textContent).toContain('Номер, вложения и история остаются за заявкой');
    // Пока не подтвердили — заявку не трогали: подтверждение стоит перед запросом, а не после.
    expect(http.countOf('PATCH /vehicle-requests/:id/request-type')).toBe(0);

    fireEvent.click(screen.getByText('Переоформить').closest('button')!);

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/request-type')).toBe(1));
    // Правка и переоформление — разные ручки: у второй тело полное, а не частичное.
    expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(0);
    const sent = http.lastCall('PATCH /vehicle-requests/:id/request-type')!.body as {
      requestType: string;
      dateFrom: string;
      responsibleName: string;
      version: number;
    };
    expect(sent.requestType).toBe('special_equipment');
    expect(sent.dateFrom).toBe('2026-08-12');
    expect(sent.responsibleName).toBe('Кузнецов К. К.');
    expect(sent.version).toBe(FREIGHT_REQUEST.version);
  });
});
