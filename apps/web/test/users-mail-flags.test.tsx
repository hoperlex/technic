import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { MailOutcome, RejectUserBody, UserDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { selectOption } from './antd';
import { UsersTab } from '../src/pages/admin/UsersTab';

/**
 * Письма по учётным записям: отказ по заявке и «доступ выдан».
 *
 * Портал не рассылает писем сам по себе — каждое уходит по отметке в том же окне, где принимается
 * решение, и проверяется здесь именно это: где отметка есть, где её нет вовсе и что от неё
 * попадает в тело запроса. Ошибка тут стоит дорого в обе стороны: лишнее письмо уходит по адресу,
 * который никто не подтверждал, а потерянное оставляет человека ждать доступа, о котором ему не
 * сказали.
 *
 * Второй предмет проверки — половинчатое рассмотрение заявки: роль без активации сервер отвергает
 * 400, и форма не должна доводить до впустую нажатой кнопки.
 */

function user(over: Partial<UserDto> = {}): UserDto {
  return {
    id: 'u-1',
    email: 'applicant@example.test',
    lastName: 'Заявкин',
    firstName: 'Захар',
    middleName: 'Петрович',
    fullName: 'Заявкин Захар Петрович',
    phone: '',
    requestedRole: null,
    requestedObject: '',
    requestedCompany: '',
    requestedComment: '',
    role: null,
    isActive: false,
    mustChangePassword: false,
    emailVerifiedAt: null,
    constructionObjects: [],
    departments: [],
    addons: [],
    /*
     * Права и наборы карточки (ADR 0106, этап 2б) — то, что посчитал сервер. В фикстуре пусто:
     * сценарии этих тестов про почту, журнал и адрес, а не про доступ; срез витрины, которому
     * права нужны, задаёт их сам.
     */
    grantCodes: [],
    permissions: [],
    counterpartyId: null,
    counterpartyName: null,
    counterpartyType: null,
    deletedAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

/** Нерассмотренная заявка: роли нет, учётка неактивна. */
const PENDING = user();
/** Действующий сотрудник: заявку по нему рассмотрели однажды и давно. */
const EMPLOYEE = user({
  id: 'u-2',
  email: 'manager@example.test',
  lastName: 'Менеджеров',
  firstName: 'Максим',
  fullName: 'Менеджеров Максим Петрович',
  role: 'manager',
  isActive: true,
});
/** Деактивированный сотрудник: роль у него уже есть — включение обратно письма не порождает. */
const DEACTIVATED = user({ ...EMPLOYEE, id: 'u-3', email: 'off@example.test', isActive: false });

/**
 * Дождаться каталога полномочий: одобрить заявку раньше, чем он дочитан, форма не даёт (план
 * «пожелание при регистрации», §3.6) — иначе учётка получила бы роль без предложенных наборов,
 * причём молча. Без ожидания сценарии ниже проверяли бы этот барьер, а не судьбу письма.
 */
const catalogRead = () => screen.findByText(/Наборов, совместимых с этой ролью, нет/);

const REJECT = 'POST /users/:id/reject';
const PATCH = 'PATCH /users/:id';

function renderTab(users: UserDto[] = [PENDING], over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /users': () => json(list(users)),
    'GET /users/pending-count': () => json({ count: 1 }),
    // Справочники области: сценариям не нужны, но форма учётки спрашивает их при открытии.
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    /*
     * Каталог полномочий (план «полномочия назначаются в окне учётки», §6): форма спрашивает его
     * при каждом открытии с выбранной ролью. Пустой — и это не отговорка: сценарии здесь про почту,
     * а неполный каталог запер бы и поле роли, то есть подменил бы условие задачи. `total` при этом
     * равен нулю, значит список полон, и высказывание формы законно.
     */
    'GET /grants': () => json(emptyList()),
    [REJECT]: () => json({ ok: true, notified: 'queued' }),
    [PATCH]: () => json({ user: EMPLOYEE, notified: 'queued' }),
    ...over,
  });
  renderWithUser(<UsersTab />, { user: authUser({ role: 'admin' }) });
  return http;
}

/**
 * Пункт меню строки. Действия живут в выпадающем меню, и добраться до отказа или правки можно
 * только через него — так же, как это делает администратор.
 */
async function rowAction(email: string, label: string): Promise<void> {
  const row = await waitFor(() => {
    const found = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(email),
    );
    if (!found) throw new Error(`строки «${email}» в списке нет`);
    return found;
  });
  fireEvent.click(row.querySelector('button')!);
  fireEvent.click(await screen.findByText(label));
}

