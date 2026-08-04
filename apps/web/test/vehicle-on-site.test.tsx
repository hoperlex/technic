import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type {
  SpecialEquipmentRequestDto,
  VehicleOnSiteListDto,
  VehicleOnSiteSummaryDto,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { vehicleRequest } from './factories/vehicle';
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
  onSite({ id: 'r3', num: 103, displayNumber: 'ТС-103', dateFrom: '2026-07-20', dateTo: ON_DATE }),
];

const list: VehicleOnSiteListDto = { items, total: 3, page: 1, pageSize: 50, onDate: ON_DATE };

/** Сводка считается сервером по тем же строкам: одна машина выходит, одна уезжает, одна ждёт визы. */
const summary: VehicleOnSiteSummaryDto = {
  total: 3,
  objects: 1,
  arrivedToday: 1,
  leavingToday: 1,
  earlyEndPending: 1,
};

/**
 * Смотрит администратор: у него сходятся оба права на сокращение срока — запрос
 * (`vehicleRequests.update`, право заказчика и диспетчера) и виза на него
 * (`vehicleRequests.approve`, право руководителя строительства, ADR 0025). Тест разбирает обе
 * группы действий разом, а роли, у которой есть только одно из прав, вторая была бы не видна.
 */
const admin = authUser({ role: 'admin' });

function renderTab(viewport?: Viewport) {
  mockHttp({
    'GET /vehicle-requests/on-site': () => json(list),
    'GET /vehicle-requests/on-site/summary': () => json(summary),
    // Справочники наполняют фильтры вкладки; отбор строк ведёт сервер, и на проверяемое они не
    // влияют — поэтому пусты.
    'GET /objects': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(emptyList()),
  });
  return renderWithUser(<VehicleRequestsOnSiteTab />, { user: admin, viewport });
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
    expect(document.querySelectorAll('.list-card')).toHaveLength(3);
    expect(screen.getByText('вышла сегодня')).toBeDefined();
  });

  it('срез ведёт одно действие — досрочное завершение; статусы и правка остаются в списке', async () => {
    renderTab();

    expect(await screen.findByText('ООО «Арендатех»')).toBeDefined();
    // Статусы, виза заявки и правка сюда не переехали: их ведут в списке заказов (ADR 0036).
    expect(screen.queryByRole('button', { name: 'Изменить статус' })).toBeNull();
    // Действия строки — иконки с подсказками (ADR 0030); ищутся по подписи, которую подсказка
    // дублирует в `aria-label`: сама она в разметку до наведения не попадает.
    expect(screen.getAllByLabelText('Открыть карточку')).toHaveLength(3);

    // Заявка, которой есть что сокращать, получает действие; уезжающая сегодня (r3) — нет.
    expect(screen.getAllByLabelText('Завершить досрочно')).toHaveLength(1);
    // Ожидающий визы запрос вместо этого предлагает решение — и объявляет себя тегом.
    expect(screen.getByLabelText('Согласовать досрочное завершение')).toBeDefined();
    expect(screen.getByLabelText('Отклонить досрочное завершение')).toBeDefined();
    expect(screen.getByText('досрочно до 25.07.2026 · ждёт визы')).toBeDefined();
  });
});
