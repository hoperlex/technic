import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  PERMISSION_CATALOG,
  roleLabels,
  type AuthUser,
  type GrantDto,
  type GrantStatement,
  type UserAccountDto,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { selectOption } from './antd';
import {
  account,
  CUSTOM,
  grantRef,
  ORDERING,
  ORDERING_ASSIGNED_VERSION,
  ORDERING_ID,
  orderingRef,
  SHTAB_ID,
  SYSTEM,
} from './factories/grants';
import { UsersTab } from '../src/pages/admin/UsersTab';

/**
 * Поле «Полномочия» в окне учётки (план «полномочия назначаются в окне учётки», §6) — рендером
 * вкладки, а не вызовом хука: предмет проверки здесь не расчёт (он проверен значениями в
 * `user-grants-model.test.ts`), а то, что форма его зовёт и кладёт результат в тело запроса.
 *
 * Главный тест файла — про **тело**. Значение группы чекбоксов и тело правки не совпадают: набор,
 * который смена роли гасит, в группе не показан вовсе, а строка о нём в теле обязана быть (§4.2), и
 * ошибка здесь молчаливая — правило полноты ответит 400 на запрос, верный по смыслу, либо, наоборот,
 * сервер отзовёт назначение, которого никто не касался.
 *
 * Каталог отдаёт мок по роли из запроса — так же, как его отбирает сервер по `grant_roles`: своего
 * представления о совместимости у портала нет ни строчки, и заводить его в тесте значило бы
 * проверять фикстуру.
 */

const PATCH = 'PATCH /users/:id';
const CATALOG = 'GET /grants';
const USERS = 'GET /users';

/** Объект области: у объектной роли без него учётку не сохранить (ADR 0025). */
const OBJECT = { id: 'o-1', code: 'A', name: 'Объект А' };

/** Наборы, совместимые с ролью, — тем же отбором, каким отвечает сервер (`grant_roles`). */
function catalogFor(role: string | null): GrantDto[] {
  return [ORDERING, CUSTOM, SYSTEM].filter(
    (grant) => !!role && (grant.roles as readonly string[]).includes(role),
  );
}

/** Действующий «Штаб» с площадкой: от него идут переходы ролей. */
function shtab(over: Partial<UserAccountDto> = {}): UserAccountDto {
  return account({ role: 'shtab', constructionObjects: [OBJECT], ...over });
}

/** Нерассмотренная заявка: роли нет, учётка неактивна — поля полномочий у неё нет до выбора роли. */
const PENDING = account({
  id: 'u-pending',
  email: 'applicant@example.test',
  lastName: 'Заявкин',
  firstName: 'Захар',
  middleName: 'Петрович',
  fullName: 'Заявкин Захар Петрович',
  role: null,
  isActive: false,
  emailVerifiedAt: null,
});

function renderTab(users: UserAccountDto[], over: RouteMap = {}, user?: AuthUser): HttpMock {
  const http = mockHttp({
    [USERS]: () => json(list(users)),
    'GET /users/pending-count': () => json({ count: 0 }),
    'GET /objects': () => json(list([OBJECT])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    // Каталог формы: страницами, но здесь он умещается в одну — `total` равен числу отданных строк,
    // и признак полноты приходит истинным.
    [CATALOG]: (ctx) => json(list(catalogFor(ctx.query.get('role')))),
    [PATCH]: () => json({ user: users[0], notified: 'not_requested' }),
    ...over,
  });
  renderWithUser(<UsersTab />, { user: user ?? authUser({ role: 'admin' }) });
  return http;
}

/** Открыть карточку учётки из меню строки — так же, как её открывает администратор. */
async function openCard(email: string, action = 'Редактировать'): Promise<void> {
  const row = await waitFor(() => {
    const found = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(email),
    );
    if (!found) throw new Error(`строки «${email}» в списке нет`);
    return found;
  });
  fireEvent.click(row.querySelector('button')!);
  fireEvent.click(await screen.findByText(action));
  await screen.findByLabelText('Фамилия');
}

/** Кнопка подвала окна по подписи: заголовки и подписи полей ею не задеваются. */
function clickButton(label: string): void {
  const button = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label,
  );
  expect(button, `кнопка «${label}»`).toBeTruthy();
  fireEvent.click(button!);
}

/**
 * Чекбокс набора по его имени. `getByLabelText` не годится: подпись чекбокса antd — соседний `span`
 * внутри общего `label`, и таких в форме несколько.
 */
function grantBox(name: string): HTMLInputElement | null {
  const wrapper = [...document.querySelectorAll('label.ant-checkbox-wrapper')].find((el) =>
    el.textContent?.includes(name),
  );
  return wrapper?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
}

