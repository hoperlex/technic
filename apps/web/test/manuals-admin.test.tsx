import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { ADMIN_PAGE_PERMISSIONS, type AuthUser, type ManualDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { AppLayout } from '../src/components/AppLayout';
import { AdministrationPage } from '../src/pages/AdministrationPage';
import { HomeRedirect, RequirePermission } from '../src/auth/ProtectedRoute';

/**
 * Вкладка ведения руководств (`docs/manuals-plan.md`, этап 4).
 *
 * Право `manuals.manage` назначаемое (ADR 0106): руководства ведёт тот, кто их пишет, и это не
 * обязательно администратор. Поэтому проверяется не только сама вкладка, но и дорога к ней —
 * пункт меню, маршрут и стартовый редирект: право, которое выдано и никуда не пускает, хуже
 * невыданного (§3.6).
 *
 * Второе, ради чего заведён файл, — что окно и вкладка не расходятся. Ключи у них разные
 * намеренно (§3.3), и мутация обязана гасить корень сущности: иначе тот, кто только что снял
 * руководство с публикации, продолжал бы видеть его в собственном окне.
 */

const FIRST: ManualDto = {
  id: 'm-1',
  title: 'Краткая инструкция по созданию заявок',
  description: 'Пошаговое создание заявок в портале',
  url: 'https://disk.360.yandex.ru/i/jeliNg4vUBZdSw',
  sortOrder: 100,
  isActive: true,
  createdAt: '2026-08-18T09:00:00.000Z',
  updatedAt: '2026-08-18T09:00:00.000Z',
};

/**
 * Учётка ведущего руководства: право приходит списком от сервера (ADR 0106), а не выводится из
 * роли, — этим «держатель одного `manuals.manage`» вообще выразим. Ровно так выглядит выданный
 * набор «Руководства» у того, кому больше ничего не выдано.
 */
const manualsKeeper = (): AuthUser =>
  authUser({ id: 'user-manuals', role: 'manager', permissions: ['manuals.manage'] });

/** Ручка отвечает как сервер: `isActive` в запросе отбирает строки, без него приходят все. */
const manualsRoutes = (store: { items: ManualDto[] }) => ({
  'GET /manuals': ({ query }: { query: URLSearchParams }) => {
    const isActive = query.get('isActive');
    return json(
      list(
        isActive === null
          ? store.items
          : store.items.filter((m) => String(m.isActive) === isActive),
      ),
    );
  },
  'POST /manuals': ({ body }: { body: unknown }) => {
    const created = { ...FIRST, ...(body as Partial<ManualDto>), id: 'm-new' };
    store.items = [...store.items, created];
    return json(created);
  },
});

/**
 * Кнопки ищутся разметкой, а не ролью: доступное имя кнопки без `aria-label` считается через
 * `getComputedStyle` с псевдоэлементами, которого в jsdom нет вовсе, и на экране с таблицей один
 * такой поиск стоит секунд. Тем же способом их ищет `directory-purge.test.tsx`.
 */
function clickButton(name: string, root: ParentNode = document): void {
  const button = [...root.querySelectorAll('button')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name,
  );
  if (!button) throw new Error(`кнопки «${name}» на экране нет`);
  fireEvent.click(button);
}

/** Окно по заголовку: закрытые окна antd остаются в разметке, и брать «первое попавшееся» нельзя. */
function modal(title: string): HTMLElement {
  const heading = [...document.querySelectorAll('.ant-modal-title')].find(
    (el) => el.textContent === title,
  );
  if (!heading) throw new Error(`окна «${title}» на экране нет`);
  return heading.closest('.ant-modal') as HTMLElement;
}

/**
 * Поле формы ищется внутри окна: подпись столбца таблицы (`aria-label`) совпадает с подписью поля
 * буква в букву, и по всему экрану «Название» находится дважды.
 */
const fill = (form: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });

