import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { roleLabels, type DepartmentDto, type UserAccountDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { openSelectOptions, selectOption } from './antd';
import { DepartmentsTab } from '../src/pages/directories/DepartmentsTab';
import { UsersTab } from '../src/pages/admin/UsersTab';

/**
 * Руководитель отдела как признак связи, а не как роль (§11.1 плана реструктуризации прав,
 * миграция 0149).
 *
 * Признак живёт на привязке «человек ↔ отдел» (`user_departments.is_head`): держатель руководит при
 * любой роли, а роль «Руководитель отдела» без признака не руководит ничем. Сервер за этим уже
 * переехал — роль кандидата он не проверяет, — и портал обязан переехать так же, потому что ошибка
 * здесь молчаливая: доступ остаётся правильным, тесты прав зелёными, а карточка отдела теряет
 * выбор, которого сервер не запрещал.
 *
 * Проверяются два конца одной связи. В карточке отдела — что кандидаты больше не сужены одной
 * ролью и что назначенный уходит на сервер. В карточке учётки — что признак вообще виден: раньше
 * руководителя делала роль плюс добавленный отдел, теперь это разные действия, и без ответа на
 * экране администратор заводил бы руководителя, который ничего не визирует.
 *
 * Признак в карточке учётки читается из неё самой (`UserDepartmentRefDto.isHead`), а не из
 * справочника отделов, как читался в первой волне. Отсюда и приём этих тестов: справочнику и
 * карточке в них нарочно дают разные ответы — иначе не видно, который из двух источников читает
 * форма, и возврат к обходу через `heads` прошёл бы зелёным.
 */

function department(over: Partial<DepartmentDto> = {}): DepartmentDto {
  return {
    id: 'dep-1',
    code: 'PTO',
    name: 'ПТО',
    isActive: true,
    object: null,
    heads: [],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

function account(over: Partial<UserAccountDto> = {}): UserAccountDto {
  return {
    id: 'u-head',
    email: 'head@example.test',
    lastName: 'Иванов',
    firstName: 'Иван',
    middleName: 'Иванович',
    fullName: 'Иванов Иван Иванович',
    phone: '',
    requestedRole: null,
    requestedObject: '',
    requestedCompany: '',
    requestedComment: '',
    role: 'department_head',
    isActive: true,
    mustChangePassword: false,
    emailVerifiedAt: '2026-08-01T10:00:00.000Z',
    constructionObjects: [],
    departments: [{ id: 'dep-1', code: 'PTO', name: 'ПТО', isHead: false }],
    addons: [],
    grantCodes: [],
    permissions: [],
    counterpartyId: null,
    counterpartyName: null,
    counterpartyType: null,
    person: null,
    deletedAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

/** Учётка роли «Руководитель отдела» — до реформы единственный кандидат. Признака у неё нет. */
const HEAD_ROLE = account();
/** Та же учётка с признаком на привязке: руководителем её делает он, а не роль. */
const HEAD_ASSIGNED = account({
  departments: [{ id: 'dep-1', code: 'PTO', name: 'ПТО', isHead: true }],
});
/** Сотрудник того же отдела: роль другая, ось та же — сервер такого руководителем принимает. */
const EMPLOYEE = account({
  id: 'u-emp',
  email: 'emp@example.test',
  lastName: 'Петров',
  firstName: 'Пётр',
  middleName: 'Петрович',
  fullName: 'Петров Пётр Петрович',
  role: 'department',
});

/** Кнопка подвала окна по подписи: заголовки и подписи полей ею не задеваются. */
function clickButton(label: string): void {
  const button = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label,
  );
  expect(button, `кнопка «${label}»`).toBeTruthy();
  fireEvent.click(button!);
}

// --- карточка отдела --------------------------------------------------------

/** Учётки отдаются по роли из запроса — так же, как их отбирает сервер. */
function renderDepartments(departments: DepartmentDto[], candidates: UserAccountDto[]): HttpMock {
  const http = mockHttp({
    'GET /departments': () => json(list(departments)),
    'GET /objects': () => json(emptyList()),
    'GET /users': (ctx) => json(list(candidates.filter((u) => u.role === ctx.query.get('role')))),
    'PATCH /departments/:id': () => json(department()),
  });
  renderWithUser(<DepartmentsTab />, { user: authUser({ role: 'admin' }) });
  return http;
}

/** Правка строки справочника — первая кнопка в её действиях. */
async function openDepartmentCard(name: string): Promise<void> {
  const row = await waitFor(() => {
    const found = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(name),
    );
    if (!found) throw new Error(`строки «${name}» в справочнике нет`);
    return found;
  });
  fireEvent.click(row.querySelector('button')!);
}

describe('карточка отдела: кандидаты в руководители', () => {
  it('предлагает учётки всей отдельской оси, а не одной роли', async () => {
    const http = renderDepartments([department()], [HEAD_ROLE, EMPLOYEE]);
    await openDepartmentCard('ПТО');

    const options = await openSelectOptions('Руководители');
    const texts = options.map((o) => o.textContent ?? '');
    // Сотрудник отдела — тот самый выбор, который сервер принимает, а прежний портал не предлагал.
    expect(texts.some((t) => t.includes('Петров Пётр Петрович'))).toBe(true);
    expect(texts.some((t) => t.includes('Иванов Иван Иванович'))).toBe(true);
    // Роль в строке названа: с двумя ролями в списке одного ФИО для выбора мало.
    expect(texts.some((t) => t.includes(roleLabels.department))).toBe(true);

    // И спрошены обе роли, а не одна: список кандидатов идёт от оси области.
    const asked = http.calls.filter((c) => c.path === '/users').map((c) => c.query.get('role'));
    expect(asked).toContain('department');
    expect(asked).toContain('department_head');
  });

  it('назначает руководителем сотрудника отдела: набор уходит целиком', async () => {
    const http = renderDepartments(
      [department({ heads: [{ id: HEAD_ROLE.id, fullName: HEAD_ROLE.fullName }] })],
      [HEAD_ROLE, EMPLOYEE],
    );
    await openDepartmentCard('ПТО');

    await selectOption('Руководители', /Петров Пётр Петрович/);
    clickButton('Сохранить');

    await waitFor(() => {
      const call = http.lastCall('PATCH /departments/:id');
      if (!call) throw new Error('карточка отдела не сохранилась');
      expect((call.body as { headUserIds: string[] }).headUserIds).toEqual([
        HEAD_ROLE.id,
        EMPLOYEE.id,
      ]);
    });
  });

  it('уже назначенного показывает именем, даже если его нет среди кандидатов', async () => {
    // Кандидаты отбираются страницей на роль, и однажды действующий руководитель в неё не попадёт.
    // Без добавки поле показало бы на его месте идентификатор, а сохранение молча его вычеркнуло.
    renderDepartments([department({ heads: [{ id: 'u-out', fullName: 'Сидоров Семён' }] })], []);
    await openDepartmentCard('ПТО');

    const options = await openSelectOptions('Руководители');
    expect(options.some((o) => o.textContent?.includes('Сидоров Семён'))).toBe(true);
  });
});

// --- карточка учётки --------------------------------------------------------

function renderUsers(
  user: UserAccountDto,
  departments: DepartmentDto[],
  over: RouteMap = {},
): HttpMock {
  const http = mockHttp({
    'GET /users': () => json(list([user])),
    'GET /users/pending-count': () => json({ count: 0 }),
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(list(departments)),
    'GET /counterparties': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<UsersTab />, { user: authUser({ role: 'admin' }) });
  return http;
}

/** Правка учётки — из меню строки, как её открывает администратор. */
async function openUserCard(email: string): Promise<void> {
  const row = await waitFor(() => {
    const found = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(email),
    );
    if (!found) throw new Error(`строки «${email}» в списке нет`);
    return found;
  });
  fireEvent.click(row.querySelector('button')!);
  fireEvent.click(await screen.findByText('Редактировать'));
}

describe('карточка учётки: признак руководителя', () => {
  it('называет отделы, которыми учётка руководит, — по своей карточке', async () => {
    // Справочник в этой выдаче руководителей не называет вовсе: признак пришёл привязкой учётки,
    // и подсказка обязана строиться по ней — иначе форма снова спрашивала бы вторую сторону связи.
    renderUsers(HEAD_ASSIGNED, [department({ heads: [] })]);
    await openUserCard(HEAD_ASSIGNED.email);

    const hint = await screen.findByText(/Руководит: PTO — ПТО/);
    // И предупреждает про снятие отдела: убранный отсюда отдел уносит и руководство им.
    expect(hint.textContent).toContain('руководство');
  });

  it('видит руководство выключенным отделом — справочник его не отдаёт', async () => {
    // Выпадающий список идёт по действующим отделам (`isActive=true`), и обход через `heads` о
    // выключенном молчал бы: отдел деактивировали, руководитель у него остался, а форма сообщила бы
    // «не руководит ничем» — ровно там, где администратор разбирается с последствиями отключения.
    renderUsers(
      account({
        departments: [{ id: 'dep-off', code: 'AXO', name: 'АХО', isHead: true }],
      }),
      [],
    );
    await openUserCard(HEAD_ROLE.email);

    expect(await screen.findByText(/Руководит: AXO — АХО/)).toBeTruthy();
  });

  it('без признака отвечает, что руководство назначают в справочнике отделов', async () => {
    // Роль «Руководитель отдела» и отдел в наборе — ровно то, чем руководителя заводили раньше.
    // Признака при этом нет, и форма обязана сказать, где он ставится. Справочник здесь нарочно
    // утверждает обратное: читайся признак из него, тест бы этого не заметил.
    renderUsers(HEAD_ROLE, [department({ heads: [{ id: HEAD_ROLE.id, fullName: 'Иванов' }] })]);
    await openUserCard(HEAD_ROLE.email);

    const hint = await screen.findByText(/Отделами не руководит/);
    expect(hint.textContent).toContain('Отделы');
  });

  it('после сохранения перечитывает учётки — набор мог унести руководство', async () => {
    // Отдел, убранный из набора, удаляет привязку целиком вместе с признаком. Не перечитай портал
    // список учёток, следующее открытие карточки показывало бы руководство, которого уже нет.
    const http = renderUsers(HEAD_ASSIGNED, [department()], {
      'PATCH /users/:id': () => json({ user: HEAD_ASSIGNED, notified: 'not_requested' }),
    });
    await openUserCard(HEAD_ASSIGNED.email);
    await screen.findByText(/Руководит: PTO — ПТО/);
    const before = http.countOf('GET /users');

    clickButton('Сохранить');

    await waitFor(() => {
      expect(http.lastCall('PATCH /users/:id')).toBeTruthy();
      expect(http.countOf('GET /users')).toBeGreaterThan(before);
    });
  });

  it('у новой учётки отсылает в справочник отделов, а не молчит', async () => {
    renderUsers(HEAD_ROLE, [department()]);
    clickButton('Добавить');
    // Роль «Отдел», а не «Руководитель отдела»: та упраздняется и новым учёткам больше не
    // предлагается (ADR 0113). Подсказку это не трогает — она и заводилась затем, чтобы признак
    // руководства не искали в роли: любая отдельская роль отсылает в справочник одинаково.
    await selectOption('Роль', roleLabels.department);

    expect(await screen.findByText(/Руководителем отдела учётка становится не здесь/)).toBeTruthy();
  });

  /**
   * Обратная сторона того же решения: упраздняемая роль не исчезает из карточки того, кто на ней
   * стоит. Иначе форма открывалась бы с пустым выбором и любое сохранение требовало бы перевода,
   * которого этот релиз ещё не делает.
   */
  it('у действующего руководителя отдела его роль в списке остаётся', async () => {
    renderUsers(HEAD_ROLE, [department()]);
    await openUserCard(HEAD_ROLE.email);

    const options = await openSelectOptions('Роль');
    expect(options.map((o) => o.textContent)).toContain(
      `${roleLabels.department_head} (упраздняется)`,
    );
    // А у новой учётки её нет вовсе — предлагать роль, которую сервер отклонит, нельзя.
    clickButton('Добавить');
    const fresh = await openSelectOptions('Роль');
    expect(fresh.map((o) => o.textContent).join('|')).not.toContain(roleLabels.department_head);
  });
});