/** Есть ли поле полномочий на экране: у трёх случаев из §6 его не бывает вовсе. */
const grantsFieldShown = (): boolean => screen.queryByText('Полномочия') !== null;

/** Поле формы заперто: antd вешает признак на обёртку выбора, а не на видимый ввод. */
function selectDisabled(labelText: string): boolean {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  const id = label?.getAttribute('for');
  const input = id ? document.getElementById(id) : null;
  return !!input?.closest('.ant-select')?.classList.contains('ant-select-disabled');
}

/** Тело последней правки: `grants` в нём — то самое высказывание (§4). */
function lastBody(http: HttpMock): Record<string, unknown> {
  const call = http.lastCall(PATCH);
  expect(call, 'правка не ушла на сервер').toBeTruthy();
  return call!.body as Record<string, unknown>;
}

describe('где поле полномочий есть и где его нет (§6, Р9)', () => {
  it('появляется по выбранной роли, а до неё каталог не спрашивается', async () => {
    // Список наборов задаёт роль, выбранная в форме, а не роль в базе (Р2): пока её не выбрали,
    // спрашивать нечего — полномочия выдаются поверх должности.
    const http = renderTab([PENDING]);
    await openCard(PENDING.email, 'Рассмотреть заявку');

    expect(grantsFieldShown()).toBe(false);
    expect(http.countOf(CATALOG)).toBe(0);

    await selectOption('Роль', roleLabels.manager);

    await waitFor(() => expect(grantBox(SYSTEM.name)).toBeTruthy());
    expect(grantsFieldShown()).toBe(true);
    expect(http.lastCall(CATALOG)?.query.get('role')).toBe('manager');
    // Несовместимого с ролью набора в списке нет вовсе — отбор делает сервер, а не экран.
    expect(grantBox(ORDERING.name)).toBeNull();
  });

  it('у роли «Водитель» его нет: наборов она не принимает ни одним способом', async () => {
    const http = renderTab([PENDING], {
      // Водительская роль открывает поле работника, а оно спрашивает кандидатов на привязку.
      'GET /users/person-candidates': () => json({ items: [] }),
    });
    await openCard(PENDING.email, 'Рассмотреть заявку');

    await selectOption('Роль', roleLabels.driver);

    await waitFor(() => expect(screen.queryByLabelText('Работник')).toBeTruthy());
    expect(grantsFieldShown()).toBe(false);
    expect(http.countOf(CATALOG)).toBe(0);
  });

  it('в своей учётке его нет вовсе — себе полномочия не правятся', async () => {
    // Инвариант 6 ADR 0106 рядом с «нельзя менять себе роль». Недоступное портал не показывает
    // даже выключенным, поэтому проверяется и отсутствие поля, и отсутствие запроса за каталогом.
    const http = renderTab(
      [shtab({ grants: [grantRef()] })],
      {},
      authUser({ role: 'admin', id: SHTAB_ID }),
    );
    await openCard(account().email);

    expect(grantsFieldShown()).toBe(false);
    expect(http.countOf(CATALOG)).toBe(0);
  });
});

describe('что поле показывает', () => {
  it('взведённые переводом ролей отмечены и заблокированы', async () => {
    // Снять такое назначение можно только в реестре выдач: здесь оно выглядело бы галочкой среди
    // прочих, а снимается им часть подготовленного перевода (Р4, ADR 0113).
    renderTab([
      account({
        role: 'site',
        constructionObjects: [OBJECT],
        grants: [orderingRef({ origin: 'migration' })],
      }),
    ]);
    await openCard(account().email);

    const box = await waitFor(() => {
      const found = grantBox(ORDERING.name);
      if (!found) throw new Error('набора нет в списке полномочий');
      return found;
    });
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/взведено переводом ролей/)).toBeTruthy();
  });

  it('несовместимые назначения названы справкой под полем', async () => {
    // «Аудитор» выдан, но роли «Площадка» он не действует: чекбоксом его не показать (список
    // отобран ролью), а вопрос «почему в списке нет набора, который я точно выдавал» остаётся.
    renderTab([account({ role: 'site', constructionObjects: [OBJECT], grants: [grantRef()] })]);
    await openCard(account().email);

    expect(
      await screen.findByText(
        new RegExp(`Ещё выдано, но этой роли не действует: «${CUSTOM.name}»`),
      ),
    ).toBeTruthy();
  });

  it('смена роли объявляет последствие, а не снятие', async () => {
    // Назначение остаётся жить, гаснут только права по нему — и сказать это форма обязана в тот
    // момент, когда пришёл каталог новой роли: до него неизвестно, что именно перестаёт действовать.
    renderTab([account({ role: 'site', constructionObjects: [OBJECT], grants: [orderingRef()] })]);
    await openCard(account().email);
    await waitFor(() => expect(grantBox(ORDERING.name)?.checked).toBe(true));

    await selectOption('Роль', roleLabels.manager);

    expect(await screen.findByText(/не действует; назначение остаётся/)).toBeTruthy();
  });
});

