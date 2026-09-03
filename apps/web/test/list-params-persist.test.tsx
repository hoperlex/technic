import { describe, expect, it } from 'vitest';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { AuthUser, OfficeEquipmentDto } from '@technic/contracts';
import { MOBILE_PAGE_SIZE } from '@shared/config';
import { readListParams, useListParams, writeListParams } from '@shared/lib';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { setViewport, DESKTOP_VIEWPORT, MOBILE_VIEWPORT } from './viewport';
import { ServiceRequestsPage } from '../src/pages/service/ServiceRequestsPage';

/**
 * Память отборов списка (ADR 0139).
 *
 * Проверяется то, ради чего её и заводили: сотрудник работает своим срезом — своя площадка, свой
 * тип техники, — и выставлять его заново после каждой перезагрузки не должен. Состояние в
 * `useState` такого не даёт, поэтому у утверждений здесь одна форма: набор пережил размонтирование
 * дерева или не пережил.
 *
 * Вторая половина файла — про границы этой памяти, и они важнее самой памяти. Страница и поиск не
 * сохраняются; чужая учётка чужого среза не видит; просроченное и битое не восстанавливается, а
 * сносится; отбор, потерявший предмет, снимается сам, — иначе человек получает пустой список и ни
 * одной подсказки, почему он пуст.
 */

interface Filters {
  objectId?: string;
  equipmentTypeId?: string;
}

const FIELDS = ['objectId', 'equipmentTypeId'] as const;
const SCOPE = { scope: 'test-list', userId: 'user-1', fields: FIELDS };

/** Тот же вызов, каким хуком пользуются вкладки: перечень отборов и имя набора заданы. */
function persistedList(userId: string | undefined) {
  return renderHook(() =>
    useListParams<Filters>(
      {},
      { searchKeys: ['name'], filterKeys: FIELDS, persist: { scope: 'test-list', userId } },
    ),
  );
}

