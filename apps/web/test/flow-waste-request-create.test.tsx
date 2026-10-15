import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { minRequestDateKey, type WasteRequestDto } from '@technic/contracts';
import { json, mockHttp, type MockResponse, type RouteMap } from './http';
import { createTestQueryClient, renderWithUser } from './render';
import { list } from './factories/common';
import { objectDto, operator, wasteRequest, wasteSummary, wasteType } from './factories/waste';
import { WasteRequestsPage } from '../src/pages/waste';
import { objectRecordsQuery } from '../src/entities/object';
import { expectModalClosed } from './antd';

/**
 * Waste Removal creation crosses the full page: list, create action, form, and save.
 *
 * The test protects the HTTP body and route, list refresh, and modal close. Layout can change,
 * but the versioned receipt route must keep the submitted body after a lost response.
 *
 * The network mock rejects every unexpected request, including a fallback to the root create route.
 */

/** Use the same Moscow date floor as the form so the test remains valid across days. */
const DELIVERY_DAY = dayjs(minRequestDateKey()).add(3, 'day').format('YYYY-MM-DD');
/** The server reads the submitted delivery time in Moscow time. */
const EXPECTED_DELIVERY_AT = dayjs.tz(`${DELIVERY_DAY} 09:30`, 'Europe/Moscow').toISOString();

/**
 * Two choices prevent AutoSelect from filling a field without user input.
 */
function setup(over: RouteMap = {}, queryClient?: QueryClient) {
  const http = mockHttp({
    'GET /waste-requests': () => json(list<WasteRequestDto>([])),
    'GET /waste-requests/summary': () => json(wasteSummary()),
    // The recognition health banner polls on this screen; an unmocked request would hide failures.
    'GET /waste-requests/ticket-recognition/health': () =>
      json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    // Site selection queries present container groups even for requests without containers.
    'GET /waste-requests/present-groups': () => json([]),
    'GET /objects': () =>
      json(
        list([
          objectDto(),
          objectDto({
            id: 'obj-2',
            code: 'ОБ-2',
            name: 'ЖК Южный',
            address: 'г. Москва, ул. Южная, 2',
          }),
        ]),
      ),
    'GET /container-types': () => json(list([])),
    'GET /waste-types': () =>
      json(list([wasteType(), wasteType({ id: 'wt-2', name: 'Грунт', sortOrder: 2 })])),
    'GET /counterparties': () => json(list([operator()])),
    // Tariff preview queries on waste type selection, although it does not block creation.
    'GET /waste-tariffs/resolve': () =>
      json({
        tariff: {
          tariffId: 'tf-1',
          wasteTypeId: 'wt-2',
          containerTypeId: null,
          operatorCounterpartyId: 'cp-1',
          operatorName: 'ООО «Чистый двор»',
          isMinimum: true,
          pricePerM3: 500,
          isPerContainer: false,
          containerVolumeM3: null,
          volumeStepM3: null,
          matchedBy: 'container_kind' as const,
        },
      }),
    'POST /waste-requests/_create-with-receipt': ({ body }) =>
      json(wasteRequest({ ...(body as Partial<WasteRequestDto>), id: 'wr-new' }), 201),
    ...over,
  });
  renderWithUser(<WasteRequestsPage />, { queryClient });
  return http;
}

/**
 * AutoSelect leaves closed dropdowns in the DOM, so search within this field's dropdown.
 */
