import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { CaptchaChallenge, RegisterInput } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { selectOption } from './antd';
import { RegisterPage } from '../src/pages/RegisterPage';

/**
 * Форма регистрации (ADR 0034). Проверяется то, ради чего её переделывали: ФИО уходит тремя
 * полями, отчество можно не заполнять, а без кода с картинки заявка не отправляется. Сама
 * капча здесь заглушка — её свойства проверяет `apps/api/test/captcha.test.ts`.
 *
 * Обе ручки подменяются сетью, а не модулем `api/auth`: «заявка не ушла» — утверждение о том, что
 * запроса не было, и проверять его подменённым модулем значит держаться за нынешнюю раскладку
 * файлов портала вместо HTTP-контракта регистрации.
 */

const CHALLENGE: CaptchaChallenge = {
  token: 'challenge-token',
  image: 'data:image/png;base64,AA',
  expiresIn: 180,
};

/**
 * Страница вместе с двумя своими ручками. Пользователя в дереве нет намеренно: регистрацию
 * открывает тот, у кого учётной записи ещё не существует.
 */
function renderPage(): HttpMock {
  const http = mockHttp({
    'GET /auth/captcha': () => json(CHALLENGE),
    'POST /auth/register': () => json({ ok: true, message: 'ок' }),
  });
  renderWithUser(<RegisterPage />, { user: null });
  return http;
}

/**
 * Картинка на экране — значит челлендж приехал и его токен уже лежит в форме. Отправлять до
 * этого бессмысленно: заявка уехала бы с пустым токеном, и тест ловил бы гонку, а не поведение.
 */
const captchaShown = () => screen.findByAltText('Проверочный код на картинке');

/** Сколько заявок на доступ ушло на сервер. */
const registrations = (http: HttpMock) => http.countOf('POST /auth/register');

/** Что уехало заявкой: тело последнего запроса регистрации. */
const sent = (http: HttpMock) => http.lastCall('POST /auth/register')?.body as RegisterInput;

/** antd связывает подпись с полем через `for`/`id`, поэтому ищем по подписи, как это делает человек. */
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Выбор в `Select`: открыть список поля и нажать пункт — как это делает человек. */
function selectRoleRequest(optionLabel: string) {
  return selectOption('Выберите наиболее подходящую роль', optionLabel);
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
}

/** Обязательный минимум, кроме пожелания по роли: его тесты задают сами. */
function fillCommonFields() {
  fill('Фамилия', 'Иванов');
  fill('Имя', 'Иван');
  fill('Email', 'ivanov@example.com');
  // Телефон обязателен (ADR 0066): без него заявку рассматривать нечем — портал не пишет писем.
  fill('Телефон', '9261234567');
  fill('Пароль', 'Sn3-verkhoyansk-77');
  fill('Проверка', '47293');
}

