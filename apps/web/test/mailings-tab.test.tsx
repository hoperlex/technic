import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  can,
  EMAIL_VERIFICATION_ENABLED,
  MAIL_TEST_KINDS,
  mailTestKindLabels,
  mailTestKindNeedsDate,
  mailTestKindNeedsDriver,
  mailTestKindNeedsSampleUser,
  type AuthUser,
  type MailTestBody,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { selectOption, typeDate } from './antd';
import type { MailDigestSampleUser, MailTestDriver, MailTestRecipient } from '../src/api/resources';
import { MailingsTab } from '../src/pages/admin/MailingsTab';

/**
 * Отладочная отправка письма (ADR 0075).
 *
 * Письмо уходит по-настоящему и содержит рабочие данные, поэтому проверяется ровно то, из-за чего
 * оно может уйти не тем и не про то: какие поля экран спрашивает у каждого вида письма, что из них
 * попадает в запрос и кому вообще доступна кнопка отправки.
 *
 * Состав полей сверяется с таблицами контрактов (`mailTestKindNeedsDate` и соседние), а не со
 * списком, переписанным в тест: эти же таблицы читает и сама вкладка, и сервер в
 * `mailTestSchema` — расхождение здесь означало бы либо поле, которого не спросили, либо отказ 400
 * на кнопке.
 */

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const DRIVER_PERSON_ID = '22222222-2222-2222-2222-222222222222';
const SAMPLE_USER_ID = '33333333-3333-3333-3333-333333333333';

const RECIPIENTS: MailTestRecipient[] = [
  { id: ADMIN_ID, fullName: 'Админов Антон', email: 'admin@example.test' },
];
const DRIVERS: MailTestDriver[] = [
  { personId: DRIVER_PERSON_ID, fullName: 'Водителев Виктор', email: 'driver@example.test' },
];
const SAMPLE_USERS: MailDigestSampleUser[] = [
  {
    id: SAMPLE_USER_ID,
    fullName: 'Штабов Сергей',
    email: 'shtab@example.test',
    role: 'shtab',
  },
];

/** Виды писем, которые предлагает вкладка: подтверждение адреса скрыто, пока оно выключено. */
const KINDS = MAIL_TEST_KINDS.filter((k) => EMAIL_VERIFICATION_ENABLED || k !== 'verify_email');

const SEND = 'POST /admin/mail/test';

/**
 * Вкладка целиком, вместе с блоком расписаний над ней: экран у них общий, и рендерить отладку в
 * отрыве значило бы проверять не тот экран, который открывает администратор. Расписаний в ответе
 * нет — они предмет своей проверки, а здесь важно лишь, что их запрос не уходит в настоящую сеть.
 */
function renderTab(user: AuthUser = authUser({ role: 'admin' })): HttpMock {
  const http = mockHttp({
    'GET /admin/mail/schedules': () => json([]),
    'GET /admin/mail/test-recipients': () => json(RECIPIENTS),
    'GET /admin/mail/drivers-with-routes': () => json(DRIVERS),
    'GET /admin/mail/digest-sample-users': () => json(SAMPLE_USERS),
    [SEND]: () => json({ ok: true, message: 'Письмо отправлено' }),
  });
  renderWithUser(<MailingsTab />, { user });
  return http;
}

/** Поле на экране или его нет: у необязательных полей проверяется именно это. */
const shown = (label: string) => screen.queryByLabelText(label) !== null;

const DATE_FIELD = 'Дата, за которую собрать письмо';
const DRIVER_FIELD = 'Водитель (образец)';
const SAMPLE_FIELD = 'Чьими глазами смотреть';
const WINDOW_FROM_FIELD = 'Первый день';
const WINDOW_DAYS_FIELD = 'На сколько дней';

/**
 * Окно данных по умолчанию: «сегодняшний день, на день». Отправляется всегда, когда у письма есть
 * период, — сервер разбирает его теми же полями, что и расписание, и письмо без окна собралось бы
 * не за те дни.
 */
