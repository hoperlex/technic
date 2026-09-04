import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  AuthUser,
  OfficeEquipmentConsumableUsageDto,
  ServiceRequestDto,
  ServiceWarrantyRowDto,
} from '@technic/contracts';
import { SERVICE_REQUEST_NO_EQUIPMENT } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { serviceOperator, serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { authUser } from './factories/auth';
import { MOBILE_VIEWPORT } from './viewport';
import { RequestsTab } from '../src/pages/service/RequestsTab';
import { ServiceArchiveTab } from '../src/pages/service/ArchiveTab';
import { WarrantiesTab } from '../src/pages/service/WarrantiesTab';
import { OfficeEquipmentConsumableUsageModal } from '../src/pages/directories/OfficeEquipmentConsumableUsageModal';

/**
 * Заявка с ПУСТЫМ предметом в портале (Р8 плана
 * `docs/office-equipment-consumables-and-purchase-plan.md`, ADR 0146, решение 7).
 *
 * Заводить такие заявки ещё нечем — выпуск 2а учит только ЧИТАТЬ, — и потому проверяется здесь
 * ровно одно: что портал показывает её людям так же уверенно, как любую другую. Ошибка тут
 * молчалива дважды. Сначала это `undefined` в чтении `equipment.name`: белый экран вместо списка у
 * того, кому такая заявка попалась, — и ни строчки в почте о том, что случилось. Потом — тихая
 * потеря: строка реестра гарантий или отчёта о расходе, у которой не оказалось аппарата, исчезает
 * с экрана, и итог под ней перестаёт сходиться с показанным.
 *
 * Слова везде одни и те же — `SERVICE_REQUEST_NO_EQUIPMENT`: разойдись они, «Без аппарата» в
 * списке и прочерк в карточке читались бы как два разных состояния заявки.
 */

const OPERATOR: AuthUser = serviceOperator();

/** Заявка «от отдела»: аппарата нет, площадки нет, заказчик — отдел (`CHECK` предмета, Р7). */
const fromDepartment = (over: Partial<ServiceRequestDto> = {}) =>
  serviceRequest({
    id: 'sr-2',
    num: 15,
    displayNumber: 'СО-15',
    kind: 'consumable',
    equipment: null,
    object: null,
    customerDepartment: { id: 'dep-1', code: 'ОТД-1', name: 'Отдел ИТ' },
    description: 'Нужен тонер на склад',
    ...over,
  });

function requestRoutes(items: ServiceRequestDto[], over: RouteMap = {}): RouteMap {
  return {
    'GET /service-requests': () => json(list(items)),
    'GET /service-requests/executor-candidates': () => json({ items: [] }),
    // Карточка спрашивает заявку сама: без этого маршрута окно осталось бы пустым, и сценарий,
    // ничего не проверив, остался бы зелёным.
    'GET /service-requests/:id': ({ params }) =>
      json(items.find((r) => r.id === params.id) ?? items[0]!),
    'GET /service-requests/:id/history': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    ...over,
  };
}

function renderTab(items: ServiceRequestDto[], over: RouteMap = {}): HttpMock {
  const http = mockHttp(requestRoutes(items, over));
  renderWithUser(<RequestsTab />, { user: OPERATOR });
  return http;
}

/** Меню действий строки: по его пунктам и видно, что заявке предлагают сделать. */
async function rowActionLabels(): Promise<string[]> {
  fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
  const menu = await waitFor(() => {
    const found = document.querySelector('.ant-dropdown-menu');
    if (!found) throw new Error('меню действий не открылось');
    return found;
  });
  return [...menu.querySelectorAll('.ant-dropdown-menu-title-content')].map(
    (el) => el.textContent ?? '',
  );
}

describe('список заявок: заявка без аппарата', () => {
  it('строка на месте, предмет назван словами, а площадку заменяет отдел-заказчик', async () => {
    renderTab([fromDepartment()]);

    expect(await screen.findByText('СО-15')).toBeDefined();
    // Не прочерк и не пустое место: прочерк читается как «данные не догрузились».
    expect(screen.getByText(SERVICE_REQUEST_NO_EQUIPMENT)).toBeDefined();
    expect(screen.queryByText('Kyocera M3145')).toBeNull();
    // Верхняя строка колонки «Объект» достаётся отделу: он и есть область такой заявки.
    expect(screen.getByText('Отдел ИТ')).toBeDefined();
  });

  it('строка держит ту же высоту, что у соседей: подпись под предметом не пустеет', async () => {
    renderTab([fromDepartment(), serviceRequest()]);
    await screen.findByText('СО-15');

    /*
     * Номеров и типа у заявки без аппарата нет, и подпись под предметом ей взять неоткуда. Останься
     * она пустой — ячейка потеряла бы вторую строку, а с ней и высоту: в списке это читается не как
     * «здесь пусто», а как недорисованная таблица. Место держит неразрывный пробел, поэтому
     * проверяется не число узлов (пустой `<span>` antd рисует и так), а то, что строка непуста.
     */
    const rows = [...document.querySelectorAll<HTMLElement>('.ant-table-tbody .ant-table-row')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const hint = row.querySelectorAll('td')[2]!.querySelector('.ant-typography');
      expect(hint?.textContent?.length).toBeGreaterThan(0);
    }
  });

  it('на телефоне карточка называет предмет и не рисует пустую строку площадки', async () => {
    mockHttp(requestRoutes([fromDepartment()]));
    renderWithUser(<RequestsTab />, { user: OPERATOR, viewport: MOBILE_VIEWPORT });

    await screen.findByText('СО-15');
    const card = document.querySelector<HTMLElement>('.list-card')!;
    expect(within(card).getByText(SERVICE_REQUEST_NO_EQUIPMENT)).toBeDefined();
    // Пустых строк в карточке нет вовсе: площадки у заявки «от отдела» не существует, и строка
    // пропускается целиком — прочерк на телефоне читался бы как недогруженная запись.
    const lines = [...card.querySelectorAll('.list-card__line')];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.textContent?.trim()).not.toBe('');
  });
});

