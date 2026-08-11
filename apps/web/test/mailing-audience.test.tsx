import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  MailingRecipientCandidateDto,
  MailingScheduleDto,
  Role,
  UpdateMailingScheduleBody,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { MailingSchedulesBlock } from '../src/pages/admin/MailingSchedulesBlock';

/**
 * Аудитория сводки по ролям: три окна выбора и каскад между ними.
 *
 * Проверяется то, из-за чего письмо уходит не тем: список получателей обязан пересобираться при
 * смене ролей (иначе в расписании остаётся человек, которого отбор уже не берёт), «отмечено всё»
 * обязано сохраняться режимом, а не перечнем (иначе заведённая завтра учётка молча выпадает из
 * рассылки), а отмеченный вручную и выпавший из отбора получатель обязан быть назван — снимать
 * его молча нельзя, вернуть роль означает вернуть и его.
 */

const SCHEDULE_ID = '11111111-1111-1111-1111-111111111111';
const DISPATCHER_ID = '22222222-2222-2222-2222-222222222222';
const SHTAB_ID = '33333333-3333-3333-3333-333333333333';
const GONE_ONE_ID = '44444444-4444-4444-4444-444444444444';
const GONE_TWO_ID = '55555555-5555-5555-5555-555555555555';
const NORTH_ID = '66666666-6666-6666-6666-666666666666';
const SOUTH_ID = '77777777-7777-7777-7777-777777777777';
const SUPPLY_ID = '88888888-8888-8888-8888-888888888888';

/** Кандидаты, которых сервер вернёт на роль. Отбор считает он же — портал только показывает. */
const BY_ROLE: Partial<Record<Role, MailingRecipientCandidateDto>> = {
  // Диспетчер площадко-отдельной оси не имеет вовсе (Р8): выбор площадок его не отсекает, и в
  // счётчик ни одной площадки он не попадает.
  dispatcher: {
    userId: DISPATCHER_ID,
    fullName: 'Диспетчеров Дмитрий',
    role: 'dispatcher',
    scopeLabel: 'без привязки к площадкам',
    objectIds: [],
    departmentIds: [],
    emailVerified: true,
  },
  shtab: {
    userId: SHTAB_ID,
    fullName: 'Штабов Сергей',
    role: 'shtab',
    scopeLabel: 'Северный',
    objectIds: [NORTH_ID],
    departmentIds: [],
    emailVerified: true,
  },
};

function schedule(over: Partial<MailingScheduleDto> = {}): MailingScheduleDto {
  return {
    id: SCHEDULE_ID,
    type: 'role_digest',
    name: 'Диспетчерская сводка',
    isEnabled: true,
    sendAt: '18:00',
    runWeekdays: [1, 2, 3, 4, 5],
    windowFromDays: 1,
    windowDays: 1,
    nextRunAt: null,
    version: 3,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    excludedRunDates: [],
    excludedRouteDates: [],
    excludedPersonIds: [],
    roles: ['dispatcher', 'shtab'],
    requestScope: 'scope',
    showTrips: true,
    showOnsite: true,
    scopeMode: 'all',
    objectIds: [],
    departmentIds: [],
    recipientMode: 'all',
    recipientUserIds: [],
    ...over,
  };
}

const CANDIDATES = 'GET /admin/mail/recipient-candidates';
const PATCH = 'PATCH /admin/mail/schedules/:id';

function renderBlock(over: Partial<MailingScheduleDto> = {}): HttpMock {
  const record = schedule(over);
  const http = mockHttp({
    'GET /admin/mail/schedules': () => json([record]),
    // Справочники областей рассылки приходят целиком: ролями они не сужаются (Р7) — площадка без
    // единого получателя из списка не пропадает, у неё лишь нулевой счётчик.
    'GET /objects': () =>
      json(
        list([
          { id: NORTH_ID, code: 'СМР-1', name: 'Северный', isActive: true },
          { id: SOUTH_ID, code: 'СМР-2', name: 'Южный', isActive: true },
        ]),
      ),
    'GET /departments': () =>
      json(list([{ id: SUPPLY_ID, code: 'ОС', name: 'Снабжение', isActive: true }])),
    [CANDIDATES]: ({ query }) =>
      json(
        (query.get('roles') ?? '')
          .split(',')
          .filter((r) => r !== '')
          .map((r) => BY_ROLE[r as Role])
          .filter((c) => !!c),
      ),
    [PATCH]: () => json(record),
  });
  renderWithUser(<MailingSchedulesBlock />, { user: authUser({ role: 'admin' }) });
  return http;
}

/** Открыть форму правки единственного расписания в списке. */
async function openForm(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Редактировать' }));
  await screen.findByLabelText('Название');
}

