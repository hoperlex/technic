import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import {
  passwordWeakness,
  type PasswordResetConfirmInput,
  type PasswordResetRequestInput,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteHandler } from './http';
import { renderWithSession, renderWithUser } from './render';
import { authUser, loginResponse } from './factories/auth';
import {
  captchaConfig,
  captchaConfigUnreachable,
  captchaConfigWithoutKey,
  captchaScriptTags,
  clickLeavesDocument,
  heldResponse,
  smartCaptchaService,
  trackNavigation,
  type NavigationLog,
  type SmartCaptchaService,
} from './captcha';
import { ForgotPasswordPage } from '../src/pages/ForgotPasswordPage';
import { ResetPasswordPage } from '../src/pages/ResetPasswordPage';

/**
 * Восстановление доступа (ADR 0072): запрос ссылки и задание нового пароля по ней; капча на первой
 * из них — по ADR 0130.
 *
 * Обе страницы открыты без входа, и обе проверяются с одной оглядкой — они не должны рассказывать
 * постороннему больше, чем он и так знает: ни того, заведена ли учётка с таким адресом, ни того,
 * что за токен приехал в ссылке.
 *
 * Отдельно — четыре состояния капчи (план `docs/smart-captcha-plan.md` §5) и изоляция стороннего
 * скрипта (§12): форма запроса ссылки шлёт письма по любому названному адресу, поэтому именно она
 * и стоит под проверкой, а страница нового пароля — нет: туда приходят по одноразовой ссылке.
 *
 * Сеть подменяется на уровне HTTP, а не модулем `api/auth`: «запрос не ушёл» — утверждение о
 * контракте восстановления, а не о нынешней раскладке файлов портала.
 */

/** Клиентский ключ виджета: портал берёт его у собственной ручки, а не из сборки. */
const CLIENT_KEY = 'ysc1_test_key';
/** Одноразовый токен, который отдаёт виджет прошедшему проверку. */
const CAPTCHA_TOKEN = 'smart-captcha-token';

/** Поддельная служба Яндекса и журнал полных переходов — свои на каждый тест (см. ./captcha). */
let captcha: SmartCaptchaService;
let navigation: NavigationLog;

beforeEach(() => {
  captcha = smartCaptchaService();
  navigation = trackNavigation();
});

/**
 * Ответ ручки запроса ссылки. Текст нейтральный и один и тот же независимо от того, есть ли такая
 * учётка: сервер отвечает им всегда, и портал печатает его как есть.
 */
const NEUTRAL = 'Если такой адрес известен порталу, письмо со ссылкой отправлено';

const EMAIL = 'ivanov@example.com';
const TOKEN = 'token-iz-pisma';

/** Пароль той же силы, что требует регистрация: политика у портала одна на все формы. */
const STRONG = 'Sn3-verkhoyansk-77';
/** Длину проходит, но подбирается мгновенно — форма обязана отвергнуть его сама. */
const WEAK = '1234567890';

const REQUEST = 'POST /auth/password-reset/request';
const CONFIRM = 'POST /auth/password-reset/confirm';

/** antd связывает подпись с полем через `for`/`id`, поэтому ищем по подписи, как это делает человек. */
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/**
 * «Забыли пароль?» вместе со своими ручками; пользователя в дереве нет — форма открыта до входа.
 *
 * Ответ ручки конфига задаётся сценарием: включённая капча, выключенная, чужой формат ответа и
 * молчание сети — четыре разных формы, а не четыре настроения одной.
 */
function renderForgot(captchaRoute: RouteHandler = () => captchaConfig(CLIENT_KEY)): HttpMock {
  const http = mockHttp({
    'GET /auth/captcha': captchaRoute,
    [REQUEST]: () => json({ ok: true, message: NEUTRAL }),
  });
  renderWithUser(<ForgotPasswordPage />, { user: null, route: '/forgot-password' });
  return http;
}

