import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import dayjs from 'dayjs';
import type { VehicleRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import {
  classification,
  freightRequest,
  freightTrip,
  vehicleFeed,
  vehicleRequest,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * Копия заявки на технику (ADR 0173): «Создать копию» в карточке «Новой» открывает форму
 * **заведения** с составом прежнего заказа.
 *
 * Что здесь стережётся — четыре вещи, и каждая ломается молча:
 *
 * 1. **Копия сохраняется заведением, а не правкой.** Ошибись `record` — и «копия» переписала бы
 *    исходную заявку: экран при этом выглядит одинаково, а в списке вместо двух заявок остаётся
 *    одна, изменённая.
 * 2. **Срок сдвигается вперёд с сохранением длительности.** Заведение не принимает необъявленное
 *    прошлое (`BACKDATE_UNDECLARED_MESSAGE`), и копия месячной давности упёрлась бы в отказ на
 *    поле, которого человек не трогал. Длительность при этом — часть заказа: «кран на три дня»
 *    обязан остаться заказом на три дня.
 * 3. **Ездки переносятся без `id`.** Схема заведения строгая: чужой `id` она отвергнет целиком, а
 *    пройди он — новая заявка ссылалась бы на строки старой.
 * 4. **Кнопки нет там, где копировать нечего или некому**: у заявки в работе (даты прошли, состав
 *    привязан к машине) и у роли без права заводить заявки.
 */

/** Заказ спецтехники в прошлом: три дня, 05.08–07.08 — оба дня давно позади. */
const SPECIAL = vehicleRequest({ id: 'vr-1', status: 'new', version: 7 });

/** Та же заявка, но в работе: копировать её карточка не предлагает. */
const IN_WORK = vehicleRequest({ id: 'vr-9', displayNumber: 'Т-44', status: 'confirmed' });

/** Проверенный адрес (ADR 0006): у заведения он обязателен, и копия ездки несёт его метаданные. */
const RESOLVED = {
  source: 'resolved' as const,
  fiasId: 'f-1',
  fiasLevel: 8,
  geoLat: 55.7,
  geoLon: 37.6,
};

/** Грузоперевозка с ездкой: у копии её адреса и контакты те же, а `id` — уже нет. */
const FREIGHT = freightRequest({
  trips: [
    freightTrip({
      id: 'vrt-1',
      scheduledAt: '2026-08-06T06:30:00.000Z',
      fromAddress: RESOLVED,
      toAddress: { ...RESOLVED, fiasId: 'f-2' },
    }),
  ],
});

/** Та же заявка, но адреса ездки не верифицированы — как у строк, доехавших бэкфилом (Р2а). */
const FREIGHT_RAW = freightRequest({
  id: 'vr-3',
  displayNumber: 'Т-45',
  trips: [freightTrip({ id: 'vrt-2' })],
});

/** Карточка спрашивает своё при открытии — сценарию важна не она, а кнопка в её футере. */
const CARD_ROUTES: RouteMap = {
  'GET /vehicle-requests/:id/history': () => json([]),
  'GET /vehicle-requests/:id/waybills': () => json([]),
  'GET /vehicle-requests/:id/relocations': () => json([]),
};

const CREATE = 'POST /vehicle-requests';

function renderTab(
  items: VehicleRequestDto[] = [SPECIAL],
  user = authUser(),
  over: RouteMap = {},
): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests/feed': () => json(vehicleFeed(items)),
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: items.length })),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    // Классификатор отдаёт ровно ту позицию, что заказана: копия подставляет тип и категорию
    // только живой строкой справочника — выключенную сервер всё равно не примет.
    'GET /vehicle-classifications': () =>
      json(
        list([
          classification({ vehicleTypeId: 'vt-1', vehicleCategoryId: 'vc-1' }),
          classification({
            vehicleTypeId: 'vt-2',
            typeName: 'Самосвалы',
            vehicleCategoryId: 'vc-2',
            categoryName: '20 м³',
            kindCode: 'freight',
          }),
        ]),
      ),
    'GET /vehicles': () => json(emptyList()),
    [CREATE]: () => json(vehicleRequest({ id: 'vr-new', num: 77, displayNumber: 'Т-77' })),
    ...CARD_ROUTES,
    ...over,
  });
  renderWithUser(<VehicleRequestsTab />, { user });
  return http;
}

/** Открыть карточку заявки так, как её открывает человек: нажатием на строку списка. */
async function openCard(displayNumber: string) {
  fireEvent.click(await screen.findByText(displayNumber));
  await waitFor(() =>
    expect(
      [...document.querySelectorAll('.ant-modal')].some((el) =>
        el.textContent?.includes(`Заявка ${displayNumber}`),
      ),
    ).toBe(true),
  );
}

/** Кнопка по видимой подписи — их в окне несколько, и целимся именно в текст. */
function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((el) => el.textContent === label);
}

