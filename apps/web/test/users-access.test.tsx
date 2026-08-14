import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  PERMISSION_CATALOG,
  permissionModuleLabels,
  roleAddonLabels,
  roleLabels,
  type UserDto,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { AccessTab } from '../src/pages/admin/AccessTab';
import { AdministrationPage } from '../src/pages/AdministrationPage';

/**
 * Вкладка «Права» — витрина модели доступа (`docs/permissions-tab-plan.md`).
 *
 * Проверяется то единственное, ради чего экран заводили: он обязан показывать матрицу, а не
 * собственное представление о ней. Витрина, разошедшаяся с моделью, хуже её отсутствия — по ней
 * принимают решение о том, кому что выдать, и ошибка здесь тиражируется в права живых учёток.
 *
 * Отсюда состав проверок: право приходит с именем своего источника (роль это или надстройка —
 * главный вопрос пересмотра ролей), учётка без области помечена, незанятый профиль назван
 * незанятым, а право, запертое в одной роли, — запертым. Сами наборы прав здесь не сверяются: за
 * них отвечает `apps/api/test/permissions.test.ts`, и дублировать матрицу в тесте портала значило
 * бы завести её вторую копию ровно там, где витрина не должна её иметь.
 */

function user(over: Partial<UserDto> = {}): UserDto {
  return {
    id: 'u-1',
    email: 'shtab@example.test',
    lastName: 'Штабов',
    firstName: 'Степан',
    middleName: 'Сергеевич',
    fullName: 'Штабов Степан Сергеевич',
    phone: '',
    requestedRole: null,
    requestedObject: '',
    requestedCompany: '',
    requestedComment: '',
    role: 'shtab',
    isActive: true,
    mustChangePassword: false,
    emailVerifiedAt: '2026-08-01T10:00:00.000Z',
    constructionObjects: [{ id: 'o-1', code: 'A', name: 'Объект А' }],
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

const SHTAB = user();

/** Тот же штаб, но с надстройкой (ADR 0086): его права приходят из двух источников сразу. */
const EQUIPMENT_OPERATOR = user({
  id: 'u-2',
  email: 'orgtech@example.test',
  lastName: 'Оргтехников',
  firstName: 'Олег',
  fullName: 'Оргтехников Олег Олегович',
  addons: ['office_equipment_operator'],
});

/** Учётка, которая не видит ничего: роль работает на объектах, а объектов у неё нет. */
const WITHOUT_SCOPE = user({
  id: 'u-3',
  email: 'noobject@example.test',
  lastName: 'Безобъектов',
  firstName: 'Борис',
  fullName: 'Безобъектов Борис Борисович',
  role: 'rukstroy',
  constructionObjects: [],
});

/** Выключенная учётка: доступа у неё нет, и в витрине живых её быть не должно. */
const DISABLED = user({
  id: 'u-4',
  email: 'off@example.test',
  lastName: 'Уволенов',
  firstName: 'Устин',
  fullName: 'Уволенов Устин Устинович',
  role: 'manager',
  constructionObjects: [],
  isActive: false,
});

function renderAccess(users: UserDto[] = [SHTAB]) {
  mockHttp({ 'GET /users': () => json(list(users)) });
  renderWithUser(<AccessTab />, { user: authUser({ role: 'admin' }) });
}

/** Срез открывается нажатием, как это делает администратор. */
function openSlice(label: string): void {
  const tab = [...document.querySelectorAll('.ant-tabs-tab-btn')].find(
    (el) => el.textContent?.trim() === label,
  );
  expect(tab, `срез «${label}»`).toBeTruthy();
  fireEvent.click(tab!);
}

async function rowWith(text: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(text),
    );
    if (!found) throw new Error(`строки «${text}» в таблице нет`);
    return found as HTMLElement;
  });
}

/** Карточка доступа открывается нажатием на строку — отдельной кнопки у витрины нет. */
async function openCard(fullName: string): Promise<HTMLElement> {
  fireEvent.click(await rowWith(fullName));
  return await screen.findByRole('dialog');
}