const DEFAULT_WINDOW = { windowFromDays: 0, windowDays: 1 };

describe('состав полей следует из вида письма', () => {
  for (const kind of KINDS) {
    it(`«${mailTestKindLabels[kind]}» спрашивает то, из чего собирается`, async () => {
      // Лишнее поле здесь — вопрос, на который человеку нечего ответить (у писем про доступ нет
      // ни периода, ни образца: они относятся к событию). Недостающее — отказ сервера на кнопке:
      // те же таблицы проверяет `mailTestSchema`.
      renderTab();
      await screen.findByLabelText('Тип письма');
      await selectOption('Тип письма', mailTestKindLabels[kind]);

      await waitFor(() => expect(shown(DATE_FIELD)).toBe(mailTestKindNeedsDate[kind]));

      // Окно данных ходит парой с датой: она играет роль дня рассылки, а окно отсчитывается от
      // неё. У писем про доступ нет ни того, ни другого — периода у события не бывает.
      expect(shown(WINDOW_FROM_FIELD)).toBe(mailTestKindNeedsDate[kind]);
      expect(shown(WINDOW_DAYS_FIELD)).toBe(mailTestKindNeedsDate[kind]);

      // Водителя выбирают из тех, у кого на эту дату есть рейсы, поэтому поле появляется только
      // вместе с заданной датой: пустой список читался бы как «водителей нет вовсе».
      if (mailTestKindNeedsDate[kind]) {
        expect(shown(DRIVER_FIELD)).toBe(false);
        typeDate(DATE_FIELD, '10.08.2026');
      }

      await waitFor(() => expect(shown(DRIVER_FIELD)).toBe(mailTestKindNeedsDriver[kind]));
      expect(shown(SAMPLE_FIELD)).toBe(mailTestKindNeedsSampleUser[kind]);
    });
  }

  it('вид письма выбирается из реестра, а подтверждение адреса из него убрано', async () => {
    // Подтверждение выключено (EMAIL_VERIFICATION_ENABLED): портал такого письма не отправляет, и
    // проверять вёрстку письма, которого не бывает, незачем — кнопка отправила бы его в пустоту.
    renderTab();
    await screen.findByLabelText('Тип письма');
    await selectOption('Тип письма', mailTestKindLabels[KINDS[0]!]);

    expect(EMAIL_VERIFICATION_ENABLED).toBe(false);
    expect(KINDS).not.toContain('verify_email');
    expect(screen.queryByText(mailTestKindLabels.verify_email)).toBeNull();
  });
});

