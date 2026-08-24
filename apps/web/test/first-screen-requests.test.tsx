import { describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { WasteRequestsPage } from '../src/pages/WasteRequestsPage';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser, shtabUser } from './factories/auth';
import { list } from './factories/common';
import { containerType, objectDto, operator, wasteSummary, wasteType } from './factories/waste';

/**
 * Сколько запросов уходит на первый экран раздела — замер, а не запрет.
 *
 * Число здесь зафиксировано как есть: сегодня список вывоза грузит вместе с собой четыре
 * справочника, часть которых нужна только форме, которую могут и не открыть. Оптимизация запросов
 * (этап 5 плана) уменьшит это число, и тогда ожидание меняется вместе с ней — а любая случайная
 * регрессия становится красным тестом, а не наблюдением в devtools.
 *
 * Считаются запросы до первого действия пользователя и на холодном кэше: у каждого рендера свой
 * QueryClient.
 */
function mockFirstScreen() {
  return mockHttp({
    'GET /waste-requests': () => json(list([])),
    'GET /waste-requests/summary': () => json(wasteSummary()),
    // Баннер состояния распознавания (ADR 0114, Р29) спрашивает подсистему на каждом экране
    // разбора: молчащее распознавание неотличимо от «талоны в порядке». Здесь оно исправно.
    'GET /waste-requests/ticket-recognition/health': () =>
      json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    'GET /objects': () => json(list([objectDto()])),
    'GET /container-types': () => json(list([containerType()])),
    'GET /waste-types': () => json(list([wasteType()])),
    'GET /counterparties': () => json(list([operator()])),
  });
}

describe('запросы первого экрана «Вывоз мусора»', () => {
  it('диспетчер: список, сводка, четыре справочника и состояние распознавания — семь запросов', async () => {
    const http = mockFirstScreen();
    renderWithUser(<WasteRequestsPage />, { user: authUser() });

    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));
    await waitFor(() => expect(http.countOf('GET /counterparties')).toBe(1));

    // Диспетчер назначает исполнителя, поэтому видит и фильтр операторов: у него самый полный
    // набор запросов из всех ролей. Седьмой — состояние распознавания талонов (ADR 0114, Р29):
    // баннер стоит одного запроса на портал (ответ общий с карточкой заявки), и это плата за то,
    // что сломанное распознавание перестало выглядеть спокойным днём.
    expect(http.calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      'GET /container-types',
      'GET /counterparties',
      'GET /objects',
      'GET /waste-requests',
      'GET /waste-requests/summary',
      'GET /waste-requests/ticket-recognition/health',
      'GET /waste-types',
    ]);
  });

  it('штаб объекта: то же без справочника операторов — исполнителя он не назначает', async () => {
    const http = mockFirstScreen();
    renderWithUser(<WasteRequestsPage />, { user: shtabUser('obj-1') });

    await waitFor(() => expect(http.countOf('GET /waste-requests')).toBe(1));
    await waitFor(() => expect(http.countOf('GET /waste-types')).toBe(1));

    expect(http.countOf('GET /counterparties')).toBe(0);
    expect(http.calls.length).toBe(5);
  });
});
