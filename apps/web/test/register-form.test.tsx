import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { RegisterInput } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteHandler } from './http';
import { renderWithSession, renderWithUser } from './render';
import { selectOption } from './antd';
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
import { RegisterPage } from '../src/pages/RegisterPage';

/**
 * Форма регистрации (ADR 0034, капча по ADR 0130). Проверяется то, ради чего её переделывали: ФИО
 * уходит тремя полями, отчество можно не заполнять, а без пройденной проверки заявка не
 * отправляется. Сама проверка теперь у Яндекса — здесь подделана его служба (`test/captcha.ts`),
 * а разгадывание не имитируется вовсе: портал в токен не пишет и его не читает.
 *
 * Отдельный разбор — четыре состояния капчи (план `docs/smart-captcha-plan.md` §5). Форма ведёт
 * себя по-разному не потому, что «удобно», а потому, что в трёх из них портал не знает, требуется
 * ли токен, и угадывать нельзя.
 *
 * Обе ручки подменяются сетью, а не модулем `api/auth`: «заявка не ушла» — утверждение о том, что
 * запроса не было, и проверять его подменённым модулем значит держаться за нынешнюю раскладку
 * файлов портала вместо HTTP-контракта регистрации.
 */

/** Клиентский ключ виджета: портал берёт его у собственной ручки, а не из сборки. */
const CLIENT_KEY = 'ysc1_test_key';
/** Одноразовый токен, который отдаёт виджет прошедшему проверку. */
const TOKEN = 'smart-captcha-token';

/** Поддельная служба Яндекса и журнал полных переходов — свои на каждый тест (см. ./captcha). */
let captcha: SmartCaptchaService;
let navigation: NavigationLog;

beforeEach(() => {
  captcha = smartCaptchaService();
  navigation = trackNavigation();
});

/**
 * Страница вместе с двумя своими ручками. Пользователя в дереве нет намеренно: регистрацию
 * открывает тот, у кого учётной записи ещё не существует.
 *
 * Ответ ручки конфига задаётся сценарием: включённая капча, выключенная, чужой формат ответа и
 * молчание сети — четыре разных формы, а не четыре настроения одной.
 */
function renderPage(captchaRoute: RouteHandler = () => captchaConfig(CLIENT_KEY)): HttpMock {
  const http = mockHttp({
    'GET /auth/captcha': captchaRoute,
    'POST /auth/register': () => json({ ok: true, message: 'ок' }),
  });
  renderWithUser(<RegisterPage />, { user: null });
  return http;
}

/**
 * Чекбокс на экране — значит ключ приехал, скрипт «загрузился» и виджет нарисован. Отправлять до
 * этого бессмысленно: кнопка ещё заблокирована, и тест ловил бы гонку, а не поведение.
 */
const captchaShown = () => captcha.appear();

/** Кнопка отправки: её состояние — половина всего, что проверяется про капчу. */
const submitButton = () =>
  screen.getByRole('button', { name: 'Зарегистрироваться' }) as HTMLButtonElement;

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

/** Всё обязательное, кроме проверки и пожелания по роли: их сценарии задают сами. */
function fillFieldsWithoutCaptcha() {
  fill('Фамилия', 'Иванов');
  fill('Имя', 'Иван');
  fill('Email', 'ivanov@example.com');
  // Телефон обязателен (ADR 0066): без него заявку рассматривать нечем — портал не пишет писем.
  fill('Телефон', '9261234567');
  fill('Пароль', 'Sn3-verkhoyansk-77');
}

