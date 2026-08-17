import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleRequestRouteDto, VehicleRouteDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { VehicleRouteModal } from '../src/pages/vehicle/VehicleRouteModal';

/**
 * Карточка рейса: порядок заявок — это строки задания бланка 4-П, и переставляются они стрелками
 * (позиций максимум четыре, а перетаскивание внутри таблицы на телефоне требует своего решения).
 *
 * Проверяется два правила, каждое из которых легко потерять при правках:
 *   1. порядок уходит на сервер **полным составом** — сервер переписывает позиции одним заходом,
 *      и «подвинуть одну строку» здесь не бывает;
 *   2. выписанный лист карточку замораживает — ни стрелок, ни изъятия, ни добавления, потому что
 *      бланк уже у водителя (ADR 0037 п. 9).
 *
 * Данные приходят HTTP-моком: и порядок, и перенос — это то, что уезжает в теле запроса, и
 * проверять их по подменённому модулю портала значило бы проверять сегодняшнее устройство кода.
 */

const REQUEST_A = {
  requestId: 'r-a',
  displayNumber: 'ТС-501',
  position: 1,
  status: 'confirmed' as const,
  customerName: 'Объект А',
  loadingLocation: 'Карьер',
  unloadingLocation: 'Площадка 1',
  scheduledAt: '2026-08-03T06:00:00.000Z',
  scheduledTimeUnspecified: false,
  cargoLabel: '12 м³',
};

const REQUEST_B = { ...REQUEST_A, requestId: 'r-b', displayNumber: 'ТС-502', position: 2 };

/**
 * Порядок объезда рейса: у каждой заявки своя пара точек, точки не общие. Так карточка и работает
 * после этапа 7 — стрелки переставляют **точки**, а не строки состава: печать задания идёт по их
 * позициям (Р11), и состав на неё больше не влияет.
 */
const action = (
  position: number,
  role: 'load' | 'unload',
  requestId: string,
  requestNum: number,
  pairPosition: number,
) => ({
  position,
  kind: 'freight' as const,
  ref: { kind: 'freight' as const, requestId, tripId: `t-${requestId}` },
  role,
  cargoLabel: '12 м³',
  pairPosition,
  displayNumber: `ТС-${requestNum}/1`,
  requestNum,
  tripNum: 1,
  customerName: 'Объект А',
  contactName: 'Иванов И.И.',
  contactPhone: '9160000001',
  addressMismatch: false,
});

const point = (
  id: string,
  position: number,
  location: string,
  actions: ReturnType<typeof action>[],
) => ({
  id,
  position,
  location,
  address: null,
  arrivalTime: '',
  comment: '',
  actions,
  contacts: [{ name: 'Иванов И.И.', phone: '9160000001' }],
});

const POINTS = [
  point('pt-1', 1, 'Карьер', [action(1, 'load', 'r-a', 501, 2)]),
  point('pt-2', 2, 'Площадка 1', [action(1, 'unload', 'r-a', 501, 1)]),
  point('pt-3', 3, 'Карьер-2', [action(1, 'load', 'r-b', 502, 4)]),
  point('pt-4', 4, 'Площадка 2', [action(1, 'unload', 'r-b', 502, 3)]),
];

const ROUTE: VehicleRouteDto = {
  id: 'route-1',
  displayNumber: 'Р-12',
  // Обычный маршрут грузоперевозки: состав из заявок, бланк по типу машины.
  purpose: 'freight',
  formCode: '4p',
  sourceRequest: null,
  moveFrom: '',
  moveTo: '',
  routeDate: '2026-08-03',
  vehicleId: 'v-own',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  vehicleKindId: 'kind-freight',
  vehicleTypeId: 'type-dump',
  vehicleTypeName: 'Самосвалы',
  vehicleCategoryId: null,
  vehicleCategorySpecs: null,
  driverPersonId: 'p-1',
  driverName: 'Тестовый Водитель Первый',
  driverGaps: [],
  withTrailer: false,
  trailerLabel: '',
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '00000389',
  communicationKind: '',
  transportationKind: '',
  comment: '',
  requests: [REQUEST_A, REQUEST_B],
  points: POINTS,
  waybill: null,
  createdByName: 'Диспетчер',
  createdAt: '2026-08-01T09:00:00.000Z',
  version: 3,
};

const ISSUED_ROUTE: VehicleRouteDto = {
  ...ROUTE,
  waybill: {
    id: 'w-1',
    number: '260604-646-00000004897',
    status: 'issued',
    issuedForDate: '2026-08-03',
  },
};