/** Только вкладка: дорога к ней проверяется отдельно, здесь проверяется ведение списка. */
function renderTab(items: ManualDto[] = [FIRST]): HttpMock {
  const store = { items };
  const http = mockHttp({
    ...manualsRoutes(store),
    'PATCH /manuals/:id': ({ body }) => json({ ...FIRST, ...(body as Partial<ManualDto>) }),
    // Удаление отвечает `{ ok: true }`, а не карточкой: после `DELETE` возвращать нечего.
    'DELETE /manuals/:id': () => {
      store.items = [];
      return json({ ok: true });
    },
  });
  renderWithUser(<AdministrationPage />, { user: manualsKeeper() });
  return http;
}

describe('вкладка «Руководства» в администрировании', () => {
  it('открыта держателю `manuals.manage` и показывает список', async () => {
    renderTab();
    expect(await screen.findByRole('tab', { name: 'Руководства' })).toBeDefined();
    expect(await screen.findByText(FIRST.title)).toBeDefined();
    // Адрес показан ссылкой и здесь: ведущий список проверяет, туда ли она ведёт, там же, где ведёт.
    const link = document.querySelector('tbody a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(FIRST.url);
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('без права её нет — страница остаётся с вкладками остальных прав', async () => {
    mockHttp({ 'GET /directories': () => json({ items: [] }) });
    renderWithUser(<AdministrationPage />, {
      // Держатель набора «Обмен справочниками»: страница ему открыта, а вкладка руководств — нет.
      user: authUser({ role: 'manager', permissions: ['directories.export'] }),
    });

    expect(await screen.findByRole('tab', { name: 'Обмен справочниками' })).toBeDefined();
    expect(screen.queryByRole('tab', { name: 'Руководства' })).toBeNull();
  });
});

describe('ведение списка', () => {
  it('заводит руководство с умолчаниями порядка и активности', async () => {
    const http = renderTab();
    await screen.findByText(FIRST.title);

    clickButton('Добавить руководство');
    const form = modal('Новое руководство');
    fill(form, 'Название', 'Инструкция для водителей');
    fill(form, 'Описание', 'Как принять задание с телефона');
    fill(form, 'Ссылка', 'https://disk.360.yandex.ru/i/driver');
    clickButton('Сохранить', form);

    await waitFor(() => expect(http.countOf('POST /manuals')).toBe(1));
    expect(http.lastCall('POST /manuals')?.body).toEqual({
      title: 'Инструкция для водителей',
      description: 'Как принять задание с телефона',
      url: 'https://disk.360.yandex.ru/i/driver',
      // Умолчания те же, что в контракте и в базе: заведённое без раздумий руководство встаёт в
      // общий ряд и сразу показывается — заводят их затем, чтобы ими пользовались.
      sortOrder: 100,
      isActive: true,
    });
  });

  it('не отпускает форму со ссылкой не по https', async () => {
    const http = renderTab();
    await screen.findByText(FIRST.title);

    clickButton('Добавить руководство');
    const form = modal('Новое руководство');
    fill(form, 'Название', 'Инструкция в общей папке');
    fill(form, 'Ссылка', 'file://server/share/manual.docx');
    clickButton('Сохранить', form);

    // Тот же единственный запрет, что и в контракте: без `https` браузер показал бы вместо
    // документа предупреждение, а ловить это отказом сервера значило бы ждать круга по сети.
    expect(await screen.findByText('Ссылка должна начинаться с https://')).toBeDefined();
    expect(http.countOf('POST /manuals')).toBe(0);
  });

  it('правит существующее и шлёт правку с его идентификатором', async () => {
    const http = renderTab();
    await screen.findByText(FIRST.title);

    clickButton('Редактировать');
    const form = modal('Редактирование руководства');
    fill(form, 'Название', 'Инструкция по созданию заявок');
    clickButton('Сохранить', form);

    await waitFor(() => expect(http.countOf('PATCH /manuals/:id')).toBe(1));
    const call = http.lastCall('PATCH /manuals/:id');
    expect(call?.path).toBe(`/manuals/${FIRST.id}`);
    expect((call?.body as { title: string }).title).toBe('Инструкция по созданию заявок');
  });

  it('удаляет только после подтверждения и называет запасной выход', async () => {
    const http = renderTab();
    await screen.findByText(FIRST.title);

    clickButton('Удалить');
    const confirm = document.querySelector('.ant-modal-confirm') as HTMLElement;
    // Заголовок antd рисует дважды — в шапке и в теле подтверждения; важно, что он есть.
    expect(
      within(confirm).getAllByText(`Удалить руководство «${FIRST.title}»?`).length,
    ).toBeGreaterThan(0);
    // Удаление настоящее и без второго шага (§3.4), поэтому подтверждение обязано назвать то, чем
    // его заменить: чаще всего руководство не ошибочное, а устаревшее.
    expect(within(confirm).getByText(/снимите «Активно»/)).toBeDefined();
    expect(http.countOf('DELETE /manuals/:id')).toBe(0);

    clickButton('Удалить', confirm);
    await waitFor(() => expect(http.countOf('DELETE /manuals/:id')).toBe(1));
    expect(http.lastCall('DELETE /manuals/:id')?.path).toBe(`/manuals/${FIRST.id}`);
  });
});

describe('окно и вкладка не делят кэш, но и не расходятся', () => {
  it('после заведения открытое окно показывает новый список', async () => {
    const store = { items: [FIRST] };
    const http = mockHttp({
      // Журнал обновлений каркас спрашивает сам (ADR 0077) — к руководствам он отношения не имеет.
      'GET /releases': () => json([]),
      ...manualsRoutes(store),
    });
    renderWithUser(
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/admin" element={<AdministrationPage />} />
        </Route>
      </Routes>,
      { user: manualsKeeper(), route: '/admin' },
    );

    // Пункт меню и вкладка называются одинаково — окно открывается именно из подвала панели.
    const utility = document.querySelector('.sider-utility') as HTMLElement;
    fireEvent.click(within(utility).getByText('Руководства'));
    const window = modal('Руководства');
    await within(window).findByText(FIRST.title);

    // Окно остаётся открытым: гашение по корню проверяется только так — закрытое окно
    // перезапросило бы список при следующем открытии само, независимо от инвалидации.
    clickButton('Добавить руководство');
    const form = modal('Новое руководство');
    fill(form, 'Название', 'Инструкция для водителей');
    fill(form, 'Ссылка', 'https://disk.360.yandex.ru/i/driver');
    clickButton('Сохранить', form);

    await waitFor(() => expect(http.countOf('POST /manuals')).toBe(1));
    expect(await within(window).findByText('Инструкция для водителей')).toBeDefined();
  });
});

describe('дорога к вкладке у держателя одного права', () => {
  it('видит пункт меню, проходит маршрут и стартует на администрировании', async () => {
    mockHttp({ 'GET /releases': () => json([]), ...manualsRoutes({ items: [FIRST] }) });
    renderWithUser(
      <Routes>
        <Route element={<AppLayout />}>
          <Route element={<RequirePermission permission={[...ADMIN_PAGE_PERMISSIONS]} />}>
            <Route path="/admin" element={<AdministrationPage />} />
          </Route>
        </Route>
        <Route path="/change-password" element={<div>Смена пароля</div>} />
        {/* Стартовая страница: `homePath` ведёт на первый доступный раздел, и у этой учётки
            более приоритетных разделов нет — остаётся администрирование. */}
        <Route path="*" element={<HomeRedirect />} />
      </Routes>,
      { user: manualsKeeper(), route: '/' },
    );

    expect(await screen.findByRole('tab', { name: 'Руководства' })).toBeDefined();
    // Пункт меню — из того же списка прав, что маршрут и редирект (§3.6).
    expect(screen.getByText('Администрирование')).toBeDefined();
    expect(screen.queryByText('Смена пароля')).toBeNull();
  });
});
