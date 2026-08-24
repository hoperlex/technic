import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  AuthUser,
  OfficeEquipmentConsumableDetailDto,
  OfficeEquipmentConsumableDto,
  OfficeEquipmentConsumableStockEntryDto,
  OfficeEquipmentConsumableUsageDto,
} from '@technic/contracts';
import { permissionsFor } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { OfficeEquipmentConsumablesModal } from '../src/pages/directories/OfficeEquipmentConsumablesModal';

/**
 * Расход расходников: лента журнала со ссылкой на заявку и отчёт за период (наброски переработки
 * заявок оргтехники, Р10; опрос В18).
 *
 * Закрепляются три вещи, и каждая ломается молча.
 *
 * Первое — **ссылка на заявку в ленте**. Событие «−2» без ответа «по какой заявке» — это ровно та
 * строка, ради которой журнал и заводили: «куда делись двенадцать картриджей» отвечает не число, а
 * заявка. Номер приходит с сервера готовым, и портал его не склеивает: вторая сборка номера
 * разошлась бы с той, что стоит в причине события.
 *
 * Второе — **отчёт спрашивает период и не считает сам**. Итоги приходят с сервера по всему периоду,
 * а не суммируются по показанным строкам: обрезанный потолком список дал бы неверный расход — и
 * по нему составили бы заказ на квартал.
 *
 * Третье — **выгрузка идёт тем же отбором**, что и экран. Файл, собранный по другому периоду, чем
 * показанная таблица, — это спор двух чисел, который разбирают глазами.
 */

const CONSUMABLE: OfficeEquipmentConsumableDto = {
  id: 'oec-1',
  code: 'Д0000093569',
  name: 'Тонер Ricoh 201 (шт)',
  quantity: 10,
  isActive: true,
  color: null,
  comment: '',
  models: [],
  equipmentCount: 4,
  hasStockHistory: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-21T09:00:00.000Z',
};

/** Выдача по заявке: обе ссылки заполнены, номер собран сервером — как их пишет маршрут закрытия. */
const ISSUE: OfficeEquipmentConsumableStockEntryDto = {
  id: 'oes-2',
  seq: 2,
  entryKind: 'issue',
  serviceRequestId: 'req-1',
  serviceRequestConsumableId: 'line-1',
  serviceRequestNumber: 'СО-1234',
  quantityBefore: 12,
  quantityAfter: 10,
  reason: 'Выдано по заявке СО-1234',
  changedByName: 'Иванов И. И.',
  createdAt: '2026-08-21T09:00:00.000Z',
};

/** Ручная правка кладовщика: заявки у неё нет вовсе — ни ссылки, ни номера. */
const MANUAL: OfficeEquipmentConsumableStockEntryDto = {
  ...ISSUE,
  id: 'oes-1',
  seq: 1,
  entryKind: 'manual',
  serviceRequestId: null,
  serviceRequestConsumableId: null,
  serviceRequestNumber: null,
  quantityBefore: 0,
  quantityAfter: 12,
  reason: 'Заведение карточки: начальный остаток',
  createdAt: '2026-08-20T09:00:00.000Z',
};

const DETAIL: OfficeEquipmentConsumableDetailDto = {
  ...CONSUMABLE,
  stockEntries: [ISSUE, MANUAL],
};

const USAGE: OfficeEquipmentConsumableUsageDto = {
  from: '2026-08-01',
  to: '2026-08-24',
  rows: [
    {
      requestId: 'req-1',
      displayNumber: 'СО-1234',
      equipmentId: 'oe-1',
      equipmentName: 'Ricoh Aficio MP 201SPF',
      equipmentInventoryNumber: '0012345',
      equipmentSerialNumber: '',
      consumableId: CONSUMABLE.id,
      code: CONSUMABLE.code,
      name: CONSUMABLE.name,
      color: null,
      issued: 3,
      returned: 1,
      quantity: 2,
      actorName: 'Иванов И. И.',
      at: '2026-08-21T09:00:00.000Z',
    },
  ],
  totalIssued: 3,
  totalReturned: 1,
  truncated: false,
};

const LIST = 'GET /office-equipment-consumables';
const USAGE_ROUTE = 'GET /office-equipment-consumables/usage-report';
const EXPORT_ROUTE = 'GET /office-equipment-consumables/usage-report.xlsx';
const DETAIL_ROUTE = 'GET /office-equipment-consumables/:id';

/**
 * Оператор оргтехники: расход открыт правом на сам справочник (`officeEquipment.read`), а не
 * ведением номенклатуры — отчёт собирает те же события, что видны в ленте журнала.
 */
const USER: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
  permissions: permissionsFor({
    role: 'shtab',
    counterpartyType: null,
    addons: ['office_equipment_operator'],
  }),
});