/**
 * Кандидаты на добавление в рейс: свободная заявка, заявка чужого рейса (её переносят) и заявка
 * рейса, замороженного выписанным листом, — последнюю предлагать нельзя (ADR 0052).
 */
const FREE_REQUEST = {
  id: 'r-free',
  displayNumber: 'ТС-701',
  requestType: 'freight_transport' as const,
  // Адреса лежат в ездке, а не у заявки (план `docs/route-trips-plan.md`, Р2). Подсказка читает
  // первую и приписывает счёт, когда их больше одной, — здесь она одна, как у всех заявок,
  // доехавших бэкфилом.
  trips: [
    {
      id: 'vrt-free',
      num: 1,
      displayNumber: 'ТС-701/1',
      fromLocation: 'Карьер',
      toLocation: 'Площадка 3',
      fromAddress: null,
      toAddress: null,
      volumeM3: 10,
      weightTons: null,
      fromResponsibleName: 'Иванов И. И.',
      fromResponsiblePhone: '+7 900 000-00-01',
      toResponsibleName: 'Петров П. П.',
      toResponsiblePhone: '+7 900 000-00-02',
      scheduledAt: null,
      comment: '',
      placement: null,
    },
  ],
  assignment: { ownership: 'own' as const, vehicleId: 'v-own' },
  // Тип назван явно: без него у свободной заявки выводится `null`, и соседние записи с рейсом
  // перестают быть тем же видом данных.
  route: null as VehicleRequestRouteDto | null,
};

const REQUEST_IN_OTHER_ROUTE = {
  ...FREE_REQUEST,
  id: 'r-other',
  displayNumber: 'ТС-702',
  assignment: { ownership: 'own' as const, vehicleId: 'v-other' },
  route: { id: 'route-9', displayNumber: 'Р-9', position: 2, hasWaybill: false, version: 5 },
};

const REQUEST_IN_FROZEN_ROUTE = {
  ...FREE_REQUEST,
  id: 'r-frozen',
  displayNumber: 'ТС-703',
  route: { id: 'route-8', displayNumber: 'Р-8', position: 1, hasWaybill: true, version: 2 },
};

/**
 * Карточка вместе с ручками рейса. Изменения отвечают тем же рейсом: карточка после правки
 * перерисовывается ответом сервера, и подсовывать ей другой состав значило бы проверять не то,
 * что ушло, а то, что мы сами придумали в ответ.
 */
function renderModal(route: VehicleRouteDto, candidates: unknown[] = []): HttpMock {
  const http = mockHttp({
    'GET /vehicle-routes/:id': () => json(route),
    // Что можно положить в рейс, отбирает сервер: карточка сужает список только по рейсу заявки.
    'GET /vehicle-requests': () => json(list(candidates)),
    'PUT /vehicle-routes/:id/points/order': () => json(route),
    'POST /vehicle-routes/:id/requests': () => json(route),
  });
  renderWithUser(<VehicleRouteModal routeId="route-1" onClose={() => {}} onChanged={() => {}} />);
  return http;
}

