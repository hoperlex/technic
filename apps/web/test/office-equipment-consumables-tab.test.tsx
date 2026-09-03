import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  permissionsFor,
  type AuthUser,
  type OfficeEquipmentConsumableDto,
  type OfficeEquipmentModelDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { ConsumablesTab } from '../src/pages/service/ConsumablesTab';
import { OfficeEquipmentConsumablesModal } from '../src/pages/directories/OfficeEquipmentConsumablesModal';
import { ServiceRequestsPage } from '../src/pages/service/ServiceRequestsPage';

/**
 * Вкладка «Расходники» раздела «Орг.техника» (план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р13, Р14).
 *
 * Закрепляются три вещи, и каждая ломается молча.
 *
 * Первое — ГРАНИЦА ДВЕРЕЙ. Вкладка — это работа со складом, а не ведение номенклатуры: заведения,
 * правки и удаления позиций на ней нет вовсе (решение заказчика). Кнопка, случайно попавшая сюда
 * из общего описания строки, была бы не «лишней кнопкой», а второй дверью к ведению — открытой
 * тому, кому его не выдавали.
 *
 * Второе — ЧТО ОБЕ ДВЕРИ ПОКАЗЫВАЮТ ОДНО И ТО ЖЕ. Колонки приходят из общего модуля, и проверка
 * держится за это: столбцы потребности и дефицита обязаны стоять и на вкладке, и в окне
 * «Картриджи и тонеры». Разъехались бы они не сразу — а в тот день, когда столбец добавят одной из
 * дверей и забудут про вторую.
 *
 * Третье — ПРАВО НА ЗАКУПКУ спрашивается там же, где показывается кнопка: вкладку открывает
 * `officeEquipment.read`, а вести закупки — своё право, и без него кнопки нет вовсе.
 */

/** Оператор со всеми тремя правами модуля: номенклатура, склад и закупки. */
const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  addons: ['office_equipment_operator'],
  permissions: [
    ...permissionsFor({
      role: 'shtab',
      counterpartyType: null,
      addons: ['office_equipment_operator'],
    }),
    'officeEquipment.read',
    'officeEquipmentConsumables.manage',
    'officeEquipmentConsumables.stock',
    'officeEquipmentPurchases.manage',
  ],
});

/** Тот же человек без права вести закупки: перечень позиций ему открыт, кнопка — нет (Р12). */
const WITHOUT_PURCHASES: AuthUser = {
  ...OPERATOR,
  permissions: OPERATOR.permissions.filter((p) => p !== 'officeEquipmentPurchases.manage'),
};

const MODEL: OfficeEquipmentModelDto = {
  id: 'oem-1',
  type: { id: 'oet-1', name: 'МФУ', isActive: true },
  name: 'Ricoh Aficio MP 201SPF',
  manufacturer: 'Ricoh',
  isActive: true,
  comment: '',
  isUsed: true,
  equipmentCount: 68,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function consumableDto(
  over: Partial<OfficeEquipmentConsumableDto> = {},
): OfficeEquipmentConsumableDto {
  return {
    id: 'oec-1',
    code: 'Д0000093569',
    name: 'Тонер Ricoh 201 (шт)',
    quantity: 5,
    // Три числа заказа (Р13, Р15) — считает их сервер, экран печатает как есть.
    requiredQuantity: 20,
    alreadyOrdered: 3,
    deficit: 12,
    isActive: true,
    color: null,
    comment: '',
    models: [{ id: MODEL.id, name: MODEL.name }],
    hasStockHistory: true,
    equipmentCount: 1,
    lastManualStockAt: '2026-08-20T09:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T09:00:00.000Z',
    ...over,
  };
}

const LIST = 'GET /office-equipment-consumables';
const PATCH = 'PATCH /office-equipment-consumables/:id';

function renderTab(over: RouteMap = {}, user: AuthUser = OPERATOR): HttpMock {
  const http = mockHttp({
    [LIST]: () => json(list([consumableDto()])),
    'GET /office-equipment-models': () => json(list([MODEL])),
    ...over,
  });
  renderWithUser(<ConsumablesTab />, { user });
  return http;
}

/** Кнопка строки: подпись живёт в `aria-label` — подсказка antd появляется только по наведению. */
function rowButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('table button')].find(
    (b) => b.getAttribute('aria-label') === label,
  );
}

/** Заголовки таблицы текстом: подсказка в заголовке — разметка, и `getByText` её не находит. */
function headers(): string[] {
  return [...document.querySelectorAll('th')].map((th) => th.textContent ?? '');
}

