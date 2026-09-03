import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { can, type AuthUser, type OfficeEquipmentDto } from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { ServiceRequestsPage } from '../src/pages/service/ServiceRequestsPage';

/**
 * Раздел «Орг.техника» открывают два права, и вкладки внутри проверяют своё (план
 * `docs/office-equipment-mail-and-history-plan.md`, Р72).
 *
 * Проверяется именно то, что нельзя увидеть в контрактах: у менеджера есть `officeEquipment.read`
 * и нет `serviceRequests.read`, и до этой правки раздел был для него закрыт целиком — маршрут
 * пускал по праву заявок. Обратная сторона так же важна: сервисной компании парк не показывают ни
 * вкладкой, ни прямой ссылкой — реквизиты нужной ей единицы приходят снимком в самой заявке (Р7).
 *
 * Вкладка по умолчанию считается по правам, а не константой: жёсткое «Заявки» у роли без права на
 * них означало бы пустой экран с отказами в запросах.
 */

const EQUIPMENT: OfficeEquipmentDto = {
  id: 'oe-1',
  type: { id: 'ty-1', name: 'МФУ', isActive: true },
  name: 'Kyocera M3145',
  serialNumber: 'SN-1',
  inventoryNumber: '0012345',
  object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
  department: null,
  location: 'каб. 214',
  state: 'on_site',
  stateNote: '',
  purchasedOn: null,
  warrantyUntil: null,
  comment: '',
  isActive: true,
  createdAt: '2026-01-10T09:00:00.000Z',
  updatedAt: '2026-01-10T09:00:00.000Z',
  deletedAt: null,
};

const ROUTES: RouteMap = {
  'GET /office-equipment': () => json(list([EQUIPMENT])),
  'GET /office-equipment-types': () => json(list([EQUIPMENT.type])),
  'GET /objects': () => json(list([EQUIPMENT.object])),
  'GET /departments': () => json(emptyList()),
  'GET /service-requests': () => json(emptyList()),
  'GET /service-requests/warranties': () => json(emptyList()),
  'GET /service-requests/waiting-count': () => json({ count: 0 }),
  'GET /counterparties': () => json(emptyList()),
};

function renderPage(user: AuthUser, search = '') {
  const http = mockHttp(ROUTES);
  renderWithUser(<ServiceRequestsPage />, { user, route: `/office-equipment${search}` });
  return http;
}

/** Менеджер ведёт справочники, но заявок на обслуживание у него нет вовсе. */
const KEEPER = authUser({ role: 'manager', constructionObjectIds: [] });
/** Оператор оргтехники: надстройка над штабом — у него есть и заявки, и парк. */
const OPERATOR = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
});
/**
 * Сервисная компания: заявки видит, парк — нет. Роль `operator` здесь не «оператор оргтехники», а
 * роль учётки контрагента — права ей даёт тип контрагента (ADR 0038).
 */
const SERVICE = authUser({ role: 'operator', counterpartyType: 'service' });

describe('вкладки раздела «Орг.техника»', () => {
  it('у того, кто ведёт заявки и парк, вкладок четыре', async () => {
    renderPage(OPERATOR);

    expect(await screen.findByRole('tab', { name: 'Заявки' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Гарантии' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Техника' })).toBeTruthy();
  });

  it('менеджеру открыта только «Техника», и она же становится вкладкой по умолчанию', async () => {
    // Право заявок у него отсутствует — иначе проверка ничего не значит.
    expect(can(KEEPER, 'serviceRequests.read')).toBe(false);
    expect(can(KEEPER, 'officeEquipment.read')).toBe(true);

    renderPage(KEEPER);

    const equipmentTab = await screen.findByRole('tab', { name: 'Техника' });
    expect(equipmentTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: 'Заявки' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Гарантии' })).toBeNull();
    // Список парка при этом рабочий: строка техники на экране.
    expect(await screen.findByText(/Kyocera M3145/)).toBeTruthy();
  });

  /**
   * Прямая ссылка переживает смену роли: адрес с недоступной вкладкой обязан вести на доступную, а
   * не на пустой экран с отказами.
   */
  it('ссылка на «Заявки» у менеджера ведёт на доступную вкладку', async () => {
    renderPage(KEEPER, '?tab=requests');

    const equipmentTab = await screen.findByRole('tab', { name: 'Техника' });
    expect(equipmentTab.getAttribute('aria-selected')).toBe('true');
  });

  it('сервисной компании парк закрыт и ссылкой тоже', async () => {
    expect(can(SERVICE, 'officeEquipment.read')).toBe(false);

    renderPage(SERVICE, '?tab=equipment');

    expect(await screen.findByRole('tab', { name: 'Заявки' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Техника' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Заявки' }).getAttribute('aria-selected')).toBe('true');
  });

  it('перемещение доступно только тому, кто ведёт парк', async () => {
    renderPage(KEEPER, '?tab=equipment');
    await screen.findByText(/Kyocera M3145/);

    // У менеджера есть `officeEquipment.write` — кнопка переезда в строке.
    expect(can(KEEPER, 'officeEquipment.write')).toBe(true);
    const row = screen.getByText(/Kyocera M3145/).closest('tr')!;
    expect(within(row).getByLabelText('swap')).toBeTruthy();
    // А правки и удаления во вкладке модуля нет вовсе: карточку ведут в справочнике.
    expect(within(row).queryByLabelText('edit')).toBeNull();
    expect(within(row).queryByLabelText('delete')).toBeNull();
  });
});