describe('Вкладка «Права»', () => {
  it('в администрировании открыта правом `users.manage`, а не ролью', async () => {
    mockHttp({
      'GET /users': () => json(list([SHTAB])),
      'GET /users/pending-count': () => json({ count: 0 }),
      // Справочники области витрине не нужны — их спрашивает соседняя вкладка учёток.
      'GET /objects': () => json(emptyList()),
      'GET /departments': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
    });
    renderWithUser(<AdministrationPage />, { user: authUser({ role: 'admin' }) });

    expect(await screen.findByRole('tab', { name: 'Права' })).toBeTruthy();
  });

  it('без права на учётки вкладки в администрировании нет', async () => {
    mockHttp({ 'GET /users': () => json(list([SHTAB])) });
    renderWithUser(<AdministrationPage />, { user: authUser({ role: 'manager' }) });

    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Права' })).toBeNull());
  });

  it('показывает роль, область и открытые модули учётки', async () => {
    renderAccess([SHTAB]);

    const row = await rowWith(SHTAB.fullName);
    expect(within(row).getByText(roleLabels.shtab)).toBeTruthy();
    expect(within(row).getByText('Объект А')).toBeTruthy();
    // Модуль в строке — тот, что открыт правом: списка «что видит штаб» у витрины нет.
    expect(within(row).getByText(permissionModuleLabels.waste)).toBeTruthy();
    expect(within(row).queryByText(permissionModuleLabels.garage)).toBeNull();
  });

  it('живыми считает только активные учётки', async () => {
    renderAccess([SHTAB, DISABLED]);

    await rowWith(SHTAB.fullName);
    expect(screen.queryByText(DISABLED.fullName)).toBeNull();
  });

  it('в карточке доступа право названо вместе с источником — надстройкой, а не ролью', async () => {
    renderAccess([EQUIPMENT_OPERATOR]);

    const card = await openCard(EQUIPMENT_OPERATOR.fullName);
    // Источник проверяется у самой строки права, а не где-нибудь в карточке: надстройка даёт
    // несколько прав, и «источник упомянут» не отвечает на вопрос «чем выдано вот это».
    const addonLine = within(card).getAllByText(
      new RegExp(PERMISSION_CATALOG['officeEquipment.write'].label),
    )[0]!;
    expect(addonLine.textContent).toContain(
      `надстройка «${roleAddonLabels.office_equipment_operator}»`,
    );

    // Право той же учётки, пришедшее должностью, подписано ролью — иначе витрина сваливала бы в
    // надстройку весь доступ человека, у которого она есть.
    const roleLine = within(card).getAllByText(
      new RegExp(PERMISSION_CATALOG['wasteRequests.create'].label),
    )[0]!;
    expect(roleLine.textContent).toContain(`роль «${roleLabels.shtab}»`);
  });

  it('той же роли без надстройки право не приписывает', async () => {
    renderAccess([SHTAB]);

    const card = await openCard(SHTAB.fullName);
    const granted = PERMISSION_CATALOG['officeEquipment.write'].label;
    const readOnly = PERMISSION_CATALOG['officeEquipment.read'].label;
    expect(within(card).queryAllByText(new RegExp(granted))).toHaveLength(0);
    expect(within(card).getAllByText(new RegExp(readOnly)).length).toBeGreaterThan(0);
  });

  it('помечает учётку, которой роль требует области, а области нет', async () => {
    renderAccess([WITHOUT_SCOPE]);

    const row = await rowWith(WITHOUT_SCOPE.fullName);
    expect(within(row).getByText(/объекты не заданы/i)).toBeTruthy();
  });

  it('срез «Профили»: роль без единой живой учётки помечена незанятой', async () => {
    renderAccess([SHTAB]);
    await rowWith(SHTAB.fullName);
    openSlice('Профили');

    const occupied = await rowWith(roleLabels.shtab);
    expect(within(occupied).queryByText('не занят')).toBeNull();
    const empty = await rowWith(roleLabels.commandant);
    expect(within(empty).getByText('не занят')).toBeTruthy();
  });

  it('срез «Права»: право, запертое в одной роли, названо запертым', async () => {
    renderAccess([SHTAB]);
    await rowWith(SHTAB.fullName);
    openSlice('Права');

    const purge = await rowWith(PERMISSION_CATALOG['records.purge'].label);
    expect(within(purge).getByText(`Только «${roleLabels.admin}»`)).toBeTruthy();
    // Право, которым владеет не только администратор, пометки не получает — иначе она перестала
    // бы что-либо значить.
    const read = await rowWith(PERMISSION_CATALOG['directories.read'].label);
    expect(within(read).queryByText(`Только «${roleLabels.admin}»`)).toBeNull();
  });
});