describe('тело запроса: обе стороны перехода (§6, §4.3)', () => {
  it('shtab → site: зажигаемый набор уходит строкой с selected: true', async () => {
    // Тот самый сценарий, ради которого заведён диапазон: у «Штаба» взведённое переводом назначение
    // несовместимо и скрыто, у «Площадки» — совместимо. Галочку никто не ставил, её поставила
    // гидратация, и не назови форма набор — сервер отозвал бы его вместе с `id`, которого ищет
    // откат перевода ролей.
    const record = shtab({ grants: [orderingRef({ roleMismatch: true, origin: 'migration' })] });
    const http = renderTab([record]);
    await openCard(record.email);

    await waitFor(() => expect(grantBox(CUSTOM.name)).toBeTruthy());
    expect(grantBox(ORDERING.name)).toBeNull();

    await selectOption('Роль', roleLabels.site);
    await waitFor(() => expect(grantBox(ORDERING.name)?.checked).toBe(true));

    /*
     * Строка «Добавится» считается двумя полными субъектами от роли **из формы**, а не вычитанием
     * из прав записи: вычитание вернуло бы сюда и права самой должности — у заявки список прав пуст
     * вовсе, а у правки описывает прежнего человека.
     */
    const added = await screen.findByText(/Добавится сверх должности/);
    expect(added.textContent).toContain(PERMISSION_CATALOG['vehicleRequests.create'].label);
    expect(added.textContent).not.toContain(PERMISSION_CATALOG['wasteRequests.create'].label);

    clickButton('Сохранить');

    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    const body = lastBody(http);
    expect(body.role).toBe('site');
    // Версия — каталожная: подписывают тот состав, который форма показала подсказкой (Р7).
    expect(body.grants as GrantStatement[]).toEqual([
      { id: ORDERING_ID, version: ORDERING.version, selected: true },
    ]);
  });

  it('обратный переход: гасимый набор уходит строкой с selected: false', async () => {
    /*
     * В плане это `site → shtab`; упраздняемые роли форма не предлагает (ADR 0113), поэтому роль
     * после правки здесь «Менеджер». Существенно ровно одно и то же: набор был совместим с ролью до
     * правки и несовместим с ролью после, в группе чекбоксов его после смены нет вовсе, а строка о
     * нём обязана прийти — `false` в ней означает «вижу, что перестаёт действовать», а не «снять».
     */
    const record = account({
      role: 'site',
      constructionObjects: [OBJECT],
      grants: [orderingRef()],
    });
    const http = renderTab([record]);
    await openCard(record.email);
    await waitFor(() => expect(grantBox(ORDERING.name)?.checked).toBe(true));

    await selectOption('Роль', roleLabels.manager);
    await waitFor(() => expect(grantBox(SYSTEM.name)).toBeTruthy());
    expect(grantBox(ORDERING.name)).toBeNull();

    clickButton('Сохранить');

    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    const body = lastBody(http);
    expect(body.role).toBe('manager');
    // Версия здесь не каталожная и быть ею не может: в каталоге «Менеджера» набора нет — она
    // приходит из назначения (Р7). А совместимый, но не отмеченный «Согласование ИТ» в теле не
    // назван: операция о нём ничего не решает (§4.2).
    expect(body.grants as GrantStatement[]).toEqual([
      { id: ORDERING_ID, version: ORDERING_ASSIGNED_VERSION, selected: false },
    ]);
  });

  it('правка без смены роли подтверждает выданное, а не молчит о нём', async () => {
    // Полнота высказывания (§4.2): управляемое назначение названо и здесь — иначе «снял» было бы
    // неотличимо от «не показал», и сервер отклонил бы обычную правку.
    const record = account({
      role: 'site',
      constructionObjects: [OBJECT],
      grants: [orderingRef()],
    });
    const http = renderTab([record]);
    await openCard(record.email);
    await waitFor(() => expect(grantBox(ORDERING.name)?.checked).toBe(true));
    // С полным каталогом роль правится: тем же признаком ниже проверяется, что неполный её запирает.
    expect(selectDisabled('Роль')).toBe(false);

    clickButton('Сохранить');

    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    expect(lastBody(http).grants as GrantStatement[]).toEqual([
      { id: ORDERING_ID, version: ORDERING.version, selected: true },
    ]);
  });

  it('снятая галочка уходит строкой с selected: false — это и есть отзыв', async () => {
    const record = account({
      role: 'site',
      constructionObjects: [OBJECT],
      grants: [orderingRef()],
    });
    const http = renderTab([record]);
    await openCard(record.email);
    const box = await waitFor(() => {
      const found = grantBox(ORDERING.name);
      if (!found) throw new Error('набора нет в списке полномочий');
      return found;
    });

    fireEvent.click(box);
    await waitFor(() => expect(grantBox(ORDERING.name)?.checked).toBe(false));
    clickButton('Сохранить');

    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    expect(lastBody(http).grants as GrantStatement[]).toEqual([
      { id: ORDERING_ID, version: ORDERING.version, selected: false },
    ]);
  });
});

