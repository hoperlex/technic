import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { VehicleRequestDto } from '@technic/contracts';
import { pretendContentOverflows } from './clamp';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import {
  classification,
  freightRequest,
  vehicleRequest,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * Строка списка заявок ТС: открытие карточки кликом и колонка контактов.
 *
 * Карточку открывают кликом по строке — целиться в иконку колонки «Действия» приходилось на
 * каждую заявку, а читают в списке именно её. Но строка полна активного содержимого: виза,
 * переходы статуса, файлы, действия и переключатели свёрнутых ячеек. Проверяется поэтому не
 * «клик открывает», а граница — что открывает, а что нет: ошибка здесь не падает тестом, она
 * открывает окно поверх каждого нажатия и обнаруживается людьми.
 */

const SPECIAL = vehicleRequest({ id: 'vr-1', status: 'new', version: 7 });
const FREIGHT = freightRequest();

/** Карточка заявки спрашивает своё при открытии — сценариям нужен только сам факт открытия. */
const CARD_ROUTES: RouteMap = {
  'GET /vehicle-requests/:id/history': () => json([]),
  'GET /vehicle-requests/:id/waybills': () => json([]),
  'GET /vehicle-requests/:id/relocations': () => json([]),
};

/**
 * Список смотрит руководитель строительства своего объекта: виза — его право, а она и есть та
 * самая ячейка с активным содержимым, поверх которой карточка открываться не должна. Меню
 * переходов смотрит администратор — ему их доступно больше всех (ADR 0021).
 */
function renderTab(
  items: VehicleRequestDto[] = [SPECIAL],
  over: RouteMap = {},
  user = authUser({ role: 'rukstroy', constructionObjectIds: ['obj-1'] }),
): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests': () => json(list(items)),
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: items.length })),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(list([classification()])),
    'PATCH /vehicle-requests/:id/approval': () => json(SPECIAL),
    ...CARD_ROUTES,
    ...over,
  });

  renderWithUser(<VehicleRequestsTab />, { user });
  return http;
}

/** Открыта ли карточка заявки: окно подписано её номером. */
function cardOf(displayNumber: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.ant-modal')].find((el) =>
    el.textContent?.includes(`Заявка ${displayNumber}`),
  );
}

const row = () => document.querySelector<HTMLElement>('.ant-table-tbody tr.ant-table-row')!;

describe('строка списка заявок ТС', () => {
  it('открывает карточку кликом по ячейке без активного содержимого', async () => {
    renderTab();
    fireEvent.click(await screen.findByText('ЖК Северный'));

    await waitFor(() => expect(cardOf('Т-42')).toBeTruthy());
  });

  it('не открывает карточку нажатием визы — виза уходит, окно не всплывает', async () => {
    const http = renderTab();
    await screen.findByText('Т-42');

    const approve = within(row())
      .getAllByRole('button')
      .find((el) => el.textContent === 'Согласовать')!;
    fireEvent.click(approve);

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/approval')).toBe(1));
    expect(cardOf('Т-42')).toBeUndefined();
  });

  it('не открывает карточку кликом по колонке действий — она отдана нажатиям целиком', async () => {
    renderTab();
    await screen.findByText('Т-42');

    // Промах мимо кнопки: попали в саму ячейку действий, а не в действие.
    const actions = row().querySelector<HTMLElement>('td.no-row-click')!;
    expect(actions).toBeTruthy();
    fireEvent.click(actions);

    await waitFor(() => expect(cardOf('Т-42')).toBeUndefined());
  });

  it('не открывает карточку выбором в меню статуса — оно живёт в портале', async () => {
    // Меню antd рисует в конце `body`: в дереве React оно осталось внутри ячейки, и событие
    // всплывает до строки, хотя в DOM лежит вне её. Не отсеки его — выбор перехода открывал бы
    // карточку поверх окна, которое сам же и вызвал.
    renderTab([SPECIAL], {}, authUser({ role: 'admin' }));
    await screen.findByText('Т-42');

    const status = within(row())
      .getAllByRole('button')
      .find((el) => el.textContent?.includes('Новая'))!;
    fireEvent.click(status);
    const cancel = await waitFor(() => {
      const found = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(
        (el) => el.textContent === 'Отменена',
      );
      expect(found, 'пункт меню «Отменена»').toBeTruthy();
      return found!;
    });
    fireEvent.click(cancel);

    // Открылось окно причины отмены — и только оно: карточка заявки поверх него не всплыла.
    expect(await screen.findByText('Причина отмены заявки № Т-42')).toBeDefined();
    expect(cardOf('Т-42')).toBeUndefined();
  });

  it('не открывает карточку переключателем свёрнутой ячейки — он разворачивает текст', async () => {
    pretendContentOverflows();
    renderTab();
    await screen.findByText('Т-42');

    const toggles = within(row()).getAllByLabelText('Показать полностью');
    // Свёрнуты обе длинные ячейки строки: контакты и комментарий.
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[1]!);

    await waitFor(() => expect(within(row()).getAllByLabelText('Свернуть')).toHaveLength(1));
    expect(cardOf('Т-42')).toBeUndefined();
  });
});

describe('колонка контактов', () => {
  it('у грузоперевозки показывает оба конца маршрута: роль с именем, адрес и телефон', async () => {
    renderTab([FREIGHT]);
    await screen.findByText('Т-43');

    const cells = within(row()).getByText('Отв. за погрузку').closest('.expandable-cell')!;
    const text = cells.textContent ?? '';
    // Роль неотделима от имени: «Сидоров» без неё не говорит, о каком конце маршрута речь.
    expect(text).toContain('Отв. за погрузку Сидоров С. С.');
    expect(text).toContain('г. Москва, ул. Складская, 4');
    expect(text).toContain('Отв. за разгрузку Кузнецов К. К.');
    expect(text).toContain('г. Москва, ул. Северная, 1');
    // По контакту в списке звонят — номер ссылкой `tel:` (ADR 0066).
    expect(cells.querySelector('a[href^="tel:"]')).toBeTruthy();
  });

  it('у заказа техники на объект — встречающий на площадке и адрес самого объекта', async () => {
    renderTab();
    await screen.findByText('Т-42');

    const text = within(row())
      .getByText('Отв. на объекте')
      .closest('.expandable-cell')?.textContent;
    expect(text).toContain('Отв. на объекте Петров П. П.');
    expect(text).toContain('г. Москва, ул. Северная, 1');
  });
});
