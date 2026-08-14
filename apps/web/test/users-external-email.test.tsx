import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { UserDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { UsersTab } from '../src/pages/admin/UsersTab';

/**
 * Пометка «Внешняя почта» в списке учётных записей (ADR 0090). Она ничего не запрещает и ни на
 * что не влияет — по ней администратор решает, к какой заявке приглядеться, — и потому проверяется
 * прежде всего её адресность: висящая у всех подряд пометка перестаёт что-либо означать.
 */

function user(over: Partial<UserDto> = {}): UserDto {
  return {
    id: 'u-1',
    email: 'applicant@mail.ru',
    lastName: 'Заявкин',
    firstName: 'Захар',
    middleName: 'Петрович',
    fullName: 'Заявкин Захар Петрович',
    phone: '',
    requestedRole: 'dispatcher',
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
    counterpartyId: null,
    counterpartyName: null,
    counterpartyType: null,
    deletedAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

/** Заявка своего сотрудника, поданная с личного ящика, — тот самый случай. */
const EXTERNAL = user();
/** Та же заявка с рабочего адреса. */
const CORPORATE = user({ id: 'u-2', email: 'ivanov@su10.ru' });
/** Оператор: он работает от лица сторонней компании (ADR 0010), чужой адрес у него в порядке вещей. */
const OPERATOR = user({
  id: 'u-3',
  email: 'operator@mail.ru',
  requestedRole: 'waste_operator',
  requestedCompany: 'ООО «Ромашка»',
});
/** Действующий сотрудник: его адрес администратор уже принял, рассматривая заявку. */
const EMPLOYEE = user({ id: 'u-4', email: 'manager@mail.ru', role: 'manager', isActive: true });

const TAG = 'Внешняя почта';

function renderTab(users: UserDto[]) {
  mockHttp({
    'GET /users': () => json(list(users)),
    'GET /users/pending-count': () => json({ count: users.length }),
    // Справочники области: сценариям не нужны, но форма учётки спрашивает их при открытии.
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'PATCH /users/:id': () => json({ user: EMPLOYEE, notified: 'not_requested' }),
  });
  renderWithUser(<UsersTab />, { user: authUser({ role: 'admin' }) });
}

/** Строка списка по адресу — пометку читаем в ней, а не по всей странице. */
async function row(email: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(email),
    );
    if (!found) throw new Error(`строки «${email}» в списке нет`);
    return found as HTMLElement;
  });
}

const tagged = async (email: string) => (await row(email)).textContent?.includes(TAG) === true;

describe('пометка о внешней почте в списке учётных записей', () => {
  it('стоит у заявки своего сотрудника с чужого адреса', async () => {
    renderTab([EXTERNAL]);
    expect(await tagged(EXTERNAL.email)).toBe(true);
  });

  it('заявку с рабочего адреса не помечает', async () => {
    renderTab([CORPORATE]);
    expect(await tagged(CORPORATE.email)).toBe(false);
  });

  it('заявку оператора не помечает — своей почты от него не ждут', async () => {
    renderTab([OPERATOR]);
    expect(await tagged(OPERATOR.email)).toBe(false);
  });

  it('на рассмотренной учётке не остаётся', async () => {
    // Адрес действующего сотрудника администратор однажды принял: пометка на нём висела бы вечно,
    // ничего не решая.
    renderTab([EMPLOYEE]);
    expect(await tagged(EMPLOYEE.email)).toBe(false);
  });

  it('повторяется в окне рассмотрения заявки', async () => {
    // Решение принимается там, и увиденное в списке к этому моменту уже забыто.
    renderTab([EXTERNAL]);
    const target = await row(EXTERNAL.email);
    fireEvent.click(target.querySelector('button')!);
    fireEvent.click(await screen.findByText('Рассмотреть заявку'));

    await screen.findByLabelText('Фамилия');
    expect(
      screen.getByText('При регистрации указал: Диспетчер · Адрес внешней почты'),
    ).toBeDefined();
  });
});
