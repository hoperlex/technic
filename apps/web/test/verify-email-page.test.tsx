import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ResendVerificationInput, VerifyEmailInput } from '@technic/contracts';
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
import { VerifyEmailPage } from '../src/pages/VerifyEmailPage';

/**
 * Подтверждение адреса по ссылке из письма (ADR 0072), капча на форме повторного письма — по
 * ADR 0130.
 *
 * Проверяется главное свойство страницы — она ничего не делает сама. Всё остальное здесь про то,
 * чтобы человек с недействительной или обрезанной ссылкой не оказался в тупике: форма нового
 * письма обязана работать и тогда, когда капча выключена, и не отправлять ничего, когда портал не
 * знает, требуется ли токен (план `docs/smart-captcha-plan.md` §5). Само подтверждение по ссылке
 * капчи не спрашивает вовсе — код из письма и есть доказательство.
 *
 * Сеть подменяется на уровне HTTP, а не модулем `api/auth`: утверждение «запроса не было» о
 * подменённом модуле говорит лишь то, что портал сейчас разложен по таким файлам, а проверять надо
 * контракт подтверждения — тот же, по которому портал разговаривает с сервером на самом деле.
 */

const TOKEN = 'token-iz-pisma';

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

/** Нейтральный ответ ручки повторной отправки: адрес в нём не называется (см. ADR 0072). */
const RESENT = 'Если такой адрес известен порталу, письмо отправлено';

const ok: RouteHandler = () => json({ ok: true, message: 'Адрес подтверждён' });

/**
 * Страница вместе со своими тремя ручками. Пользователя в дереве нет намеренно: по ссылке из
 * письма приходит тот, у кого доступа в портал ещё нет.
 *
 * `search` — хвост адреса: именно из него страница берёт токен, и различаются им все сценарии.
 */
function renderPage(
  search: string,
  verify: RouteHandler = ok,
  captchaRoute: RouteHandler = () => captchaConfig(CLIENT_KEY),
): HttpMock {
  const http = mockHttp({
    'GET /auth/captcha': captchaRoute,
    'POST /auth/verify-email': verify,
    'POST /auth/verify-email/resend': () => json({ ok: true, message: RESENT }),
  });
  renderWithUser(<VerifyEmailPage />, { user: null, route: `/verify-email${search}` });
  return http;
}

/** Сколько подтверждений ушло на сервер. */
const confirmations = (http: HttpMock) => http.countOf('POST /auth/verify-email');

const confirmButton = () => screen.findByRole('button', { name: 'Подтвердить адрес' });

/** Кнопка повторного письма: её состояние — половина всего, что проверяется про капчу. */
const resendButton = () =>
  screen.getByRole('button', { name: 'Прислать письмо заново' }) as HTMLButtonElement;