/** Кнопка подвала окна по подписи: заголовки и подписи полей ею не задеваются. */
function clickButton(label: string): void {
  const button = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label,
  );
  expect(button, `кнопка «${label}»`).toBeTruthy();
  fireEvent.click(button!);
}

function typeInto(label: string, text: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
}

/**
 * Чекбокс по его подписи. `getByLabelText` тут не годится: подпись у чекбокса antd — соседний
 * `span` внутри общего `label`, и у формы их несколько (надстройки роли, фильтр архива).
 */
function checkbox(text: string): HTMLInputElement | null {
  const wrapper = [...document.querySelectorAll('label.ant-checkbox-wrapper')].find((el) =>
    el.textContent?.includes(text),
  );
  return wrapper?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
}

/** Переключатель «Активен»: в открытой форме учётки он один. */
function activeSwitch(): HTMLElement {
  const found = document.querySelector<HTMLElement>('.ant-modal button.ant-switch');
  expect(found, 'переключатель «Активен»').toBeTruthy();
  return found!;
}

const REJECT_MAIL = 'Сообщить заявителю по почте';
const ACCESS_MAIL = 'Сообщить пользователю по почте';
const ANSWER = 'Ответ заявителю';

/** Поле на экране или его нет — у полей, которые появляются по отметке, проверяется именно это. */
const shown = (label: string) => screen.queryByLabelText(label) !== null;

describe('окно отказа по заявке на регистрацию', () => {
  it('снятая отметка убирает поле ответа, и текст в запрос не уходит', async () => {
    // Регистрации ботов и явный мусор отвечать незачем: со снятой отметкой письма нет, а
    // набранный и передуманный ответ не должен уехать в аудит как отправленный.
    const http = renderTab();
    await rowAction(PENDING.email, 'Отклонить заявку');
    expect(await screen.findByLabelText('Причина отказа')).toBeDefined();
    expect(shown(ANSWER)).toBe(true);

    typeInto(ANSWER, 'Заявка отклонена, обратитесь к руководителю');
    fireEvent.click(checkbox(REJECT_MAIL)!);
    await waitFor(() => expect(shown(ANSWER)).toBe(false));

    typeInto('Причина отказа', 'Дубль: человек заведён под другим адресом');
    clickButton('Отклонить');

    await waitFor(() => expect(http.countOf(REJECT)).toBe(1));
    expect(http.lastCall(REJECT)?.body as RejectUserBody).toEqual({
      reason: 'Дубль: человек заведён под другим адресом',
      notifyApplicant: false,
    });
  });

  it('с включённой отметкой пустой ответ не даёт отправить форму', async () => {
    // Иначе отказ ушёл бы с письмом без текста: сервер отвечает на это 400, а человек получал бы
    // пустое «ваша заявка отклонена».
    const http = renderTab();
    await rowAction(PENDING.email, 'Отклонить заявку');
    await screen.findByLabelText('Причина отказа');

    typeInto('Причина отказа', 'Дубль заявки');
    clickButton('Отклонить');

    expect(await screen.findByText('Напишите ответ или снимите отметку об отправке')).toBeDefined();
    expect(http.countOf(REJECT)).toBe(0);
  });

  it('причина и ответ уходят разными полями', async () => {
    // Служебная формулировка наружу не годится, а обтекаемая — в аудит: два поля именно поэтому,
    // и слипнуться в одно они не должны.
    const http = renderTab();
    await rowAction(PENDING.email, 'Отклонить заявку');
    await screen.findByLabelText('Причина отказа');

    typeInto('Причина отказа', 'Дубль: человек заведён под другим адресом');
    typeInto(ANSWER, 'Учётная запись у вас уже есть, войдите под рабочим адресом');
    clickButton('Отклонить');

    await waitFor(() => expect(http.countOf(REJECT)).toBe(1));
    expect(http.lastCall(REJECT)?.body as RejectUserBody).toEqual({
      reason: 'Дубль: человек заведён под другим адресом',
      notifyApplicant: true,
      applicantMessage: 'Учётная запись у вас уже есть, войдите под рабочим адресом',
    });
  });

  const OUTCOMES: [MailOutcome, string][] = [
    ['queued', 'Заявка отклонена, заявителю отправлено письмо'],
    ['not_requested', 'Заявка отклонена'],
    ['mail_disabled', 'Заявка отклонена. Письмо не отправлено — почта выключена'],
  ];

  for (const [notified, text] of OUTCOMES) {
    it(`исход «${notified}» назван в сообщении об успехе`, async () => {
      // Молча проглотить неотправку нельзя: администратор уходит уверенным, что человека
      // предупредили, — а выключенная почта означает ровно обратное.
      renderTab([PENDING], { [REJECT]: () => json({ ok: true, notified }) });
      await rowAction(PENDING.email, 'Отклонить заявку');
      await screen.findByLabelText('Причина отказа');

      typeInto('Причина отказа', 'Дубль заявки');
      typeInto(ANSWER, 'Учётная запись у вас уже есть');
      clickButton('Отклонить');

      expect(await screen.findByText(text)).toBeDefined();
    });
  }
});

