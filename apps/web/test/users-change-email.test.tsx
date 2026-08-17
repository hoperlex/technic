import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { UserDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { UsersTab } from '../src/pages/admin/UsersTab';

/**
 * Смена адреса учётной записи из списка учёток (ADR 0092).
 *
 * Что здесь проверяется и почему именно это. Адрес — логин, и портал отвечает за две вещи, которых
 * сервер не покажет: во-первых, за то, чтобы пункта не было там, где сервер откажет (чужой
 * администратор, нерассмотренная заявка) — выключенный пункт обещал бы действие, которого не
 * бывает; во-вторых, за повторный ввод адреса — единственную защиту от опечатки, которую иначе
 * никто не заметит: `ivan@` и `ivam@` одинаково правильны с виду.
 */

const ADMIN_ID = 'me-1';

function user(over: Partial<UserDto> = {}): UserDto {
  return {
    id: 'u-1',
    email: 'ivanov@su10.ru',
    lastName: 'Иванов',
    firstName: 'Иван',
    middleName: 'Иванович',
    fullName: 'Иванов Иван Иванович',
    phone: '',
    requestedRole: null,
    requestedObject: '',
    requestedCompany: '',
    requestedComment: '',
    role: 'manager',
    isActive: true,
    mustChangePassword: false,
    emailVerifiedAt: '2026-08-01T10:00:00.000Z',
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

const EMPLOYEE = user();
/** Чужая администраторская: её адрес меняет только владелец. */
const OTHER_ADMIN = user({ id: 'u-2', email: 'admin2@su10.ru', role: 'admin' });
/** Нерассмотренная заявка: адрес заявителя не правят, её рассматривают целиком. */
const PENDING = user({ id: 'u-3', email: 'applicant@mail.ru', role: null, isActive: false });
/** Своя учётка: меняется с подтверждением паролем. */
const SELF = user({ id: ADMIN_ID, email: 'me@su10.ru', role: 'admin' });

function renderTab(users: UserDto[], onChange?: (body: unknown) => void) {
  mockHttp({
    'GET /users': () => json(list(users)),
    'GET /users/pending-count': () => json({ count: 0 }),
    // Справочники области: сценариям не нужны, но форма учётки спрашивает их при открытии.
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'POST /users/:id/email': ({ body }) => {
      onChange?.(body);
      return json({
        user: { ...EMPLOYEE, email: (body as { newEmail: string }).newEmail },
        notifiedNew: 'queued',
        notifiedOld: 'queued',
        shadowsArchived: false,
      });
    },
  });
  renderWithUser(<UsersTab />, { user: authUser({ id: ADMIN_ID, role: 'admin' }) });
}

/** Строка списка по адресу — действия читаем в ней, а не по всей странице. */
async function row(email: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(email),
    );
    if (!found) throw new Error(`строки «${email}» в списке нет`);
    return found as HTMLElement;
  });
}

/** Открыть меню строки и вернуть подписи его пунктов. */
async function menuLabels(email: string): Promise<string[]> {
  const target = await row(email);
  fireEvent.click(target.querySelector('button')!);
  const menu = await screen.findByRole('menu');
  return [...menu.querySelectorAll('.ant-dropdown-menu-title-content')].map(
    (i) => i.textContent ?? '',
  );
}

async function openChangeEmail(email: string): Promise<void> {
  const target = await row(email);
  fireEvent.click(target.querySelector('button')!);
  fireEvent.click(await screen.findByText('Сменить email'));
  await screen.findByLabelText('Новый адрес');
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('смена адреса учётной записи', () => {
  it('пункт есть у действующей учётки', async () => {
    renderTab([EMPLOYEE]);
    expect(await menuLabels(EMPLOYEE.email)).toContain('Сменить email');
  });

  it('пункта нет у чужой администраторской учётки', async () => {
    // Смена логина отдаёт учётку целиком и тихо: администратора уводит только он сам.
    renderTab([OTHER_ADMIN]);
    expect(await menuLabels(OTHER_ADMIN.email)).not.toContain('Сменить email');
  });

  it('пункт есть у своей — даже администраторской', async () => {
    renderTab([SELF]);
    expect(await menuLabels(SELF.email)).toContain('Сменить email');
  });

  it('пункта нет у нерассмотренной заявки', async () => {
    // Заявку рассматривают целиком, а не правят адрес заявителя (ADR 0072).
    renderTab([PENDING]);
    expect(await menuLabels(PENDING.email)).not.toContain('Сменить email');
  });

  it('не отправляет запрос, пока адреса в двух полях не совпали', async () => {
    const sent = vi.fn();
    renderTab([EMPLOYEE], sent);
    await openChangeEmail(EMPLOYEE.email);

    fill('Новый адрес', 'petrov@su10.ru');
    fill('Повторите новый адрес', 'petroy@su10.ru');
    fireEvent.click(screen.getByRole('button', { name: 'Сменить адрес' }));

    expect(await screen.findByText('Адреса не совпадают')).toBeDefined();
    await waitFor(() => expect(sent).not.toHaveBeenCalled());
  });

  it('отправляет адрес, когда оба поля совпали', async () => {
    const sent = vi.fn();
    renderTab([EMPLOYEE], sent);
    await openChangeEmail(EMPLOYEE.email);

    fill('Новый адрес', 'petrov@su10.ru');
    fill('Повторите новый адрес', 'petrov@su10.ru');
    fireEvent.click(screen.getByRole('button', { name: 'Сменить адрес' }));

    // Пароля в теле нет: чужую учётку сервер о нём не спрашивает.
    await waitFor(() => expect(sent).toHaveBeenCalledWith({ newEmail: 'petrov@su10.ru' }));
  });

  it('у своей учётки спрашивает текущий пароль и шлёт его вместе с адресом', async () => {
    const sent = vi.fn();
    renderTab([SELF], sent);
    await openChangeEmail(SELF.email);

    fill('Новый адрес', 'new-me@su10.ru');
    fill('Повторите новый адрес', 'new-me@su10.ru');
    fill('Ваш текущий пароль', 'my-current-password');
    fireEvent.click(screen.getByRole('button', { name: 'Сменить адрес' }));

    await waitFor(() =>
      expect(sent).toHaveBeenCalledWith({
        newEmail: 'new-me@su10.ru',
        currentPassword: 'my-current-password',
      }),
    );
  });

  it('предупреждает о чужом почтовом домене (ADR 0090)', async () => {
    renderTab([EMPLOYEE]);
    await openChangeEmail(EMPLOYEE.email);

    fill('Новый адрес', 'ivanov@mail.ru');

    expect(
      await screen.findByText('Адрес вне доменов компании — проверьте, что он написан верно'),
    ).toBeDefined();
  });
});