describe('порядок объезда в рейсе', () => {
  /**
   * Стрелки переставляют **точки**, а не строки состава, и это не оформление: задание печатается по
   * позициям точек (Р11). Пока карточка двигала состав, экран показывал один порядок, а бумага
   * печатала другой — регресс, который нашло ревью уже после выката.
   */
  it('стрелка вверх отправляет весь порядок объезда', async () => {
    const http = renderModal(ROUTE);

    fireEvent.click(await screen.findByLabelText('Поднять точку 2'));

    await waitFor(() => expect(http.countOf('PUT /vehicle-routes/:id/points/order')).toBe(1));
    const call = http.lastCall('PUT /vehicle-routes/:id/points/order')!;
    expect(call.path).toBe('/vehicle-routes/route-1/points/order');
    expect(call.body).toEqual({ pointIds: ['pt-2', 'pt-1', 'pt-3', 'pt-4'], version: 3 });
  });

  it('первую точку выше не поднять, последнюю ниже не опустить', async () => {
    renderModal(ROUTE);

    // jest-dom в проекте не подключён: смотрим на сам атрибут, как в auto-select.test.tsx.
    expect((await screen.findByLabelText('Поднять точку 1')).hasAttribute('disabled')).toBe(true);
    expect((await screen.findByLabelText('Опустить точку 4')).hasAttribute('disabled')).toBe(true);
  });

  /**
   * У строк, различённых объездом, стрелок в «Задании листа» нет вовсе — не «выключены», а нет:
   * переставлять их надо точками, и предлагать два способа сделать одно значит запутать. Стрелки
   * там появляются только у строк, стоящих на **одной и той же паре** точек (миграция `0146`), —
   * этих в фикстуре нет.
   */
  it('у строк, разведённых объездом, стрелок задания нет', async () => {
    renderModal(ROUTE);

    await screen.findByLabelText('Поднять точку 2');
    expect(screen.queryByLabelText(/Поднять строку задания/)).toBeNull();
  });

  it('выписанный лист замораживает рейс: правок в карточке нет, и сказано почему', async () => {
    renderModal(ISSUED_ROUTE);

    expect(await screen.findByText(/аннулируйте его, чтобы править рейс/i)).toBeTruthy();
    expect(screen.queryByLabelText('Поднять точку 2')).toBeNull();
    expect(screen.queryByLabelText('Убрать ТС-501')).toBeNull();
    // Второй лист по рейсу не выписывается — кнопка остаётся, но нажать её нельзя.
    expect(screen.getByRole('button', { name: 'Выписать лист' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});

/**
 * Открыть список кандидатов: у antd плейсхолдер — не атрибут поля, а свой элемент, поэтому поле
 * ищется по нему и открывается тем же mouseDown, каким его открывает человек.
 */
/** Тексты пунктов открытого списка: antd рисует их и в самом списке, и в подписи выбранного. */
const optionTexts = () =>
  [...document.querySelectorAll('.ant-select-item-option')].map((n) => n.textContent ?? '');

async function openCandidates() {
  // Сначала — что список кандидатов доехал: до него поле пустует и открывать в нём нечего.
  await screen.findByText(/свободная или из другого рейса/i);
  const field = [...document.querySelectorAll('.ant-select')].at(-1)!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
}

/**
 * Перенос заявки из чужого рейса (ADR 0052): переложить ТС-702 из Р-9 сюда — одно действие, а не
 * «вынуть и положить» двумя, между которыми заявка висит в работе без маршрута.
 */
describe('перенос заявки в этот рейс', () => {
  it('заявка чужого рейса подписана рейсом и уходит вместе с ним в source', async () => {
    const http = renderModal(ROUTE, [FREE_REQUEST, REQUEST_IN_OTHER_ROUTE]);

    await openCandidates();
    // Подпись говорит, откуда заявку забирают: диспетчер не должен думать, что она свободна.
    const option = await screen.findByText(/ТС-702.*из Р-9, строка 2/);
    fireEvent.click(option.closest('.ant-select-item-option') ?? option);

    // Кнопка называет действие своим именем — это перенос, а не добавление.
    fireEvent.click(await screen.findByText('Перенести'));

    await waitFor(() => expect(http.countOf('POST /vehicle-routes/:id/requests')).toBe(1));
    const call = http.lastCall('POST /vehicle-routes/:id/requests')!;
    expect(call.path).toBe('/vehicle-routes/route-1/requests');
    expect(call.body).toEqual({
      requestId: 'r-other',
      version: 3,
      // Исходный рейс — парой «кто + версия»: одинокая версия совпала бы случайно.
      source: { routeId: 'route-9', version: 5 },
    });
  });

  it('заявку из замороженного рейса не предлагают: из бумаги у водителя она не исчезнет', async () => {
    renderModal(ROUTE, [FREE_REQUEST, REQUEST_IN_FROZEN_ROUTE]);

    await openCandidates();

    await waitFor(() => expect(optionTexts().some((t) => t.includes('ТС-701'))).toBe(true));
    expect(optionTexts().some((t) => t.includes('ТС-703'))).toBe(false);
  });

  it('свободная заявка добавляется без source — забирать её не у кого', async () => {
    const http = renderModal(ROUTE, [FREE_REQUEST]);

    await openCandidates();
    await waitFor(() => expect(optionTexts().some((t) => t.includes('ТС-701'))).toBe(true));
    const free = [...document.querySelectorAll('.ant-select-item-option')].find((n) =>
      n.textContent?.includes('ТС-701'),
    )!;
    fireEvent.click(free);
    fireEvent.click(await screen.findByText('Добавить'));

    await waitFor(() => expect(http.countOf('POST /vehicle-routes/:id/requests')).toBe(1));
    // `source` не ушёл вовсе — не «пустым»: забирать заявку не у кого.
    expect(http.lastCall('POST /vehicle-routes/:id/requests')!.body).toEqual({
      requestId: 'r-free',
      version: 3,
    });
  });
});
