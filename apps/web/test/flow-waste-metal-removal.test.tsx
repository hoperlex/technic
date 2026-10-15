import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import dayjs from 'dayjs';
import { minRequestDateKey, type WasteRequestDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { objectDto, operator, wasteRequest, wasteSummary, wasteType } from './factories/waste';
import { WasteRequestsPage } from '../src/pages/waste';

/**
 * Metal removal (ADR 0067) has no container, waste type, volume, or price. Creation needs a
 * site, schedule, and contact; completion records weight in tons.
 *
 * The assertions cover the fields this type omits, the versioned create body, and completion.
 */

const DELIVERY_DAY = dayjs(minRequestDateKey()).add(2, 'day').format('YYYY-MM-DD');
const EXPECTED_DELIVERY_AT = dayjs.tz(`${DELIVERY_DAY} 08:00`, 'Europe/Moscow').toISOString();

/** An active metal removal request can be completed by weight. */
const IN_WORK = wasteRequest({
  id: 'wr-9',
  displayNumber: 'М-129',
  requestType: 'metal_removal',
  status: 'confirmed',
  version: 3,
  // This type has neither pricing nor containers (ADR 0067).
  containerTypeId: null,
  containerTypeName: null,
  wasteTypeId: null,
  wasteTypeName: null,
  volumeM3: null,
  pricePerM3: null,
  amount: null,
  operatorCounterpartyId: 'cp-1',
  operatorName: 'ООО «Чистый двор»',
});

function setup(requests: WasteRequestDto[] = []) {
  const http = mockHttp({
    'GET /waste-requests': () => json(list(requests)),
    'GET /waste-requests/summary': () => json(wasteSummary({ confirmed: requests.length })),
    // The recognition health banner polls on this screen; an unmocked request would hide failures.
    'GET /waste-requests/ticket-recognition/health': () =>
      json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    'GET /waste-requests/present-groups': () => json([]),
    'GET /objects': () =>
      json(list([objectDto(), objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' })])),
    'GET /container-types': () => json(list([])),
    'GET /waste-types': () => json(list([wasteType()])),
    'GET /counterparties': () => json(list([operator()])),
    'POST /waste-requests/_create-with-receipt': ({ body }) =>
      json(wasteRequest({ ...(body as Partial<WasteRequestDto>), id: 'wr-new' }), 201),
  });
  renderWithUser(<WasteRequestsPage />);
  return http;
}

/** Search within this AutoSelect field so a closed neighboring dropdown cannot supply the option. */
async function pickOption(fieldId: string, text: string) {
  const input = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>(`#${fieldId}`);
    expect(el?.disabled).toBe(false);
    return el!;
  });
  const field = input.closest('.ant-select')!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  const option = await waitFor(() => {
    const dropdown = document.querySelector(`#${fieldId}_list`)?.closest('.ant-select-dropdown');
    const found = [...(dropdown?.querySelectorAll('.ant-select-item-option') ?? [])].find((o) =>
      o.textContent?.includes(text),
    );
    expect(found).toBeTruthy();
    return found!;
  });
  fireEvent.click(option);
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Status transitions are selected from the row's dropdown. */
async function chooseTransition(label: string) {
  fireEvent.click(screen.getByLabelText('Изменить статус'));
  const item = await waitFor(() => {
    const found = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(
      (el) => el.textContent === label,
    );
    expect(found).toBeTruthy();
    return found!;
  });
  fireEvent.click(item);
}

describe('заведение заявки на вывоз металлолома', () => {
  it('форма не спрашивает ни контейнера, ни типа мусора, ни объёма', async () => {
    const http = setup();
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));

    fireEvent.click(screen.getByText('Создать заявку'));
    expect(await screen.findByText('Новая заявка')).toBeDefined();

    await pickOption('objectId', 'ЖК Южный');
    await pickOption('requestType', 'Вывоз металлолома');

    // The server would clear these subject fields, and migration 0091 rejects them.
    await waitFor(() => expect(document.querySelector('#wasteTypeId')).toBeNull());
    expect(document.querySelector('#volumeM3')).toBeNull();
    expect(document.querySelector('#containerTypeId')).toBeNull();
    expect(document.querySelector('#containerGroupKey')).toBeNull();
  });

  it('уходит одним POST без предмета заявки', async () => {
    const http = setup();
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));

    fireEvent.click(screen.getByText('Создать заявку'));
    expect(await screen.findByText('Новая заявка')).toBeDefined();

    await pickOption('objectId', 'ЖК Южный');
    await pickOption('requestType', 'Вывоз металлолома');

    const date = screen.getByLabelText('Дата доставки');
    fireEvent.change(date, { target: { value: dayjs(DELIVERY_DAY).format('DD.MM.YYYY') } });
    fireEvent.keyDown(date, { key: 'Enter', keyCode: 13 });
    const time = screen.getByPlaceholderText('чч:мм');
    fireEvent.change(time, { target: { value: '08:00' } });
    fireEvent.blur(time);
    fill('Ответственный на площадке', 'Петров Пётр');
    fill('Контактный телефон', '+7 926 123-45-67');

    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(1));
    const body = http.lastCall('POST /waste-requests/_create-with-receipt')?.body as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      objectId: 'obj-2',
      requestType: 'metal_removal',
      deliveryAt: EXPECTED_DELIVERY_AT,
      responsibleName: 'Петров Пётр',
      // The mask sends the ten digits stored in the database (ADR 0066).
      responsiblePhone: '9261234567',
    });
    // The database check rejects subject fields that this request type cannot have.
    expect(body.wasteTypeId).toBeUndefined();
    expect(body.volumeM3).toBeUndefined();
    expect(body.containerTypeId).toBeUndefined();
  });
});

describe('закрытие заявки на вывоз металлолома', () => {
  it('окно закрытия спрашивает вес и молчит о стоимости', async () => {
    setup([IN_WORK]);
    expect(await screen.findByText('М-129')).toBeDefined();

    await chooseTransition('Выполнена');
    expect(await screen.findByText('Выполнение заявки')).toBeDefined();

    // Weight is the only completion amount; per-volume pricing cannot apply (ADR 0067).
    expect(screen.getByLabelText('Сдано металлолома, т')).toBeDefined();
    expect(screen.queryByLabelText('Вывезено, м³')).toBeNull();
    expect(screen.queryByLabelText('Стоимость, ₽')).toBeNull();

    // The acceptance certificate serves as the mandatory ticket (ADR 0020).
    expect(screen.getByText('Талон обязателен: без него заявка не закрывается')).toBeDefined();
  });

  it('закрытая заявка показывает сданный вес в списке', async () => {
    setup([
      wasteRequest({
        ...IN_WORK,
        status: 'done',
        completion: {
          unit: 'weight_tons',
          weightTons: 3.2,
          pricePerM3: null,
          totalCost: null,
          completedBy: 'user-1',
          completedByName: 'Диспетчеров Д. П.',
          completedAt: '2026-08-04T10:00:00.000Z',
        },
      }),
    ]);
    expect(await screen.findByText('М-129')).toBeDefined();

    // The row needs completed weight because this request has no other subject amount.
    expect(await screen.findByText('сдано 3.2 т')).toBeDefined();
  });
});
