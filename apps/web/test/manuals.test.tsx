import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Navigate, Route, Routes } from 'react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { AuthUser, ManualDto } from '@technic/contracts';
import { manualKeys } from '@entities/manual';
import { apiError, json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, type Viewport } from './viewport';
import { AppLayout } from '../src/components/AppLayout';

/**
 * Руководства пользователя (`docs/manuals-plan.md`) — третий служебный пункт того же угла меню,
 * где живут «Техподдержка» и «Обновления» (ADR 0077). Прав он не спрашивает: список открыт всем
 * вошедшим, правом закрыта только вкладка ведения (ADR 0021).
 *
 * Отсюда состав проверок. Место пункта — на обоих устройствах: на телефоне служебные пункты
 * уезжают в меню учётной записи (ADR 0030), и потерянный там пункт недостижим вовсе. Вид ссылки —
 * потому что документ лежит в чужом хранилище: без `target`/`rel` он увёл бы человека из портала.
 * И главное — **окно спрашивает только опубликованные**: у администратора есть `manuals.manage`,
 * и без своего фильтра окно показало бы ему снятое с публикации — то есть ровно то, что он только
 * что оттуда убрал (план §3.3).
 */

const ACTIVE: ManualDto = {
  id: 'm-1',
  title: 'Краткая инструкция по созданию заявок',
  description: 'Пошаговое создание заявок в портале',
  url: 'https://disk.360.yandex.ru/i/jeliNg4vUBZdSw',
  sortOrder: 100,
  isActive: true,
  createdAt: '2026-08-18T09:00:00.000Z',
  updatedAt: '2026-08-18T09:00:00.000Z',
};

/** Снятое с публикации: держатель права видит его на вкладке ведения — и только там. */
const RETIRED: ManualDto = {
  ...ACTIVE,
  id: 'm-2',
  title: 'Инструкция к прошлой версии заявок',
  description: '',
  url: 'https://disk.360.yandex.ru/i/outdated',
  sortOrder: 200,
  isActive: false,
};

/**
 * Ручка отвечает как сервер: с `isActive` в запросе — отобранные строки, без него — все. Мок,
 * отдающий один и тот же список на любой запрос, не отличил бы окно с фильтром от окна без него.
 */
function renderLayout(
  options: { user?: AuthUser; viewport?: Viewport; manuals?: ManualDto[] } = {},
): { http: HttpMock; queryClient: QueryClient } {
  const manuals = options.manuals ?? [ACTIVE, RETIRED];
  // Счётчик заявок на регистрацию (ADR 0034) и журнал обновлений (ADR 0077) каркас спрашивает
  // сам, к руководствам они отношения не имеют — без ответов макет пошёл бы за ними в сеть.
  const http = mockHttp({
    'GET /users/pending-count': () => json({ count: 0 }),
    'GET /releases': () => json([]),
    // Счётчик «ждут меня» на разделе оргтехники (ADR 0085) спрашивает администратор: к меню
    // помощи он отношения не имеет, чей это запрос — предмет `service-waiting-badge.test.tsx`.
    'GET /service-requests/waiting-count': () => json({ count: 0 }),
    // Непрочитанное в обсуждениях заявок (ADR 0141): второй счётчик каркаса, и спрашивает его
    // каждый, кому видны заявки, — иначе каркас остался бы без ответа на живой запрос.
    'GET /service-requests/unread-count': () => json({ count: 0 }),
    'GET /manuals': ({ query }) => {
      const isActive = query.get('isActive');
      return json(
        list(isActive === null ? manuals : manuals.filter((m) => String(m.isActive) === isActive)),
      );
    },
  });
  const { queryClient } = renderWithUser(
    <Routes>
      {/* Роутер поднят оболочкой рендера и стартует с «/»: нужный раздел открывается редиректом. */}
      <Route path="/" element={<Navigate to="/waste" replace />} />
      <Route element={<AppLayout />}>
        <Route path="/waste" element={<div>Список заявок</div>} />
      </Route>
    </Routes>,
    { user: options.user ?? authUser(), viewport: options.viewport ?? DESKTOP_VIEWPORT },
  );
  // Кэш отдаётся наружу ради одной проверки: «перезапрос упал» — состояние запроса, и ждать его
  // по экрану нечем, ведь показанным при этом остаётся прежний список.
  return { http, queryClient };
}

/*
 * Свёрнутость панели переживает размонтирование дерева — она в `localStorage` (`siderCollapsed`),
 * и тест, свернувший панель, оставил бы её свёрнутой следующему.
 */
beforeEach(() => localStorage.clear());

/** Окно открывается только нажатием — до него в разметке нет ни одной ссылки на документ. */
async function openManuals(): Promise<HTMLElement> {
  fireEvent.click(screen.getByText('Руководства'));
  return await screen.findByRole('dialog');
}