/** Обязательный минимум, кроме пожелания по роли: его тесты задают сами. */
async function fillCommonFields() {
  fillFieldsWithoutCaptcha();
  // Проверку проходит виджет, а не форма: человек ставит галочку, и в поле оказывается токен.
  await captcha.check(TOKEN);
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

  it('отправляет части ФИО и токен проверки, отчество можно не заполнять', async () => {
    const http = renderPage();
    await captchaShown();

    await fillCommonFields();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    await waitFor(() => expect(registrations(http)).toBe(1));
    expect(sent(http)).toMatchObject({
      email: 'ivanov@example.com',
      lastName: 'Иванов',
      firstName: 'Иван',
      middleName: '',
      requestedRole: 'dispatcher',
      // Уезжает ровно то, что отдал виджет: решение «пройдена ли проверка» принимает сервер, и
      // портал этот токен не разбирает и не подписывает.
      captchaToken: TOKEN,
    });
  });

  it('без пройденной проверки заявка не уходит', async () => {
    const http = renderPage();
    await captchaShown();

    fill('Фамилия', 'Иванов');
    fill('Имя', 'Иван');
    fill('Email', 'ivanov@example.com');
    fill('Пароль', 'Sn3-verkhoyansk-77');
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
    expect(await screen.findByText('Подтвердите, что вы не робот')).toBeDefined();
  });

  it('после отправки показывает экран ожидания, а не исчезающее сообщение', async () => {
    renderPage();
    await captchaShown();

    await fillCommonFields();
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
    await captcha.check(TOKEN);
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

    await fillCommonFields();
    fill('Телефон', '8 926 123-45-67');
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    await waitFor(() => expect(registrations(http)).toBe(1));
    expect(sent(http)).toMatchObject({ phone: '9261234567' });
  });

  it('вместо номера слово — в поле не попадает вовсе, и заявка не уходит', async () => {
    const http = renderPage();
    await captchaShown();

    await fillCommonFields();
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

    await fillCommonFields();
    fill('Телефон', '926 123');
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
    expect(await screen.findByText('Телефон в формате +7 (900) 000 00 00')).toBeDefined();
  });

  it('слабый пароль не отправляется: длины мало, если это фамилия или последовательность', async () => {
    const http = renderPage();
    await captchaShown();

    await fillCommonFields();
    await selectRoleRequest('Диспетчер');
    fill('Пароль', '1234567890');
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
  });
});

/**
 * Предупреждение о чужом почтовом домене (ADR 0090). Проверяется прежде всего то, чем оно не
 * является: заявку с внешнего адреса форма отправляет как любую другую. Стань оно запретом —
 * закрылась бы регистрация тем, у кого рабочей почты нет, а доступ нужен по делу.
 */
const WARNING = 'Указан адрес внешней почтовой службы';
const warned = () => screen.queryByText(WARNING) !== null;

describe('предупреждение о внешней почте', () => {
  it('появляется на дописанном адресе чужого домена и не мешает отправить заявку', async () => {
    const http = renderPage();
    await captchaShown();

    await fillCommonFields();
    fill('Email', 'ivanov@mail.ru');
    await selectRoleRequest('Диспетчер');
    expect(await screen.findByText(WARNING)).toBeDefined();

    await act(async () => submit());
    await waitFor(() => expect(registrations(http)).toBe(1));
    expect(sent(http)).toMatchObject({ email: 'ivanov@mail.ru' });
  });

  it('на рабочем адресе и его поддомене молчит', async () => {
    renderPage();
    await captchaShown();

    fill('Email', 'ivanov@su10.ru');
    await selectRoleRequest('Диспетчер');
    await waitFor(() => expect(warned()).toBe(false));

    fill('Email', 'ivanov@auto.su10.ru');
    await waitFor(() => expect(warned()).toBe(false));
  });

  it('недописанный адрес предупреждения не вызывает', async () => {
    renderPage();
    await captchaShown();

    await selectRoleRequest('Диспетчер');
    fill('Email', 'ива');
    await waitFor(() => expect(warned()).toBe(false));
  });

  it('оператору его не показывают — рабочая почта у него по определению не наша', async () => {
    // Оператор работает от лица сторонней компании (ADR 0010): требовать от него наш домен
    // значило бы требовать невозможного.
    renderPage();
    await captchaShown();

    fill('Email', 'operator@mail.ru');
    expect(await screen.findByText(WARNING)).toBeDefined();

    await selectRoleRequest('Оператор по вывозу мусора');
    await waitFor(() => expect(warned()).toBe(false));
  });
});

