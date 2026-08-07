import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import {
  passwordWeakness,
  type CaptchaChallenge,
  type PasswordResetConfirmInput,
  type PasswordResetRequestInput,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { ForgotPasswordPage } from '../src/pages/ForgotPasswordPage';
import { ResetPasswordPage } from '../src/pages/ResetPasswordPage';

/**
 * Восстановление доступа (ADR 0072): запрос ссылки и задание нового пароля по ней.
 *
 * Обе страницы открыты без входа, и обе проверяются с одной оглядкой — они не должны рассказывать
 * постороннему больше, чем он и так знает: ни того, заведена ли учётка с таким адресом, ни того,
 * что за токен приехал в ссылке.
 *
 * Сеть подменяется на уровне HTTP, а не модулем `api/auth`: «запрос не ушёл» — утверждение о
 * контракте восстановления, а не о нынешней раскладке файлов портала.
 */

const CHALLENGE: CaptchaChallenge = {
  token: 'challenge-token',
  image: 'data:image/png;base64,AA',
  expiresIn: 180,
};

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

/** «Забыли пароль?» вместе со своими ручками; пользователя в дереве нет — форма открыта до входа. */
function renderForgot(): HttpMock {
  const http = mockHttp({
    'GET /auth/captcha': () => json(CHALLENGE),
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
 * Картинка на экране — значит челлендж приехал и его токен уже лежит в форме. Отправлять раньше
 * бессмысленно: запрос уехал бы с пустым токеном, и тест ловил бы гонку, а не поведение.
 */
const captchaShown = () => screen.findByAltText('Проверочный код на картинке');

describe('запрос ссылки на восстановление', () => {
  it('без разгаданной капчи запрос не уходит', async () => {
    // Форма открыта без входа и шлёт письма по любому названному адресу: без капчи ею перебирали
    // бы ящики и заваливали письмами людей, которые ничего не забывали.
    const http = renderForgot();
    await captchaShown();

    fill('Email', EMAIL);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Прислать ссылку' })));

    expect(http.countOf(REQUEST)).toBe(0);
    expect(await screen.findByText('Введите код')).toBeDefined();
  });

  it('с капчей уходит адрес вместе с ответом на неё', async () => {
    const http = renderForgot();
    await captchaShown();

    fill('Email', EMAIL);
    fill('Проверка', '47293');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Прислать ссылку' })));

    await waitFor(() => expect(http.countOf(REQUEST)).toBe(1));
    // Ответ капчи уходит вместе с её токеном: сервер сверяет пару, и одного набранного кода ему
    // мало — иначе разгадка одной картинки годилась бы для любого запроса.
    expect(http.lastCall(REQUEST)?.body as PasswordResetRequestInput).toMatchObject({
      email: EMAIL,
      captchaToken: 'challenge-token',
      captchaAnswer: '47293',
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
    fill('Проверка', '47293');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Прислать ссылку' })));

    await waitFor(() => expect(http.countOf(REQUEST)).toBe(1));
    expect(await screen.findByText(NEUTRAL)).toBeDefined();
    // Набранного адреса на экране не остаётся: он ушёл вместе с формой, и подтверждать чужую
    // догадку «такой ящик у них есть» нечем.
    expect(screen.queryByText(new RegExp(EMAIL))).toBeNull();
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
