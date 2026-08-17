import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  NON_GRANTABLE_PERMISSIONS,
  PERMISSION_CATALOG,
  permissionModuleLabels,
  roleLabels,
  type GrantDto,
  type UpdateGrantInput,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import {
  CUSTOM,
  CUSTOM_ID,
  GRANT_ACCOUNTS,
  grantCard,
  grantImpact,
  HASH,
  MANAGER_ID,
  NEXT_HASH,
  SHTAB_ID,
  SYSTEM,
} from './factories/grants';
import { selectOption } from './antd';
import { AccessGrantsTab } from '../src/pages/admin/AccessGrantsTab';
import { AccessTab } from '../src/pages/admin/AccessTab';

/**
 * Каталог полномочий и конструктор набора (ADR 0106, этап 3; план §12).
 *
 * Проверяется то, из-за чего этот экран может раздать доступ мимо модели, и ничего сверх того.
 * Барьеры выдачи, сироты состава и приговор по держателям считает сервер — их сверяют тесты API; на
 * портале же ошибиться можно тремя способами: показать в списке право, которого набор нести не
 * может; открыть на правку набор, живущий в коде; применить правку, последствий которой никто не
 * видел. Реестр выдач — предмет соседнего файла (`access-grants-holders.test.tsx`).
 *
 * Ни одного правила модели тест не переписывает: невыдаваемые права берутся константой контрактов,
 * подписи прав и ролей — их словарями, а текст нарушения приходит «с сервера» ответом мока — ровно
 * так, как его отдаёт ручка.
 */

const PREVIEW = `POST /grants/${CUSTOM_ID}/preview`;
const PATCH = `PATCH /grants/${CUSTOM_ID}`;

function renderCatalog(routes: RouteMap = {}, grants: GrantDto[] = [CUSTOM, SYSTEM]): HttpMock {
  const http = mockHttp({
    'GET /grants': () => json(list(grants)),
    'GET /users': () => json(list(GRANT_ACCOUNTS)),
    ...routes,
  });
  renderWithUser(<AccessGrantsTab />, { user: authUser({ role: 'admin' }) });
  return http;
}

async function rowWith(text: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(text),
    );
    if (!found) throw new Error(`строки «${text}» в каталоге нет`);
    return found as HTMLElement;
  });
}

/** Конструктор открывается кликом по строке — так его открывает администратор. */
async function openBuilder(name: string): Promise<void> {
  fireEvent.click(await rowWith(name));
  await screen.findByText('Что откроется');
}

const clickButton = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole('button', { name }));

describe('каталог полномочий', () => {
  it('во вкладке «Права» есть подвкладка «Полномочия»', async () => {
    // Каталог живёт там же, где витрина модели доступа, и открыт тем же правом `users.manage`:
    // отдельного права у него нет намеренно (инвариант 1 решения 6).
    mockHttp({
      'GET /users': () => json(list(GRANT_ACCOUNTS)),
      'GET /grants': () => json(list([CUSTOM])),
    });
    renderWithUser(<AccessTab />, { user: authUser({ role: 'admin' }) });

    const tab = await waitFor(() => {
      const found = [...document.querySelectorAll('.ant-tabs-tab-btn')].find(
        (el) => el.textContent?.trim() === 'Полномочия',
      );
      if (!found) throw new Error('подвкладки «Полномочия» нет');
      return found as HTMLElement;
    });
    fireEvent.click(tab);
    expect(await screen.findByText(CUSTOM.name)).toBeTruthy();
  });

  it('показывает наборы и отличает системный от пользовательского', async () => {
    renderCatalog();

    const custom = await rowWith(CUSTOM.name);
    expect(within(custom).getByText('Пользовательское')).toBeTruthy();
    expect(within(custom).getByText(CUSTOM.code)).toBeTruthy();
    // Держатели и совместимые роли — то, ради чего каталог читают перед правкой: число выдач
    // отличается от числа прав, иначе проверка не различала бы две колонки.
    expect(within(custom).getByText(String(CUSTOM.holderCount))).toBeTruthy();
    expect(within(custom).getByText(String(CUSTOM.permissions.length))).toBeTruthy();
    expect(within(custom).getByText(roleLabels.shtab)).toBeTruthy();

    const system = await rowWith(SYSTEM.name);
    expect(within(system).getByText('Системное')).toBeTruthy();
    // У набора без выдач ноль показан пометкой: пустая клетка читалась бы как «неизвестно».
    expect(within(system).getByText('нет')).toBeTruthy();
  });

  it('отбор по классу уходит на сервер параметром `kind`', async () => {
    // Отбирает сервер: каталог листается страницами, и клиентский фильтр показывал бы «системных
    // нет» на странице, где их просто не оказалось.
    const http = renderCatalog();
    await rowWith(CUSTOM.name);

    await selectOption('Класс набора', 'Системные');

    await waitFor(() => expect(http.lastCall('GET /grants')?.query.get('kind')).toBe('system'));
  });
});

