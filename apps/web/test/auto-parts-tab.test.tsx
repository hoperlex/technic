import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AutoPartDetailDto, AutoPartDto, AutoPartStockEntryDto } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Гараж → «Автозапчасти» (план `docs/auto-parts-plan.md`, Р10, Р13, Р14, §8; концепт
 * «Автозапчасти в гараже»).
 *
 * Закрепляется то, что ломается молча.
 *
 * **Ноль — это ответ, а не пустое место.** Вкладку открывают вопросом «что заказывать», и весь
 * сигнал закупки в этом выпуске — красный тег, подложенная строка и счётчик, который сам же и
 * включает срез. Порога и писем план не делает, поэтому потерять этот сигнал значит потерять
 * ответ целиком.
 *
 * **Отбор считает сервер.** Быстрый фильтр обязан уйти в запрос (`stock=out_of_stock`), а не
 * отобрать пришедшую страницу: справочник разбит на страницы, и «нет в наличии» на клиенте
 * показывало бы нули только той двадцатки, что уже приехала.
 *
 * **Ссылка ленты называет акт, а не машину.** Ключ `?maintenance=` открывает сводку машины, и без
 * второго ключа (`record`) движение вело бы в длинную историю без указания, о каком документе
 * речь.
 *
 * **Прав два, и они не про чтение.** Менеджер и диспетчер видят склад целиком (Р10) — и не имеют
 * ни одной кнопки: ведут его механики. Кнопка, кончающаяся 403, хуже отсутствующей.
 */

const LIST = 'GET /auto-parts';
const DETAIL = 'GET /auto-parts/:id';
const STOCK = 'POST /auto-parts/:id/stock';

/** Механик: у роли оба права склада (`ROLE_PERMISSIONS`), и он единственный, кто им пользуется. */
const MECHANIC = authUser({
  id: 'user-mechanic',
  role: 'mechanic',
  lastName: 'Механиков',
  firstName: 'Иван',
  middleName: 'Иванович',
});

function partDto(over: Partial<AutoPartDto> = {}): AutoPartDto {
  return {
    id: 'ap-1',
    code: 'LF3349',
    name: 'Фильтр масляный',
    unit: 'шт',
    quantity: 12,
    isActive: true,
    comment: '',
    applicability: [
      {
        id: 'aa-1',
        vehicleModel: {
          id: 'vm-1',
          name: 'КАМАЗ 65115',
          vehicleTypeId: 'vt-1',
          vehicleTypeName: 'Самосвалы',
        },
        vehicleType: null,
      },
    ],
    // Движение уже было: такую позицию удалить нельзя — журнал не подчищают (Р11).
    hasStockHistory: true,
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-24T08:42:00.000Z',
    ...over,
  };
}

/** Позиция, ради которой вкладку и листают: ноль на складе. */
const EMPTY_PART = partDto({
  id: 'ap-2',
  code: 'AVX13x1250',
  name: 'Ремень генератора',
  quantity: 0,
});

/** Движение по акту: у него есть документ, и лента обязана вести именно в него (Р14). */
const ISSUE_ENTRY: AutoPartStockEntryDto = {
  id: 'ase-1',
  seq: 2,
  entryKind: 'issue',
  maintenanceId: 'vm-9',
  maintenanceVehicleId: 'v-1',
  maintenanceVehicleLabel: 'В613ВУ197',
  maintenancePerformedOn: '2026-08-12',
  quantityBefore: 13,
  quantityAfter: 12,
  reason: 'Списание по акту обслуживания',
  changedByName: 'Механиков И. И.',
  createdAt: '2026-08-24T08:42:00.000Z',
};

/** Ручная правка: документа у неё нет вовсе, и объясняет её причина, написанная человеком. */
const MANUAL_ENTRY: AutoPartStockEntryDto = {
  id: 'ase-2',
  seq: 1,
  entryKind: 'manual',
  maintenanceId: null,
  maintenanceVehicleId: null,
  maintenanceVehicleLabel: null,
  maintenancePerformedOn: null,
  quantityBefore: 3,
  quantityAfter: 13,
  reason: 'Приход по накладной 406',
  changedByName: 'Механиков И. И.',
  createdAt: '2026-08-22T06:15:00.000Z',
};

