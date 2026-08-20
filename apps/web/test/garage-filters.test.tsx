import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import type {
  GarageDriverListDto,
  GarageDriversSummaryDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Отбор среза дня по площадке и по бланку работы дня (план «Срезы дня», Р6–Р8, Р20).
 *
 * Проверяется не разметка полей, а то, что уходит в запрос: отбор идёт **до страницы** — сервер
 * считает им и таблицу, и счётчик, и сводку, — поэтому вся правда фильтра в строке запроса. Отсюда
 * три вопроса теста: набор уезжает одним ключом, вкладка техники бланка не спрашивает вовсе, а
 * снятый фильтр не оставляет за собой пустого ключа.
 *
 * Данные приходят HTTP-моком: фильтры держатся за контракт ручек среза, а не за то, каким модулем
 * портал их сегодня зовёт.
 */

const ON_DATE = '2026-07-24';

/*
 * Площадки нарочно поданы в порядке, обратном каноническому: набор уезжает отсортированным по
 * самому ключу, а не по тому, в каком порядке нажимали варианты, — иначе один и тот же выбор давал
 * бы две разные строки и два ключа кэша.
 */
const NORTH = objectDto({
  id: '11111111-1111-4111-8111-111111111111',
  code: 'ОБ-1',
  name: 'ЖК Северный',
});
/** Закрытая площадка: срез открывают и на прошлогоднем дне, и отобрать его по ней надо (Р8). */
const SOUTH = objectDto({
  id: '22222222-2222-4222-8222-222222222222',
  code: 'ОБ-2',
  name: 'ЖК Южный',
  isActive: false,
});

const vehicleList: GarageVehicleListDto = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 50,
  onDate: ON_DATE,
};
const vehicleSummary: GarageVehiclesSummaryDto = {
  total: 0,
  free: 0,
  onRoute: 0,
  onSite: 0,
  unavailable: 0,
  routesWithoutDriver: 0,
  onDate: ON_DATE,
};
const driverList: GarageDriverListDto = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 50,
  onDate: ON_DATE,
};
const driverSummary: GarageDriversSummaryDto = {
  total: 0,
  free: 0,
  assigned: 0,
  documentsIncomplete: 0,
  onDate: ON_DATE,
};

/** Смотрит администратор: объектной области у него нет, и в списке стоят все площадки. */
const admin = authUser({ role: 'admin' });

function renderPage(tab: 'vehicles' | 'drivers') {
  const http = mockHttp({
    'GET /garage/vehicles': () => json(vehicleList),
    'GET /garage/vehicles/summary': () => json(vehicleSummary),
    'GET /garage/drivers': () => json(driverList),
    'GET /garage/drivers/summary': () => json(driverSummary),
    // Справочник площадок наполняет фильтр; отбор строк ведёт сервер.
    'GET /objects': () => json(list([NORTH, SOUTH])),
    'GET /vehicle-classifications': () => json(emptyList()),
    'GET /vehicle-maintenance/snapshot': ({ query }) =>
      json({ on: query.get('on') ?? '', items: [] }),
  });
  const rendered = renderWithUser(<GaragePage />, {
    user: admin,
    route: `/garage?tab=${tab}&date=${ON_DATE}`,
  });
  return { ...rendered, http };
}

/**
 * Поля ищутся внутри открытой вкладки, а не по всему документу: скрытая вкладка остаётся
 * смонтированной (`PageTabs`), и после переключения фильтр площадок стоит на экране дважды.
 */
function activePane(): HTMLElement {
  return document.querySelector('.ant-tabs-content-active') as HTMLElement;
}

/** Поле опознаётся своей подсказкой: подписи у фильтров полосы нет, её место занимает placeholder. */
async function openFilter(placeholder: string) {
  const field = await waitFor(() => {
    const found = [...activePane().querySelectorAll<HTMLElement>('.ant-select')].find(
      (el) => el.textContent?.trim() === placeholder,
    );
    if (!found) throw new Error(`фильтра «${placeholder}» на вкладке нет`);
    return found;
  });
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
}

/**
 * Отметить (или снять) вариант в открытом списке. Список ищется среди видимых: закрытая выпадашка
 * соседнего поля остаётся в документе, и её варианты нашлись бы наравне с нужными.
 */
async function toggleOption(option: string) {
  await waitFor(() => {
    const dropdown = [...document.querySelectorAll<HTMLElement>('.ant-select-dropdown')].findLast(
      (d) => !d.classList.contains('ant-select-dropdown-hidden'),
    );
    const options = [...(dropdown?.querySelectorAll<HTMLElement>('.ant-select-item-option') ?? [])];
    const match = options.find((o) => o.textContent?.includes(option));
    expect(match, `вариант «${option}»`).toBeTruthy();
    fireEvent.click(match!);
  });
}

