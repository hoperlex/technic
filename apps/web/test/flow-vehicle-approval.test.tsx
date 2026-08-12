import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { VehicleRequestDto, VehicleRequestSummaryDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import {
  approvedVehicleRequest,
  classification,
  vehicleFeed,
  vehicleRequest,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';
import { PageTabs } from '../src/components/PageTabs';

/**
 * Виза руководителя строительства на заявке ТС (ADR 0025).
 *
 * Виза — единственное собственное действие этой роли: без неё диспетчер не возьмёт заявку в
 * работу. Проверяется поток целиком — что уходит на сервер (`approved` и версия заявки) и что
 * перезапрашивается после. Перезапрос здесь не косметика: заявка без визы не двигается дальше
 * «Новой», и по статусам этого не видно — считает её только сводка своим `awaitingApproval`.
 * Не перезапросив сводку, экран показывал бы «Ждут визы: 1» на уже завизированной заявке.
 */

/** Заявка на визу: новая, визы нет. Версия нарочно не единица — её видно в теле запроса. */
const AWAITING = vehicleRequest({ id: 'vr-1', status: 'new', version: 7 });

/**
 * Она же после визы: подписант и момент проставлены, версия выросла. Собирается своей фабрикой,
 * а не подмешиванием полей к `AWAITING`: пустая виза оттуда затёрла бы проставленную.
 */
const APPROVED = approvedVehicleRequest({ id: 'vr-1', status: 'new', version: 8 });

/**
 * Вкладка внутри строки вкладок — так её монтирует и сама страница (`VehicleRequestsPage`).
 * Сводка живёт в слоте этой строки, и без неё счётчик «Ждут визы» проверить было бы негде:
 * вкладка сама его не рисует.
 *
 * Смотрит руководитель строительства своего объекта: право визы есть только у него.
 */
function renderTab(over: RouteMap = {}): HttpMock {
  let current: VehicleRequestDto = AWAITING;
  let summary: VehicleRequestSummaryDto = vehicleSummary({ new: 1, awaitingApproval: 1 });

  const http = mockHttp({
    'GET /vehicle-requests/feed': () => json(vehicleFeed([current])),
    'GET /vehicle-requests/summary': () => json(summary),
    // Справочники экрана: сценарию не нужны, но вкладка их спрашивает при первом рендере.
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(list([classification()])),
    // Справочник техники — фильтр по назначенной машине (ADR 0098); списку заявок он не важен.
    'GET /vehicles': () => json(emptyList()),
    'PATCH /vehicle-requests/:id/approval': ({ body }) => {
      const approved = (body as { approved: boolean }).approved;
      current = approved ? APPROVED : vehicleRequest({ id: 'vr-1', status: 'new', version: 9 });
      summary = vehicleSummary({ new: 1, awaitingApproval: approved ? 0 : 1 });
      return json(current);
    },
    ...over,
  });

  renderWithUser(
    <PageTabs
      activeKey="requests"
      items={[{ key: 'requests', label: 'Заказ автотехники', children: <VehicleRequestsTab /> }]}
    />,
    { user: authUser({ role: 'rukstroy', constructionObjectIds: ['obj-1'] }) },
  );
  return http;
}

/**
 * Кнопка визы в строке списка. Ищется по тексту среди кнопок, а не ролью: `*ByRole` считает
 * доступные имена всему дереву и на таблице antd уходит в секунды — тест с ней упирается в
 * собственный таймаут.
 */
function clickButton(label: string, root: ParentNode = document) {
  const button = [...root.querySelectorAll('button')].find((el) => el.textContent === label);
  expect(button, `кнопка «${label}»`).toBeTruthy();
  fireEvent.click(button!);
}

/**
 * Окно подтверждения по заголовку. Не `findByText`: заголовок окна antd повторяет сам себя
 * скрытой строкой для скринридера, и поиск по документу нашёл бы два совпадения.
 */
function findModal(title: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('.ant-modal')].find((el) =>
      el.textContent?.includes(title),
    );
    expect(found, `окно «${title}»`).toBeTruthy();
    return found!;
  });
}

/** Счётчик сводки строкой, как его читает человек: «Ждут визы: 1». */
function summaryCounter(label: string): string {
  return screen.getByText(`${label}:`).parentElement?.textContent?.trim() ?? '';
}

/** Только изменяющие запросы — по ним видно, сколько их ушло на одно нажатие. */
const writes = (http: HttpMock) =>
  http.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

describe('виза руководителя строительства на заявке ТС', () => {
  it('уходит одним запросом: approved и версия заявки', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();

    clickButton('Согласовать');
    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/approval')).toBe(1));

    // Виза — отдельная ручка, а не правка заявки: заявку руководитель не переписывает, и лишний
    // PATCH самой заявки затёр бы чужие изменения (ADR 0025).
    expect(writes(http)).toEqual(['PATCH /vehicle-requests/vr-1/approval']);
    expect(http.lastCall('PATCH /vehicle-requests/:id/approval')?.body).toEqual({
      approved: true,
      version: 7,
    });
  });

  it('после успеха перезапрашивает список и сводку — счётчик «Ждут визы» гаснет', async () => {
    const http = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();
    expect(http.countOf('GET /vehicle-requests/feed')).toBe(1);
    expect(http.countOf('GET /vehicle-requests/summary')).toBe(1);
    expect(summaryCounter('Ждут визы')).toBe('Ждут визы: 1');

    clickButton('Согласовать');

    // Список и сводка перезапрашиваются оба: статус заявки виза не меняет, и без перезапроса
    // сводки счётчик «Ждут визы» остался бы прежним — заявка ушла бы из него незаметно.
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/feed')).toBe(2));
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/summary')).toBe(2));

    await waitFor(() => expect(summaryCounter('Ждут визы')).toBe('Ждут визы: 0'));
    // Ответ дошёл и до строки: кнопка визы сменилась на «Завизирована».
    const rows = document.querySelector<HTMLElement>('.ant-table-tbody')!;
    await waitFor(() => expect(within(rows).getByText('Завизирована')).toBeDefined());
    expect(await screen.findByText('Заявка завизирована')).toBeDefined();
  });

  it('снятие визы спрашивает подтверждение и уходит тем же маршрутом с approved: false', async () => {
    // Уже завизированная заявка: у неё кнопка предлагает снять визу.
    const http = renderTab({ 'GET /vehicle-requests/feed': () => json(vehicleFeed([APPROVED])) });
    expect(await screen.findByText('Т-42')).toBeDefined();

    clickButton('Завизирована');
    // Пока подтверждения нет, запроса тоже нет: без визы заявку нельзя взять в работу, и снять
    // её случайным нажатием в строке списка человек не должен.
    const confirm = await findModal('Снять визу с заявки Т-42?');
    expect(writes(http)).toEqual([]);

    clickButton('Снять визу', confirm);
    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/approval')).toBe(1));
    // Тот же маршрут, что и виза, — отличается только флагом; версия берётся из строки списка.
    expect(http.lastCall('PATCH /vehicle-requests/:id/approval')?.body).toEqual({
      approved: false,
      version: 8,
    });
  });
});