describe('пожелание по роли', () => {
  it('без выбора роли заявка не уходит', async () => {
    const http = renderPage();
    await captchaShown();

    await fillCommonFields();
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
    expect(await screen.findByText('Выберите роль')).toBeDefined();
  });

  it('«Сотрудник объекта» открывает поле объекта и требует его заполнить', async () => {
    const http = renderPage();
    await captchaShown();

    await fillCommonFields();
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

    await fillCommonFields();
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

  it('«Другое» требует комментария: без него заявку не рассмотреть', async () => {
    const http = renderPage();
    await captchaShown();

    await fillCommonFields();
    await selectRoleRequest('Другое');
    expect(await screen.findByLabelText('Комментарий')).toBeDefined();
    expect(screen.queryByLabelText('Объект')).toBeNull();
    expect(screen.queryByLabelText('Компания')).toBeNull();

    // Роли «Другое» в портале не соответствует никакая: пустая заявка оставляла бы
    // администратора с одним ФИО и адресом.
    await act(async () => submit());
    expect(registrations(http)).toBe(0);
    expect(await screen.findByText('Напишите, кем вы работаете')).toBeDefined();

    fill('Комментарий', 'Сметчик, нужен просмотр заявок');
    await act(async () => submit());
    await waitFor(() => expect(registrations(http)).toBe(1));
    expect(sent(http)).toMatchObject({
      requestedRole: 'other',
      requestedComment: 'Сметчик, нужен просмотр заявок',
      requestedObject: '',
      requestedCompany: '',
    });
  });

  it('комментарий спрашивают только у «Другого»', async () => {
    const http = renderPage();
    await captchaShown();

    await fillCommonFields();
    await selectRoleRequest('Диспетчер');
    expect(screen.queryByLabelText('Комментарий')).toBeNull();
    await act(async () => submit());

    await waitFor(() => expect(registrations(http)).toBe(1));
    expect(sent(http)).toMatchObject({ requestedRole: 'dispatcher', requestedComment: '' });
  });
});

/**
 * Четыре состояния капчи (план `docs/smart-captcha-plan.md` §5). Разница между ними — не оттенки
 * одного и того же: при «выключено» заявка уходит с пустым токеном, а при «портал не смог узнать»
 * не уходит вовсе. Свести их к двум («ключ есть» / «ключа нет») значит однажды отправить форму без
 * проверки, которую сервер требует, — и не заметить этого.
 */
describe('капча выключена', () => {
  it('поля нет вовсе, заявка уходит с пустым токеном и без стороннего скрипта', async () => {
    // `clientKey: null` — единственный признак выключенной капчи, общий у формы и у серверной
    // проверки: рассинхрон «портал рисует виджет, сервер не проверяет» так стать не может.
    const http = renderPage(() => captchaConfig(null));
    await waitFor(() => expect(http.countOf('GET /auth/captcha')).toBe(1));
    await waitFor(() => expect(submitButton().disabled).toBe(false));

    // Прячется весь `Form.Item`, а не одно поле: подпись «Проверка» над пустым местом объясняла бы
    // человеку то, чего на форме нет.
    expect(screen.queryByLabelText('Проверка')).toBeNull();
    expect(screen.queryByText('Проверка')).toBeNull();

    fillFieldsWithoutCaptcha();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    await waitFor(() => expect(registrations(http)).toBe(1));
    expect(sent(http)).toMatchObject({ email: 'ivanov@example.com', captchaToken: '' });
    // Сторонний код в документ не попадает вовсе: грузить его без нужды — тот самый риск, ради
    // которого §12 выносился заказчику.
    expect(captchaScriptTags()).toHaveLength(0);
  });
});

describe('портал не смог узнать, нужна ли проверка', () => {
  it('ответ без поля clientKey — это ошибка, а не «капча выключена»', async () => {
    // Ключевой случай протокола (§5): старый API во время выката, чужой прокси, обрезанный JSON.
    // Сочти портал такой ответ выключенной капчей — он молча отправлял бы заявки без токена, и
    // незакрытая регистрация выглядела бы исправной.
    const http = renderPage(captchaConfigWithoutKey);

    expect(await screen.findByText('Проверка не загрузилась.')).toBeDefined();
    expect(screen.getByRole('button', { name: /Повторить/ })).toBeDefined();
    expect(submitButton().disabled).toBe(true);

    fillFieldsWithoutCaptcha();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
    expect(captchaScriptTags()).toHaveLength(0);
  });

  it('молчание сети читается так же: отправка заблокирована', async () => {
    const http = renderPage(captchaConfigUnreachable);

    expect(await screen.findByText('Проверка не загрузилась.')).toBeDefined();
    expect(submitButton().disabled).toBe(true);

    fillFieldsWithoutCaptcha();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
  });

  it('«Повторить» поднимает из ошибки всю форму, а не одно поле', async () => {
    /*
     * Два свойства одной кнопки, и второе важнее.
     *
     * Первое: кеш ключа на вкладку — один промис на три формы, и «Повторить» обязана сбросить его.
     * Не сбрось — кнопка ходила бы в тот же неудачный разбор, и вкладка сидела бы в ошибке до
     * перезагрузки страницы.
     *
     * Второе: состояние капчи спрашивают ДВА места одной страницы — сама форма (ставить ли правило
     * и пускать ли отправку) и поле капчи (рисовать ли виджет). Будь оно у каждого своё, кнопка
     * «Повторить», живущая в поле, поднимала бы из `error` только поле: виджет появлялся бы, а
     * отправка оставалась заблокированной навсегда — форма выглядела бы исправной и не работала.
     * Поэтому проверяется не «виджет вернулся», а «заявка уходит».
     */
    let answers = 0;
    const http = renderPage(() => {
      answers += 1;
      return answers === 1 ? captchaConfigWithoutKey() : captchaConfig(CLIENT_KEY);
    });
    await screen.findByText('Проверка не загрузилась.');
    expect(submitButton().disabled).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Повторить/ }));
    });
    await captchaShown();

    // Второй запрос — не второе чтение первого ответа: ключ приехал заново, и виджет нарисован им.
    expect(http.countOf('GET /auth/captcha')).toBe(2);
    expect(captcha.sitekeys).toEqual([CLIENT_KEY]);
    // Форма вышла из `error` вместе с полем: кнопка снова доступна.
    await waitFor(() => expect(submitButton().disabled).toBe(false));

    await fillCommonFields();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());

    await waitFor(() => expect(registrations(http)).toBe(1));
    expect(sent(http)).toMatchObject({ captchaToken: TOKEN });
  });
});