function renderModal(over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    [LIST]: () => json(list([CONSUMABLE])),
    'GET /office-equipment-models': () => json(list([])),
    // Статический путь описан раньше карточки: маршруты мока разбираются по порядку, и
    // `usage-report` иначе уехал бы в `:id` — ровно та ошибка, которую на сервере снимает
    // маршрутизатор Fastify сам.
    [USAGE_ROUTE]: () => json(USAGE),
    [EXPORT_ROUTE]: () => json({}),
    [DETAIL_ROUTE]: () => json(DETAIL),
    ...over,
  });
  renderWithUser(<OfficeEquipmentConsumablesModal open onClose={() => {}} />, { user: USER });
  return http;
}

/** Окно отчёта среди прочих: узнаётся по заголовку. */
function usageWindow(): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.ant-modal')].find((m) =>
    m.querySelector('.ant-modal-title')?.textContent?.includes('Расход расходников'),
  );
  if (!found) throw new Error('окно отчёта не открыто');
  return found;
}

async function openUsage(): Promise<void> {
  await screen.findByText(CONSUMABLE.name, undefined, { timeout: 5000 });
  fireEvent.click(screen.getByRole('button', { name: /Расход за период/u }));
  await waitFor(() => usageWindow(), { timeout: 5000 });
  await screen.findByText('СО-1234', undefined, { timeout: 5000 });
}

beforeAll(() => {
  // jsdom не умеет ни того, ни другого, а `apiDownload` зовёт оба: без заглушек падал бы транспорт,
  // а не проверяемое поведение.
  URL.createObjectURL = () => 'blob:consumable-usage';
  URL.revokeObjectURL = () => {};
});

describe('журнал остатка: движение по заявке', () => {
  it('выдача подписана и ведёт ссылкой в заявку, ручная правка — без ссылки', async () => {
    renderModal();

    await screen.findByText(CONSUMABLE.name, undefined, { timeout: 5000 });
    // У смотрящего нет ведения номенклатуры, поэтому карточка открывается на чтение — журнал в
    // ней виден тот же: лента открыта всем, кому открыт справочник.
    fireEvent.click(
      [...document.querySelectorAll<HTMLButtonElement>('table button')].find(
        (b) => b.getAttribute('aria-label') === 'Открыть карточку',
      )!,
    );
    await screen.findByText('Журнал остатка', undefined, { timeout: 5000 });

    // Вид события назван словом: «12 → 10» само по себе не отвечает, выдача это или пересчёт полки.
    expect(screen.getByText('Выдача')).toBeDefined();
    // Ссылка ведёт в раздел заявок и открывает ту самую заявку (ADR 0074).
    const link = screen.getByRole('link', { name: 'СО-1234' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/office-equipment?tab=requests&open=req-1');
    // Насколько сдвинулся остаток — знаком и числом: вычитать в уме при беглом чтении не нужно.
    expect(screen.getByText('-2')).toBeDefined();
    // У ручной правки заявки нет вовсе, и ссылка на неё в ленте одна — от выдачи.
    expect(screen.getAllByRole('link', { name: /СО-/u })).toHaveLength(1);
  });
});

describe('отчёт по расходу за период', () => {
  it('спрашивает период и показывает строку «заявка — аппарат — позиция — кто»', async () => {
    const http = renderModal();
    await openUsage();

    const call = http.lastCall(USAGE_ROUTE)!;
    // Период — обе границы: отчёт это отрезок, и «всё до сегодня» им не заменяется.
    expect(call.query.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(call.query.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

    const box = within(usageWindow());
    // Аппарат — с инвентарным номером: «на какие аппараты» (В18) без номера не отвечает.
    expect(box.getByText('Ricoh Aficio MP 201SPF · инв. 0012345')).toBeDefined();
    expect(box.getByText(/Д0000093569/u)).toBeDefined();
    expect(box.getByText('Иванов И. И.')).toBeDefined();
    // Расход и его слагаемые: там, где был возврат, число обязано быть объяснено.
    expect(box.getByText('выдано 3, возврат 1')).toBeDefined();
  });

  it('итоги берёт с сервера, а не складывает показанные строки', async () => {
    // Обрезанный отчёт: строк показана одна, а расход за период — двадцать. Посчитай портал сам,
    // он показал бы 2 и соврал бы ровно тому, кто составляет заказ.
    renderModal({
      [USAGE_ROUTE]: () =>
        json({ ...USAGE, totalIssued: 25, totalReturned: 5, truncated: true }),
    });
    await openUsage();

    const box = within(usageWindow());
    expect(box.getByText('20')).toBeDefined();
    expect(box.getByText(/Показаны не все строки/u)).toBeDefined();
  });

  it('выгружает файл тем же отбором, что показан на экране', async () => {
    const http = renderModal();
    await openUsage();

    fireEvent.click(within(usageWindow()).getByRole('button', { name: /Выгрузить/u }));

    await waitFor(() => expect(http.countOf(EXPORT_ROUTE)).toBe(1));
    const shown = http.lastCall(USAGE_ROUTE)!;
    const file = http.lastCall(EXPORT_ROUTE)!;
    expect(file.query.get('from')).toBe(shown.query.get('from'));
    expect(file.query.get('to')).toBe(shown.query.get('to'));
  });
});