/** Ключи кэша одного семейства: по ним видно, сколько разных вопросов задал экран. */
function cacheKeys(queryClient: QueryClient, family: string): unknown[][] {
  return queryClient
    .getQueryCache()
    .getAll()
    .map((q) => q.queryKey as unknown[])
    .filter((key) => key[0] === 'garage' && key[1] === family);
}

describe('гараж: отбор по площадке и бланку', () => {
  it('вкладка водителей шлёт площадки и бланки набором — и тем же набором считает сводку', async () => {
    const { http } = renderPage('vehicles');

    fireEvent.click(screen.getByRole('tab', { name: 'Водители' }));
    await waitFor(() => expect(http.lastCall('GET /garage/drivers')).toBeTruthy());

    await openFilter('Все объекты');
    // Закрытая площадка выбирается наравне с действующей: без неё исторический срез нельзя было
    // бы отобрать по той самой площадке, ради которой его открыли (Р8).
    await toggleOption('ЖК Южный');
    await toggleOption('ЖК Северный');

    await openFilter('Все бланки');
    // Подпись в списке короткая — полная («Форма ЭСМ-2 (строительная машина)») не влезает тегом.
    await toggleOption('ЭСМ-2');

    await waitFor(() => {
      const call = http.lastCall('GET /garage/drivers')!;
      // Две площадки — один ключ, а не повторённый параметр: набор уезжает канонической строкой.
      expect(call.query.get('objects')).toBe(`${NORTH.id},${SOUTH.id}`);
      expect(call.query.get('forms')).toBe('esm2');
      // Отбор возвращает список на первую страницу: иначе третья страница прежнего перечня
      // означала бы уже другие строки.
      expect(call.query.get('page')).toBe('1');
    });

    /*
     * Сводка сужается теми же двумя фильтрами (Р7): они определяют перечень людей, а не одну из
     * его цифр, — суженная таблица с несуженной сводкой отвечали бы про разных людей. Состояние и
     * комплект документов, наоборот, в сводку не уходят: ими она свелась бы к своей же цифре.
     */
    await waitFor(() => {
      const summary = http.lastCall('GET /garage/drivers/summary')!;
      expect(summary.query.get('objects')).toBe(`${NORTH.id},${SOUTH.id}`);
      expect(summary.query.get('forms')).toBe('esm2');
      expect(summary.query.has('state')).toBe(false);
      expect(summary.query.has('documents')).toBe(false);
    });
  });

  it('на вкладке техники фильтра бланков нет вовсе, а площадки спрашиваются', async () => {
    const { http } = renderPage('vehicles');
    await waitFor(() => expect(http.lastCall('GET /garage/vehicles')).toBeTruthy());

    /*
     * Бланка на этой вкладке нет ни полем, ни ключом, и это не забывчивость: схема запроса техники
     * `forms` прямо запрещает и отвечает на него 400 (Р20). Портал, приславший ключ «на всякий
     * случай», уронил бы весь список.
     */
    expect(screen.queryByText('Все бланки')).toBeNull();

    await openFilter('Все объекты');
    await toggleOption('ЖК Северный');

    await waitFor(() => {
      const call = http.lastCall('GET /garage/vehicles')!;
      expect(call.query.get('objects')).toBe(NORTH.id);
    });
    // Ни один запрос вкладки — ни список, ни сводка — бланка не называл даже пустым.
    for (const call of http.calls) expect(call.query.has('forms'), call.path).toBe(false);
  });

  it('снятый фильтр не оставляет за собой пустого ключа', async () => {
    const { http, queryClient } = renderPage('vehicles');
    await waitFor(() => expect(http.lastCall('GET /garage/vehicles')).toBeTruthy());

    await openFilter('Все объекты');
    await toggleOption('ЖК Северный');
    await waitFor(() =>
      expect(http.lastCall('GET /garage/vehicles')!.query.get('objects')).toBe(NORTH.id),
    );

    // Тот же вариант вторым нажатием — снятие: набор становится пустым.
    await toggleOption('ЖК Северный');
    await waitFor(() =>
      expect(http.lastCall('GET /garage/vehicles')!.query.has('objects')).toBe(false),
    );

    /*
     * Пустой набор отдаётся как `undefined`, а не пустой строкой, и проверяется это по кэшу, а не
     * по адресу: до сервера пустая строка всё равно не доехала бы (её отбрасывает `apiFetch`), а
     * вот ключей запроса стало бы три вместо двух — «фильтра нет», «площадка N» и «фильтр пуст», —
     * и возврат к неотобранному списку стоил бы лишнего похода на сервер за тем же самым.
     */
    expect(cacheKeys(queryClient, 'vehicles')).toHaveLength(2);
    expect(cacheKeys(queryClient, 'vehicles-summary')).toHaveLength(2);
  });
});
