import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuditEntryDto, UserDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { UsersTab } from '../src/pages/admin/UsersTab';

/**
 * Подвкладка «Аудит» во вкладке «Пользователи» (ADR 0088).
 *
 * Проверяется то, ради чего экран заводили. Первое: строку журнала собирает описатель из
 * контрактов, и код действия наружу не выходит — «user.update 8f0c…» не отвечает ни на один вопрос
 * разбора. Второе: журнал закрыт своим правом, а не ролью. Третье: историю одной учётки открывают
 * из её же строки — искать человека в общем журнале руками и есть та работа, от которой экран
 * должен избавлять.
 */

function user(over: Partial<UserDto> = {}): UserDto {
  return {
    id: 'u-1',
    email: 'manager@example.test',
    lastName: 'Менеджеров',
    firstName: 'Максим',
    middleName: 'Петрович',
    fullName: 'Менеджеров Максим Петрович',
    phone: '',
    requestedRole: null,
    requestedObject: '',
    requestedCompany: '',
    requestedComment: '',
    role: 'manager',
    isActive: true,
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

const EMPLOYEE = user();

function entry(over: Partial<AuditEntryDto> = {}): AuditEntryDto {
  return {
    id: 'a-1',
    createdAt: '2026-08-05T08:30:00.000Z',
    action: 'user.update',
    actorUserId: 'admin-1',
    actorName: 'Администраторов Артём Игоревич',
    entityType: 'user',
    entityId: EMPLOYEE.id,
    targetName: EMPLOYEE.fullName,
    targetEmail: EMPLOYEE.email,
    targetRole: EMPLOYEE.role,
    targetIsActive: EMPLOYEE.isActive,
    targetDeletedAt: null,
    metadata: {},
    ...over,
  };
}

/**
 * Правка учётки: значения пишутся перечнем изменений (ADR 0109) — по нему и собираются строки
 * «поле: было → стало».
 */
const ROLE_CHANGE = entry({
  metadata: {
    changes: [
      { field: 'role', from: 'Диспетчер', to: 'Менеджер' },
      { field: 'objectsAdded', from: null, to: 'СУ-10' },
    ],
  },
});
/** Отправка в архив (ADR 0063): своё действие, и путать его с удалением насовсем нельзя. */
const ARCHIVED = entry({ id: 'a-2', action: 'user.delete', createdAt: '2026-08-04T12:00:00.000Z' });

const AUDIT = 'GET /audit';
const USER_CARD = 'GET /users/:id';

function renderTab(role: 'admin' | 'manager' = 'admin', over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /users': () => json(list([EMPLOYEE])),
    'GET /users/pending-count': () => json({ count: 0 }),
    [USER_CARD]: () => json({ user: EMPLOYEE }),
    // Справочники области: журналу они нужны для фильтров по данным учёток.
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    [AUDIT]: () => json(list([ROLE_CHANGE, ARCHIVED])),
    ...over,
  });
  renderWithUser(<UsersTab />, { user: authUser({ role }) });
  return http;
}

/** Переход на подвкладку: она открывается нажатием, как это делает администратор. */
function openTab(label: string): void {
  const tab = [...document.querySelectorAll('.ant-tabs-tab-btn')].find(
    (el) => el.textContent?.trim() === label,
  );
  expect(tab, `подвкладка «${label}»`).toBeTruthy();
  fireEvent.click(tab!);
}

/**
 * Пункт меню строки. Действия живут в выпадающем меню, и добраться до истории можно только через
 * него — так же, как это делает администратор.
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

/**
 * Поля выбора в полосе фильтров по порядку. Искать их по подсказке нельзя: у поля с выбранным
 * значением подсказки уже нет, а отмечать второе действие приходится в том же поле.
 */
const FILTER = {
  actions: 0,
  actor: 1,
  target: 2,
  role: 3,
  access: 4,
  object: 5,
  department: 6,
  counterparty: 7,
  archive: 8,
};

