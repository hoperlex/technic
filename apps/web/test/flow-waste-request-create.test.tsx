import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import dayjs from 'dayjs';
import { minRequestDateKey, type WasteRequestDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { objectDto, operator, wasteRequest, wasteSummary, wasteType } from './factories/waste';
import { WasteRequestsPage } from '../src/pages/WasteRequestsPage';
import { expectModalClosed } from './antd';

/**
 * Заведение заявки на вывоз мусора — сквозь весь экран: список, кнопка, форма, сохранение.
 *
 * Проверяется поток, а не разметка: какой запрос ушёл на сервер и с каким телом, что список
 * перезапрошен после сохранения и что окно закрылось. Расположение полей рефакторинг меняет
 * свободно, а тело `POST /waste-requests` — это договор с API, и разойтись с ним нельзя.
 *
 * Сеть подменена целиком (`mockHttp`), поэтому видно и лишнее: запрос, которого экран делать не
 * должен, падает сообщением «Нет мока для ...», а не проходит незамеченным.
 */

// Сценарий ведёт весь экран — список, форму, сохранение: пяти секунд по умолчанию ему хватает не
// всегда, а упавший по таймауту тест читается как поломка портала.

/** День доставки — от «сегодня по МСК»: тем же правилом форма запирает прошедшие даты. */
const DELIVERY_DAY = dayjs(minRequestDateKey()).add(3, 'day').format('YYYY-MM-DD');
/** Ожидаемый `deliveryAt`: дата и время собираются в МСК — в этом же поясе их читает сервер. */
const EXPECTED_DELIVERY_AT = dayjs.tz(`${DELIVERY_DAY} 09:30`, 'Europe/Moscow').toISOString();

/**
 * Справочники отдаются по два значения: с единственным вариантом `AutoSelect` заполнил бы поле
 * сам (в этом его работа), и тест перестал бы проверять выбор человека.
 */
function setup() {
  const http = mockHttp({
    'GET /waste-requests': () => json(list<WasteRequestDto>([])),
    'GET /waste-requests/summary': () => json(wasteSummary()),
    // Присутствие контейнеров на площадке (ADR 0054) спрашивается на любой выбор объекта, даже
    // когда заявка вывоза о контейнерах не говорит.
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
    // Цена — предпросмотром в форме (ADR 0009): заявку она не задерживает, но запрос уходит по
    // выбору типа мусора, и без мока экран сорвался бы на нём.
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
    'POST /waste-requests': ({ body }) =>
      json(wasteRequest({ ...(body as Partial<WasteRequestDto>), id: 'wr-new' }), 201),
  });
  renderWithUser(<WasteRequestsPage />);
  return http;
}

/**
 * Выбор в `AutoSelect`: список живёт в портале, поэтому поле ищется по id, а вариант — в
 * выпадашке именно этого поля (`<id>_list`). Поиск по всему документу брал бы варианты соседнего
 * списка: закрытая выпадашка остаётся в разметке, и «выбор» уходил бы в неё.
 */
async function pickOption(fieldId: string, text: string) {
  // Поле ждём отпертым: тип заявки открывается только после выбора объекта, и щелчок по
  // запертому полю прошёл бы вхолостую.
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

/** antd связывает подпись с полем через `for`/`id` — ищем так же, как читает человек. */
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Обязательный минимум заявки на вывоз: объект, тип, что и сколько вывозим, когда и к кому. */
async function fillRequestForm() {
  await pickOption('objectId', 'ЖК Южный');
  await pickOption('requestType', 'Вывоз мусора (разовый объём)');
  await pickOption('wasteTypeId', 'Грунт');

  fill('Объём, м³', '20');

  // Дату форма подставляет сама (сегодня по МСК) — переставляем, чтобы в теле запроса было видно
  // выбранное человеком, а не совпавшее с умолчанием.
  const date = screen.getByLabelText('Дата доставки');
  fireEvent.change(date, { target: { value: dayjs(DELIVERY_DAY).format('DD.MM.YYYY') } });
  fireEvent.keyDown(date, { key: 'Enter', keyCode: 13 });

  // Время необязательно, но вместе с датой оно и составляет `deliveryAt`: без него проверять
  // сборку срока в МСК было бы не на чем. Поле ищется по подсказке внутри: `TimeInput` не
  // принимает `id` от `Form.Item`, и подпись «Время» ни с чем в разметке не связана.
  const time = screen.getByPlaceholderText('чч:мм');
  fireEvent.change(time, { target: { value: '09:30' } });
  fireEvent.blur(time);

  fill('Ответственный на площадке', 'Петров Пётр');
  fill('Контактный телефон', '+7 926 123-45-67');
}

/** Окно с таким заголовком; заголовок ищется по тексту — так его видит и человек. */

describe('заведение заявки на вывоз мусора', () => {
  it('уходит одним POST с предметом заявки, сроком в МСК и контактом площадки', async () => {
    const http = setup();
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));

    fireEvent.click(screen.getByText('Создать заявку'));
    expect(await screen.findByText('Новая заявка')).toBeDefined();

    await fillRequestForm();
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf('POST /waste-requests')).toBe(1));
    const body = http.lastCall('POST /waste-requests')?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      objectId: 'obj-2',
      requestType: 'waste_removal',
      // Тип мусора и объём — весь предмет заявки на вывоз (ADR 0019).
      wasteTypeId: 'wt-2',
      volumeM3: 20,
      deliveryAt: EXPECTED_DELIVERY_AT,
      deliveryTimeUnspecified: false,
      // Оператор приезжает к человеку, а не к адресу (миграция 0062).
      responsibleName: 'Петров Пётр',
      responsiblePhone: '+7 926 123-45-67',
    });
    // Техники у вывоза нет вовсе (ADR 0022), исполнителя новой заявке не назначают (ADR 0010) —
    // и в запросе этих полей быть не должно: сервер обнулил бы их молча.
    expect(body).not.toHaveProperty('containerTypeId');
    expect(body).not.toHaveProperty('operatorCounterpartyId');
    // Заявка заводится одним запросом: второй POST означал бы двойное нажатие «Сохранить».
    expect(http.countOf('POST /waste-requests')).toBe(1);
  });

  it('после сохранения список перезапрашивается, а окно закрывается', async () => {
    const http = setup();
    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));

    fireEvent.click(screen.getByText('Создать заявку'));
    expect(await screen.findByText('Новая заявка')).toBeDefined();

    await fillRequestForm();
    fireEvent.click(screen.getByText('Сохранить'));

    // Заведённая заявка обязана появиться в списке сама: перезапрос — единственное, что об этом
    // заботится, и без него человек увидел бы прежний список и завёл бы заявку второй раз.
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
    // Запроса нет вовсе: незаполненную заявку сервер отверг бы, но узнать об этом человек должен
    // на форме, а не тостом после круга по сети.
    expect(http.countOf('POST /waste-requests')).toBe(0);
  });
});