/**
 * Страница нового пароля. `search` — хвост адреса: токен берётся только оттуда, и им же
 * различаются оба состояния экрана.
 */
function renderReset(search: string): HttpMock {
  const http = mockHttp({
    [CONFIRM]: () => json({ ok: true, message: 'Пароль изменён' }),
  });
  renderWithUser(<ResetPasswordPage />, { user: null, route: `/reset-password${search}` });
  return http;
}

/**
 * Чекбокс на экране — значит ключ приехал, скрипт «загрузился» и виджет нарисован. Отправлять
 * раньше бессмысленно: кнопка ещё заблокирована, и тест ловил бы гонку, а не поведение.
 */
const captchaShown = () => captcha.appear();

/** Кнопка отправки: её состояние — половина всего, что проверяется про капчу. */
const requestButton = () =>
  screen.getByRole('button', { name: 'Прислать ссылку' }) as HTMLButtonElement;

const submit = () =>
  act(async () => {
    fireEvent.click(requestButton());
  });

describe('запрос ссылки на восстановление', () => {
  it('без пройденной проверки запрос не уходит', async () => {
    // Форма открыта без входа и шлёт письма по любому названному адресу: без капчи ею перебирали
    // бы ящики и заваливали письмами людей, которые ничего не забывали.
    const http = renderForgot();
    await captchaShown();

    fill('Email', EMAIL);
    await submit();

    expect(http.countOf(REQUEST)).toBe(0);
    expect(await screen.findByText('Подтвердите, что вы не робот')).toBeDefined();
  });

  it('с пройденной проверкой уходит адрес вместе с её токеном', async () => {
    const http = renderForgot();
    await captchaShown();

    fill('Email', EMAIL);
    await captcha.check(CAPTCHA_TOKEN);
    await submit();

    await waitFor(() => expect(http.countOf(REQUEST)).toBe(1));
    // Уезжает ровно то, что отдал виджет: решение «пройдена ли проверка» принимает сервер, у
    // Яндекса, — портал этот токен не разбирает и не подписывает.
    expect(http.lastCall(REQUEST)?.body as PasswordResetRequestInput).toMatchObject({
      email: EMAIL,
      captchaToken: CAPTCHA_TOKEN,
    });
  });

  it('после успеха печатается ответ сервера, а адрес на экране не повторяется', async () => {
    // Страница, по которой можно проверить, зарегистрирован ли человек в портале, — утечка сама
    // по себе: форма входа такой проверки не даёт, и восстановление не должно давать тоже.
    // Поэтому текст берётся серверный (он одинаков для известного и неизвестного адреса), а не
    // сочиняется порталом в духе «письмо отправлено на ivanov@example.com»: своя формулировка
    // однажды разойдётся с серверной и начнёт обещать письмо, которого не было.
    const http = renderForgot();
    await captchaShown();

    fill('Email', EMAIL);
    await captcha.check(CAPTCHA_TOKEN);
    await submit();

    await waitFor(() => expect(http.countOf(REQUEST)).toBe(1));
    expect(await screen.findByText(NEUTRAL)).toBeDefined();
    // Набранного адреса на экране не остаётся: он ушёл вместе с формой, и подтверждать чужую
    // догадку «такой ящик у них есть» нечем.
    expect(screen.queryByText(new RegExp(EMAIL))).toBeNull();
  });
});

/**
 * Четыре состояния капчи на форме запроса ссылки (§5). Разница между ними — не оттенки одного и
 * того же: при «выключено» письмо уходит с пустым токеном, а при «портал не смог узнать» не уходит
 * вовсе. Свести их к двум («ключ есть» / «ключа нет») значит однажды отправить форму без проверки,
 * которую сервер требует, — и не заметить этого.
 */
