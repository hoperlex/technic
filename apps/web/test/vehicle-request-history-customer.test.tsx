import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, DepartmentDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser, departmentUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { VehicleRequestsHistoryTab } from '../src/pages/vehicle/VehicleRequestsHistoryTab';
import { VehicleRequestsArchiveTab } from '../src/pages/vehicle/VehicleRequestsArchiveTab';

/**
 * Фильтр «Объект/отдел» в «Истории» и «Архиве» заказа автотехники (план
 * `docs/department-requests-plan.md`, Р9).
 *
 * Проверяется то, что незаметно ломается: состав подбора по оси учётки и пара параметров запроса.
 * Род выбранного решает, в какой из двух параметров писать, а второй обязан чиститься той же
 * правкой — оставшись оба, они сузили бы выдачу до пересечения объекта с отделом, то есть до
 * пустоты, и экран молча показал бы «ничего не найдено» вместо заявок.
 *
 * Роли по имени нигде не спрашиваются: сценарий задаёт учётку с осью (сотрудник отдела) либо без
 * неё (офис, наблюдатель), а правило считают `useObjectScope`/`useDepartmentScope` — те же, по
 * которым живёт портал. Идентификаторы условные (`obj-1`, `dep-1`): род подбор берёт из опции, а
 * не из разбора строки (Р2а).
 */

const CUSTOMER_PLACEHOLDER = 'Все объекты и отделы';

const OBJECTS = [
  objectDto({ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' }),
  objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' }),
];

function department(over: Partial<DepartmentDto> = {}): DepartmentDto {
  return {
    id: 'dep-1',
    code: 'ПТО',
    name: 'Производственно-технический',
    isActive: true,
    // Площадки набором (ADR 0144); `object` — устаревшая проекция набора: при пустом
    // наборе и при наборе из нескольких сервер отдаёт в ней `null`.
    objects: [],
    object: null,
    heads: [],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

const DEPARTMENTS = [department(), department({ id: 'dep-2', code: 'СНБ', name: 'Снабжение' })];

const PTO = 'ПТО — Производственно-технический';
const SUPPLY = 'СНБ — Снабжение';
const NORTH = 'ОБ-1 — ЖК Северный';

const OFFICE = authUser({ role: 'manager' });

/** Справочники подбора отдаются обоим экранам одинаково: состав сужает не мок, а сам подбор. */
function directories() {
  return {
    'GET /objects': () => json(list(OBJECTS)),
    'GET /departments': () => json(list(DEPARTMENTS)),
  };
}

function renderHistory(user: AuthUser, viewport?: Viewport): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests/history': () => json(emptyList()),
    'GET /vehicle-requests/history/summary': () =>
      json({ total: 0, done: 0, cancelled: 0, totalCost: 0, withoutCost: 0 }),
    // Соседние фильтры журнала: заказанная позиция, машина и арендодатель — они его состав не
    // меняют, но без ответа экран остался бы без данных.
    'GET /vehicle-classifications': () => json(emptyList()),
    'GET /vehicles': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    ...directories(),
  });
  renderWithUser(<VehicleRequestsHistoryTab />, { user, viewport });
  return http;
}

function renderArchive(user: AuthUser): HttpMock {
  const http = mockHttp({ 'GET /vehicle-requests': () => json(emptyList()), ...directories() });
  renderWithUser(<VehicleRequestsArchiveTab />, { user });
  return http;
}

/**
 * Открыть фильтр панели. Подписи у него нет — её место занимает подсказка, а после выбора сам
 * выбранный вариант: им поле и опознаётся во второй раз.
 */
async function openFilter(shown: string): Promise<void> {
  const field = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('.ant-select')].find(
      (el) => el.textContent?.trim() === shown,
    );
    if (!found) throw new Error(`фильтра «${shown}» на экране нет`);
    return found;
  });
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
}

async function pickFilter(shown: string, option: string): Promise<void> {
  await openFilter(shown);
  await waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find((o) =>
      o.textContent?.includes(option),
    );
    expect(match, `вариант «${option}»`).toBeTruthy();
    fireEvent.click(match!);
  });
}

/** Заголовки групп открытого подбора — по ним видно, какие оси учётке показаны. */
const shownGroups = () =>
  [...document.querySelectorAll('.ant-select-item-group')].map((el) => el.textContent);

/** Что ушло в запрос заказчиком: заполнена ровно одна половина пары. */
function customerOf(http: HttpMock, route: string) {
  const call = http.lastCall(route)!;
  return { objectId: call.query.get('objectId'), departmentId: call.query.get('departmentId') };
}

