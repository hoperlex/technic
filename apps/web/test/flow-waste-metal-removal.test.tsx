import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import dayjs from 'dayjs';
import { minRequestDateKey, type WasteRequestDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { objectDto, operator, wasteRequest, wasteSummary, wasteType } from './factories/waste';
import { WasteRequestsPage } from '../src/pages/WasteRequestsPage';

/**
 * Вывоз металлолома (ADR 0067) — самый короткий тип заявки в модуле: ни контейнера, ни типа
 * мусора, ни объёма, ни цены. Заводится объектом, сроком и контактом площадки, а закрывается
 * весом в тоннах.
 *
 * Проверяется то, что отличает этот тип от соседних, и ровно на границах, где отличие живёт:
 * какие поля форма спрашивает, что уходит в теле запроса и в чём заявку закрывают. Полей у типа
 * нет — значит проверять надо именно их отсутствие: лишнее поле здесь не украшение, а вопрос,
 * на который заявке нечем ответить.
 */

const DELIVERY_DAY = dayjs(minRequestDateKey()).add(2, 'day').format('YYYY-MM-DD');
const EXPECTED_DELIVERY_AT = dayjs.tz(`${DELIVERY_DAY} 08:00`, 'Europe/Moscow').toISOString();

/** Заявка на металлолом, взятая в работу: её и закрывают весом. */
const IN_WORK = wasteRequest({
  id: 'wr-9',
  displayNumber: 'М-129',
  requestType: 'metal_removal',
  status: 'confirmed',
  version: 3,
  // Предмета у типа нет вовсе — ни тарификации, ни контейнера (ADR 0067).
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
    'GET /waste-requests/present-groups': () => json([]),
    'GET /objects': () =>
      json(list([objectDto(), objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' })])),
    'GET /container-types': () => json(list([])),
    'GET /waste-types': () => json(list([wasteType()])),
    'GET /counterparties': () => json(list([operator()])),
    'POST /waste-requests': ({ body }) =>
      json(wasteRequest({ ...(body as Partial<WasteRequestDto>), id: 'wr-new' }), 201),
  });
  renderWithUser(<WasteRequestsPage />);
  return http;
}

/** Выбор в `AutoSelect`: список живёт в портале, поэтому вариант ищется в выпадашке своего поля. */
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

/** Переход по статусу из строки списка — тег статуса с выпадающим списком переходов. */
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

    // Полей предмета у типа нет: их присутствие означало бы вопрос, на который заявке нечем
    // ответить, а сервер присланное всё равно обнулит (CHECK миграции 0091).
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

    await waitFor(() => expect(http.countOf('POST /waste-requests')).toBe(1));
    const body = http.lastCall('POST /waste-requests')?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      objectId: 'obj-2',
      requestType: 'metal_removal',
      deliveryAt: EXPECTED_DELIVERY_AT,
      responsibleName: 'Петров Пётр',
      // Маска съедает скобки и пробелы: в заявку уходят те же десять цифр, что хранит база
      // (ADR 0066).
      responsiblePhone: '9261234567',
    });
    // Ни типа мусора, ни объёма, ни контейнера: сервер их обнулил бы, а CHECK в БД — отверг.
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

    // Вес — единственная величина закрытия (ADR 0067). Расчёта по прайсу здесь нет и быть не
    // может: цена задана в ₽/м³ на пару «тип мусора × техника», а у лома нет ни того, ни другого.
    expect(screen.getByLabelText('Сдано металлолома, т')).toBeDefined();
    expect(screen.queryByLabelText('Вывезено, м³')).toBeNull();
    expect(screen.queryByLabelText('Стоимость, ₽')).toBeNull();

    // Талон обязателен у любого типа (ADR 0020) — металлолом закрывается приёмо-сдаточным актом.
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

    // Предмета у заявки нет, и без сданного веса строка списка не отвечала бы, чем она кончилась.
    expect(await screen.findByText('сдано 3.2 т')).toBeDefined();
  });
});
