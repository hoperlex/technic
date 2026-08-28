import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { Navigate, Route, Routes } from 'react-router';
import { SHELL_SECTIONS, type AuthUser } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser, loginResponse } from './factories/auth';
import { AppLayout } from '../src/components/AppLayout';
import { HomeRedirect, ProtectedRoute, RequireSection } from '../src/auth/ProtectedRoute';
import { LoginPage } from '../src/pages/LoginPage';
import { ChangePasswordPage } from '../src/pages/ChangePasswordPage';

/**
 * Куда портал приземляет вошедшего (`docs/portal-sections-plan.md` §6).
 *
 * Вопрос «где человек оказывается» не проверял никто, и стоило это живого бага: стартовая страница
 * перебирала разделы поимённым списком, «Орг.техники» (ADR 0085) в списке не было, и оператор
 * сервисной компании — учётка, которой этот раздел единственный, — приезжал после входа на форму
 * смены пароля. Пароль менять не требовалось, форма ничего не объясняла, а смена его не спасала:
 * после сохранения перебор повторялся и приводил туда же.
 *
 * Проверяется здесь стык четырёх мест — вход, стартовая страница, гейты разделов и форма смены
 * пароля, — поэтому дерево маршрутов повторяет `App`: тот же `ProtectedRoute`, тот же цикл по
 * `SHELL_SECTIONS` под общим `RequireSection`, тот же `*` на корень и тот же каркас со стартовой
 * страницей index-маршрутом. Настоящие страницы разделов заменены заглушками, и это осознанно:
 * предмет проверки — адрес, на который портал приводит учётку, а не таблицы и запросы за ними.
 * Каждая настоящая страница притащила бы свою сеть, и красный тест здесь читался бы как поломка
 * раздела, а не маршрутизации. Всё остальное — своё: и `HomeRedirect`, и `LoginPage`, и форма
 * пароля, и `AppLayout`, потому что именно они и отвечают на вопрос.
 *
 * `RouteModalProvider` (ADR 0120) из ветки опущен: окна рейса и заявки в общей оболочке рендера
 * уже подставлены заглушкой, а настоящий провайдер разбирает адрес и монтирует за собой карточку
 * рейса со всеми её запросами — к разделам это отношения не имеет.
 */

/** Заглушка страницы раздела: подпись из реестра, но не равная ей — иначе спутается с пунктом меню. */
const sectionPage = (label: string) => `Страница раздела «${label}»`;

/** Экран, которым отвечает второй контур (ADR 0102): своя ветка, своя страница, общий гейт. */
const CABINET = 'Кабинет водителя';

const CHANGE_PASSWORD = 'POST /auth/change-password';

/**
 * Что каркас спрашивает независимо от разделов: журнал обновлений (ADR 0077), бейдж заявок на
 * регистрацию (ADR 0034) и счётчик «ждут меня» на оргтехнике (Р39). К стартовой странице это
 * отношения не имеет, но без ответа каркас ушёл бы за ними в настоящую сеть.
 */
function portalRoutes(user: AuthUser) {
  return {
    'GET /releases': () => json([]),
    'GET /users/pending-count': () => json({ count: 0 }),
    'GET /service-requests/waiting-count': () => json({ count: 0 }),
    // Непрочитанное в обсуждениях заявок (ADR 0141): второй счётчик каркаса, и спрашивает его
    // каждый, кому видны заявки, — иначе каркас остался бы без ответа на живой запрос.
    'GET /service-requests/unread-count': () => json({ count: 0 }),
    // Смена пароля отвечает тем же, чем вход: новая пара «токен + учётка». Пользователь остаётся
    // прежним — проверяется, куда портал ведёт после успеха, а не что сервер вернул.
    [CHANGE_PASSWORD]: () => json(loginResponse(user)),
  };
}

function renderPortal(user: AuthUser, route = '/') {
  mockHttp(portalRoutes(user));
  return renderWithUser(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route element={<RequireSection id="driver-cabinet" />}>
          <Route path="/driver" element={<div>{CABINET}</div>} />
        </Route>
        <Route element={<AppLayout />}>
          <Route index element={<HomeRedirect />} />
          {SHELL_SECTIONS.map((section) => (
            <Route key={section.id} element={<RequireSection id={section.id} />}>
              <Route path={section.path} element={<div>{sectionPage(section.label)}</div>} />
            </Route>
          ))}
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>,
    { user, route },
  );
}