describe('состав подбора в журнале (Р3)', () => {
  it('роль отдела видит свои отделы, а объектов не видит вовсе', async () => {
    const http = renderHistory(departmentUser('dep-1', [], { departmentIds: ['dep-1', 'dep-2'] }));
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/history')).toBe(1));

    await openFilter(CUSTOMER_PLACEHOLDER);
    await waitFor(() => expect(shownGroups()).toEqual(['Отделы']));
    expect(
      [...document.querySelectorAll('.ant-select-item-option')].map((o) => o.textContent),
    ).toEqual([PTO, SUPPLY]);
    // Справочник объектов не спрашивается: показывать из него нечего.
    expect(http.countOf('GET /objects')).toBe(0);
  });

  it('читателю без своей оси видны обе группы целиком', async () => {
    // У наблюдателя оси нет, и сужать фильтр нечем: выдачу всё равно режет сервер
    // (`vehicleRequestVisibilityWhere`), а не список вариантов перед глазами.
    const http = renderHistory(authUser({ role: 'observer' }));
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/history')).toBe(1));

    await openFilter(CUSTOMER_PLACEHOLDER);
    await waitFor(() => expect(shownGroups()).toEqual(['Объекты', 'Отделы']));
  });
});

describe('выбор пишет в одну половину пары и чистит вторую (Р9)', () => {
  it('отдел уходит параметром departmentId — и в журнал, и в его итог', async () => {
    const http = renderHistory(departmentUser('dep-1', [], { departmentIds: ['dep-1', 'dep-2'] }));
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/history')).toBe(1));
    expect(customerOf(http, 'GET /vehicle-requests/history')).toEqual({
      objectId: null,
      departmentId: null,
    });

    await pickFilter(CUSTOMER_PLACEHOLDER, SUPPLY);

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/history')!;
      expect(call.query.get('departmentId')).toBe('dep-2');
      expect(call.query.get('objectId')).toBeNull();
      // Отбор начинается заново: та же страница при другом фильтре означала бы другие строки.
      expect(call.query.get('page')).toBe('1');
    });
    // Итог за период считается по тем же фильтрам, что и таблица.
    await waitFor(() =>
      expect(customerOf(http, 'GET /vehicle-requests/history/summary')).toEqual({
        objectId: null,
        departmentId: 'dep-2',
      }),
    );
  });

  it('объект уходит параметром objectId, а следом выбранный отдел его снимает', async () => {
    const http = renderHistory(OFFICE);
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/history')).toBe(1));

    await pickFilter(CUSTOMER_PLACEHOLDER, NORTH);
    await waitFor(() =>
      expect(customerOf(http, 'GET /vehicle-requests/history')).toEqual({
        objectId: 'obj-1',
        departmentId: null,
      }),
    );

    // Второй выбор — по другой оси: поле теперь показывает объект, им же и опознаётся.
    await pickFilter(NORTH, PTO);
    await waitFor(() =>
      expect(customerOf(http, 'GET /vehicle-requests/history')).toEqual({
        objectId: null,
        departmentId: 'dep-1',
      }),
    );
  });
});

describe('тот же подбор в шите фильтров на телефоне (ADR 0030)', () => {
  it('выбор из шита уходит в список по «Применить» — той же парой параметров', async () => {
    const http = renderHistory(OFFICE, MOBILE_VIEWPORT);
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/history')).toBe(1));

    fireEvent.click(screen.getByText('Фильтры'));
    const row = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('.filter-sheet__row')].find((el) =>
        el.textContent?.startsWith('Объект/отдел'),
      );
      if (!found) throw new Error('фильтра «Объект/отдел» в шите нет');
      return found;
    });
    fireEvent.mouseDown(row.querySelector('.ant-select-content') ?? row);
    await waitFor(() => {
      const match = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
        (o) => o.textContent?.includes(PTO),
      );
      expect(match, `вариант «${PTO}»`).toBeTruthy();
      fireEvent.click(match!);
    });

    // Черновик шита в список до «Применить» не уходит: иначе заход в фильтры стоил бы четырёх
    // загрузок вместо одной.
    expect(customerOf(http, 'GET /vehicle-requests/history')).toEqual({
      objectId: null,
      departmentId: null,
    });
    fireEvent.click(screen.getByText('Применить'));

    await waitFor(() =>
      expect(customerOf(http, 'GET /vehicle-requests/history')).toEqual({
        objectId: null,
        departmentId: 'dep-1',
      }),
    );
  });
});

describe('умолчание фильтра — единственный заказчик учётки', () => {
  it('единственный отдел подставлен так же, как единственный объект', async () => {
    const http = renderHistory(departmentUser('dep-1'));

    // Первый же запрос уходит по своему отделу: до фичи так подставлялся только объект.
    await waitFor(() =>
      expect(customerOf(http, 'GET /vehicle-requests/history')).toEqual({
        objectId: null,
        departmentId: 'dep-1',
      }),
    );
    // И это видно в самом поле: ключ заказчика показан подписью отдела, а не пустотой.
    await waitFor(() => expect(document.body.textContent).toContain(PTO));
  });
});

describe('тот же подбор в архиве', () => {
  it('выбор отдела сужает архивную выдачу, не теряя самого архива', async () => {
    const http = renderArchive(authUser({ role: 'admin' }));
    await waitFor(() => expect(http.countOf('GET /vehicle-requests')).toBe(1));

    await pickFilter(CUSTOMER_PLACEHOLDER, PTO);

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests')!;
      expect(call.query.get('departmentId')).toBe('dep-1');
      expect(call.query.get('objectId')).toBeNull();
      // Срез вкладки фильтром не подменяется: архив остаётся архивом.
      expect(call.query.get('archive')).toBe('only');
    });
  });
});