describe('вкладка «Расходники»', () => {
  it('показывает склад, но заводить, править и удалять позиции на ней нечем', async () => {
    renderTab();
    await screen.findByText('Тонер Ricoh 201 (шт)');

    // Работа со складом здесь есть вся: остаток, потребность и журнал.
    expect(rowButton('Изменить остаток')).toBeTruthy();
    expect(rowButton('Потребность')).toBeTruthy();
    expect(rowButton('История остатка')).toBeTruthy();

    /*
     * А ведения нет ни в каком виде — ни кнопкой заведения, ни карточкой, ни удалением. Проверяется
     * именно отсутствие: у оператора все права модуля выданы, значит скрыть эти действия может
     * только сама дверь, а не отказ в праве.
     */
    expect(rowButton('Удалить')).toBeUndefined();
    expect(rowButton('Редактировать')).toBeUndefined();
    expect(rowButton('Открыть карточку')).toBeUndefined();
    expect(screen.queryByText('Добавить расходник')).toBeNull();
  });

  it('столбцы потребности и дефицита стоят в обеих дверях', async () => {
    renderTab();
    await screen.findByText('Тонер Ricoh 201 (шт)');
    const onTab = headers();
    expect(onTab).toContain('Потребность');
    expect(onTab).toContain('К закупке');
    expect(onTab).toContain('Уже заказано');
  });

  it('те же столбцы стоят в окне «Картриджи и тонеры»', async () => {
    mockHttp({
      [LIST]: () => json(list([consumableDto()])),
      'GET /office-equipment-models': () => json(list([MODEL])),
      'GET /office-equipment-consumables/:id': () => json(consumableDto()),
    });
    renderWithUser(<OfficeEquipmentConsumablesModal open onClose={() => {}} />, { user: OPERATOR });
    await screen.findByText('Тонер Ricoh 201 (шт)');

    const inDirectory = headers();
    expect(inDirectory).toContain('Потребность');
    expect(inDirectory).toContain('К закупке');
    expect(inDirectory).toContain('Уже заказано');
    // И ведение здесь на месте: обе двери различаются действиями, а не набором колонок.
    expect(screen.getByText('Добавить расходник')).toBeTruthy();
  });

  it('кнопки плановой закупки нет без права её вести', async () => {
    renderTab({}, WITHOUT_PURCHASES);
    await screen.findByText('Тонер Ricoh 201 (шт)');
    expect(screen.queryByText('Плановая закупка')).toBeNull();
    // И переключателя на список закупок тоже: смотреть там нечего, ручка отвечает 403.
    expect(screen.queryByText('Закупки')).toBeNull();
  });

  it('кнопка плановой закупки есть у того, кто их ведёт', async () => {
    renderTab();
    await screen.findByText('Тонер Ricoh 201 (шт)');
    expect(screen.getByText('Плановая закупка')).toBeTruthy();
  });

  it('потребность правится быстрым действием и уходит одним полем в ручку карточки', async () => {
    const http = renderTab({ [PATCH]: () => json(consumableDto({ requiredQuantity: 25 })) });
    await screen.findByText('Тонер Ricoh 201 (шт)');

    fireEvent.click(rowButton('Потребность')!);
    await screen.findByText('Потребность: Тонер Ricoh 201 (шт)');

    const input = document.querySelector<HTMLInputElement>('.ant-modal input[role="spinbutton"]');
    fireEvent.change(input!, { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    /*
     * ОДНО ПОЛЕ В ТЕЛЕ, а не вся карточка (Р13): вторая дверь к числу ведёт в ту же ручку правки,
     * и прислать она обязана только то, что человек менял. Пришли форма код, наименование и набор
     * моделей — она затирала бы чужую правку, которой не видела.
     */
    expect(http.lastCall(PATCH)!.body).toEqual({ requiredQuantity: 25 });
  });
});

describe('раздел «Орг.техника»', () => {
  it('показывает вкладку «Расходники» тому, кому открыта техника', async () => {
    mockHttp({
      'GET /office-equipment': () => json(emptyList()),
      'GET /office-equipment-types': () => json(emptyList()),
      'GET /objects': () => json(emptyList()),
      'GET /departments': () => json(emptyList()),
      [LIST]: () => json(list([consumableDto()])),
      'GET /office-equipment-models': () => json(list([MODEL])),
    });
    /*
     * Учётка без права на заявки: вкладку открывает `officeEquipment.read` — то же право, что и
     * справочник расходников (Р14). Второе право означало бы, что перечень позиций виден, а полка
     * нет.
     */
    const keeper: AuthUser = authUser({
      role: 'manager',
      permissions: ['officeEquipment.read'],
    });
    renderWithUser(<ServiceRequestsPage />, { user: keeper, route: '/office-equipment' });

    fireEvent.click(await screen.findByRole('tab', { name: 'Расходники' }));
    await screen.findByText('Тонер Ricoh 201 (шт)');
  });
});