describe('карточка заявки без аппарата', () => {
  const openCard = async (num = 'СО-15') => {
    fireEvent.click(await screen.findByText(num));
    await waitFor(() => {
      if (!document.querySelector('.ant-modal-wrap')) throw new Error('карточка не открылась');
    });
  };

  it('называет предмет словами, а строку площадки сужает до вопроса «для кого»', async () => {
    renderTab([fromDepartment()]);
    await openCard();

    expect(screen.getAllByText(SERVICE_REQUEST_NO_EQUIPMENT).length).toBeGreaterThan(0);
    // Подпись меняется вместе с содержимым: стоять у такой заявки нечему, а заказчик у неё есть.
    expect(screen.getByText('Для кого')).toBeDefined();
    expect(screen.queryByText('Где стоит и для кого')).toBeNull();
    expect(screen.getAllByText('Отдел ИТ').length).toBeGreaterThan(0);
    // Гарантии единицы у заявки без аппарата не «неизвестна» — её нет вовсе.
    expect(screen.queryByText('гарантия на технику:')).toBeNull();
    expect(screen.queryByText('Объект указан заявителем')).toBeNull();
  });

  it('перемещение техники такой заявке не предлагается: переезжать нечему', async () => {
    renderTab([fromDepartment()]);
    await screen.findByText('СО-15');
    expect(await rowActionLabels()).not.toContain('Записать перемещение техники');
  });

  /*
   * Вход у перемещения теперь один и он в карточке (ADR 0162): в меню списка пункта нет ни у
   * какой заявки — переезд правит справочник, и решают его, глядя на реквизиты аппарата. Проверяем
   * обе половины сразу, иначе «пункта нет» прошло бы и на потерянном действии.
   */
  it('перемещение записывают из карточки, а в меню списка его нет', async () => {
    renderTab([serviceRequest()]);
    await screen.findByText('СО-14');
    expect(await rowActionLabels()).not.toContain('Записать перемещение техники');

    await openCard('СО-14');
    expect(screen.getByText('Записать перемещение')).toBeDefined();
  });

  it('у заявки без аппарата кнопки перемещения в карточке нет', async () => {
    renderTab([fromDepartment()]);
    await openCard();
    expect(screen.queryByText('Записать перемещение')).toBeNull();
  });
});

describe('архив заявок', () => {
  it('удалённая заявка без аппарата читается теми же словами', async () => {
    mockHttp({
      'GET /service-requests': () =>
        json(list([fromDepartment({ deletedAt: '2026-08-30T10:00:00.000Z' })])),
      'GET /service-requests/:id': () => json(fromDepartment()),
      'GET /service-requests/:id/history': () => json([]),
      'GET /objects': () => json(emptyList()),
      'GET /departments': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
      'GET /office-equipment': () => json(emptyList()),
      'GET /office-equipment-types': () => json(emptyList()),
    });
    renderWithUser(<ServiceArchiveTab />, { user: authUser({ role: 'admin' }) });

    expect(await screen.findByText('СО-15')).toBeDefined();
    expect(screen.getByText(SERVICE_REQUEST_NO_EQUIPMENT)).toBeDefined();
    // Вторая строка не пустеет: у заявки «от отдела» её занимает отдел-заказчик.
    expect(screen.getByText('Отдел ИТ')).toBeDefined();
  });
});