describe('набор отборов между сеансами', () => {
  it('отборы и сортировка возвращаются после перезагрузки, страница — нет', () => {
    const first = persistedList('user-1');
    act(() => {
      first.result.current.setParams((p) => ({ ...p, objectId: 'obj-1', page: 3 }));
    });
    act(() => first.result.current.setSort('name', 'asc'));
    first.unmount();

    const second = persistedList('user-1');
    expect(second.result.current.params.objectId).toBe('obj-1');
    expect(second.result.current.params.sortBy).toBe('name');
    expect(second.result.current.params.sortOrder).toBe('asc');
    // Вчерашняя третья страница сегодня — уже другие записи.
    expect(second.result.current.params.page).toBe(1);
  });

  it('поиск не запоминается: строка, встретившая человека утром, читается как поломка списка', () => {
    const first = persistedList('user-1');
    act(() => {
      first.result.current.setParams((p) => ({ ...p, search: 'SN-1', objectId: 'obj-1' }));
    });
    first.unmount();

    const second = persistedList('user-1');
    expect(second.result.current.params.search).toBeUndefined();
    expect(second.result.current.params.objectId).toBe('obj-1');
  });

  it('чужой учётке набор не достаётся: браузер в конторе бывает общим', () => {
    const first = persistedList('user-1');
    act(() => first.result.current.setParams((p) => ({ ...p, objectId: 'obj-1' })));
    first.unmount();

    const second = persistedList('user-2');
    expect(second.result.current.params.objectId).toBeUndefined();
  });

  it('без учётки набор не пишется вовсе', () => {
    const { result, unmount } = persistedList(undefined);
    act(() => result.current.setParams((p) => ({ ...p, objectId: 'obj-1' })));
    unmount();

    expect(Object.keys(localStorage).filter((k) => k.includes('list-params'))).toHaveLength(0);
  });

  it('просроченный набор не восстанавливается и не остаётся в хранилище', () => {
    writeListParams(SCOPE, { mode: 'desktop', filters: { objectId: 'obj-1' } });
    const key = Object.keys(localStorage).find((k) => k.includes('list-params'))!;
    const stored = JSON.parse(localStorage.getItem(key)!) as { savedAt: number };
    // Девяносто дней и один день: отпуск в срок укладывается, забытое год назад — нет.
    stored.savedAt = Date.now() - 91 * 24 * 60 * 60 * 1000;
    localStorage.setItem(key, JSON.stringify(stored));

    expect(readListParams(SCOPE, 'desktop')).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('битая запись открывает список, а не ломает его', () => {
    writeListParams(SCOPE, { mode: 'desktop', filters: { objectId: 'obj-1' } });
    const key = Object.keys(localStorage).find((k) => k.includes('list-params'))!;
    localStorage.setItem(key, 'не json вовсе');

    const { result } = persistedList('user-1');
    expect(result.current.params.objectId).toBeUndefined();
    expect(result.current.params.page).toBe(1);
  });

  it('неизвестный ключ из прошлого выпуска в запрос не уходит', () => {
    writeListParams(
      { ...SCOPE, fields: ['objectId', 'legacyFilter'] },
      { mode: 'desktop', filters: { objectId: 'obj-1', legacyFilter: 'да' } },
    );

    const { result } = persistedList('user-1');
    expect(result.current.params.objectId).toBe('obj-1');
    expect(result.current.params.legacyFilter).toBeUndefined();
  });

  it('размер страницы принадлежит режиму: выбранный на десктопе на телефоне не берётся', () => {
    const desktop = persistedList('user-1');
    act(() => desktop.result.current.setParams((p) => ({ ...p, pageSize: 200 })));
    desktop.unmount();

    setViewport(MOBILE_VIEWPORT);
    const mobile = persistedList('user-1');
    expect(mobile.result.current.params.pageSize).toBe(MOBILE_PAGE_SIZE);
    mobile.unmount();

    setViewport(DESKTOP_VIEWPORT);
    const again = persistedList('user-1');
    expect(again.result.current.params.pageSize).toBe(200);
  });

  it('«Сбросить» снимает отборы и стирает запись, но не трогает сортировку', () => {
    const { result, unmount } = persistedList('user-1');
    act(() => {
      result.current.setParams((p) => ({ ...p, objectId: 'obj-1', equipmentTypeId: 'ty-1' }));
    });
    act(() => result.current.setSort('name', 'asc'));
    expect(result.current.filtersActive).toBe(true);

    act(() => result.current.resetFilters());
    expect(result.current.filtersActive).toBe(false);
    expect(result.current.params.objectId).toBeUndefined();
    // Сброс означает «покажи всё», а не «забудь, как я смотрю на список».
    expect(result.current.params.sortBy).toBe('name');
    unmount();

    const second = persistedList('user-1');
    expect(second.result.current.params.objectId).toBeUndefined();
    expect(second.result.current.params.sortBy).toBe('name');
  });
});

// ── вкладка «Техника» раздела «Орг.техника» ────────────────────────────────

const TYPE = { id: 'ty-1', name: 'МФУ', isActive: true };
const OBJECT = { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' };

const EQUIPMENT: OfficeEquipmentDto = {
  id: 'oe-1',
  type: TYPE,
  name: 'Kyocera M3145',
  serialNumber: 'SN-1',
  inventoryNumber: '0012345',
  object: OBJECT,
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
  'GET /office-equipment-types': () => json(list([TYPE])),
  'GET /objects': () => json(list([OBJECT])),
  'GET /departments': () => json(emptyList()),
  'GET /service-requests': () => json(emptyList()),
  'GET /service-requests/warranties': () => json(emptyList()),
  'GET /service-requests/waiting-count': () => json({ count: 0 }),
  'GET /counterparties': () => json(emptyList()),
};

/** Оператор оргтехники: у него есть и заявки, и парк. */
const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
});

/** Набор вкладки «Техника» — тем же именем, каким его пишет сама вкладка. */
const equipmentScope = {
  scope: 'service-equipment',
  userId: OPERATOR.id,
  fields: ['objectId'],
};

function openEquipmentTab() {
  const http = mockHttp(ROUTES);
  renderWithUser(<ServiceRequestsPage />, {
    user: OPERATOR,
    route: '/office-equipment?tab=equipment',
  });
  return http;
}

/** Последний запрос списка парка: по нему видно, с каким срезом вкладка открылась. */
const lastEquipmentQuery = (http: ReturnType<typeof mockHttp>) =>
  http.lastCall('GET /office-equipment')?.query;

describe('вкладка «Техника» открывается сохранённым срезом', () => {
  it('сохранённая площадка уходит в запрос, и её видно чем снять', async () => {
    writeListParams(equipmentScope, { mode: 'desktop', filters: { objectId: 'obj-1' } });
    const http = openEquipmentTab();

    await waitFor(() => expect(lastEquipmentQuery(http)?.get('objectId')).toBe('obj-1'));

    const reset = await screen.findByRole('button', { name: 'Сбросить' });
    fireEvent.click(reset);
    await waitFor(() => expect(lastEquipmentQuery(http)?.get('objectId')).toBeNull());
  });

  it('площадка, которой больше нет в выборе, снимается сама', async () => {
    writeListParams(equipmentScope, { mode: 'desktop', filters: { objectId: 'obj-closed' } });
    const http = openEquipmentTab();

    // Первый запрос уходит со срезом: перечень объектов ещё не пришёл, и судить не по чему.
    await waitFor(() => expect(http.countOf('GET /office-equipment')).toBeGreaterThan(0));
    // Пришёл — площадки в нём нет, и отбор снимается вместе с записью в хранилище.
    await waitFor(() => expect(lastEquipmentQuery(http)?.get('objectId')).toBeNull());
    expect(readListParams(equipmentScope, 'desktop')?.filters.objectId).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Сбросить' })).toBeNull();
  });
});