describe('капча на форме запроса ссылки', () => {
  it('выключена: поля нет вовсе, письмо уходит с пустым токеном и без стороннего скрипта', async () => {
    // `clientKey: null` — единственный признак выключенной капчи, общий у формы и у серверной
    // проверки: рассинхрон «портал рисует виджет, сервер не проверяет» так стать не может.
    const http = renderForgot(() => captchaConfig(null));
    await waitFor(() => expect(http.countOf('GET /auth/captcha')).toBe(1));
    await waitFor(() => expect(requestButton().disabled).toBe(false));

    // Прячется весь `Form.Item`, а не одно поле: подпись «Проверка» над пустым местом объясняла бы
    // человеку то, чего на форме нет.
    expect(screen.queryByLabelText('Проверка')).toBeNull();
    expect(screen.queryByText('Проверка')).toBeNull();

    fill('Email', EMAIL);
    await submit();

    await waitFor(() => expect(http.countOf(REQUEST)).toBe(1));
    expect(http.lastCall(REQUEST)?.body as PasswordResetRequestInput).toMatchObject({
      email: EMAIL,
      captchaToken: '',
    });
    expect(captchaScriptTags()).toHaveLength(0);
  });

  it('ответ без поля clientKey — это ошибка, а не «капча выключена»', async () => {
    // Ключевой случай протокола (§5): старый API во время выката, чужой прокси, обрезанный JSON.
    // Сочти портал такой ответ выключенной капчей — он молча слал бы письма без проверки, и
    // незакрытая форма выглядела бы исправной.
    const http = renderForgot(captchaConfigWithoutKey);

    expect(await screen.findByText('Проверка не загрузилась.')).toBeDefined();
    expect(screen.getByRole('button', { name: /Повторить/ })).toBeDefined();
    expect(requestButton().disabled).toBe(true);

    fill('Email', EMAIL);
    await submit();

    expect(http.countOf(REQUEST)).toBe(0);
    expect(captchaScriptTags()).toHaveLength(0);
  });

  it('молчание сети читается так же: отправка заблокирована', async () => {
    const http = renderForgot(captchaConfigUnreachable);

    expect(await screen.findByText('Проверка не загрузилась.')).toBeDefined();
    expect(requestButton().disabled).toBe(true);

    fill('Email', EMAIL);
    await submit();

    expect(http.countOf(REQUEST)).toBe(0);
  });

  it('пока ответа нет, отправка заблокирована, и портал объясняет, чего ждёт', async () => {
    // Ответ ручки придержим: это состояние живёт доли секунды, но именно в нём форма ушла бы без
    // токена, будь кнопка доступна.
    const config = heldResponse(() => captchaConfig(CLIENT_KEY));
    const http = renderForgot(config.handler);

    expect(await screen.findByText(/Портал выясняет, нужна ли проверка/)).toBeDefined();
    expect(requestButton().disabled).toBe(true);
    expect(captchaScriptTags()).toHaveLength(0);

    fill('Email', EMAIL);
    await submit();
    expect(http.countOf(REQUEST)).toBe(0);

    await config.release();
    await captchaShown();
    expect(requestButton().disabled).toBe(false);
  });

  it('виджет рисуется ключом от сервера, а отклонённая попытка его сбрасывает', async () => {
    // Токен одноразовый и живёт минуты: после обработанной попытки он потрачен. Не сбрось его
    // форма — второе нажатие отправило бы заведомо отклонённую проверку, и человек получил бы
    // отказ на ровном месте.
    const http = renderForgot();
    http.use({
      [REQUEST]: () =>
        apiError(400, {
          code: 'captcha_failed',
          message: 'Проверка не пройдена',
          fields: { captchaToken: 'Проверка не пройдена' },
        }),
    });
    await captchaShown();
    expect(captcha.sitekeys).toEqual([CLIENT_KEY]);

    fill('Email', EMAIL);
    await captcha.check(CAPTCHA_TOKEN);
    await submit();
    await waitFor(() => expect(http.countOf(REQUEST)).toBe(1));

    await waitFor(() => expect(captcha.reset).toHaveBeenCalled());
    /*
     * Отказ виден у самого поля проверки. Какими именно словами — тест не закрепляет: сброс
     * виджета обнуляет значение поля, и правило формы перекрывает текст сервера. Проверяется то,
     * что останется верным и после того, как отказ научатся показывать серверной формулировкой:
     * попытка ушла один раз, виджет сброшен, потраченный токен второй раз не уезжает.
     */
    await waitFor(() =>
      expect(document.querySelectorAll('.ant-form-item-explain-error').length).toBeGreaterThan(0),
    );

    await submit();
    expect(http.countOf(REQUEST)).toBe(1);
    expect(await screen.findByText('Подтвердите, что вы не робот')).toBeDefined();
  });
});