describe('пункт «Руководства» в служебном меню', () => {
  it('стоит в подвале панели первым — до техподдержки и обновлений', () => {
    renderLayout();
    const utility = document.querySelector('.sider-utility') as HTMLElement;
    expect([...utility.querySelectorAll('.ant-menu-item')].map((el) => el.textContent)).toEqual([
      'Руководства',
      'Техподдержка',
      'Обновления',
    ]);
  });

  it('на свёрнутой панели остаётся названным и рабочим', async () => {
    renderLayout();
    // Свёрнутая панель рисует пункты кнопками: от пункта остаётся одна иконка, и единственное,
    // чем он назван, — `title` и `aria-label`. Проверяется вместе с нажатием: до переезда меню в
    // виджет свёрнутая панель звала поддержку на любой пункт, и безымянная иконка это скрывала.
    fireEvent.click(screen.getByRole('button', { name: 'Свернуть меню' }));
    fireEvent.click(screen.getByRole('button', { name: 'Руководства' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
  });

  it('на телефоне уезжает в меню учётной записи (ADR 0030)', () => {
    renderLayout({ viewport: MOBILE_VIEWPORT });
    // Нижняя навигация занята разделами целиком: служебному пункту там места нет.
    const nav = screen.getByRole('navigation', { name: 'Разделы портала' });
    expect(within(nav).queryByText('Руководства')).toBeNull();

    expect(screen.queryByText('Руководства')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Учётная запись' }));
    expect(screen.getByText('Руководства')).toBeDefined();
  });

  it('список не спрашивают, пока окно не открыли', async () => {
    const { http } = renderLayout();
    // Точки «есть новое» у пункта нет (в отличие от журнала обновлений), и до нажатия список
    // никому не нужен: запрос на каждой загрузке портала платил бы за окно, которое не открыли.
    expect(http.countOf('GET /manuals')).toBe(0);
    await openManuals();
    expect(http.countOf('GET /manuals')).toBe(1);
  });
});

describe('окно со списком руководств', () => {
  it('показывает название с пояснением и ведёт наружу новой вкладкой', async () => {
    renderLayout();
    const dialog = await openManuals();

    expect(await within(dialog).findByText(ACTIVE.title)).toBeDefined();
    expect(within(dialog).getByText(ACTIVE.description)).toBeDefined();

    const link = within(dialog).getByRole('link', { name: new RegExp(ACTIVE.title) });
    expect(link.getAttribute('href')).toBe(ACTIVE.url);
    // Документ лежит в чужом хранилище: открывать его вместо портала нельзя, а `rel` не даёт
    // открытой вкладке распоряжаться исходной через `window.opener`.
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('у администратора не показывает снятые с публикации', async () => {
    const { http } = renderLayout({ user: authUser({ role: 'admin' }) });
    const dialog = await openManuals();
    await within(dialog).findByText(ACTIVE.title);

    // Право `manuals.manage` у администратора есть, и без фильтра сервер отдал бы ему всё —
    // поэтому фильтр ставит само окно, независимо от прав смотрящего.
    expect(http.lastCall('GET /manuals')?.query.get('isActive')).toBe('true');
    expect(within(dialog).queryByText(RETIRED.title)).toBeNull();
  });

  it('упавший перезапрос не стирает уже показанный список', async () => {
    const { http, queryClient } = renderLayout();
    const dialog = await openManuals();
    await within(dialog).findByText(ACTIVE.title);

    // Окно уже открыто, а сервер к моменту перезапроса отвечает отказом. TanStack Query поднимает
    // `status: 'error'`, но прежний ответ оставляет при себе, — и окно, спрашивающее про ошибку
    // раньше, чем про данные, сменило бы рабочие ссылки на «Список сейчас недоступен».
    http.use({
      'GET /manuals': () => apiError(503, { code: 'unavailable', message: 'Сервис недоступен' }),
    });
    await queryClient.refetchQueries({ queryKey: manualKeys.active() });
    expect(queryClient.getQueryState(manualKeys.active())?.status).toBe('error');

    await waitFor(() => expect(http.countOf('GET /manuals')).toBe(2));
    expect(within(dialog).getByText(ACTIVE.title)).toBeDefined();
    expect(within(dialog).queryByText('Список сейчас недоступен')).toBeNull();
  });

  it('пустой список объясняет себя словами', async () => {
    renderLayout({ manuals: [] });
    const dialog = await openManuals();
    // Пункт меню виден всем и всегда — в том числе когда руководств ещё не завели. Пустое окно
    // без объяснения читалось бы как недогрузившееся.
    expect(await within(dialog).findByText('Руководств пока нет')).toBeDefined();
  });
});
