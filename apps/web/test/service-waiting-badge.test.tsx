import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import type { AuthUser } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { AppLayout } from '../src/components/AppLayout';

/**
 * Бейдж «ждёт меня» на пункте меню «Орг.техника» (ADR 0085, Р39).
 *
 * Проверяется не число в кружке, а условие запроса: счётчик заводится только тем, у кого в цикле
 * заявки есть шаг, — оператору оргтехники (право приходит надстройкой роли, ADR 0086) и сервисной
 * компании (тип контрагента, ADR 0038). У заказчика `isWaitingOn` всегда `false`, и бейдж был бы
 * вечным нулём: лишний запрос на каждый вход и обещание «непрочитанного», которого в портале нет.
 *
 * Поэтому у штаба проверяется именно отсутствие вызова, а не нулевой бейдж: экран с ответом
 * `{ count: 0 }` выглядит точно так же, как экран без запроса, — разницу видно только в журнале
 * сети. Проверяй мы вёрстку, «исправление» в виде счётчика заказчику прошло бы мимо теста.
 */

const WAITING_COUNT = 'GET /service-requests/waiting-count';

/** Оператор оргтехники: штаб объекта плюс надстройка — решения по заявкам даёт именно она. */
const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
});

/** Исполнитель: роль «оператор» плюс контрагент типа `service` — сторону задаёт тип. */
const EXECUTOR: AuthUser = authUser({ role: 'operator', counterpartyType: 'service' });

/** Заказчик: тот же штаб, но без надстройки — заявки заводит, решений по ним не принимает. */
const CUSTOMER: AuthUser = authUser({ role: 'shtab', constructionObjectIds: ['obj-1'] });

/**
 * Адрес открытого раздела: бейдж обещает очередь, и проверить это можно только параметрами, с
 * которыми открылась страница, — сам список живёт в разделе и о меню ничего не знает.
 */
function SectionSpy() {
  const { search } = useLocation();
  return <div data-testid="section">{search}</div>;
}

function renderMenu(user: AuthUser, count = 3): HttpMock {
  const http = mockHttp({
    // Журнал обновлений спрашивают все вошедшие независимо от прав (ADR 0077) — он же служит
    // точкой синхронизации: его ответ означает, что запросы каркаса на монтировании уже ушли.
    'GET /releases': () => json([]),
    [WAITING_COUNT]: () => json({ count }),
    // Второй счётчик каркаса — непрочитанное в обсуждениях заявок (ADR 0141). Здесь он нулевой
    // намеренно: файл про золотой бейдж, а синий проверяется своим (`service-chat.test.tsx`), — но
    // ответить ему надо, иначе запрос остался бы без мока и тест упал бы не на своём смысле.
    'GET /service-requests/unread-count': () => json({ count: 0 }),
  });
  renderWithUser(
    <Routes>
      {/* Роутер поднят оболочкой рендера и стартует с «/»: нужный адрес берётся редиректом. */}
      <Route path="/" element={<Navigate to="/waste" replace />} />
      <Route element={<AppLayout />}>
        <Route path="/waste" element={<div>Список заявок</div>} />
        <Route path="/office-equipment" element={<SectionSpy />} />
      </Route>
    </Routes>,
    { user },
  );
  return http;
}

describe('счётчик «ждут меня» спрашивают только у тех, за кем шаг', () => {
  it('оператор оргтехники видит бейдж с числом заявок', async () => {
    const http = renderMenu(OPERATOR);
    expect(await screen.findByText('3')).toBeDefined();
    expect(http.countOf(WAITING_COUNT)).toBe(1);
  });

  it('сервисная компания видит бейдж — сторону задаёт тип контрагента, а не роль', async () => {
    const http = renderMenu(EXECUTOR, 5);
    /*
     * ⚠️ Кружка на экране сейчас нет, и не потому, что счётчик её не касается: раздел
     * «Орг.техника» скрыт до запуска временной заплаткой (`src/auth/temporarySectionLock.ts`), а
     * бейдж живёт на пункте меню. Предмет проверки от этого не меняется — файл про условие
     * запроса, а не про вёрстку кружка (см. заголовок), — и сторону по-прежнему задаёт тип
     * контрагента: запрос уходит, хотя роль у учётки та же, что у оператора вывоза.
     *
     * На запуске заплатку снимают, и строка возвращается к прежнему виду:
     *   expect(await screen.findByText('5')).toBeDefined();
     */
    await waitFor(() => expect(http.countOf(WAITING_COUNT)).toBe(1));
  });

  it('штаб без надстройки счётчик не запрашивает вовсе', async () => {
    const http = renderMenu(CUSTOMER);
    // ⚠️ Раздел ему открыт по правам, но до запуска скрыт заплаткой
    // (`src/auth/temporarySectionLock.ts`) — проверяется тишина в сети, и её заплатка не трогает:
    // счётчик спрашивает каркас по субъекту, а не пункт меню. На запуске сюда возвращается
    // `expect(screen.getByText('Орг.техника')).toBeDefined();`.
    await waitFor(() => expect(http.countOf('GET /releases')).toBe(1));
    expect(http.countOf(WAITING_COUNT)).toBe(0);
  });
});

describe('бейдж ведёт в очередь, пункт меню — в раздел', () => {
  it('нажатие на бейдж открывает «Требуют решения»', async () => {
    renderMenu(OPERATOR);
    fireEvent.click(await screen.findByText('3'));
    expect(screen.getByTestId('section').textContent).toBe('?tab=requests&waitingOnMe=true');
  });

  it('нажатие мимо бейджа открывает раздел целиком', async () => {
    renderMenu(OPERATOR);
    await screen.findByText('3');
    fireEvent.click(screen.getByText('Орг.техника'));
    // Пустая строка параметров: очередь — это выбор бейджа, а не состояние раздела по умолчанию.
    expect(screen.getByTestId('section').textContent).toBe('');
  });
});
