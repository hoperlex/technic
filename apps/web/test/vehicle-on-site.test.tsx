import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  SpecialEquipmentRequestDto,
  VehicleOnSiteListDto,
  VehicleOnSiteSummaryDto,
  VehicleRequestAssignmentDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list as listOf } from './factories/common';
import { classification, vehicleRequest } from './factories/vehicle';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { VehicleRequestsOnSiteTab } from '../src/pages/vehicle/VehicleRequestsOnSiteTab';

/**
 * Вкладка «На объекте» (ADR 0036): техника, которая работает на объектах сегодня.
 *
 * Проверяется то, ради чего вкладку открывают: строка отвечает, что за машина стоит на площадке
 * и что для неё значит сегодняшний день — вышла, стоит или уезжает. День среза берётся из ответа
 * API (`onDate`), а не из часов браузера, поэтому подписи присутствия проверяются на фиксированном
 * дне без подмены системного времени.
 *
 * Данные приходят HTTP-моком, а не подменой `api/resources`: вкладка держится за контракт ручек
 * среза, а не за то, каким модулем портал их сегодня зовёт.
 */

const ON_DATE = '2026-07-24';

/** Строка среза: спецтехника в работе — только такую отбирает вкладка и только её сокращают. */
const onSite = (over: Partial<SpecialEquipmentRequestDto>): SpecialEquipmentRequestDto =>
  vehicleRequest({ status: 'confirmed', objectName: 'Альфа-объект', ...over });

/**
 * Своя машина в назначении: подпись строки — госномер, а марка идёт второй строкой рядом со
 * «Своей техникой» — по ней машину и держат в голове, номер не говорит, самосвал это или автокран.
 */
const ownAssignment = (
  registrationNumber: string,
  modelName: string,
): VehicleRequestAssignmentDto => ({
  vehicleId: `v-${registrationNumber}`,
  ownership: 'own',
  vehicleKindId: 'vk-special',
  vehicleTypeId: 'vt-1',
  typeName: 'Автокраны',
  vehicleCategoryId: 'vc-130',
  categoryName: 'Автокран, г/п 130 т',
  categorySpecs: { lift_capacity: 130 },
  modelName,
  registrationNumber,
  description: '',
  lessorId: null,
  lessorName: null,
  pricePerHour: null,
  pricePerShift: null,
  shiftHours: null,
  assignedBy: 'user-2',
  assignedByName: 'Петров П. П.',
  assignedAt: '2026-07-23T09:00:00.000Z',
});

const items: SpecialEquipmentRequestDto[] = [
  onSite({
    id: 'r1',
    num: 101,
    displayNumber: 'ТС-101',
    dateFrom: ON_DATE,
    dateTo: '2026-07-28',
    comment: 'разработка котлована',
    assignment: {
      vehicleId: 'v1',
      ownership: 'rental',
      vehicleKindId: 'vk-special',
      vehicleTypeId: 'vt-1',
      typeName: 'Автокраны',
      vehicleCategoryId: 'vc-130',
      categoryName: 'Автокран, г/п 130 т',
      categorySpecs: { lift_capacity: 130 },
      modelName: null,
      registrationNumber: null,
      description: 'Автокран 70 тн',
      lessorId: 'c1',
      lessorName: 'ООО «Арендатех»',
      pricePerHour: null,
      pricePerShift: 18000,
      shiftHours: 8,
      assignedBy: 'user-2',
      assignedByName: 'Петров П. П.',
      assignedAt: '2026-07-23T09:00:00.000Z',
    },
  }),
  // Запрошенное досрочное завершение (ADR 0044): срок в строке пока прежний, а тег уже говорит,
  // что машина уезжает раньше — если визу поставят.
  onSite({
    id: 'r2',
    num: 102,
    displayNumber: 'ТС-102',
    dateFrom: '2026-07-22',
    dateTo: '2026-07-26',
    earlyEnd: {
      status: 'pending',
      newDateTo: '2026-07-25',
      previousDateTo: '2026-07-26',
      reason: 'работы на фундаменте закончены',
      requestedBy: 'user-3',
      requestedByName: 'Сидоров С. С.',
      requestedAt: '2026-07-24T06:00:00.000Z',
      decidedBy: null,
      decidedByName: null,
      decidedAt: null,
      decisionComment: '',
    },
  }),
  onSite({
    id: 'r3',
    num: 103,
    displayNumber: 'ТС-103',
    dateFrom: '2026-07-20',
    dateTo: ON_DATE,
    assignment: ownAssignment('Е646СК799', 'КамАЗ 65115'),
  }),
  // Срок прошёл, а работа не принята: такую заявку срез не отпускает — закрыть её всё равно
  // нельзя, и без строки о ней вспомнили бы через месяц.
  onSite({
    id: 'r4',
    num: 104,
    displayNumber: 'ТС-104',
    dateFrom: '2026-07-18',
    dateTo: '2026-07-21',
    shifts: { approvedDays: 1, unapprovedPastDays: 3 },
  }),
];