const resend = () =>
  act(async () => {
    fireEvent.click(resendButton());
  });

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
    /*
     * И у соседних ручек страница ничего не просит. Единственное исключение — конфиг капчи: ключ
     * на вкладку один, и спрашивают его на всякой странице с формой (§5). Запрос этот безобиден:
     * он ничего не подтверждает и стороннего скрипта в документ не тянет — виджета на экране
     * подтверждения нет.
     */
    expect(http.calls.filter((call) => call.path !== '/auth/captcha')).toHaveLength(0);
    expect(captchaScriptTags()).toHaveLength(0);
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

  it('повторное письмо запрашивается с адресом и пройденной проверкой', async () => {
    // Форма повторной отправки — вход без учётной записи, поэтому она под капчей: иначе ею
    // перебирали бы адреса и рассылали письма чужим людям.
    const http = renderPage('');
    await captcha.appear();

    fill('Email из заявки', 'ivanov@example.com');
    await captcha.check(CAPTCHA_TOKEN);
    await resend();

    await waitFor(() => expect(http.countOf('POST /auth/verify-email/resend')).toBe(1));
    // Уезжает ровно то, что отдал виджет: решение «пройдена ли проверка» принимает сервер, у
    // Яндекса, — портал этот токен не разбирает и не подписывает.
    expect(
      http.lastCall('POST /auth/verify-email/resend')?.body as ResendVerificationInput,
    ).toMatchObject({
      email: 'ivanov@example.com',
      captchaToken: CAPTCHA_TOKEN,
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

/**
 * Четыре состояния капчи на форме повторного письма (§5). Разница между ними — не оттенки одного
 * и того же: при «выключено» письмо уходит с пустым токеном, а при «портал не смог узнать» не
 * уходит вовсе. Свести их к двум («ключ есть» / «ключа нет») значит однажды отправить форму без
 * проверки, которую сервер требует, — и не заметить этого.
 */
describe('капча на форме повторного письма', () => {
  it('выключена: поля нет вовсе, письмо уходит с пустым токеном и без стороннего скрипта', async () => {
    // `clientKey: null` — единственный признак выключенной капчи, общий у формы и у серверной
    // проверки: рассинхрон «портал рисует виджет, сервер не проверяет» так стать не может.
    const http = renderPage('', ok, () => captchaConfig(null));
    await waitFor(() => expect(http.countOf('GET /auth/captcha')).toBe(1));
    await waitFor(() => expect(resendButton().disabled).toBe(false));

    // Прячется весь `Form.Item`, а не одно поле: подпись «Проверка» над пустым местом объясняла бы
    // человеку то, чего на форме нет.
    expect(screen.queryByLabelText('Проверка')).toBeNull();
    expect(screen.queryByText('Проверка')).toBeNull();

    fill('Email из заявки', 'ivanov@example.com');
    await resend();

    await waitFor(() => expect(http.countOf('POST /auth/verify-email/resend')).toBe(1));
    expect(
      http.lastCall('POST /auth/verify-email/resend')?.body as ResendVerificationInput,
    ).toMatchObject({ email: 'ivanov@example.com', captchaToken: '' });
    expect(captchaScriptTags()).toHaveLength(0);
  });

  it('ответ без поля clientKey — это ошибка, а не «капча выключена»', async () => {
    // Ключевой случай протокола (§5): старый API во время выката, чужой прокси, обрезанный JSON.
    // Сочти портал такой ответ выключенной капчей — он молча слал бы письма без проверки, и
    // незакрытая форма выглядела бы исправной.
    const http = renderPage('', ok, captchaConfigWithoutKey);

    expect(await screen.findByText('Проверка не загрузилась.')).toBeDefined();
    expect(screen.getByRole('button', { name: /Повторить/ })).toBeDefined();
    expect(resendButton().disabled).toBe(true);

    fill('Email из заявки', 'ivanov@example.com');
    await resend();

    expect(http.countOf('POST /auth/verify-email/resend')).toBe(0);
    expect(captchaScriptTags()).toHaveLength(0);
  });

  it('молчание сети читается так же: отправка заблокирована', async () => {
    const http = renderPage('', ok, captchaConfigUnreachable);

    expect(await screen.findByText('Проверка не загрузилась.')).toBeDefined();
    expect(resendButton().disabled).toBe(true);

    fill('Email из заявки', 'ivanov@example.com');
    await resend();

    expect(http.countOf('POST /auth/verify-email/resend')).toBe(0);
  });

  it('пока ответа нет, отправка заблокирована, и портал объясняет, чего ждёт', async () => {
    // Ответ ручки придержим: это состояние живёт доли секунды, но именно в нём форма ушла бы без
    // токена, будь кнопка доступна.
    const config = heldResponse(() => captchaConfig(CLIENT_KEY));
    const http = renderPage('', ok, config.handler);

    expect(await screen.findByText(/Портал выясняет, нужна ли проверка/)).toBeDefined();
    expect(resendButton().disabled).toBe(true);
    expect(captchaScriptTags()).toHaveLength(0);

    fill('Email из заявки', 'ivanov@example.com');
    await resend();
    expect(http.countOf('POST /auth/verify-email/resend')).toBe(0);

    await config.release();
    await captcha.appear();
    expect(resendButton().disabled).toBe(false);
  });

  it('без пройденной проверки письмо не уходит, а отклонённая попытка сбрасывает виджет', async () => {
    // Токен одноразовый и живёт минуты: после обработанной попытки он потрачен. Не сбрось его
    // форма — второе нажатие отправило бы заведомо отклонённую проверку, и человек получил бы
    // отказ на ровном месте.
    const http = renderPage('');
    await captcha.appear();
    expect(captcha.sitekeys).toEqual([CLIENT_KEY]);

    fill('Email из заявки', 'ivanov@example.com');
    await resend();
    expect(http.countOf('POST /auth/verify-email/resend')).toBe(0);
    expect(await screen.findByText('Подтвердите, что вы не робот')).toBeDefined();

    http.use({
      'POST /auth/verify-email/resend': () =>
        apiError(400, {
          code: 'captcha_failed',
          message: 'Проверка не пройдена',
          fields: { captchaToken: 'Проверка не пройдена' },
        }),
    });
    await captcha.check(CAPTCHA_TOKEN);
    await resend();
    await waitFor(() => expect(http.countOf('POST /auth/verify-email/resend')).toBe(1));

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

    await resend();
    expect(http.countOf('POST /auth/verify-email/resend')).toBe(1);
  });

  it('подтверждение по ссылке капчи не спрашивает — даже когда она не отвечает', async () => {
    // Код из письма и есть доказательство: требовать сверх него ещё и проверку значило бы запереть
    // человека на странице, куда он пришёл по ссылке, из-за сбоя стороннего сервиса.
    const http = renderPage(`?token=${TOKEN}`, ok, captchaConfigUnreachable);

    await act(async () => fireEvent.click(await confirmButton()));

    await waitFor(() => expect(confirmations(http)).toBe(1));
    expect(http.lastCall('POST /auth/verify-email')?.body as VerifyEmailInput).toEqual({
      token: TOKEN,
    });
  });
});

/**
 * Изоляция стороннего скрипта (§12). `captcha.js` исполняется в origin портала и, однажды
 * загруженный, остаётся в документе и после ухода со страницы: `destroy()` снимает виджет, но не
 * скрипт. Поэтому документ со скриптом и документ, в котором набирают логин и пароль, не должны
 * пересекаться никогда — а это свойство переходов, и проверяется оно здесь.
 */
describe('изоляция стороннего скрипта на подтверждении адреса', () => {
  it('«Вернуться ко входу» уводит полной навигацией, а не SPA-переходом', async () => {
    renderPage('');
    await captcha.appear();

    const link = screen.getByRole('link', { name: 'Вернуться ко входу' });
    expect(link.getAttribute('href')).toBe('/login');
    // `Link` react-router погасил бы событие и оставил документ жить — вместе со скриптом.
    expect(clickLeavesDocument(link)).toBe(true);
  });

  it('«Ко входу» с экрана подтверждённого адреса уводит вкладку целиком', async () => {
    const http = renderPage(`?token=${TOKEN}`);
    await act(async () => fireEvent.click(await confirmButton()));
    await waitFor(() => expect(confirmations(http)).toBe(1));

    fireEvent.click(await screen.findByRole('button', { name: 'Ко входу' }));
    expect(navigation.to).toEqual(['/login']);
  });

  it('вошедшая вкладка страницу не рисует и уходит в портал', async () => {
    // Сегодня этот маршрут вошедшего не отсекает вовсе, и сторонний код втягивался бы прямо в
    // авторизованный документ.
    const http = mockHttp({
      'GET /auth/captcha': () => captchaConfig(CLIENT_KEY),
      'POST /auth/verify-email': ok,
      'POST /auth/verify-email/resend': () => json({ ok: true, message: RESENT }),
    });
    renderWithUser(<VerifyEmailPage />, { user: authUser(), route: '/verify-email' });

    await waitFor(() => expect(navigation.to).toEqual(['/']));
    expect(screen.queryByRole('button', { name: 'Прислать письмо заново' })).toBeNull();
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
      'POST /auth/verify-email': ok,
      'POST /auth/verify-email/resend': () => json({ ok: true, message: RESENT }),
    });
    renderWithSession(<VerifyEmailPage />, { route: '/verify-email' });

    expect(await screen.findByText(/Портал выясняет, нужна ли проверка/)).toBeDefined();
    expect(resendButton().disabled).toBe(true);
    expect(http.countOf('GET /auth/captcha')).toBe(0);
    expect(captchaScriptTags()).toHaveLength(0);
    // И уводить некуда: по неизвестному статусу выбросили бы со страницы того, кто пришёл по
    // ссылке из письма и в портал ещё не вошёл.
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
      'POST /auth/verify-email': ok,
      'POST /auth/verify-email/resend': () => json({ ok: true, message: RESENT }),
    });
    renderWithSession(<VerifyEmailPage />, { route: '/verify-email' });

    expect(http.countOf('GET /auth/captcha')).toBe(0);
    await bootstrap.release();

    await captcha.appear();
    expect(http.countOf('GET /auth/captcha')).toBe(1);
    expect(navigation.to).toEqual([]);
  });
});