/** Значение текстового поля формы по его подписи: то, что человек в поле видит. */
function fieldValue(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

/**
 * Выбранное в списке — подписью, а не значением поля: у antd выбор лежит не в `input` (тот пуст и
 * у заполненного списка), а в `.ant-select-content`.
 */
function selectedValue(label: string): string {
  const item = [...document.querySelectorAll('.ant-modal .ant-form-item')]
    .find((el) => el.querySelector('label')?.textContent === label)
    ?.querySelector('.ant-select-content');
  return item?.textContent ?? '';
}

const day = (offset: number) => dayjs().add(offset, 'day').format('DD.MM.YYYY');

describe('копия заявки на технику', () => {
  it('«Новая» копируется, работающая — нет', async () => {
    renderTab([SPECIAL, IN_WORK]);

    await openCard('Т-42');
    expect(button('Создать копию')).toBeTruthy();
    fireEvent.click(button('Закрыть')!);

    await openCard('Т-44');
    // Не «спрятали на всякий случай»: у работающей заявки прошедшие даты и состав, привязанный к
    // назначенной машине, — копировать там нечего.
    await waitFor(() => expect(button('Создать копию')).toBeUndefined());
  });

  it('кнопки нет у того, кто заявок не заводит', async () => {
    // Наблюдатель заявку читает, но не заводит: копия — это заведение, и предлагать её значило бы
    // вести человека к отказу сервера.
    renderTab([SPECIAL], authUser({ role: 'observer' }));

    await openCard('Т-42');
    expect(button('Создать копию')).toBeUndefined();
  });

  it('переносит состав заказа и сдвигает прошедший срок, сохраняя длительность', async () => {
    renderTab();
    await openCard('Т-42');
    fireEvent.click(button('Создать копию')!);

    // Заголовок называет источник: иначе копия неотличима от заявки, заведённой с нуля, и человек
    // не поймёт, почему поля заполнены.
    await waitFor(() => expect(screen.getByText(/копия Т-42/)).toBeDefined());
    // Вложения — единственное, чего копия не унесла, и сказано об этом до сохранения.
    expect(screen.getByText(/Вложения не переносятся/)).toBeDefined();

    expect(selectedValue('Объект/отдел')).toContain('ЖК Северный');
    expect(selectedValue('Тип/категория ТС')).toContain('г/п 25 т');
    expect(fieldValue('Ответственный на объекте')).toBe('Петров П. П.');
    expect(fieldValue('Комментарий (планируемые задачи)')).toBe('разгрузка плит');
    // Срок 05.08–07.08 давно прошёл: начало встаёт на первый доступный день, а конец уезжает на
    // столько же — три дня заказа остаются тремя днями.
    expect(fieldValue('Дата начала')).toBe(day(0));
    expect(fieldValue('Дата окончания')).toBe(day(2));
  });

  it('сохранение уходит заведением, а не правкой исходной заявки', async () => {
    const http = renderTab();
    await openCard('Т-42');
    fireEvent.click(button('Создать копию')!);
    await waitFor(() => expect(screen.getByText(/копия Т-42/)).toBeDefined());

    fireEvent.click(button('Сохранить')!);

    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    expect(http.lastCall(CREATE)?.body).toMatchObject({
      requestType: 'special_equipment',
      objectId: 'obj-1',
      vehicleTypeId: 'vt-1',
      vehicleCategoryId: 'vc-1',
      responsibleName: 'Петров П. П.',
      comment: 'разгрузка плит',
      dateFrom: dayjs().format('YYYY-MM-DD'),
      dateTo: dayjs().add(2, 'day').format('YYYY-MM-DD'),
    });
    // Исходная заявка не тронута ни одним запросом: копия — это заведение.
    expect(http.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('у грузоперевозки переносит ездки — без чужих идентификаторов', async () => {
    const http = renderTab([FREIGHT]);
    await openCard('Т-43');
    fireEvent.click(button('Создать копию')!);
    await waitFor(() => expect(screen.getByText(/копия Т-43/)).toBeDefined());

    fireEvent.click(button('Сохранить')!);

    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    const body = http.lastCall(CREATE)?.body as {
      scheduledAt: string;
      trips: Record<string, unknown>[];
    };
    expect(body.trips).toHaveLength(1);
    expect(body.trips[0]).toMatchObject({
      fromLocation: 'г. Москва, ул. Складская, 4',
      toLocation: 'г. Москва, ул. Северная, 1',
      toResponsibleName: 'Кузнецов К. К.',
      volumeM3: 12,
    });
    // Строгая схема заведения `id` не примет, и переносить его незачем: номера ездкам назначит
    // сервер.
    expect(body.trips[0]!.id).toBeUndefined();
    // День подачи уехал вперёд, а час остался прежним — вместе с ним и час самой ездки.
    expect(body.scheduledAt.slice(0, 10)).toBe(dayjs().format('YYYY-MM-DD'));
  });

  /**
   * Граница, а не поломка: заведение принимает только проверенный адрес (ADR 0006), а правка
   * старой ездки — любой (Р2а). Копия заявки с адресом, доехавшим бэкфилом, поэтому и требует
   * выбрать его заново — и делает это ДО отправки, полем формы, а не отказом сервера.
   */
  it('копия ездки с непроверенным адресом просит выбрать его заново', async () => {
    const http = renderTab([FREIGHT_RAW]);
    await openCard('Т-45');
    fireEvent.click(button('Создать копию')!);
    await waitFor(() => expect(screen.getByText(/копия Т-45/)).toBeDefined());

    fireEvent.click(button('Сохранить')!);

    expect(
      await screen.findAllByText('Адрес нужно выбрать из подсказок DaData либо из справочника'),
    ).toHaveLength(2);
    expect(http.countOf(CREATE)).toBe(0);
  });
});
