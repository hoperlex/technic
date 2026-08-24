import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { VehicleRequestsPage } from '../src/pages/VehicleRequestsPage';
import { WasteRequestsPage } from '../src/pages/WasteRequestsPage';
import { VehicleRequestsArchiveTab } from '../src/pages/vehicle/VehicleRequestsArchiveTab';
import { WasteArchiveTab } from '../src/pages/waste/WasteArchiveTab';
import { emptyList, list } from './factories/common';
import { authUser } from './factories/auth';
import { vehicleFeed, vehicleRequest } from './factories/vehicle';
import { wasteRequest, wasteSummary } from './factories/waste';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';

/**
 * Архив заявок обоих модулей (ADR 0070).
 *
 * Проверяется то, что легко разъезжается между сервером и порталом: вкладка показана не тому,
 * список просит не тот срез, действие вызывает не ту ручку. Каждая ошибка тут не видна на экране —
 * вкладка просто пустая или кнопка ведёт в 403.
 *
 * Удаление насовсем показывается только из архива: в рабочем списке этого действия нет вовсе, и
 * второй защитой стоит сам сервер — он сносит лишь заявку, уже лежащую в архиве.
 */

const admin = authUser({ id: 'user-admin', role: 'admin' });

const archivedVehicle = vehicleRequest({
  id: 'vr-9',
  displayNumber: 'ТС-9',
  status: 'confirmed',
  deletedAt: '2026-08-05T10:00:00.000Z',
  deletedByName: 'Админов А. А.',
});

const archivedWaste = wasteRequest({
  id: 'wr-9',
  displayNumber: 'М-9',
  status: 'confirmed',
  deletedAt: '2026-08-05T10:00:00.000Z',
  deletedByName: 'Админов А. А.',
});

/** Ручки, без которых страница раздела не отрисуется: фильтры и сводки её вкладок. */
function vehiclePageRoutes() {
  return {
    'GET /vehicle-requests': () => json(emptyList()),
    // Вкладка «Заказ автотехники» читает ленту: заказы и недельные заявки одним списком.
    'GET /vehicle-requests/feed': () => json(vehicleFeed([])),
    'GET /vehicle-requests/summary': () =>
      json({ new: 0, confirmed: 0, done: 0, cancelled: 0, awaitingApproval: 0 }),
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(emptyList()),
    'GET /vehicle-classifications': () => json([]),
    // Справочник техники — фильтр по назначенной машине (ADR 0098); списку заявок он не важен.
    'GET /vehicles': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
  };
}

function wastePageRoutes() {
  return {
    'GET /waste-requests': () => json(emptyList()),
    'GET /waste-requests/summary': () => json(wasteSummary()),
    // Баннер состояния распознавания (ADR 0114, Р29) спрашивает подсистему на каждом экране
    // разбора: молчащее распознавание неотличимо от «талоны в порядке». Здесь оно исправно.
    'GET /waste-requests/ticket-recognition/health': () =>
      json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    'GET /waste-requests/present': () => json(emptyList()),
    'GET /objects': () => json(emptyList()),
    'GET /container-types': () => json(emptyList()),
    'GET /waste-types': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
  };
}

/** Справочники подбора «Объект/отдел»: их спрашивает фильтр заказчика на вкладке архива. */
function customerRoutes() {
  return {
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(emptyList()),
  };
}

/** Кнопка строки таблицы по подписи: у `RowActionButton` она живёт в `aria-label`. */
function rowButton(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll('tbody button')].find(
    (b) => b.getAttribute('aria-label') === label,
  ) as HTMLElement | undefined;
}

const tab = (label: string) =>
  [...document.querySelectorAll('.ant-tabs-tab')].find((t) => t.textContent === label);

describe('вкладка «Архив» в разделах заявок', () => {
  it('заказ ТС: администратору вкладка есть, диспетчеру — нет', async () => {
    mockHttp(vehiclePageRoutes());
    const { unmount } = renderWithUser(<VehicleRequestsPage />, { user: admin });
    await waitFor(() => expect(tab('Архив')).toBeTruthy());
    unmount();

    // Диспетчер ведёт заявки и удаляет их, но архивом не распоряжается: у него нет `archive.read`.
    mockHttp(vehiclePageRoutes());
    renderWithUser(<VehicleRequestsPage />);
    await waitFor(() => expect(tab('Заказ автотехники')).toBeTruthy());
    expect(tab('Архив')).toBeUndefined();
  });

  it('вывоз мусора: администратору вкладка есть, диспетчеру — нет', async () => {
    mockHttp(wastePageRoutes());
    const { unmount } = renderWithUser(<WasteRequestsPage />, { user: admin });
    await waitFor(() => expect(tab('Архив')).toBeTruthy());
    unmount();

    mockHttp(wastePageRoutes());
    renderWithUser(<WasteRequestsPage />);
    await waitFor(() => expect(tab('Заявки')).toBeTruthy());
    expect(tab('Архив')).toBeUndefined();
  });

  it('список просит только архив и показывает, кто и когда удалил заявку', async () => {
    const http = mockHttp({
      'GET /vehicle-requests': () => json(list([archivedVehicle])),
      // Оба справочника — фильтр «Объект/отдел» архива (план `docs/department-requests-plan.md`,
      // Р9): удалённые заявки отдела лежат здесь наравне с объектными.
      ...customerRoutes(),
    });
    renderWithUser(<VehicleRequestsArchiveTab />, { user: admin });

    await screen.findByText('ТС-9');
    const call = http.lastCall('GET /vehicle-requests')!;
    expect(call.query.get('archive')).toBe('only');
    // Порядок по времени удаления: архив открывают вопросом «что снесли последним».
    expect(call.query.get('sortBy')).toBe('deletedAt');
    expect(screen.getByText('Админов А. А.')).toBeTruthy();
  });

  it('восстановление возвращает заявку вывоза из архива', async () => {
    const http = mockHttp({
      'GET /waste-requests': () => json(list([archivedWaste])),
      'POST /waste-requests/:id/restore': () => json({ ...archivedWaste, deletedAt: null }),
    });
    renderWithUser(<WasteArchiveTab />, { user: admin });

    await screen.findByText('М-9');
    fireEvent.click(rowButton('Восстановить')!);

    await waitFor(() => expect(http.countOf('POST /waste-requests/:id/restore')).toBe(1));
    expect(http.lastCall('POST /waste-requests/:id/restore')!.path).toContain('wr-9');
  });

  it('удаление насовсем спрашивает подтверждение и зовёт ручку purge', async () => {
    const http = mockHttp({
      'GET /vehicle-requests': () => json(list([archivedVehicle])),
      'DELETE /vehicle-requests/:id/purge': () => json({ ok: true }),
      ...customerRoutes(),
    });
    renderWithUser(<VehicleRequestsArchiveTab />, { user: admin });

    await screen.findByText('ТС-9');
    fireEvent.click(rowButton('Удалить окончательно')!);

    // Текст подтверждения — общий для справочников, учёток и заявок (ADR 0060): цена ошибки одна.
    const title = await screen.findAllByText('Удалить заявку «ТС-9» окончательно?');
    expect(title.length).toBeGreaterThan(0);
    const confirm = [...document.querySelectorAll('.ant-modal button')].find(
      (b) => b.textContent === 'Удалить окончательно',
    );
    fireEvent.click(confirm!);

    await waitFor(() => expect(http.countOf('DELETE /vehicle-requests/:id/purge')).toBe(1));
    expect(http.lastCall('DELETE /vehicle-requests/:id/purge')!.path).toContain('vr-9');
  });
});
