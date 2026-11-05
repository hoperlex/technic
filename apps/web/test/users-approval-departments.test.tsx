import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { GrantDto, UserAccountDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { account, CUSTOM, grantRef, MANAGER_ID } from './factories/grants';
import { UsersTab } from '../src/pages/admin/UsersTab';

/**
 * «Отделы визы» in the account window (ADR 0245, owner decision 05.11.2026): the visa itself stays
 * an optional checkbox among the grants; once «Виза отдела» is checked on a manager, the field
 * appears, is required, and holds one department per row with a «+» button.
 *
 * Rendered through the users tab, as `users-grants-form.test.tsx` does: the subject is what the
 * form puts into the request body, not the computation (contract tests cover that).
 */

const PATCH = 'PATCH /users/:id';
const VISA_ID = '88888888-8888-4888-8888-888888888888';
const OAT = { id: '99999999-9999-4999-8999-999999999999', code: 'ОАТ', name: 'ОАТ СМ' };
const PTO = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', code: 'ПТО', name: 'ПТО' };

/** «Виза отдела» as the server catalog returns it for a manager (`grant_roles`, migration 0410). */
const DEPARTMENT_VISA: GrantDto = {
  ...CUSTOM,
  id: VISA_ID,
  code: 'department_approval',
  name: 'Виза отдела',
  description: 'Визирует заявки своего отдела',
  isSystem: true,
  version: 2,
  permissions: ['vehicleRequests.approve', 'mechRequests.approve'],
  roles: ['department', 'manager'],
  holderCount: 0,
};

function department(d: { id: string; code: string; name: string }) {
  return {
    ...d,
    isActive: true,
    objects: [],
    heads: [],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  };
}

function manager(over: Partial<UserAccountDto> = {}): UserAccountDto {
  return account({
    id: MANAGER_ID,
    email: 'manager@example.test',
    role: 'manager',
    constructionObjects: [],
    ...over,
  });
}

function renderTab(user: UserAccountDto): HttpMock {
  const http = mockHttp({
    'GET /users': () => json(list([user])),
    'GET /users/pending-count': () => json({ count: 0 }),
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(list([department(OAT), department(PTO)])),
    'GET /counterparties': () => json(emptyList()),
    'GET /grants': () => json(list([DEPARTMENT_VISA])),
    [PATCH]: () => json({ user, notified: 'not_requested' }),
  });
  renderWithUser(<UsersTab />, { user: authUser({ role: 'admin' }) });
  return http;
}

async function openCard(email: string): Promise<void> {
  const row = await waitFor(() => {
    const found = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(email),
    );
    if (!found) throw new Error(`no row «${email}»`);
    return found;
  });
  fireEvent.click(row.querySelector('button')!);
  fireEvent.click(await screen.findByText('Редактировать'));
  await screen.findByLabelText('Фамилия');
}

function visaBox(): HTMLInputElement {
  const wrapper = [...document.querySelectorAll('label.ant-checkbox-wrapper')].find((el) =>
    el.textContent?.includes(DEPARTMENT_VISA.name),
  );
  const input = wrapper?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!input) throw new Error('no «Виза отдела» checkbox');
  return input;
}

const visaFieldShown = (): boolean => screen.queryByText('Отделы визы') !== null;

/** The department select of one row: rows carry no label of their own, only `aria-label`. */
function rowSelects(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('input[aria-label="Отдел визы"]')];
}

async function pickInRow(index: number, optionText: string): Promise<void> {
  const input = rowSelects()[index]!;
  fireEvent.mouseDown(input);
  const dropdown = await waitFor(() => {
    const found = document.getElementById(`${input.id}_list`);
    if (!found) throw new Error('row dropdown did not open');
    return (found.closest('.ant-select-dropdown') ?? found.parentElement!) as HTMLElement;
  });
  fireEvent.click(
    await within(dropdown).findByText(optionText, {
      selector: '.ant-select-item-option-content, .ant-select-item-option-content *',
    }),
  );
}

function clickButton(label: string): void {
  const button = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label,
  );
  expect(button, `button «${label}»`).toBeTruthy();
  fireEvent.click(button!);
}

function lastBody(http: HttpMock): Record<string, unknown> {
  const call = http.lastCall(PATCH);
  expect(call, 'the edit did not reach the server').toBeTruthy();
  return call!.body as Record<string, unknown>;
}

describe('«Отделы визы» in the account window (ADR 0245)', () => {
  it('appears only when «Виза отдела» is checked: the visa itself is optional', async () => {
    renderTab(manager());
    await openCard('manager@example.test');
    await waitFor(() => visaBox());
    expect(visaFieldShown()).toBe(false);

    fireEvent.click(visaBox());
    await waitFor(() => expect(visaFieldShown()).toBe(true));

    fireEvent.click(visaBox());
    await waitFor(() => expect(visaFieldShown()).toBe(false));
  });

  it('is required once the visa is checked, and goes into the body with the statement', async () => {
    const http = renderTab(manager());
    await openCard('manager@example.test');
    await waitFor(() => visaBox());
    fireEvent.click(visaBox());
    await waitFor(() => expect(rowSelects()).toHaveLength(1));

    clickButton('Сохранить');
    expect(
      await screen.findByText(
        'Виза действует в пределах отделов визы — укажите хотя бы один отдел',
      ),
    ).toBeTruthy();
    expect(http.countOf(PATCH)).toBe(0);

    await pickInRow(0, 'ОАТ — ОАТ СМ');
    // «+» adds the next row: a manager may sign for several departments.
    clickButton('Добавить отдел визы');
    await waitFor(() => expect(rowSelects()).toHaveLength(2));
    await pickInRow(1, 'ПТО — ПТО');

    clickButton('Сохранить');
    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    const body = lastBody(http);
    expect(body.approvalDepartmentIds).toEqual([OAT.id, PTO.id]);
    expect(body.grants).toEqual([{ id: VISA_ID, version: 2, selected: true }]);
  });

  it('keeps the held departments on an unrelated edit and drops them with the visa', async () => {
    const held = manager({
      approvalDepartments: [OAT],
      grants: [
        grantRef({ id: VISA_ID, code: 'department_approval', name: 'Виза отдела', version: 2 }),
      ],
      grantCodes: ['department_approval'],
    });
    const http = renderTab(held);
    await openCard('manager@example.test');
    await waitFor(() => expect(visaBox().checked).toBe(true));
    await waitFor(() => expect(visaFieldShown()).toBe(true));

    clickButton('Сохранить');
    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    expect(lastBody(http).approvalDepartmentIds).toEqual([OAT.id]);

    await openCard('manager@example.test');
    await waitFor(() => expect(visaBox().checked).toBe(true));
    fireEvent.click(visaBox());
    await waitFor(() => expect(visaFieldShown()).toBe(false));
    clickButton('Сохранить');
    await waitFor(() => expect(http.countOf(PATCH)).toBe(2));
    // A link that limits nothing would read in the card as a working restriction.
    expect(lastBody(http).approvalDepartmentIds).toEqual([]);
  });
});