async function pickOption(fieldId: string, text: string) {
  // Request type unlocks only after object selection; clicking earlier would be ignored.
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

/** Ant Design connects labels to fields through for/id. */
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Fill the required site, type, volume, schedule, and contact. */
async function fillRequestForm() {
  await pickOption('objectId', 'ЖК Южный');
  await pickOption('requestType', 'Вывоз мусора (разовый объём)');
  await pickOption('wasteTypeId', 'Грунт');

  fill('Объём, м³', '20');

  // Choose a nondefault date to verify the submitted value.
  const date = screen.getByLabelText('Дата доставки');
  fireEvent.change(date, { target: { value: dayjs(DELIVERY_DAY).format('DD.MM.YYYY') } });
  fireEvent.keyDown(date, { key: 'Enter', keyCode: 13 });

  // TimeInput has no Form.Item id, so use its placeholder to verify Moscow time conversion.
  const time = screen.getByPlaceholderText('чч:мм');
  fireEvent.change(time, { target: { value: '09:30' } });
  fireEvent.blur(time);

  fill('Ответственный на площадке', 'Петров Пётр');
  fill('Контактный телефон', '+7 926 123-45-67');
}

describe('заведение заявки на вывоз мусора', () => {
  it('does not auto-select a sole site from stale PICK data', async () => {
    const queryClient = createTestQueryClient();
    const queryKey = objectRecordsQuery(true).queryKey;
    queryClient.setQueryData([...queryKey], list([objectDto()]), {
      updatedAt: Date.now() - 61_000,
    });
    let respond!: (response: MockResponse) => void;
    const pending = new Promise<MockResponse>((resolve) => {
      respond = resolve;
    });
    const http = setup({ 'GET /objects': () => pending }, queryClient);
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));
    fireEvent.click(screen.getByText('Создать заявку'));
    expect(await screen.findByText('Новая заявка')).toBeDefined();
    await waitFor(() => expect(document.querySelector('#objectId')).toBeTruthy());
    await waitFor(() => expect(http.countOf('GET /objects')).toBe(1));
    const chosenSite = () =>
      document
        .querySelector('#objectId')
        ?.closest('.ant-select')
        ?.querySelector('.ant-select-selection-item');
    expect(chosenSite()).toBeNull();

    respond(json(list([])));
    await waitFor(() => expect(queryClient.getQueryData(queryKey)).toEqual(list([])));
    expect(chosenSite()).toBeNull();
    expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(0);
  });

  it('уходит одним POST с предметом заявки, сроком в МСК и контактом площадки', async () => {
    const http = setup();
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));

    fireEvent.click(screen.getByText('Создать заявку'));
    expect(await screen.findByText('Новая заявка')).toBeDefined();

    await fillRequestForm();
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(1));
    const body = http.lastCall('POST /waste-requests/_create-with-receipt')?.body as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      objectId: 'obj-2',
      requestType: 'waste_removal',
      // Waste type and volume define this request's subject (ADR 0019).
      wasteTypeId: 'wt-2',
      volumeM3: 20,
      deliveryAt: EXPECTED_DELIVERY_AT,
      deliveryTimeUnspecified: false,
      // The operator needs a person to meet at the site (migration 0062).
      responsibleName: 'Петров Пётр',
      // The mask sends the ten digits stored in the database (ADR 0066).
      responsiblePhone: '9261234567',
    });
    // The server would silently clear vehicle and operator fields on new removal requests.
    expect(body).not.toHaveProperty('containerTypeId');
    expect(body).not.toHaveProperty('operatorCounterpartyId');
    // A second POST would mean the save action submitted twice.
    expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(1);
  });

  it('после сохранения список перезапрашивается, а окно закрывается', async () => {
    const http = setup();
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));

    fireEvent.click(screen.getByText('Создать заявку'));
    expect(await screen.findByText('Новая заявка')).toBeDefined();

    await fillRequestForm();
    fireEvent.click(screen.getByText('Сохранить'));

    // Refetch keeps the saved request visible and prevents a second creation from a stale list.
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(2));
    expect(await screen.findByText('Сохранено')).toBeDefined();
    await expectModalClosed('Новая заявка');
  });

  it('без объекта и типа заявка не уходит: форма показывает, чего не хватает', async () => {
    const http = setup();
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));

    fireEvent.click(screen.getByText('Создать заявку'));
    expect(await screen.findByText('Новая заявка')).toBeDefined();

    fireEvent.click(screen.getByText('Сохранить'));

    expect(await screen.findByText('Выберите объект')).toBeDefined();
    expect(screen.getByText('Выберите тип заявки')).toBeDefined();
    // The form reports missing fields before any request reaches the server.
    expect(http.countOf('POST /waste-requests/_create-with-receipt')).toBe(0);
  });
});