describe('пока ответа о капче нет', () => {
  it('отправка заблокирована, и портал объясняет, чего ждёт', async () => {
    // Ответ ручки придержим: это состояние живёт доли секунды, но именно в нём форма отправилась бы
    // без токена, будь кнопка доступна.
    const config = heldResponse(() => captchaConfig(CLIENT_KEY));
    const http = renderPage(config.handler);

    expect(await screen.findByText(/Портал выясняет, нужна ли проверка/)).toBeDefined();
    expect(submitButton().disabled).toBe(true);
    expect(captchaScriptTags()).toHaveLength(0);

    fillFieldsWithoutCaptcha();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());
    expect(registrations(http)).toBe(0);

    await config.release();
    await captchaShown();
    expect(submitButton().disabled).toBe(false);
  });
});

describe('капча включена', () => {
  it('виджет рисуется ключом от сервера, а не вшитым в сборку', async () => {
    renderPage();
    await captchaShown();

    expect(captcha.sitekeys).toEqual([CLIENT_KEY]);
    expect(captchaScriptTags()).toHaveLength(1);
    expect(screen.getByTestId('smartcaptcha')).toBeDefined();
  });

  it('причина отказа доходит до человека, виджет сброшен, потраченный токен не уходит второй раз', async () => {
    /*
     * Отказ сервер возвращает на поле `captchaToken`, а показывается он сообщением — и это не
     * вкусовщина. Подпись у поля здесь не живёт в принципе: следом за отказом растёт
     * `captchaNonce`, поле сбрасывает виджет и отдаёт форме пустой токен, antd на этом `onChange`
     * перевалидирует поле и заменяет серверный текст своим «Подтвердите, что вы не робот».
     * Человек видел бы правило формы вместо причины — «Проверка не пройдена», «Слишком много
     * попыток» — и не узнал бы её никогда. Сообщение сброс виджета переживает.
     *
     * Токен при этом одноразовый и живёт минуты: после обработанной попытки он потрачен. Не сбрось
     * его форма — второе нажатие отправило бы заведомо отклонённую проверку, и человек получил бы
     * отказ на ровном месте.
     */
    const REFUSAL = 'Проверка не пройдена — попробуйте ещё раз';
    const http = renderPage();
    http.use({
      'POST /auth/register': () =>
        apiError(400, {
          code: 'captcha_failed',
          message: 'Проверка не пройдена',
          fields: { captchaToken: REFUSAL },
        }),
    });
    await captchaShown();

    await fillCommonFields();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());
    await waitFor(() => expect(registrations(http)).toBe(1));

    // Именно серверная формулировка, а не общее «Ошибка запроса»: по ней человек понимает, что
    // делать дальше — пройти проверку заново, а не звонить в поддержку.
    expect(await screen.findByText(REFUSAL)).toBeDefined();
    await waitFor(() => expect(captcha.reset).toHaveBeenCalled());

    // Второе нажатие тем же токеном не уезжает: значение поля обнулено вместе с виджетом.
    await act(async () => submit());
    expect(registrations(http)).toBe(1);
    expect(await screen.findByText('Подтвердите, что вы не робот')).toBeDefined();
  });

  it('поломка виджета проверку пройденной не делает', async () => {
    // Документация SmartCaptcha требует этого прямо: обратное («скрипт сломался — пропустим»)
    // превратило бы капчу в такую, которую отключает любой клиент, а защиту регистрации — в
    // декорацию.
    const http = renderPage();
    await captchaShown();

    await fillCommonFields();
    await selectRoleRequest('Диспетчер');
    await captcha.emit('javascript-error');

    expect(await screen.findByText('Проверка сломалась.')).toBeDefined();
    await act(async () => submit());

    expect(registrations(http)).toBe(0);
    expect(await screen.findByText('Подтвердите, что вы не робот')).toBeDefined();
  });
});