describe('неполный каталог запирает форму (§6)', () => {
  const BROKEN: [string, RouteMap][] = [
    [
      'страница пришла пустой при обещанном итоге',
      { [CATALOG]: () => json(list([] as GrantDto[], { total: 5 })) },
    ],
    [
      'запрос за каталогом отказал',
      { [CATALOG]: () => apiError(500, { code: 'err.internal', message: 'Сервис недоступен' }) },
    ],
  ];

  for (const [name, routes] of BROKEN) {
    it(`${name}: поле и роль заперты, а grants в тело не уходит`, async () => {
      /*
       * Тело правки декларативно: не названное назначение сервер прочитал бы как «сняли». Поэтому
       * поле, не увидевшее списка целиком, не высказывается вовсе — а вместе с ним запирается и
       * роль: молчание законно лишь пока роль не переключает действие назначений (§4.2), и форма не
       * должна доводить до отказа, причину которого создала сама.
       */
      const record = account({
        role: 'site',
        constructionObjects: [OBJECT],
        grants: [orderingRef()],
      });
      const http = renderTab([record], routes);
      await openCard(record.email);

      expect(await screen.findByText('Список полномочий загрузился не полностью')).toBeTruthy();
      expect(
        await screen.findByText(/Роль не меняется, пока не загрузился список полномочий/),
      ).toBeTruthy();
      await waitFor(() => expect(selectDisabled('Роль')).toBe(true));

      clickButton('Сохранить');

      await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
      const body = lastBody(http);
      // Правка сохраняет всё остальное, назначений не касаясь.
      expect(body).not.toHaveProperty('grants');
      expect(body.lastName).toBe(record.lastName);
    });
  }
});

describe('отказ сервера (Р8, Р7)', () => {
  const FIELD_TEXT = 'Форма показала не все полномочия учётной записи — откройте карточку заново';
  const VIOLATION = 'Набор «Заказ техники»: права сходятся в одной учётке';
  const TOAST = 'Полномочия не сохранены';

  it('400 с деталями ложится на поле, а не общим сообщением', async () => {
    // Отказ указывает туда, где видно, какая галочка виновата: общим тостом администратор узнал бы
    // только, что сохранить не вышло.
    const record = account({
      role: 'site',
      constructionObjects: [OBJECT],
      grants: [orderingRef()],
    });
    renderTab([record], {
      [PATCH]: () => ({
        status: 400,
        body: {
          code: 'err.validation',
          message: TOAST,
          fields: { grants: FIELD_TEXT },
          details: { violations: [{ code: 'duty_conflict', message: VIOLATION }], holders: [] },
        },
      }),
    });
    await openCard(record.email);
    await waitFor(() => expect(grantBox(ORDERING.name)?.checked).toBe(true));

    clickButton('Сохранить');

    expect(await screen.findByText(FIELD_TEXT)).toBeTruthy();
    expect(await screen.findByText(VIOLATION)).toBeTruthy();
    expect(screen.queryByText(TOAST)).toBeNull();
  });

  it('409 по версии набора уводит открывать карточку заново', async () => {
    // Состав набора изменили между открытием карточки и сохранением: подписывали не то, что
    // применилось бы, и исход у этого один — перечитать.
    const record = account({
      role: 'site',
      constructionObjects: [OBJECT],
      grants: [orderingRef()],
    });
    const http = renderTab([record], {
      [PATCH]: () =>
        apiError(409, {
          code: 'grant_impact_changed',
          message: `Полномочие «${ORDERING.name}» изменили`,
        }),
    });
    await openCard(record.email);
    await waitFor(() => expect(grantBox(ORDERING.name)?.checked).toBe(true));
    const before = http.countOf(USERS);

    clickButton('Сохранить');

    expect(
      await screen.findByText(/состав полномочия изменили, откройте карточку заново/),
    ).toBeTruthy();
    await waitFor(() => expect(http.countOf(USERS)).toBeGreaterThan(before));
  });
});