function detailDto(over: Partial<AutoPartDto> = {}): AutoPartDetailDto {
  return { ...partDto(over), stockEntries: [ISSUE_ENTRY, MANUAL_ENTRY] };
}

function renderTab(options: { routes?: RouteMap; user?: typeof MECHANIC; route?: string } = {}) {
  const http = mockHttp({
    // Один и тот же маршрут отвечает и списку, и счётчику нулей: счётчик — это тот же запрос с
    // вывернутым в ноль наличием, своей ручки у него нет (§8).
    [LIST]: ({ query }) =>
      query.get('stock') === 'out_of_stock'
        ? json(list([EMPTY_PART]))
        : json(list([partDto(), EMPTY_PART])),
    [DETAIL]: () => json(detailDto()),
    // Справочники применимости: одно поле на две ссылки — модель либо тип (Р8).
    'GET /vehicle-types': () =>
      json({
        items: [{ id: 'vt-1', name: 'Самосвалы', isActive: true }],
        total: 1,
        page: 1,
        pageSize: 500,
      }),
    'GET /vehicle-models': () =>
      json({
        items: [{ id: 'vm-1', name: 'КАМАЗ 65115', vehicleTypeId: 'vt-1', isActive: true }],
        total: 1,
        page: 1,
        pageSize: 500,
      }),
    ...options.routes,
  });
  renderWithUser(<GaragePage />, {
    user: options.user ?? MECHANIC,
    route: options.route ?? '/garage?tab=parts',
  });
  return http;
}

/** Строка таблицы по наименованию — в ней и спрашивают про остаток. */
const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