/**
 * Подписи пунктов меню разделов. Отобраны по реестру, потому что `role="menuitem"` в каркасе носят
 * ещё и служебные пункты (помощь и новости портала, ADR 0077) — к составу разделов они отношения
 * не имеют, а в общий список ролей попадают.
 */
function sectionMenuLabels(): string[] {
  const labels = SHELL_SECTIONS.map((section) => section.label);
  return screen
    .queryAllByRole('menuitem')
    .map((item) => item.textContent ?? '')
    .filter((text) => labels.includes(text));
}

/** antd связывает подпись с полем через `for`/`id`, поэтому поле ищется по подписи, как человеком. */
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const click = async (name: string) =>
  act(async () => fireEvent.click(screen.getByRole('button', { name })));

/** Пароль длиннее `PASSWORD_MIN`: форма проверяет длину сама, и коротким она не отправится. */
const NEW_PASSWORD = 'novyy-parol-77';

describe('вход приводит в раздел роли, а не на служебную форму', () => {
  it('оператор сервисной компании попадает в «Орг.техника», а не на смену пароля', async () => {
    /*
     * Тот самый заявленный случай. Раздел у этой учётки единственный, и раньше стартовая страница
     * про него не знала: перебор доходил до конца и отдавал `/change-password`. Роль здесь ничего
     * не решает — решает тип контрагента (ADR 0038): `operator` со «Службой» видит оргтехнику,
     * а он же с перевозчиком — вывоз мусора.
     *
     * Вход идёт формой, а не подставленным адресом: половина цепочки — это `LoginPage`, которая
     * раньше вела на жёстко зашитый `/waste`, закрытый этой учётке. Сам вход выполняет оболочка
     * рендера (сеть сессии проверяют `flow-session-*`), а предмет здесь — адрес после него.
     */
    const service = authUser({
      id: 'user-service',
      email: 'service@example.test',
      role: 'operator',
      counterpartyType: 'service',
    });
    renderPortal(service, '/login');

    fill('Email', service.email);
    fill('Пароль', 'parol-operatora');
    await click('Войти');

    expect(await screen.findByText(sectionPage('Орг.техника'))).toBeDefined();
    expect(screen.queryByText('Смена пароля')).toBeNull();
  });

  it('механик приземляется в «Гараж», хотя в меню выше стоят «Путевые листы»', async () => {
    // Порядок меню и порядок стартовой страницы — разные вопросы и разные поля реестра
    // (`startOrder`). Механик их и разводит: заявок он не ведёт вовсе, и первой страницей ему
    // нужен парк на дату, а не журнал листов, который стоит в меню выше.
    renderPortal(authUser({ id: 'user-mechanic', role: 'mechanic' }));

    expect(await screen.findByText(sectionPage('Гараж'))).toBeDefined();
    expect(screen.queryByText(sectionPage('Путевые листы'))).toBeNull();
    // Само меню при этом прежнее: листы в нём выше гаража — иначе проверка сводилась бы к тому,
    // что оба порядка одинаковы, и подмены одного другим она бы не заметила.
    expect(sectionMenuLabels()).toEqual(['Путевые листы', 'Гараж']);
  });

  it('водитель приземляется в кабинет: разделов основного портала у роли нет', async () => {
    renderPortal(authUser({ id: 'user-driver', role: 'driver' }));
    expect(await screen.findByText(CABINET)).toBeDefined();
  });
});

/**
 * Учётка без единого раздела. Комендант без объектов — состояние, которого API сегодня не даёт
 * (объектной роли объект обязателен), но со свободной сборкой полномочий (ADR 0106) набор прав из
 * роли больше не выводится, а объекты учётки могут и исчезнуть позже. Портал обязан уметь показать
 * это состояние, и показать именно им, а не служебной формой.
 */