describe('отправка отладочного письма', () => {
  it('задание водителю уходит с датой, водителем-образцом и получателем', async () => {
    // Тело собирается из полей экрана целиком: потерянный образец означал бы письмо про другого
    // человека, а потерянная дата — про другой день, и оба случая читаются как ошибка сервера, а
    // не как промах формы.
    const http = renderTab();
    await screen.findByLabelText('Тип письма');

    // Задание водителю стоит в списке первым и выбрано изначально — отдельно его не выбираем.
    typeDate(DATE_FIELD, '10.08.2026');
    await selectOption(DRIVER_FIELD, /Водителев Виктор/);
    await selectOption('Получатель', /Админов Антон/);
    fireEvent.click(screen.getByRole('button', { name: 'Отправить тест' }));

    await waitFor(() => expect(http.countOf(SEND)).toBe(1));
    expect(http.lastCall(SEND)?.body as MailTestBody).toEqual({
      kind: 'driver_routes',
      toUserId: ADMIN_ID,
      // Дата уходит ключом, а не в том виде, в каком её показывает поле: разбирает её сервер.
      date: '2026-08-10',
      ...DEFAULT_WINDOW,
      driverPersonId: DRIVER_PERSON_ID,
    });
  });

  it('окно данных уходит тем, каким его настроили', async () => {
    // Отладкой проверяют то самое письмо, которое уйдёт по расписанию: спроси она только дату, на
    // экране оказалось бы письмо за один день там, где рассылка собирает неделю.
    const http = renderTab();
    await screen.findByLabelText('Тип письма');

    typeDate(DATE_FIELD, '10.08.2026');
    await selectOption(WINDOW_FROM_FIELD, 'Завтрашний день');
    const days = screen.getByLabelText(WINDOW_DAYS_FIELD);
    fireEvent.change(days, { target: { value: '7' } });
    fireEvent.blur(days);
    await selectOption('Получатель', /Админов Антон/);
    fireEvent.click(screen.getByRole('button', { name: 'Отправить тест' }));

    await waitFor(() => expect(http.countOf(SEND)).toBe(1));
    expect(http.lastCall(SEND)?.body as MailTestBody).toEqual({
      kind: 'driver_routes',
      toUserId: ADMIN_ID,
      date: '2026-08-10',
      windowFromDays: 1,
      windowDays: 7,
    });
  });

  it('сводка уходит с образцом-учёткой, и получатель у неё остаётся своим', async () => {
    // У сводки два разных человека в одном письме: чьей областью видимости её собрать и кому
    // отправить. Слить их в одно поле нельзя — письмо ушло бы образцу, то есть постороннему
    // человеку с чужими данными.
    const http = renderTab();
    await screen.findByLabelText('Тип письма');
    await selectOption('Тип письма', mailTestKindLabels.role_digest);

    typeDate(DATE_FIELD, '10.08.2026');
    await selectOption(SAMPLE_FIELD, /Штабов Сергей/);
    await selectOption('Получатель', /Админов Антон/);
    fireEvent.click(screen.getByRole('button', { name: 'Отправить тест' }));

    await waitFor(() => expect(http.countOf(SEND)).toBe(1));
    expect(http.lastCall(SEND)?.body as MailTestBody).toEqual({
      kind: 'role_digest',
      toUserId: ADMIN_ID,
      date: '2026-08-10',
      ...DEFAULT_WINDOW,
      sampleUserId: SAMPLE_USER_ID,
    });
  });

  it('смена даты сбрасывает выбранного водителя, а не уносит его в отправку', async () => {
    // На другой день у выбранного человека рейсов может не быть вовсе: уехавший в запрос чужой
    // образец вернулся бы отказом сервера, который читается как поломка, а не как несделанный
    // выбор.
    const http = renderTab();
    await screen.findByLabelText('Тип письма');

    typeDate(DATE_FIELD, '10.08.2026');
    await selectOption(DRIVER_FIELD, /Водителев Виктор/);
    typeDate(DATE_FIELD, '11.08.2026');

    await selectOption('Получатель', /Админов Антон/);
    fireEvent.click(screen.getByRole('button', { name: 'Отправить тест' }));

    await waitFor(() => expect(http.countOf(SEND)).toBe(1));
    expect(http.lastCall(SEND)?.body as MailTestBody).toEqual({
      kind: 'driver_routes',
      toUserId: ADMIN_ID,
      date: '2026-08-11',
      ...DEFAULT_WINDOW,
    });
  });

  it('без права на управление рассылками кнопка отправки недоступна', async () => {
    // Вкладку открывает `mailings.read`, а отправляет `mailings.manage`: права разные намеренно —
    // смотреть расписания может тот, кто за рассылку не отвечает. Экран не должен считать, что
    // «открыл вкладку — значит, может отправлять»: письмо уходит настоящим адресатам.
    const viewer = authUser({ role: 'manager' });
    expect(can(viewer, 'mailings.manage')).toBe(false);
    const http = renderTab(viewer);

    const button = await screen.findByRole('button', { name: 'Отправить тест' });
    expect(button.hasAttribute('disabled')).toBe(true);
    // Выключенная кнопка без объяснения читается как поломка — рядом сказано, чего не хватает.
    expect(screen.getByText('Нужно право на управление рассылками')).toBeDefined();

    fireEvent.click(button);
    expect(http.countOf(SEND)).toBe(0);
  });
});