describe('гараж: вкладка «Автозапчасти»', () => {
  it('показывает остаток тегом с единицей, а ноль — красным и подложенной строкой', async () => {
    renderTab();

    expect(await screen.findByText('Фильтр масляный')).toBeDefined();
    // Единица идёт рядом с числом всегда: «5» без неё — не число, а загадка (Р9).
    expect(within(row('Фильтр масляный')).getByText('12 шт')).toBeDefined();

    const empty = within(row('Ремень генератора')).getByText('0 шт');
    // Красный тег — весь сигнал закупки этого выпуска: порога и писем план не делает (§12).
    expect(empty.closest('.ant-tag-red')).not.toBeNull();
    // И вся строка подложена: ноль ищут боковым зрением, листая перечень.
    expect((row('Ремень генератора').querySelector('td') as HTMLElement).style.background).not.toBe(
      '',
    );
  });

  it('считает над таблицей всего и нулей — вторым запросом с тем же отбором', async () => {
    const http = renderTab();

    expect(await screen.findByText('Всего 2 позиции')).toBeDefined();
    expect(await screen.findByText(/Нет в наличии: 1/)).toBeDefined();
    // Счётчик — это тот же список с наличием, вывернутым в ноль: две выдачи, одна ручка.
    await waitFor(() => expect(http.countOf(LIST)).toBe(2));
    expect(http.calls.filter((c) => c.query.get('stock') === 'out_of_stock')).toHaveLength(1);
  });

  it('счётчик нулей включает срез «нет в наличии» серверным отбором', async () => {
    const http = renderTab();

    fireEvent.click(await screen.findByText(/Нет в наличии: 1/));

    // Отбор уходит на сервер, а не отсекает пришедшую страницу: справочник разбит на страницы, и
    // клиентский отбор показывал бы нули только той двадцатки, что уже приехала (Р13).
    await waitFor(() => expect(http.lastCall(LIST)!.query.get('stock')).toBe('out_of_stock'));
    await waitFor(() => expect(screen.queryByText('Фильтр масляный')).toBeNull());
  });

  it('карточка открывается адресом, а лента ведёт в тот самый акт', async () => {
    const http = renderTab({ route: '/garage?tab=parts&part=ap-1' });

    // Карточка названа в адресе (Р14): ссылку присылают соседу, перезагрузка её не теряет.
    await waitFor(() => expect(http.countOf(DETAIL)).toBe(1));
    expect(await screen.findByText('Движение остатка')).toBeDefined();
    expect(screen.getByText('13 → 12')).toBeDefined();
    expect(screen.getByText('Приход по накладной 406')).toBeDefined();

    const link = screen.getByTitle('Открыть акт обслуживания');
    // Два ключа, а не один: `maintenance` называет машину, `record` — сам акт в её истории.
    expect(link.getAttribute('href')).toBe(
      '/garage?tab=vehicles&maintenance=v-1&record=vm-9',
    );
    // Применимость читается словом, а не цветом: «Самосвалы» без него — и модель, и тип. Тегов
    // двое: один в строке списка, второй в карточке — подпись у них одна и та же.
    expect(screen.getAllByText('Модель · КАМАЗ 65115 (Самосвалы)').length).toBeGreaterThan(0);
  });

  it('диспетчер склад читает, но не правит: ни одной кнопки действия', async () => {
    // Право `garage.read` открывает вкладку целиком (Р10), а движения склада у роли нет: ведут
    // его механики, и кнопка, кончающаяся 403, хуже отсутствующей (Р19).
    renderTab({ user: authUser(), route: '/garage?tab=parts&part=ap-1' });

    expect(await screen.findByText('Фильтр масляный')).toBeDefined();
    expect(screen.queryByText('Добавить')).toBeNull();
    // Кнопки ищутся по подписи, а не ролью с именем: разбор доступного имени в этом дереве стоит
    // десятков секунд, и тест падал бы по часам, а не по смыслу.
    expect(document.querySelector('[aria-label="Удалить"]')).toBeNull();
    // Карточка при этом открыта: «есть ли на складе фильтр» — вопрос всякого, кому виден гараж.
    expect(await screen.findByText('Движение остатка')).toBeDefined();
    expect(screen.queryByText('Изменить остаток')).toBeNull();
    expect(screen.queryByText('Изменить')).toBeNull();
  });

  it('механик правит остаток: уходит увиденное число, а 409 объясняется словами', async () => {
    const http = renderTab({
      route: '/garage?tab=parts&part=ap-1',
      routes: {
        [STOCK]: () =>
          apiError(409, {
            code: 'conflict',
            message: 'Остаток изменил другой человек, сейчас 8',
          }),
      },
    });

    fireEvent.click(await screen.findByText('Изменить остаток'));
    await screen.findByText('Сейчас на складе:', undefined, { timeout: 5000 });

    fireEvent.change(document.getElementById('quantity')!, { target: { value: '20' } });
    // Разница словами — до нажатия: складское движение необратимо, и увидеть его нужно заранее.
    expect(await screen.findByText('+8 шт будет добавлено в журнал')).toBeDefined();

    fireEvent.change(document.getElementById('reason')!, {
      target: { value: 'Приход по накладной 406' },
    });
    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf(STOCK)).toBe(1));
    expect(http.lastCall(STOCK)!.body).toEqual({
      quantity: 20,
      // То самое число, которое человек видел: без него две правки от 12 записали бы «12 → 10» и
      // «12 → 8», и журнал стал бы враньём при верном итоге (Р3).
      expectedQuantity: 12,
      reason: 'Приход по накладной 406',
    });

    // 409 — нормальный исход одновременной работы двоих, а не сбой: окно остаётся открытым и
    // называет новое число словами, а карточка перечитывается.
    expect(
      await screen.findByText('Пока окно было открыто, остаток изменил другой человек'),
    ).toBeDefined();
    expect(screen.getByText('Остаток изменил другой человек, сейчас 8')).toBeDefined();
    await waitFor(() => expect(http.countOf(DETAIL)).toBeGreaterThan(1));
  });
});