describe('учётке без разделов портал отвечает экраном, а не редиректом', () => {
  const homeless = () =>
    authUser({ id: 'user-commandant', role: 'commandant', constructionObjectIds: [] });

  it('с корня — пустой главный экран с выходом, и ни слова о пароле', async () => {
    renderPortal(homeless());

    expect(await screen.findByText('Разделы портала вам пока не назначены')).toBeDefined();
    // Подпись кнопки ищется вхождением: у кнопки с иконкой antd в доступное имя попадает ещё и
    // `aria-label` самой иконки («logout Выйти»).
    expect(screen.getByRole('button', { name: /Выйти/ })).toBeDefined();
    // Главное отличие от прежнего поведения: «доступ не настроен» больше не приезжает формой
    // смены пароля, неотличимой для человека от просроченного пароля.
    expect(screen.queryByText('Смена пароля')).toBeNull();
    // Экран стоит внутри каркаса — учётная запись и её меню на месте, пуст только список разделов.
    expect(screen.getByText(homeless().fullName)).toBeDefined();
    expect(sectionMenuLabels()).toEqual([]);
  });

  it('и с неизвестного адреса — туда же, а не на смену пароля', async () => {
    // Неизвестный адрес ведёт на корень, и отвечает по нему стартовая страница внутри каркаса:
    // нарисуй её `*` сам, экран «разделов нет» вышел бы голым — без меню учётки и без выхода.
    renderPortal(homeless(), '/takogo-razdela-net');

    expect(await screen.findByText('Разделы портала вам пока не назначены')).toBeDefined();
    expect(screen.queryByText('Смена пароля')).toBeNull();
  });
});

describe('форма смены пароля перестала быть тупиком', () => {
  it('открытую добровольно можно покинуть возвратом в портал', async () => {
    // Форму открывают пунктом меню учётной записи и из кабинета водителя, а обратной дороги с неё
    // не было ни у кого: передумал — либо меняй пароль, либо выходи из портала.
    renderPortal(authUser({ mustChangePassword: false }), '/change-password');

    await click('Вернуться в портал');
    expect(await screen.findByText(sectionPage('Вывоз мусора'))).toBeDefined();
  });

  it('при обязательной смене возврата нет — только выход', () => {
    // Кнопка обходила бы требование, ради которого в `ProtectedRoute` и стоит `mustChangePassword`.
    renderPortal(authUser({ mustChangePassword: true }), '/change-password');

    expect(screen.queryByRole('button', { name: 'Вернуться в портал' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeDefined();
    expect(screen.getByText('Требуется сменить пароль перед продолжением работы.')).toBeDefined();
  });

  it('успешная смена возвращает в раздел роли', async () => {
    // Прежде отсюда уходили на жёстко зашитый `/waste`: роль без вывоза попадала на свой же гейт,
    // а тот возвращал её на эту форму — круг замыкался, и смена пароля от него не спасала.
    renderPortal(authUser({ mustChangePassword: false }), '/change-password');

    fill('Текущий пароль', 'staryy-parol');
    fill('Новый пароль', NEW_PASSWORD);
    fill('Повторите новый пароль', NEW_PASSWORD);
    await click('Сохранить');

    expect(await screen.findByText(sectionPage('Вывоз мусора'))).toBeDefined();
  });

  it('водителя успешная смена возвращает в кабинет', async () => {
    // Второй контур проверяется отдельно: раздел роли у водителя один и лежит вне каркаса, а
    // возврат считает та же стартовая страница — по тому же реестру.
    renderPortal(
      authUser({ id: 'user-driver', role: 'driver', mustChangePassword: false }),
      '/change-password',
    );

    fill('Текущий пароль', 'staryy-parol');
    fill('Новый пароль', NEW_PASSWORD);
    fill('Повторите новый пароль', NEW_PASSWORD);
    await click('Сохранить');

    expect(await screen.findByText(CABINET)).toBeDefined();
  });

  it('обязательная смена уводит на форму с защищённого адреса', () => {
    // Единственный оставшийся законный повод показать эту форму — и он работает как прежде.
    renderPortal(authUser({ mustChangePassword: true }), '/waste');

    expect(screen.getByText('Смена пароля')).toBeDefined();
    expect(screen.queryByText(sectionPage('Вывоз мусора'))).toBeNull();
  });
});