describe('реестр гарантий', () => {
  const row = (over: Partial<ServiceWarrantyRowDto> = {}): ServiceWarrantyRowDto => ({
    id: 'item:it-1',
    kind: 'repair',
    equipmentId: 'oe-1',
    equipmentName: 'Kyocera M3145',
    serialNumber: 'SN-1',
    inventoryNumber: '0012345',
    typeName: 'МФУ',
    objectName: 'ЖК Северный',
    departmentName: null,
    subject: 'Замена узла подачи',
    warrantyUntil: '2026-11-20',
    state: 'active',
    daysLeft: 102,
    requestId: 'sr-1',
    requestNum: 14,
    displayNumber: 'СО-14',
    itemId: 'it-1',
    ...over,
  });

  /** Гарантия на работу по заявке БЕЗ аппарата: носителя в справочнике нет, а гарантия есть. */
  const noEquipmentRow = row({
    id: 'item:it-2',
    equipmentId: null,
    equipmentName: '',
    serialNumber: '',
    inventoryNumber: '',
    typeName: null,
    objectName: null,
    subject: 'Заправка картриджа',
    requestId: 'sr-2',
    requestNum: 15,
    displayNumber: 'СО-15',
    itemId: 'it-2',
  });

  it('строка без аппарата остаётся видимой и названной, но обращение по ней не заводится', async () => {
    mockHttp({
      'GET /service-requests/warranties': () => json(list([row(), noEquipmentRow])),
      'GET /objects': () => json(list([objectDto()])),
      'GET /departments': () => json(emptyList()),
      'GET /office-equipment': () => json(emptyList()),
      'GET /office-equipment-types': () => json(emptyList()),
    });
    renderWithUser(<WarrantiesTab />, {
      user: authUser({ role: 'shtab', constructionObjectIds: ['obj-1'] }),
    });

    // Потеряй реестр эту строку — спорить с сервисом о гарантии на работу было бы нечем.
    expect(await screen.findByText('Заправка картриджа')).toBeDefined();
    expect(screen.getByText(SERVICE_REQUEST_NO_EQUIPMENT)).toBeDefined();
    // Обращение по гарантии заводится ВЫБОРОМ аппарата: там, где его нет, кнопка обещала бы окно,
    // которое не откроется. У соседней строки она на месте.
    expect(screen.getAllByRole('button', { name: 'Заявка по гарантии' })).toHaveLength(1);
  });
});

describe('отчёт о расходе расходников', () => {
  const usage = (over: Partial<OfficeEquipmentConsumableUsageDto> = {}) => ({
    from: '2026-08-01',
    to: '2026-08-31',
    rows: [
      {
        requestId: 'sr-2',
        displayNumber: 'СО-15',
        // Выдача «на склад»: заявка есть, аппарата у неё нет — четыре поля пустеют вместе.
        equipmentId: null,
        equipmentName: null,
        equipmentInventoryNumber: null,
        equipmentSerialNumber: null,
        consumableId: 'oec-1',
        code: 'Д0000093569',
        name: 'Тонер Ricoh 201 (шт)',
        color: null,
        issued: 3,
        returned: 0,
        quantity: 3,
        actorName: 'Иванов И. И.',
        at: '2026-08-21T09:00:00.000Z',
      },
    ],
    totalIssued: 3,
    totalReturned: 0,
    truncated: false,
    ...over,
  });

  it('строка с пустым аппаратом видна и подписана словами, а не пустой клеткой', async () => {
    mockHttp({
      'GET /office-equipment-consumables/usage-report': () => json(usage()),
      'GET /office-equipment-consumables': () => json(emptyList()),
    });
    renderWithUser(<OfficeEquipmentConsumableUsageModal open onClose={() => {}} />, {
      user: OPERATOR,
    });

    // Итог отчёта считается по журналу целиком: пропади строка — суммы под ней перестали бы
    // сходиться с показанным, и заказ на квартал составили бы по неверному расходу.
    expect(await screen.findByText('СО-15')).toBeDefined();
    expect(screen.getByText(SERVICE_REQUEST_NO_EQUIPMENT)).toBeDefined();
    expect(screen.getByText(/Д0000093569/u)).toBeDefined();
  });
});