describe('отметка о письме в форме учётной записи', () => {
  it('у новой учётки следует за «Активен»', async () => {
    // Неактивная учётка письма не получает намеренно: звать человека в портал, который его не
    // пустит, хуже молчания.
    renderTab();
    await screen.findByText(PENDING.email);
    clickButton('Добавить');

    await waitFor(() => expect(checkbox(ACCESS_MAIL)).toBeTruthy());
    expect(checkbox(ACCESS_MAIL)!.checked).toBe(true);

    fireEvent.click(activeSwitch());
    await waitFor(() => expect(checkbox(ACCESS_MAIL)).toBeNull());
  });

  it('у обычной правки действующей учётки её нет', async () => {
    // Смена роли или ФИО — не повод писать человеку: доступ у него и так есть.
    renderTab([EMPLOYEE]);
    await rowAction(EMPLOYEE.email, 'Редактировать');

    await screen.findByLabelText('Фамилия');
    expect(checkbox(ACCESS_MAIL)).toBeNull();
  });

  it('повторная активация сотрудника письма не предлагает', async () => {
    // У такой учётки роль уже есть, заявку по ней рассмотрели однажды, и «ваша заявка одобрена»
    // действующему сотруднику — ложь.
    renderTab([DEACTIVATED]);
    await rowAction(DEACTIVATED.email, 'Редактировать');
    await screen.findByLabelText('Фамилия');

    fireEvent.click(activeSwitch());
    await waitFor(() => expect(activeSwitch().getAttribute('aria-checked')).toBe('true'));
    expect(checkbox(ACCESS_MAIL)).toBeNull();
  });

  it('при рассмотрении заявки появляется вместе с ролью и активацией', async () => {
    // Условие то же самое, по которому сервер объявляет одобрение: разойдись они — портал
    // спрашивал бы про письмо там, где его не будет, или молчал бы там, где оно уйдёт.
    const http = renderTab();
    await rowAction(PENDING.email, 'Рассмотреть заявку');
    await screen.findByLabelText('Фамилия');
    expect(checkbox(ACCESS_MAIL)).toBeNull();

    fireEvent.click(activeSwitch());
    await waitFor(() => expect(activeSwitch().getAttribute('aria-checked')).toBe('true'));
    // Роли ещё нет — заявка не рассмотрена, и письму не о чем сообщать.
    expect(checkbox(ACCESS_MAIL)).toBeNull();

    await selectOption('Роль', 'Диспетчер');
    await waitFor(() => expect(checkbox(ACCESS_MAIL)).toBeTruthy());
    await catalogRead();

    clickButton('Сохранить');
    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    const body = http.lastCall(PATCH)?.body as Record<string, unknown>;
    expect(body.role).toBe('dispatcher');
    expect(body.isActive).toBe(true);
    // Намерение объявляется, а не выводится сервером из тела: без него второй администратор,
    // открывший ту же заявку, переписал бы чужое решение вместо конфликта.
    expect(body.approveRegistration).toBe(true);
    expect(body.notifyUser).toBe(true);
  });

  it('правка ФИО заявки идёт без намерения и без письма', async () => {
    // Исправить опечатку в заявке можно, не рассматривая её: она остаётся в очереди.
    const http = renderTab();
    await rowAction(PENDING.email, 'Рассмотреть заявку');
    await screen.findByLabelText('Фамилия');

    typeInto('Фамилия', 'Заявкина');
    clickButton('Сохранить');

    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    const body = http.lastCall(PATCH)?.body as Record<string, unknown>;
    expect(body.lastName).toBe('Заявкина');
    expect(body).not.toHaveProperty('approveRegistration');
    expect(body).not.toHaveProperty('notifyUser');
  });

  it('половинчатое рассмотрение заявки форма не отправляет', async () => {
    // Роль без активации сервер отвергает 400: запись перестала бы быть заявкой, но доступа не
    // давала бы, и следующая правка активировала бы её мимо журнала одобрений.
    const http = renderTab();
    await rowAction(PENDING.email, 'Рассмотреть заявку');
    await screen.findByLabelText('Фамилия');

    await selectOption('Роль', 'Диспетчер');
    clickButton('Сохранить');

    expect(
      await screen.findByText(
        'Заявку рассматривают целиком: назначьте роль и включите „Активен“ — или оставьте заявку в очереди',
      ),
    ).toBeDefined();
    expect(http.countOf(PATCH)).toBe(0);
  });

  it('сообщение об успехе называет судьбу письма', async () => {
    // Та же новость, что и у отказа, и тем же правилом: «Сохранено» без слова о письме оставляет
    // администратора уверенным, что человека позвали в портал.
    renderTab([PENDING], {
      [PATCH]: () => json({ user: EMPLOYEE, notified: 'mail_disabled' }),
    });
    await rowAction(PENDING.email, 'Рассмотреть заявку');
    await screen.findByLabelText('Фамилия');

    fireEvent.click(activeSwitch());
    await selectOption('Роль', 'Диспетчер');
    await waitFor(() => expect(checkbox(ACCESS_MAIL)).toBeTruthy());
    await catalogRead();
    clickButton('Сохранить');

    expect(
      await screen.findByText('Сохранено. Письмо не отправлено — почта выключена'),
    ).toBeDefined();
  });

  it('конфликт по уже рассмотренной заявке объясняется своими словами', async () => {
    // 409 приходит на одно: решение принял другой администратор. Серверный текст конфликта
    // человеку ничего не говорит, а повторять своё решение не по чему — сначала нужно увидеть
    // чужое, поэтому список перезапрашивается.
    const http = renderTab([PENDING], {
      [PATCH]: () => ({
        status: 409,
        body: { code: 'err.conflict', message: 'Заявка уже рассмотрена' },
      }),
    });
    await rowAction(PENDING.email, 'Рассмотреть заявку');
    await screen.findByLabelText('Фамилия');

    fireEvent.click(activeSwitch());
    await selectOption('Роль', 'Диспетчер');
    await waitFor(() => expect(checkbox(ACCESS_MAIL)).toBeTruthy());
    await catalogRead();
    const before = http.countOf('GET /users');
    clickButton('Сохранить');

    expect(
      await screen.findByText('Заявку уже рассмотрел другой администратор — обновите список'),
    ).toBeDefined();
    await waitFor(() => expect(http.countOf('GET /users')).toBeGreaterThan(before));
  });
});