/**
 * Окно выбора по его заголовку. Именно по заголовку, а не поиском по всему документу: на экране
 * одновременно и форма расписания, и закрытые окна соседних осей — отмеченное молча ушло бы в
 * чужой набор.
 */
function picker(title: string): HTMLElement {
  const heading = [...document.querySelectorAll('.ant-modal-title')].find(
    (el) => el.textContent === title,
  );
  if (!heading) throw new Error(`окна «${title}» на экране нет`);
  // Окном считается элемент с ролью диалога: заголовок, тело и кнопки лежат внутри него, и «Готово»
  // из соседнего окна в этот поиск не попадёт.
  return heading.closest('[role="dialog"]') as HTMLElement;
}

/** Открыть окно оси: поле аудитории — это кнопка, связанная с подписью формы. */
async function openPicker(field: string, title: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByLabelText(field));
  await waitFor(() => picker(title));
  return picker(title);
}

describe('каскад окон аудитории', () => {
  it('снятие роли пересобирает список получателей', async () => {
    const http = renderBlock();
    await openForm();

    await waitFor(() => expect(http.countOf(CANDIDATES)).toBe(1));
    expect(http.lastCall(CANDIDATES)?.query.get('roles')).toBe('dispatcher,shtab');

    const roles = await openPicker('Роли', 'Роли-получатели');
    fireEvent.click(within(roles).getByLabelText('Штаб'));
    fireEvent.click(within(roles).getByRole('button', { name: 'Готово' }));

    // Список людей считает сервер тем же отбором, каким рассылка выбирает адресатов: снятая роль
    // обязана уехать в запрос, иначе в окне остались бы те, кому письмо уже не уйдёт.
    await waitFor(() => expect(http.lastCall(CANDIDATES)?.query.get('roles')).toBe('dispatcher'));

    const people = await openPicker('Получатели', 'Получатели');
    await within(people).findByLabelText(/Диспетчеров Дмитрий/);
    expect(within(people).queryByLabelText(/Штабов Сергей/)).toBeNull();
  });

  it('у строк справочника стоит счётчик получателей, а вид сворачивается до непустых', async () => {
    // Список площадок ролями не сужается, поэтому без счётчика по нему не видно, кого именно
    // задевает отметка: площадка без единого получателя выглядит так же, как площадка со штабом.
    const http = renderBlock();
    await openForm();

    const scope = await openPicker('Площадки и отделы', 'Площадки и отделы');
    await within(scope).findByLabelText(/Северный · получателей: 1/);
    expect(within(scope).getByLabelText(/Южный · получателей: 0/)).toBeDefined();
    // Счётчик считается по отбору без сужения площадками — второго запроса это в режиме «все» не
    // стоит: ключ и параметры совпадают с основным, ответ берётся из кэша.
    expect(http.countOf(CANDIDATES)).toBe(1);

    fireEvent.click(within(scope).getByLabelText('Только с получателями'));
    expect(within(scope).queryByLabelText(/Южный/)).toBeNull();
    // Переключатель — вид, а не ограничение выбора: скрытая строка отметки не теряет, и счётчик
    // отмеченного считается по всему списку.
    expect(within(scope).getByText('Отмечено 3 из 3')).toBeDefined();
  });

  it('отмеченное целиком сохраняется режимом «все», а не перечнем', async () => {
    // Перечень вместо режима ломается молча: заведённая завтра учётка в рассылку не попадёт,
    // потому что её не было в списке, когда его отмечали, — и видно это только неполученным
    // письмом.
    const http = renderBlock({ recipientMode: 'selected', recipientUserIds: [DISPATCHER_ID] });
    await openForm();

    const people = await openPicker('Получатели', 'Получатели');
    await within(people).findByLabelText(/Штабов Сергей/);
    fireEvent.click(within(people).getByLabelText(/Выбрать все/));
    fireEvent.click(within(people).getByRole('button', { name: 'Готово' }));

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    const body = http.lastCall(PATCH)?.body as UpdateMailingScheduleBody;
    expect(body.recipientMode).toBe('all');
    expect(body.recipientUserIds).toEqual([]);
  });

  it('отмеченный вручную получатель, выпавший из отбора, назван строкой предупреждения', async () => {
    const http = renderBlock({
      recipientMode: 'selected',
      recipientUserIds: [DISPATCHER_ID, GONE_ONE_ID, GONE_TWO_ID],
    });
    await openForm();

    await screen.findByText(/2 отмеченных больше не подходят под отбор/);
    fireEvent.click(screen.getByRole('button', { name: 'Снять' }));
    await waitFor(() => expect(screen.queryByText(/больше не подходят под отбор/)).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    const body = http.lastCall(PATCH)?.body as UpdateMailingScheduleBody;
    expect(body.recipientUserIds).toEqual([DISPATCHER_ID]);
  });
});