/**
 * Поле фильтра в журнале по его месту в полосе. Соседняя подвкладка остаётся смонтированной
 * (вкладки antd не размонтируются), и её фильтры лежат в той же разметке — поэтому поиск идёт
 * внутри панели самого журнала, а не по всему документу.
 */
async function pickFilterOption(index: number, optionText: string): Promise<void> {
  const pane = document.querySelector('[id$="-panel-audit"]');
  expect(pane, 'подвкладка «Аудит»').toBeTruthy();
  const field = pane!.querySelectorAll('.ant-select')[index]!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  await waitFor(() => {
    const option = [...document.querySelectorAll('.ant-select-item-option')].find(
      (o) => o.textContent?.trim() === optionText,
    );
    expect(option, `вариант «${optionText}»`).toBeTruthy();
    fireEvent.click(option!);
  });
}

/**
 * Период вводится руками: календарь в jsdom мышью не открывается, а набранное значение antd
 * принимает по Enter (тот же приём, что в `typeDate`).
 */
function typeRange(from: string, to: string): void {
  const pane = document.querySelector('[id$="-panel-audit"]')!;
  const inputs = [...pane.querySelectorAll<HTMLInputElement>('.ant-picker-input input')];
  expect(inputs.length, 'поля периода').toBe(2);
  for (const [index, text] of [from, to].entries()) {
    const input = inputs[index]!;
    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
  }
}