const list: VehicleOnSiteListDto = { items, total: 4, page: 1, pageSize: 50, onDate: ON_DATE };

/** Сводка считается сервером по тем же строкам: одна машина выходит, одна уезжает, одна ждёт визы. */
const summary: VehicleOnSiteSummaryDto = {
  total: 4,
  objects: 1,
  arrivedToday: 1,
  leavingToday: 1,
  earlyEndPending: 1,
  shiftsPending: 1,
};

/**
 * Линейный заказ (ADR 0100 §12): назначение у него — машина по умолчанию, а на объект в
 * конкретный день выходит машина рейса **этого дня**, и срез обязан называть её. Своим срезом, а
 * не строками в общем списке: у линейных строк свой счёт карточек и свои подписи присутствия, и
 * подмешивание их в общий набор переписало бы соседние проверки, ничего к ним не добавив.
 */
const linearSlice: VehicleOnSiteListDto = {
  items: [
    onSite({
      id: 'r5',
      num: 105,
      displayNumber: 'ТС-105',
      isLinear: true,
      dateFrom: '2026-07-22',
      dateTo: '2026-07-28',
      assignment: ownAssignment('Х001АА777', 'КамАЗ 6520'),
      dayVehicle: {
        routeId: 'rt-1',
        routeDisplayNumber: 'Р-12',
        vehicleId: 'v-day',
        vehicleLabel: 'В321ВВ777',
        vehicleModelName: 'МАЗ 6501',
        driverPersonId: 'p-1',
        driverName: 'Иванов И. И.',
      },
    }),
    // День не распланирован: рейса на сегодня нет, и назначение показывать вместо факта нельзя.
    onSite({
      id: 'r6',
      num: 106,
      displayNumber: 'ТС-106',
      isLinear: true,
      dateFrom: '2026-07-22',
      dateTo: '2026-07-28',
      assignment: ownAssignment('У777УУ777', 'МАЗ 5440'),
      dayVehicle: null,
    }),
  ],
  total: 2,
  page: 1,
  pageSize: 50,
  onDate: ON_DATE,
};

/**
 * Смотрит администратор: у него сходятся оба права на сокращение срока — запрос
 * (`vehicleRequests.update`, право заказчика и диспетчера) и виза на него
 * (`vehicleRequests.approve`, право руководителя строительства, ADR 0025). Тест разбирает обе
 * группы действий разом, а роли, у которой есть только одно из прав, вторая была бы не видна.
 */
const admin = authUser({ role: 'admin' });

/** Позиция классификатора для фильтра техники: сам срез она не меняет — отбирает сервер. */
const CRANE = classification({
  key: 'vt-1:vc-1',
  vehicleTypeId: 'vt-1',
  vehicleCategoryId: 'vc-1',
  typeName: 'Автокраны',
  kindName: 'Спецтехника',
  label: 'Автокраны, г/п 25 т',
});