/**
 * Изоляция стороннего скрипта (§12). `captcha.js` исполняется в origin портала и, однажды
 * загруженный, остаётся в документе и после ухода со страницы: `destroy()` снимает виджет, но не
 * скрипт. Поэтому документ со скриптом и документ, в котором набирают логин и пароль, не должны
 * пересекаться никогда — а это свойство переходов, и проверяется оно здесь.
 */
describe('изоляция стороннего скрипта', () => {
  it('«Войти» уводит полной навигацией, а не SPA-переходом', async () => {
    renderPage();
    await captchaShown();

    const link = screen.getByRole('link', { name: 'Войти' });
    expect(link.getAttribute('href')).toBe('/login');
    // `Link` react-router погасил бы событие и оставил документ жить — вместе со скриптом.
    expect(clickLeavesDocument(link)).toBe(true);
  });

  it('«Перейти ко входу» с экрана принятой заявки уводит вкладку целиком', async () => {
    const http = renderPage();
    await captchaShown();

    await fillCommonFields();
    await selectRoleRequest('Диспетчер');
    await act(async () => submit());
    await waitFor(() => expect(registrations(http)).toBe(1));

    fireEvent.click(await screen.findByRole('button', { name: 'Перейти ко входу' }));
    expect(navigation.to).toEqual(['/login']);
  });

  it('вошедшая вкладка форму не рисует и уходит в портал', async () => {
    // Сегодня этот маршрут вошедшего не отсекает вовсе, и сторонний код втягивался бы прямо в
    // авторизованный документ.
    const http = mockHttp({
      'GET /auth/captcha': () => captchaConfig(CLIENT_KEY),
      'POST /auth/register': () => json({ ok: true, message: 'ок' }),
    });
    renderWithUser(<RegisterPage />, { user: authUser() });

    await waitFor(() => expect(navigation.to).toEqual(['/']));
    expect(screen.queryByRole('button', { name: 'Зарегистрироваться' })).toBeNull();
    expect(http.countOf('GET /auth/captcha')).toBe(0);
    expect(captchaScriptTags()).toHaveLength(0);
  });

  it('пока статус сессии неизвестен, портал не ходит за ключом и не вставляет скрипт', async () => {
    /*
     * Гонка, ради которой заведено правило: `AuthProvider` узнаёт про вкладку асинхронно, а
     * публичный маршрут монтируется сразу. Поэтому bootstrap здесь ЗАДЕРЖИВАЕТСЯ управляемым
     * промисом, а не подставляется готовым состоянием: подставь его — и гонки в тесте не станет,
     * а вместе с ней и проверки. Без правила скрипт успевал бы загрузиться в документ, который
     * через мгновение окажется авторизованным, и правило «вошедшая вкладка виджет не грузит»
     * опоздало бы ровно так же, как опаздывала перезагрузка после входа.
     */
    const user = authUser();
    const bootstrap = heldResponse(() => json(loginResponse(user)));
    const http = mockHttp({
      'POST /auth/refresh': bootstrap.handler,
      'GET /auth/me': () => json(user),
      'GET /auth/captcha': () => captchaConfig(CLIENT_KEY),
      'POST /auth/register': () => json({ ok: true, message: 'ок' }),
    });
    renderWithSession(<RegisterPage />, { route: '/register' });

    expect(await screen.findByText(/Портал выясняет, нужна ли проверка/)).toBeDefined();
    expect(submitButton().disabled).toBe(true);
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
      'POST /auth/register': () => json({ ok: true, message: 'ок' }),
    });
    renderWithSession(<RegisterPage />, { route: '/register' });

    expect(http.countOf('GET /auth/captcha')).toBe(0);
    await bootstrap.release();

    await captchaShown();
    expect(http.countOf('GET /auth/captcha')).toBe(1);
    expect(navigation.to).toEqual([]);
  });
});