describe('конструктор набора', () => {
  it('не показывает невыдаваемых прав и роли водителя', async () => {
    renderCatalog();
    await openBuilder(CUSTOM.name);

    // Список ролей — без водителя: кабинет открывает задание конкретного работника, и добавить к
    // нему чужие права нельзя ни одним способом (барьер 2).
    expect(screen.queryByText(roleLabels.driver)).toBeNull();
    // Совместимая роль в списке есть — иначе проверка выше проходила бы на пустом перечне ролей.
    expect(screen.getAllByText(roleLabels.shtab).length).toBeGreaterThan(0);

    // Ни одного защищённого права в списке нет вовсе — не выключенным чекбоксом, а отсутствием
    // строки: константа читается из контрактов, чтобы тест не жил по своей копии списка.
    for (const permission of NON_GRANTABLE_PERMISSIONS) {
      expect(
        screen.queryByText(PERMISSION_CATALOG[permission].label),
        `${permission} не должно предлагаться`,
      ).toBeNull();
    }
    // Выдаваемое право при этом на месте — иначе проверка проходила бы на пустом списке.
    expect(screen.getAllByText(PERMISSION_CATALOG['audit.read'].label).length).toBeGreaterThan(0);
  });

  it('справа показано, что откроется: модуль, чтение и кому набор положен', async () => {
    // Предпросмотр состава считается по отмеченному, а не по строке каталога: панель — ответ на
    // «что я собрал», и отставать от галочек она не имеет права.
    renderCatalog();
    await openBuilder(CUSTOM.name);

    // Правая колонка целиком: подпись «Что откроется» стоит над панелью, и искать внутри неё —
    // значит искать в соседних колонках заодно (подписи прав повторяются в списке).
    const panel = screen.getByText('Что откроется').closest('.ant-col') as HTMLElement;
    expect(within(panel).getByText('Открывается модулей: 1')).toBeTruthy();
    expect(within(panel).getByText(permissionModuleLabels.admin)).toBeTruthy();
    expect(within(panel).getByText(/Смотрит:/)).toBeTruthy();
    expect(within(panel).getByText(roleLabels.shtab)).toBeTruthy();

    // Снятая роль немедленно меняет ответ «кому можно выдать»: набор без ролей не откроет ничего
    // никому, и сказать это надо до сохранения.
    fireEvent.click(screen.getByLabelText(roleLabels.shtab));
    expect(await within(panel).findByText(/Роли не отмечены/)).toBeTruthy();
  });

  it('системный набор открывается просмотром, а копия заводится пользовательским набором', async () => {
    const http = renderCatalog({ 'POST /grants': () => json(grantCard(), 201) });
    await openBuilder(SYSTEM.name);

    expect(screen.getByText('Только просмотр')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull();
    clickButton('Создать копию');

    // Копия — обычное заведение: свой код, то же наполнение. Правка системного набора отвязала бы
    // его от таблиц кода, поэтому другого способа изменить его состав экран не предлагает.
    await screen.findByDisplayValue(`${SYSTEM.code}_copy`);
    clickButton('Создать');

    await waitFor(() => expect(http.countOf('POST /grants')).toBe(1));
    const body = http.lastCall('POST /grants')?.body as { permissions: string[]; roles: string[] };
    expect([...body.permissions].sort()).toEqual([...SYSTEM.permissions].sort());
    expect(body.roles).toEqual(SYSTEM.roles);
  });

  it('нарушение барьера приходит с сервера и показывается словами', async () => {
    // Приговор считает сервер — предпросмотр отдаёт его в теле, а не отказом, — и экран обязан
    // показать причину теми же словами и не дать сохранить.
    const message =
      'Набор «Аудитор»: право «Читает журнал действий» (audit.read) нельзя выдать роли «Комендант»: у модуля «Администрирование» нет фильтрации по её области.';
    const http = renderCatalog({
      [PREVIEW]: () =>
        json(
          grantImpact({
            violations: [{ code: 'module_forbidden_for_axis', message, permission: 'audit.read' }],
          }),
        ),
    });
    await openBuilder(CUSTOM.name);
    clickButton('Сохранить');

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByText('Так сохранить нельзя')).toBeTruthy();
    // Кнопки подтверждения нет вовсе: недоступное портал скрывает, а не выключает.
    expect(screen.queryByRole('button', { name: 'Подтвердить правку' })).toBeNull();
    expect(http.countOf(PATCH)).toBe(0);
  });

  it('правка уходит только после предпросмотра и с его отпечатком', async () => {
    const http = renderCatalog({
      [PREVIEW]: () => json(grantImpact()),
      [PATCH]: () => json(grantCard()),
    });
    await openBuilder(CUSTOM.name);

    // Отмечаем ещё одно право — правка состава, которая и меняет доступ держателям.
    fireEvent.click(screen.getByLabelText(PERMISSION_CATALOG['mailings.read'].label));
    clickButton('Сохранить');

    // Сначала расчёт: последствия видит человек, а не сервер в одиночку.
    await waitFor(() => expect(http.countOf(PREVIEW)).toBe(1));
    expect(http.countOf(PATCH)).toBe(0);
    expect(await screen.findByText(/Затронет 1 учётку/)).toBeTruthy();
    // Дельта названа по держателю и словами, а не кодами прав.
    expect(
      screen.getByText(new RegExp(`добавится: ${PERMISSION_CATALOG['mailings.read'].label}`)),
    ).toBeTruthy();

    clickButton('Подтвердить правку');

    await waitFor(() => expect(http.countOf(PATCH)).toBe(1));
    const body = http.lastCall(PATCH)?.body as UpdateGrantInput;
    // Отпечаток и версия — из показанного предпросмотра: подтверждается ровно то, что показано.
    expect(body.expectedImpactHash).toBe(HASH);
    expect(body.expectedVersion).toBe(CUSTOM.version);
    expect([...(body.permissions ?? [])].sort()).toEqual(['audit.read', 'mailings.read']);
  });

  it('409 приводит к перечитыванию предпросмотра, а не к повтору запроса', async () => {
    /*
     * Не совпавший отпечаток означает «за это время изменилось то, от чего расчёт зависел». Повтор
     * с новым отпечатком применил бы правку, которой никто не видел, поэтому экран перечитывает
     * предпросмотр, показывает его заново и ждёт второго подтверждения — уже с новой версией.
     */
    let previews = 0;
    let patches = 0;
    const second = grantImpact({
      version: CUSTOM.version + 1,
      expectedImpactHash: NEXT_HASH,
      users: [
        ...grantImpact().users,
        {
          userId: MANAGER_ID,
          fullName: 'Менеджеров Максим',
          role: 'manager',
          added: ['mailings.read'],
          removed: [],
          roleMismatch: false,
        },
      ],
    });
    const http = renderCatalog({
      [PREVIEW]: () => {
        previews += 1;
        return json(previews === 1 ? grantImpact() : second);
      },
      [PATCH]: () => {
        patches += 1;
        return patches === 1
          ? apiError(409, {
              code: 'grant_impact_changed',
              message: 'Полномочие выдали ещё одной учётке, пока вы смотрели предпросмотр',
            })
          : json(grantCard());
      },
    });
    await openBuilder(CUSTOM.name);
    clickButton('Сохранить');

    await screen.findByText(/Затронет 1 учётку/);
    clickButton('Подтвердить правку');

    // Предпросмотр перечитан, и об этом сказано словами сервера: молча повторить нельзя.
    await waitFor(() => expect(http.countOf(PREVIEW)).toBe(2));
    expect(
      await screen.findByText(/Полномочие выдали ещё одной учётке, пока вы смотрели предпросмотр/),
    ).toBeTruthy();
    expect(await screen.findByText(/Затронет 2 учётки/)).toBeTruthy();
    expect(http.countOf(PATCH)).toBe(1);

    // Второе подтверждение уходит с новым отпечатком и новой версией — иначе 409 стал бы вечным.
    // Имя кнопки — образцом: после отказа на ней ещё догорает крутилка, и её `aria-label`
    // («loading») входит в доступное имя, пока jsdom не проиграет анимацию.
    clickButton(/Подтвердить правку/);
    await waitFor(() => expect(http.countOf(PATCH)).toBe(2));
    const body = http.lastCall(PATCH)?.body as UpdateGrantInput;
    expect(body.expectedImpactHash).toBe(NEXT_HASH);
    expect(body.expectedVersion).toBe(CUSTOM.version + 1);
    // Первый затронутый остался тем же человеком: перечитанный расчёт — про тот же набор.
    expect(second.users[0]!.userId).toBe(SHTAB_ID);
  });
});
