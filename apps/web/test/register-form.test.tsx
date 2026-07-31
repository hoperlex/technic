import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter } from 'react-router';

/**
 * Форма регистрации (ADR 0034). Проверяется то, ради чего её переделывали: ФИО уходит тремя
 * полями, отчество можно не заполнять, а без кода с картинки заявка не отправляется. Сама
 * капча здесь заглушка — её свойства проверяет `apps/api/test/captcha.test.ts`.
 */

const register = vi.fn();
const captcha = vi.fn();

vi.mock('../src/api/auth', () => ({
  authApi: {
    register: (...args: unknown[]) => register(...args),
    captcha: () => captcha(),
  },
}));

const { RegisterPage } = await import('../src/pages/RegisterPage');

function renderPage() {
  return render(
    <MemoryRouter>
      <App>
        <RegisterPage />
      </App>
    </MemoryRouter>,
  );
}

/** antd связывает подпись с полем через `for`/`id`, поэтому ищем по подписи, как это делает человек. */
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Выбор в `Select`: открыть список и нажать пункт — как это делает человек. */
async function selectRoleRequest(optionLabel: string) {
  fireEvent.mouseDown(document.querySelector('.ant-select-content')!);
  fireEvent.click(await screen.findByTitle(optionLabel));
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));
}

/** Обязательный минимум, кроме пожелания по роли: его тесты задают сами. */
function fillCommonFields() {
  fill('Фамилия', 'Иванов');
  fill('Имя', 'Иван');
  fill('Email', 'ivanov@example.com');
  fill('Пароль', 'Sn3-verkhoyansk-77');
  fill('Проверка', '47293');
}

beforeEach(() => {
  register.mockReset().mockResolvedValue({ ok: true, message: 'ок' });
  captcha.mockReset().mockResolvedValue({
    token: 'challenge-token',
    image: 'data:image/png;base64,AA',
    expiresIn: 180,
  });
});

describe('форма регистрации', () => {
  it('ФИО спрашивается тремя полями', async () => {
    renderPage();
    await waitFor(() => expect(captcha).toHaveBeenCalled());
    expect(screen.getByLabelText('Фамилия')).toBeDefined();
    expect(screen.getByLabelText('Имя')).toBeDefined();
    expect(screen.getByLabelText('Отчество')).toBeDefined();
    expect(screen.queryByLabelText('ФИО')).toBeNull();
  });

  it('отправляет части ФИО и ответ на капчу, отчество можно не заполнять', async () => {
    renderPage();
    await waitFor(() => expect(captcha).toHaveBeenCalled());

    fillCommonFields();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register.mock.calls[0]![0]).toMatchObject({
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
    renderPage();
    await waitFor(() => expect(captcha).toHaveBeenCalled());

    fill('Фамилия', 'Иванов');
    fill('Имя', 'Иван');
    fill('Email', 'ivanov@example.com');
    fill('Пароль', 'Sn3-verkhoyansk-77');
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    expect(register).not.toHaveBeenCalled();
    expect(await screen.findByText('Введите код с картинки')).toBeDefined();
  });

  it('после отправки показывает экран ожидания, а не исчезающее сообщение', async () => {
    renderPage();
    await waitFor(() => expect(captcha).toHaveBeenCalled());

    fillCommonFields();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    expect(await screen.findByText('Заявка на доступ принята')).toBeDefined();
    expect(screen.getByText('ivanov@example.com')).toBeDefined();
  });

  it('телефон можно не заполнять — заявка уходит с пустым номером', async () => {
    renderPage();
    await waitFor(() => expect(captcha).toHaveBeenCalled());

    fillCommonFields();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register.mock.calls[0]![0]).toMatchObject({ phone: '' });
  });

  it('введённый телефон уходит как есть — формат свободный', async () => {
    renderPage();
    await waitFor(() => expect(captcha).toHaveBeenCalled());

    fillCommonFields();
    fill('Телефон', '+7 926 123-45-67');
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register.mock.calls[0]![0]).toMatchObject({ phone: '+7 926 123-45-67' });
  });

  it('вместо номера слово — заявка не уходит: по такому телефону не позвонят', async () => {
    renderPage();
    await waitFor(() => expect(captcha).toHaveBeenCalled());

    fillCommonFields();
    fill('Телефон', 'нет');
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    expect(register).not.toHaveBeenCalled();
    expect(await screen.findByText('Некорректный телефон')).toBeDefined();
  });

  it('слабый пароль не отправляется: длины мало, если это фамилия или последовательность', async () => {
    renderPage();
    await waitFor(() => expect(captcha).toHaveBeenCalled());

    fillCommonFields();
    await selectRoleRequest('Диспетчер');
    fill('Пароль', '1234567890');
    await act(async () => submit());

    expect(register).not.toHaveBeenCalled();
  });
});

describe('пожелание по роли', () => {
  it('без выбора роли заявка не уходит', async () => {
    renderPage();
    await waitFor(() => expect(captcha).toHaveBeenCalled());

    fillCommonFields();
    await act(async () => submit());

    expect(register).not.toHaveBeenCalled();
    expect(await screen.findByText('Выберите роль')).toBeDefined();
  });

  it('«Сотрудник объекта» открывает поле объекта и требует его заполнить', async () => {
    renderPage();
    await waitFor(() => expect(captcha).toHaveBeenCalled());

    fillCommonFields();
    expect(screen.queryByLabelText('Объект')).toBeNull();
    await selectRoleRequest('Сотрудник объекта');
    expect(await screen.findByLabelText('Объект')).toBeDefined();

    await act(async () => submit());
    expect(register).not.toHaveBeenCalled();

    fill('Объект', 'ЖК Северный');
    await act(async () => submit());
    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register.mock.calls[0]![0]).toMatchObject({
      requestedRole: 'site_staff',
      requestedObject: 'ЖК Северный',
      requestedCompany: '',
    });
  });

  it('«Оператор по вывозу мусора» спрашивает компанию, а не объект', async () => {
    renderPage();
    await waitFor(() => expect(captcha).toHaveBeenCalled());

    fillCommonFields();
    await selectRoleRequest('Оператор по вывозу мусора');
    expect(await screen.findByLabelText('Компания')).toBeDefined();
    expect(screen.queryByLabelText('Объект')).toBeNull();
    fill('Компания', 'ООО «Ромашка»');
    await act(async () => submit());

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register.mock.calls[0]![0]).toMatchObject({
      requestedRole: 'waste_operator',
      requestedCompany: 'ООО «Ромашка»',
      requestedObject: '',
    });
  });

  it('«Другое» ничего дополнительно не спрашивает', async () => {
    renderPage();
    await waitFor(() => expect(captcha).toHaveBeenCalled());

    fillCommonFields();
    await selectRoleRequest('Другое');
    expect(screen.queryByLabelText('Объект')).toBeNull();
    expect(screen.queryByLabelText('Компания')).toBeNull();
    await act(async () => submit());

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register.mock.calls[0]![0]).toMatchObject({ requestedRole: 'other' });
  });
});