describe('форма регистрации', () => {
  it('ФИО спрашивается тремя полями', async () => {
    renderPage();
    await captchaShown();
    expect(screen.getByLabelText('Фамилия')).toBeDefined();
    expect(screen.getByLabelText('Имя')).toBeDefined();
    expect(screen.getByLabelText('Отчество')).toBeDefined();
    expect(screen.queryByLabelText('ФИО')).toBeNull();
  });

  it('отправляет части ФИО и ответ на капчу, отчество можно не заполнять', async () => {
    const http = renderPage();
    await captchaShown();

    fillCommonFields();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    await waitFor(() => expect(registrations(http)).toBe(1));
    expect(sent(http)).toMatchObject({
      email: 'ivanov@example.com',
      lastName: 'Иванов',
      firstName: 'Иван',
      middleName: '',
      requestedRole: 'dispatcher',
      captchaToken: 'challenge-token',
      captchaAnswer: '47293',
    });
  });

  it('без кода с картинки заявка не уходит', async () => {
    const http = renderPage();
    await captchaShown();

    fill('Фамилия', 'Иванов');
    fill('Имя', 'Иван');
    fill('Email', 'ivanov@example.com');
    fill('Пароль', 'Sn3-verkhoyansk-77');
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
    expect(await screen.findByText('Введите код с картинки')).toBeDefined();
  });

  it('после отправки показывает экран ожидания, а не исчезающее сообщение', async () => {
    renderPage();
    await captchaShown();

    fillCommonFields();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    expect(await screen.findByText('Заявка на доступ принята')).toBeDefined();
    expect(screen.getByText('ivanov@example.com')).toBeDefined();
  });

  it('без телефона заявка не уходит — по нему её и рассматривают', async () => {
    // ADR 0066 отменяет необязательность номера при регистрации (ADR 0043 п. 2): почтовых
    // уведомлений у портала нет, и без телефона администратору некуда обратиться.
    const http = renderPage();
    await captchaShown();

    fill('Фамилия', 'Иванов');
    fill('Имя', 'Иван');
    fill('Email', 'ivanov@example.com');
    fill('Пароль', 'Sn3-verkhoyansk-77');
    fill('Проверка', '47293');
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
    expect(await screen.findByText('Укажите контактный телефон')).toBeDefined();
  });

  it('телефон уходит десятью цифрами, как бы его ни набрали', async () => {
    // Код страны поле подставляет само, а «8» съедает: наружу из формы уходит то же, что хранит
    // база, — маска живёт только на экране (ADR 0066).
    const http = renderPage();
    await captchaShown();

    fillCommonFields();
    fill('Телефон', '8 926 123-45-67');
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    await waitFor(() => expect(registrations(http)).toBe(1));
    expect(sent(http)).toMatchObject({ phone: '9261234567' });
  });

  it('вместо номера слово — в поле не попадает вовсе, и заявка не уходит', async () => {
    const http = renderPage();
    await captchaShown();

    fillCommonFields();
    fill('Телефон', 'нет');
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
    // Буквы маска не пропускает, поэтому поле остаётся пустым — и заявка спотыкается о
    // обязательность номера, а не о его формат.
    expect(await screen.findByText('Укажите контактный телефон')).toBeDefined();
  });

  it('недобранный номер заявку не пропускает', async () => {
    const http = renderPage();
    await captchaShown();

    fillCommonFields();
    fill('Телефон', '926 123');
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
    expect(await screen.findByText('Телефон в формате +7 (900) 000 00 00')).toBeDefined();
  });

  it('слабый пароль не отправляется: длины мало, если это фамилия или последовательность', async () => {
    const http = renderPage();
    await captchaShown();

    fillCommonFields();
    await selectRoleRequest('Диспетчер');
    fill('Пароль', '1234567890');
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
  });
});

describe('пожелание по роли', () => {
  it('без выбора роли заявка не уходит', async () => {
    const http = renderPage();
    await captchaShown();

    fillCommonFields();
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
    expect(await screen.findByText('Выберите роль')).toBeDefined();
  });

  it('«Сотрудник объекта» открывает поле объекта и требует его заполнить', async () => {
    const http = renderPage();
    await captchaShown();

    fillCommonFields();
    expect(screen.queryByLabelText('Объект')).toBeNull();
    await selectRoleRequest('Сотрудник объекта');
    expect(await screen.findByLabelText('Объект')).toBeDefined();

    await act(async () => submit());
    expect(registrations(http)).toBe(0);

    fill('Объект', 'ЖК Северный');
    await act(async () => submit());
    await waitFor(() => expect(registrations(http)).toBe(1));
    expect(sent(http)).toMatchObject({
      requestedRole: 'site_staff',
      requestedObject: 'ЖК Северный',
      requestedCompany: '',
    });
  });

  it('«Оператор по вывозу мусора» спрашивает компанию, а не объект', async () => {
    const http = renderPage();
    await captchaShown();

    fillCommonFields();
    await selectRoleRequest('Оператор по вывозу мусора');
    expect(await screen.findByLabelText('Компания')).toBeDefined();
    expect(screen.queryByLabelText('Объект')).toBeNull();
    fill('Компания', 'ООО «Ромашка»');
    await act(async () => submit());

    await waitFor(() => expect(registrations(http)).toBe(1));
    expect(sent(http)).toMatchObject({
      requestedRole: 'waste_operator',
      requestedCompany: 'ООО «Ромашка»',
      requestedObject: '',
    });
  });

  it('«Другое» ничего дополнительно не спрашивает', async () => {
    const http = renderPage();
    await captchaShown();

    fillCommonFields();
    await selectRoleRequest('Другое');
    expect(screen.queryByLabelText('Объект')).toBeNull();
    expect(screen.queryByLabelText('Компания')).toBeNull();
    await act(async () => submit());

    await waitFor(() => expect(registrations(http)).toBe(1));
    expect(sent(http)).toMatchObject({ requestedRole: 'other' });
  });
});