describe('журнал изменений учётных записей', () => {
  it('изменения читаются значениями, а кода действия в строке нет', async () => {
    // Ради этого описатель и живёт в контрактах: заголовок называет затронутое, а под ним стоят
    // пары «было → стало». «user.update» человеку не говорит ничего, а «изменена» — почти ничего.
    renderTab();
    openTab('Аудит');

    expect(await screen.findByText('Учётная запись изменена: роль, объекты')).toBeDefined();
    expect(screen.getByText('Роль: Диспетчер → Менеджер')).toBeDefined();
    // У появившегося значения левой части нет — стрелка из пустоты только мешает.
    expect(screen.getByText('Объекты добавлены: СУ-10')).toBeDefined();
    expect(screen.getByText('Учётная запись отправлена в архив')).toBeDefined();
    expect(screen.queryByText('user.update')).toBeNull();
    expect(screen.queryByText('user.delete')).toBeNull();
    // Над кем действовали — с адресом: без него строка про однофамильцев не отвечает ни на что.
    expect(screen.getAllByText(EMPLOYEE.fullName).length).toBeGreaterThan(0);
    expect(screen.getAllByText(EMPLOYEE.email).length).toBeGreaterThan(0);
  });

  it('правка, записанная до перечня изменений, честно говорит, что значений нет', async () => {
    // Записи старше ADR 0109 хранят один признак «менялось». Придумывать за них значения нельзя, а
    // молчать — значит потерять правку из истории вовсе.
    renderTab('admin', {
      [AUDIT]: () => json(list([entry({ metadata: { scopeChanged: true } })])),
    });
    openTab('Аудит');

    expect(await screen.findByText('Объекты и отделы: значения не сохранены')).toBeDefined();
  });

  it('отбор по данным учётки уходит в запрос', async () => {
    // То, ради чего фильтры и заведены: «что меняли у механиков» — вопрос про роль учётки, а не
    // про действие администратора.
    const http = renderTab();
    openTab('Аудит');
    await waitFor(() => expect(http.countOf(AUDIT)).toBe(1));

    // Роль из начала перечня: список ролей в jsdom виртуализируется, и до конца его не докрутить.
    await pickFilterOption(FILTER.role, 'Диспетчер');

    await waitFor(() => expect(http.lastCall(AUDIT)!.query.get('targetRole')).toBe('dispatcher'));
    expect(http.lastCall(AUDIT)!.query.get('page')).toBe('1');
  });

  it('без права на журнал нет ни подвкладки, ни пункта «История»', async () => {
    // Право своё, а не роль: сегодня `audit.read` и `users.manage` есть только у администратора,
    // но разъехаться им ничто не мешает — и тогда журнал должен закрыться сам, а не вкладкой.
    const http = renderTab('manager');
    await screen.findByText(EMPLOYEE.email);

    expect(screen.queryByText('Аудит')).toBeNull();
    fireEvent.click(document.querySelector('tbody tr button')!);
    expect(await screen.findByText('Редактировать')).toBeDefined();
    expect(screen.queryByText('История')).toBeNull();
    expect(http.countOf(AUDIT)).toBe(0);
  });

  it('пункт «История» показывает путь учётки, не уводя со списка', async () => {
    // Путь панелью, а не переходом на соседнюю подвкладку: разбирающий учётку человек иначе терял
    // и её строку, и отбор, которым он до неё добрался.
    const http = renderTab();
    await rowAction(EMPLOYEE.email, 'История');

    expect(await screen.findByText('Роль: Диспетчер → Менеджер')).toBeDefined();
    await waitFor(() => expect(http.countOf(AUDIT)).toBe(1));
    const query = http.lastCall(AUDIT)!.query;
    // Пара «тип и идентификатор»: журнал общий на весь портал, и без типа фильтр отобрал бы
    // заодно однажды совпавший идентификатор чужой записи.
    expect(query.get('entityType')).toBe('user');
    expect(query.get('entityId')).toBe(EMPLOYEE.id);
    // Путь читается от начала: заявка, одобрение, правки — в том порядке, в каком это было.
    expect(query.get('sortOrder')).toBe('asc');
    // Чем учётка стала сейчас — последний вопрос пути, и на него отвечает её карточка. Считается
    // точный адрес: шаблон `/users/:id` совпал бы и со счётчиком заявок на регистрацию.
    await waitFor(() =>
      expect(http.calls.filter((c) => c.path === `/users/${EMPLOYEE.id}`)).toHaveLength(1),
    );
    const drawer = document.querySelector('.ant-drawer')!;
    expect(drawer.textContent).toContain('Менеджер');
    // Список учёток остался на месте: подвкладка не переключилась.
    expect(document.querySelector('.ant-tabs-tab-active')!.textContent).toContain('Учётные записи');
  });

  it('выбранные сутки уходят границами дня, а не датами', async () => {
    // Записи ложатся с точностью до секунды: «по 6 августа» датой отрезало бы весь день, кроме
    // полуночи. Границы считаются в часовом поясе портала — у сервера свой UTC, у браузера свой.
    const http = renderTab();
    openTab('Аудит');
    await waitFor(() => expect(http.countOf(AUDIT)).toBe(1));

    typeRange('05.08.2026', '06.08.2026');

    await waitFor(() => expect(http.lastCall(AUDIT)!.query.get('from')).toBeTruthy());
    expect(http.lastCall(AUDIT)!.query.get('from')).toBe('2026-08-04T21:00:00.000Z');
    expect(http.lastCall(AUDIT)!.query.get('to')).toBe('2026-08-06T20:59:59.999Z');
  });

  it('отмеченные действия уходят одним параметром через запятую', async () => {
    // Набор, а не одно значение: фильтр по одному действию заставлял бы читать журнал по разу на
    // действие. Разбирает эту строку схема контрактов — повтор параметра она не принимает.
    const http = renderTab();
    openTab('Аудит');
    await waitFor(() => expect(http.countOf(AUDIT)).toBe(1));

    await pickFilterOption(FILTER.actions, 'Учётная запись отправлена в архив');
    await pickFilterOption(FILTER.actions, 'Учётная запись восстановлена из архива');

    await waitFor(() => expect(http.countOf(AUDIT)).toBe(3));
    expect(http.lastCall(AUDIT)!.query.get('actions')).toBe('user.delete,user.restore');
    // Отбор сменился — журнал возвращается на первую страницу.
    expect(http.lastCall(AUDIT)!.query.get('page')).toBe('1');
  });
});