/**
 * Изоляция стороннего скрипта (§12). `captcha.js` исполняется в origin портала и, однажды
 * загруженный, остаётся в документе и после ухода со страницы: `destroy()` снимает виджет, но не
 * скрипт. Поэтому документ со скриптом и документ, в котором набирают логин и пароль, не должны
 * пересекаться никогда — а это свойство переходов, и проверяется оно здесь.
 */
describe('изоляция стороннего скрипта на «Забыли пароль?»', () => {
  it('«Вернуться ко входу» уводит полной навигацией, а не SPA-переходом', async () => {
    renderForgot();
    await captchaShown();

    const link = screen.getByRole('link', { name: 'Вернуться ко входу' });
    expect(link.getAttribute('href')).toBe('/login');
    // `Link` react-router погасил бы событие и оставил документ жить — вместе со скриптом.
    expect(clickLeavesDocument(link)).toBe(true);
  });

  it('вошедшая вкладка форму не рисует и уходит в портал', async () => {
    // Сегодня этот маршрут вошедшего не отсекает вовсе, и сторонний код втягивался бы прямо в
    // авторизованный документ.
    const http = mockHttp({
      'GET /auth/captcha': () => captchaConfig(CLIENT_KEY),
      [REQUEST]: () => json({ ok: true, message: NEUTRAL }),
    });
    renderWithUser(<ForgotPasswordPage />, { user: authUser(), route: '/forgot-password' });

    await waitFor(() => expect(navigation.to).toEqual(['/']));
    expect(screen.queryByRole('button', { name: 'Прислать ссылку' })).toBeNull();
    expect(http.countOf('GET /auth/captcha')).toBe(0);
    expect(captchaScriptTags()).toHaveLength(0);
  });

  it('пока статус сессии неизвестен, портал не ходит за ключом и не вставляет скрипт', async () => {
    /*
     * Гонка, ради которой заведено правило: `AuthProvider` узнаёт про вкладку асинхронно, а
     * публичный маршрут монтируется сразу. Поэтому bootstrap здесь ЗАДЕРЖИВАЕТСЯ управляемым
     * промисом, а не подставляется готовым состоянием: подставь его — и гонки в тесте не станет, а
     * вместе с ней и проверки.
     */
    const user = authUser();
    const bootstrap = heldResponse(() => json(loginResponse(user)));
    const http = mockHttp({
      'POST /auth/refresh': bootstrap.handler,
      'GET /auth/me': () => json(user),
      'GET /auth/captcha': () => captchaConfig(CLIENT_KEY),
      [REQUEST]: () => json({ ok: true, message: NEUTRAL }),
    });
    renderWithSession(<ForgotPasswordPage />, { route: '/forgot-password' });

    expect(await screen.findByText(/Портал выясняет, нужна ли проверка/)).toBeDefined();
    expect(requestButton().disabled).toBe(true);
    expect(http.countOf('GET /auth/captcha')).toBe(0);
    expect(captchaScriptTags()).toHaveLength(0);
    // И уводить некуда: по неизвестному статусу выбросили бы с формы незалогиненного посетителя.
    expect(navigation.to).toEqual([]);

    await bootstrap.release();

    // Сессия оказалась вошедшей — уходим в портал полной навигацией, так и не тронув скрипт.
    await waitFor(() => expect(navigation.to).toEqual(['/']));
    expect(http.countOf('GET /auth/captcha')).toBe(0);
    expect(captchaScriptTags()).toHaveLength(0);
  });

  it('а не оказалось сессии — начинается обычный путь', async () => {
    const bootstrap = heldResponse(() =>
      apiError(401, { code: 'unauthorized', message: 'Сессия истекла' }),
    );
    const http = mockHttp({
      'POST /auth/refresh': bootstrap.handler,
      'GET /auth/captcha': () => captchaConfig(CLIENT_KEY),
      [REQUEST]: () => json({ ok: true, message: NEUTRAL }),
    });
    renderWithSession(<ForgotPasswordPage />, { route: '/forgot-password' });

    expect(http.countOf('GET /auth/captcha')).toBe(0);
    await bootstrap.release();

    await captchaShown();
    expect(http.countOf('GET /auth/captcha')).toBe(1);
    expect(navigation.to).toEqual([]);
  });
});