/** Срез задаётся аргументом: линейные строки проверяются своим набором, остальные — общим. */
function renderTab(viewport?: Viewport, slice: VehicleOnSiteListDto = list): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests/on-site': () => json(slice),
    'GET /vehicle-requests/on-site/summary': () => json(summary),
    // Справочник объектов наполняет фильтр вкладки; отбор строк ведёт сервер, и на проверяемое он
    // не влияет — поэтому пуст.
    'GET /objects': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(listOf([CRANE])),
  });
  renderWithUser(<VehicleRequestsOnSiteTab />, { user: admin, viewport });
  return http;
}

describe('вкладка «На объекте»', () => {
  it('строка отвечает, что за машина стоит и что для неё значит сегодня', async () => {
    renderTab();

    // Машина из назначения (ADR 0027) с арендодателем — по нему и звонят про простой.
    expect(await screen.findByText('ООО «Арендатех»')).toBeDefined();
    expect(screen.getAllByText('Альфа-объект').length).toBeGreaterThan(0);

    // Присутствие в сегодняшнем дне: вышла, стоит, уезжает — по датам и `onDate` из ответа.
    expect(screen.getByText('вышла сегодня')).toBeDefined();
    expect(screen.getByText('на объекте')).toBeDefined();
    expect(screen.getByText('уезжает сегодня')).toBeDefined();
    // Который день из заказанных идёт: у периода 22–26 июля на 24-е это третий из пяти.
    expect(screen.getByText('день 3 из 5')).toBeDefined();
  });

  it('на телефоне тот же срез читается карточками', async () => {
    renderTab(MOBILE_VIEWPORT);

    expect(await screen.findByText('ООО «Арендатех»')).toBeDefined();
    expect(document.querySelector('.ant-table')).toBeNull();
    expect(document.querySelectorAll('.list-card')).toHaveLength(4);
    expect(screen.getByText('вышла сегодня')).toBeDefined();
  });

  it('приёмка работы по дням видна в строке, а просроченная заявка не исчезает из среза', async () => {
    renderTab();

    expect(await screen.findByText('ООО «Арендатех»')).toBeDefined();
    // Заявка, чей срок прошёл, держится в срезе неподтверждёнными сменами — и подписана иначе,
    // чем работающая: техника уехала, а работа не принята.
    expect(screen.getByText('смены не согласованы')).toBeDefined();
    expect(screen.getByText('не согласовано дней: 3')).toBeDefined();
    // Столбец отвечает и по работающим заявкам: сколько дней уже принято из заказанных.
    expect(screen.getByText('согласовано 1 из 4')).toBeDefined();
  });

  it('срез ведёт одно действие — досрочное завершение; статусы и правка остаются в списке', async () => {
    renderTab();

    expect(await screen.findByText('ООО «Арендатех»')).toBeDefined();
    // Статусы, виза заявки и правка сюда не переехали: их ведут в списке заказов (ADR 0036).
    expect(screen.queryByRole('button', { name: 'Изменить статус' })).toBeNull();
    // Действия строки — иконки с подсказками (ADR 0030); ищутся по подписи, которую подсказка
    // дублирует в `aria-label`: сама она в разметку до наведения не попадает.
    expect(screen.getAllByLabelText('Открыть карточку')).toHaveLength(4);
    // Смены ведут отсюда же: срез отвечает, что стоит на площадке, — и здесь же принимают работу.
    expect(screen.getAllByLabelText('Смены')).toHaveLength(4);

    // Заявка, которой есть что сокращать, получает действие; уезжающая сегодня (r3) — нет.
    expect(screen.getAllByLabelText('Завершить досрочно')).toHaveLength(1);
    // Ожидающий визы запрос вместо этого предлагает решение — и объявляет себя тегом.
    expect(screen.getByLabelText('Согласовать досрочное завершение')).toBeDefined();
    expect(screen.getByLabelText('Отклонить досрочное завершение')).toBeDefined();
    expect(screen.getByText('досрочно до 25.07.2026 · ждёт визы')).toBeDefined();
  });

  it('в графе техники марка стоит второй строкой рядом с арендодателем', async () => {
    renderTab();

    // Подпись первой строкой — госномер; марка и «Своя техника» одной строкой под ней: две
    // отдельные строки растили бы строку таблицы втрое против соседних (Р15).
    expect(await screen.findByText('Е646СК799')).toBeDefined();
    expect(screen.getByText('КамАЗ 65115 · Своя техника')).toBeDefined();
  });

  it('на телефоне марка стоит перед арендодателем, а не он один', async () => {
    renderTab(MOBILE_VIEWPORT);

    // Ровно то, на что жаловались: раньше в карточке был виден только арендодатель, и какая это
    // машина, на ходу узнать было негде.
    expect(await screen.findByText('Е646СК799')).toBeDefined();
    expect(screen.getByText('КамАЗ 65115 · Своя техника')).toBeDefined();
  });

  it('у линейного заказа в графе стоит машина дня, а не назначенная', async () => {
    renderTab(undefined, linearSlice);

    // Машина рейса этого дня — с рейсом и человеком в кабине рядом с маркой (ADR 0100 §12).
    expect(await screen.findByText('В321ВВ777')).toBeDefined();
    expect(screen.getByText('МАЗ 6501 · Р-12 · Иванов И. И.')).toBeDefined();
    // Назначенной машины в строке нет вовсе: у линейного заказа она лишь машина по умолчанию.
    expect(screen.queryByText('Х001АА777')).toBeNull();
    expect(screen.queryByText('КамАЗ 6520 · Своя техника')).toBeNull();
  });

  it('линейный день без рейса объявляет об этом словами, а не машиной по умолчанию', async () => {
    renderTab(undefined, linearSlice);

    expect(await screen.findByText('на этот день машина не назначена')).toBeDefined();
    // Назначение вместо факта не подставляется: выдать его за вышедшую сегодня машину значило бы
    // ответить на вопрос «что на объекте» догадкой.
    expect(screen.queryByText('У777УУ777')).toBeNull();
  });

  it('выбранный бланк уходит и в список, и в сводку', async () => {
    const http = renderTab();
    await screen.findByText('ООО «Арендатех»');

    // Поле опознаётся подсказкой — подписи у фильтров полосы нет, её место занимает placeholder.
    const field = [...document.querySelectorAll<HTMLElement>('.ant-select')].find(
      (el) => el.textContent?.trim() === 'Все бланки',
    );
    expect(field, 'фильтр «Все бланки»').toBeTruthy();
    fireEvent.mouseDown(field!.querySelector('.ant-select-selector') ?? field!);
    await waitFor(() => {
      const option = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
        (o) => o.textContent?.trim() === 'ЭСМ-2',
      );
      expect(option, 'вариант «ЭСМ-2»').toBeTruthy();
      fireEvent.click(option!);
    });

    await waitFor(() => {
      expect(http.lastCall('GET /vehicle-requests/on-site')!.query.get('forms')).toBe('esm2');
      // Сводка сужается тем же ключом: цифры, посчитанные не по видимым строкам, вводили бы в
      // заблуждение вернее, чем их отсутствие.
      expect(http.lastCall('GET /vehicle-requests/on-site/summary')!.query.get('forms')).toBe(
        'esm2',
      );
    });
  });

  it('фильтр техники уезжает набором позиций одним параметром classifications', async () => {
    const http = renderTab();
    await screen.findByText('ООО «Арендатех»');

    // Поле опознаётся подсказкой: подписи у фильтров панели нет, её место занимает placeholder.
    const field = [...document.querySelectorAll<HTMLElement>('.ant-select')].find(
      (el) => el.textContent?.trim() === 'Любой тип ТС',
    );
    expect(field, 'фильтр «Любой тип ТС»').toBeTruthy();
    fireEvent.mouseDown(field!.querySelector('.ant-select-selector') ?? field!);
    await waitFor(() => {
      const option = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
        (o) => o.textContent?.includes('Автокраны, г/п 25 т'),
      );
      expect(option, 'вариант категории').toBeTruthy();
      fireEvent.click(option!);
    });

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/on-site')!;
      // Одна позиция — тоже набор: старой пары полей в запросе среза больше нет.
      expect(call.query.get('classifications')).toBe('cvc-1');
      expect(call.query.get('vehicleTypeId')).toBeNull();
    });
  });
});
