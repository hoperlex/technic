import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  CaptchaChallenge,
  ResendVerificationInput,
  VerifyEmailInput,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteHandler } from './http';
import { renderWithUser } from './render';
import { VerifyEmailPage } from '../src/pages/VerifyEmailPage';

/**
 * Подтверждение адреса по ссылке из письма (ADR 0072).
 *
 * Проверяется главное свойство страницы — она ничего не делает сама. Всё остальное здесь про то,
 * чтобы человек с недействительной или обрезанной ссылкой не оказался в тупике.
 *
 * Сеть подменяется на уровне HTTP, а не модулем `api/auth`: утверждение «запроса не было» о
 * подменённом модуле говорит лишь то, что портал сейчас разложен по таким файлам, а проверять надо
 * контракт подтверждения — тот же, по которому портал разговаривает с сервером на самом деле.
 */

const TOKEN = 'token-iz-pisma';

const CHALLENGE: CaptchaChallenge = {
  token: 'challenge-token',
  image: 'data:image/png;base64,AA',
  expiresIn: 180,
};

/** Нейтральный ответ ручки повторной отправки: адрес в нём не называется (см. ADR 0072). */
const RESENT = 'Если такой адрес известен порталу, письмо отправлено';

const ok: RouteHandler = () => json({ ok: true, message: 'Адрес подтверждён' });

/**
 * Страница вместе со своими тремя ручками. Пользователя в дереве нет намеренно: по ссылке из
 * письма приходит тот, у кого доступа в портал ещё нет.
 *
 * `search` — хвост адреса: именно из него страница берёт токен, и различаются им все сценарии.
 */
function renderPage(search: string, verify: RouteHandler = ok): HttpMock {
  const http = mockHttp({
    'GET /auth/captcha': () => json(CHALLENGE),
    'POST /auth/verify-email': verify,
    'POST /auth/verify-email/resend': () => json({ ok: true, message: RESENT }),
  });
  renderWithUser(<VerifyEmailPage />, { user: null, route: `/verify-email${search}` });
  return http;
}

/** Сколько подтверждений ушло на сервер. */
const confirmations = (http: HttpMock) => http.countOf('POST /auth/verify-email');

const confirmButton = () => screen.findByRole('button', { name: 'Подтвердить адрес' });

/** antd связывает подпись с полем через `for`/`id`, поэтому ищем по подписи, как это делает человек. */
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('подтверждение адреса по ссылке', () => {
  it('открытие ссылки ничего не подтверждает — запрос уходит только по кнопке', async () => {
    // Это главное свойство страницы. Почтовые клиенты и антивирусы открывают ссылки из писем
    // заранее, у себя: подтверждение на монтировании сработало бы раньше, чем письмо увидел
    // человек, — то есть подтверждало бы адрес без его участия. Тогда ссылка, перехваченная по
    // дороге, подтверждала бы чужой ящик молча.
    const http = renderPage(`?token=${TOKEN}`);

    // Кнопка на экране — страница отрисована целиком: будь подтверждение автоматическим, оно
    // уехало бы к этому моменту.
    expect(await confirmButton()).toBeDefined();
    // Догоняем отложенные эффекты: запрос мог бы уйти и не первым кадром.
    await act(async () => {
      await Promise.resolve();
    });

    expect(confirmations(http)).toBe(0);
    // Ни одного запроса вообще: страница с токеном ничего не спрашивает и у соседних ручек.
    expect(http.calls).toHaveLength(0);
  });

  it('нажатие кнопки отправляет токен из адресной строки', async () => {
    // Токен берётся из адреса, а не из состояния формы: другого источника у него нет, и ошибка
    // здесь означала бы, что подтверждается не та ссылка, по которой пришли.
    const http = renderPage(`?token=${TOKEN}`);
    fireEvent.click(await confirmButton());

    await waitFor(() => expect(confirmations(http)).toBe(1));
    expect(http.lastCall('POST /auth/verify-email')?.body as VerifyEmailInput).toEqual({
      token: TOKEN,
    });
    expect(await screen.findByText('Адрес подтверждён')).toBeDefined();
  });

  it('ссылка без кода ведёт к повторной отправке письма, а не в тупик', async () => {
    // Ссылку часто открывают наполовину: почтовый клиент переносит строку, и хвост с токеном
    // теряется. Показать в этом случае ошибку значит оставить человека без следующего шага —
    // страница вместо этого сразу предлагает выслать письмо заново.
    const http = renderPage('');

    expect(await screen.findByLabelText('Email из заявки')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Прислать письмо заново' })).toBeDefined();
    // Кнопки подтверждения нет вовсе: подтверждать нечем, и нажимать её было бы не на что.
    expect(screen.queryByRole('button', { name: 'Подтвердить адрес' })).toBeNull();
    expect(screen.getByText(/В адресе не хватает кода подтверждения/)).toBeDefined();
    // Пустой токен на сервер не уходит: отказ по нему выглядел бы как «ссылка недействительна»,
    // хотя дело в обрезанном адресе.
    expect(confirmations(http)).toBe(0);
  });

  it('повторное письмо запрашивается с адресом и разгаданной капчей', async () => {
    // Форма повторной отправки — вход без учётной записи, поэтому она под капчей: иначе ею
    // перебирали бы адреса и рассылали письма чужим людям.
    const http = renderPage('');
    await screen.findByAltText('Проверочный код на картинке');

    fill('Email из заявки', 'ivanov@example.com');
    fill('Проверка', '47293');
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Прислать письмо заново' })),
    );

    await waitFor(() => expect(http.countOf('POST /auth/verify-email/resend')).toBe(1));
    expect(
      http.lastCall('POST /auth/verify-email/resend')?.body as ResendVerificationInput,
    ).toMatchObject({
      email: 'ivanov@example.com',
      captchaToken: 'challenge-token',
      captchaAnswer: '47293',
    });
    // Ответ печатается серверный: адрес в нём не называется, и по нему нельзя узнать, есть ли
    // такая заявка вовсе.
    expect(await screen.findByText(RESENT)).toBeDefined();
  });

  it('отказ сервера переводит страницу в «ссылка недействительна» с формой нового письма', async () => {
    // Ссылка одноразовая и с коротким сроком, поэтому 400 — обычный исход, а не поломка. Важно,
    // что он не оставляет человека ни с чем: тот же экран предлагает выслать письмо заново, и
    // повторное нажатие мёртвой кнопки уже невозможно.
    const http = renderPage(`?token=${TOKEN}`, () =>
      apiError(400, { code: 'invalid_token', message: 'Ссылка недействительна или устарела' }),
    );
    await act(async () => fireEvent.click(await confirmButton()));

    await waitFor(() => expect(confirmations(http)).toBe(1));
    expect(
      await screen.findByText('Ссылка недействительна или устарела. Запросите новое письмо.'),
    ).toBeDefined();
    expect(await screen.findByLabelText('Email из заявки')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Подтвердить адрес' })).toBeNull();
  });
});
