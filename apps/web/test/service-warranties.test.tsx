import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { AuthUser, ServiceWarrantyRowDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { WarrantiesTab } from '../src/pages/service/WarrantiesTab';

/**
 * Реестр действующих гарантий (§9.5) и вход в гарантийное обращение (Р26).
 *
 * Главное здесь — не таблица, а то, что из неё заводится: обращение по гарантии на **прошлый
 * ремонт** требует ссылки на позицию сметы закрытой заявки, и знает эту ссылку только реестр.
 * Разорвись эта связка — форма молча отправила бы `itemId: null`, сервер ответил бы 422
 * «укажите позицию», и починить это из портала было бы нечем.
 */

function warrantyRow(overrides: Partial<ServiceWarrantyRowDto> = {}): ServiceWarrantyRowDto {
  return {
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
    ...overrides,
  };
}

/** Заказчик: штаб своего объекта — он и обращается по гарантии, когда аппарат встал снова. */
const CUSTOMER: AuthUser = authUser({ role: 'shtab', constructionObjectIds: ['obj-1'] });

function renderTab(rows: ServiceWarrantyRowDto[], over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /service-requests/warranties': () => json(list(rows)),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<WarrantiesTab />, { user: CUSTOMER });
  return http;
}

describe('реестр гарантий', () => {
  it('открывается тем, что кончится раньше всего', async () => {
    const http = renderTab([warrantyRow()]);
    expect(await screen.findByText('Kyocera M3145')).toBeDefined();
    const last = http.lastCall('GET /service-requests/warranties');
    expect(last?.query.get('sortBy')).toBe('warrantyUntil');
    expect(last?.query.get('sortOrder')).toBe('asc');
  });

  it('различает носителей гарантии: техника и ремонт — разные строки', async () => {
    renderTab([
      warrantyRow(),
      warrantyRow({
        id: 'equipment:oe-1',
        kind: 'equipment',
        subject: 'Гарантия поставщика',
        requestId: null,
        requestNum: null,
        displayNumber: null,
        itemId: null,
      }),
    ]);
    expect(await screen.findByText('Замена узла подачи')).toBeDefined();
    expect(screen.getByText('Гарантия поставщика')).toBeDefined();
    // У гарантии поставщика источника-заявки нет — на её месте стоит слово, а не пустая ячейка.
    expect(screen.getByText('поставщик')).toBeDefined();
  });

  it('фильтр «истекает» спрашивает у сервера порог, а не режет страницу на клиенте', async () => {
    const http = renderTab([warrantyRow()]);
    await screen.findByText('Kyocera M3145');
    fireEvent.click(screen.getByText('Истекает в 30 дней'));
    expect(http.lastCall('GET /service-requests/warranties')?.query.get('expiring')).toBe('true');
  });
});

describe('обращение по гарантии заводится из реестра (Р26)', () => {
  it('строка ремонта открывает форму с названным источником', async () => {
    renderTab([warrantyRow()]);
    fireEvent.click(await screen.findByText('Заявка по гарантии'));

    expect(await screen.findByText('Новая заявка на обслуживание')).toBeDefined();
    // Источник назван словами — человек должен видеть, на что ссылается заявка.
    expect(screen.getByText('Источник: Замена узла подачи')).toBeDefined();
    // Техника и источник заданы реестром и в форме не правятся: подменить их значило бы
    // сослаться на чужую работу.
    expect(screen.getByText('Гарантия на прошлый ремонт')).toBeDefined();
  });
});