describe('задание нового пароля по ссылке', () => {
  it('без токена в адресе формы нет вовсе', async () => {
    // Показать поле пароля, которому некуда уехать, значит заставить человека придумать пароль и
    // получить отказ на «Сохранить». Экран вместо этого сразу объясняет, что ссылка неполная, и
    // отправляет за новым письмом.
    const http = renderReset('');

    expect(await screen.findByText('Ссылка неполная')).toBeDefined();
    expect(screen.queryByLabelText('Новый пароль')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Сохранить пароль' })).toBeNull();
    expect(screen.getByText('Запросить письмо заново')).toBeDefined();
    expect(http.countOf(CONFIRM)).toBe(0);
  });

  it('слабый пароль форма не пропускает — политика та же, что при регистрации', async () => {
    // Одной длины мало: «1234567890» её проходит, а подбирается мгновенно. Проверка стоит на
    // клиенте не вместо серверной, а до неё: смысл ссылки одноразовый, и тратить её на заведомо
    // отклонённый пароль — это ещё одно письмо и ещё один заход.
    const http = renderReset(`?token=${TOKEN}`);
    await screen.findByLabelText('Новый пароль');

    fill('Новый пароль', WEAK);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль' })),
    );

    expect(http.countOf(CONFIRM)).toBe(0);
    // Отказ формулирует общая политика (`passwordWeakness`), а не своё правило страницы: тот же
    // текст человек увидел бы при регистрации и получил бы с сервера.
    expect(passwordWeakness(WEAK)).toBe('Слишком распространённый пароль');
    expect(await screen.findByText('Слишком распространённый пароль')).toBeDefined();
  });

  it('отправляет токен из адреса вместе с новым паролем', async () => {
    // Токен берётся из адресной строки, а не из формы: другого источника у него нет, и ошибка
    // здесь означала бы смену пароля не по той ссылке, по которой пришли.
    const http = renderReset(`?token=${TOKEN}`);
    await screen.findByLabelText('Новый пароль');

    fill('Новый пароль', STRONG);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Сохранить пароль' })),
    );

    await waitFor(() => expect(http.countOf(CONFIRM)).toBe(1));
    expect(http.lastCall(CONFIRM)?.body as PasswordResetConfirmInput).toEqual({
      token: TOKEN,
      newPassword: STRONG,
    });
    // Итог сообщает и о побочном действии: прежние сессии завершены — на других устройствах
    // придётся войти заново. Без этой строки «пароль изменён» читалось бы как «и всё осталось».
    expect(await screen.findByText('Пароль изменён')).toBeDefined();
    expect(
      screen.getByText(
        'Прежние сессии завершены — на других устройствах потребуется войти заново.',
      ),
    ).toBeDefined();
  });
});
