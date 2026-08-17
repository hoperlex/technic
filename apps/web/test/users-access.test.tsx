import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  PERMISSION_CATALOG,
  permissionModuleLabels,
  permissionsFor,
  roleAddonLabels,
  roleLabels,
  type AccessSubject,
  type Permission,
  type UserAccountDto,
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
 * Отсюда состав проверок: право приходит с именами **всех** своих источников (роль это, надстройка
 * или набор — главный вопрос пересмотра ролей), учётка без области помечена, незанятый профиль назван
 * незанятым, а право, запертое в одной роли, — запертым, пока его не выдали набором. Сами наборы
 * прав здесь не сверяются: за них отвечает `apps/api/test/permissions.test.ts`, и дублировать
 * матрицу в тесте портала значило бы завести её вторую копию ровно там, где витрина не должна её
 * иметь.
 *
 * **Права в фикстуре — поле записи, а не вывод из роли** (ADR 0106, этап 2б): сервер считает их сам
 * и отдаёт списком, витрина по нему и работает. Поэтому по умолчанию их подставляет матрица от той
 * же тройки (так отвечает сервер учётке без наборов), а сценарий про наборы задаёт свой список —
 * именно этим состояние «право пришло набором» и становится выразимым.
 */

/** Права, которые сервер отдаст учётке: должность плюс права её наборов, порядок словарный. */
const effective = (subject: AccessSubject, ...fromGrants: Permission[]): Permission[] => [
  ...permissionsFor({ ...subject, grantPermissions: fromGrants }),
];

function user(over: Partial<UserAccountDto> = {}): UserAccountDto {
  const base: UserAccountDto = {
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
    /** Наборы (ADR 0106): у учётки без выдач их нет, и сценарий назначает их сам. */
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
  // Список сервера: заданный сценарием — как есть, иначе матрица от тройки учётки. Пустой список,
  // заданный явно, тоже остаётся пустым — это учётка без роли, и права ей выводить не из чего.
  return { ...base, permissions: over.permissions ?? effective(base) };
}

const SHTAB = user();

/**
 * Тот же штаб, но с системным набором (ADR 0086, 0106): его права приходят из двух источников сразу.
 * Код набора и пометка надстройки стоят рядом, как их отдаёт сервер, — пометка выводится из кода
 * (`systemAddonsOf`), а не хранится отдельно.
 */
const EQUIPMENT_OPERATOR = user({
  id: 'u-2',
  email: 'orgtech@example.test',
  lastName: 'Оргтехников',
  firstName: 'Олег',
  fullName: 'Оргтехников Олег Олегович',
  addons: ['office_equipment_operator'],
  grantCodes: ['office_equipment_operator'],
});

/**
 * Штаб, которому набор дал право сверх должности, — тот самый случай, ради которого расчётную часть
 * витрины и переписывали.
 *
 * Набор собран администратором в проде: матрица про него не знает ничего, кода `auditor` в
 * контрактах нет, и вывести это право из роли нельзя ни одним способом. Право выбрано не случайно —
 * `audit.read` матрица держит у одного администратора, и на нём проверяется сразу и подпись
 * источника, и пометка «только у администратора», которая обязана замолчать.
 */
const AUDITOR = user({
  id: 'u-6',
  email: 'auditor@example.test',
  lastName: 'Аудиторов',
  firstName: 'Артём',
  fullName: 'Аудиторов Артём Артёмович',
  grantCodes: ['auditor'],
  permissions: effective({ role: 'shtab' }, 'audit.read'),
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

/**
 * Водитель (ADR 0102): область у роли своя, четвёртая — карточка работника, чьё задание показывает
 * кабинет. Ни объектов, ни отделов, ни контрагента у учётки нет, и «Все записи» ей писать нельзя.
 *
 * ФИО работника нарочно полнее ФИО учётки: так проверка колонки «Область» смотрит на саму область,
 * а не на повторённого сотрудника из соседней колонки.
 */
const DRIVER = user({
  id: 'u-5',
  email: 'driver@example.test',
  lastName: 'Водителев',
  firstName: 'Виктор',
  middleName: '',
  fullName: 'Водителев Виктор',
  role: 'driver',
  constructionObjects: [],
  person: {
    id: 'p-1',
    lastName: 'Водителев',
    firstName: 'Виктор',
    middleName: 'Викторович',
    fullName: 'Водителев Виктор Викторович',
    phone: '',
    email: 'driver@example.test',
    deletedAt: null,
  },
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

function renderAccess(users: UserAccountDto[] = [SHTAB]) {
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

/**
 * Строка права в карточке доступа — вместе с подписью источника: источник проверяется у самой
 * строки, а не где-нибудь в карточке. «Источник упомянут» не отвечает на вопрос «чем выдано вот это».
 */
function permissionLine(card: HTMLElement, permission: Permission): HTMLElement {
  return within(card).getAllByText(new RegExp(PERMISSION_CATALOG[permission].label))[0]!;
}

/**
 * Отбор «у кого есть право…». Поле без подписи — это полоса фильтров, не форма, — поэтому находится
 * по своей подсказке, а вариант выбирается через поиск: список прав длинный и рисуется виртуально,
 * так что нужной строки в разметке может не быть вовсе, пока её не отобрали. Так его ищет и человек —
 * точной формулировки права он не помнит.
 */
async function filterByPermission(optionLabel: string): Promise<void> {
  const placeholder = [...document.querySelectorAll('.ant-select-placeholder')].find((el) =>
    el.textContent?.startsWith('У кого есть право'),
  );
  expect(placeholder, 'отбор «у кого есть право…»').toBeTruthy();
  const field = placeholder!.closest('.ant-select') as HTMLElement;
  fireEvent.mouseDown(field.querySelector('.ant-select-content') ?? field);
  fireEvent.change(field.querySelector('input')!, { target: { value: optionLabel } });
  // Выпадашка ищется среди открытых, а не по id поля: в тестах id у полей общий, и поиск по нему
  // молча уходил бы в чужой список.
  const option = await waitFor(() => {
    const dropdown = [...document.querySelectorAll('.ant-select-dropdown')].find(
      (d) => !d.classList.contains('ant-select-dropdown-hidden'),
    );
    const found = [...(dropdown?.querySelectorAll('.ant-select-item-option') ?? [])].find((o) =>
      o.textContent?.includes(optionLabel),
    );
    if (!found) throw new Error(`варианта «${optionLabel}» в списке прав нет`);
    return found as HTMLElement;
  });
  fireEvent.click(option);
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
    expect(permissionLine(card, 'officeEquipment.write').textContent).toContain(
      `надстройка «${roleAddonLabels.office_equipment_operator}»`,
    );

    // Право той же учётки, пришедшее должностью, подписано ролью — иначе витрина сваливала бы в
    // надстройку весь доступ человека, у которого она есть.
    expect(permissionLine(card, 'wasteRequests.create').textContent).toContain(
      `роль «${roleLabels.shtab}»`,
    );
  });

  /**
   * Право из набора — то состояние, которого до этапа 2б витрина выразить не могла: считая доступ по
   * роли, она такого права не видела вовсе, а увидев — приписала бы его должности.
   *
   * Проверяются оба ответа сразу: наборное право подписано набором, ролевое той же учётки — ролью.
   * Одной первой проверки мало — подпиши витрина набором всё подряд, она бы её тоже прошла.
   */
  it('право, пришедшее набором, подписано в карточке набором', async () => {
    renderAccess([AUDITOR]);

    const card = await openCard(AUDITOR.fullName);
    expect(permissionLine(card, 'audit.read').textContent).toContain('набор');
    expect(permissionLine(card, 'wasteRequests.create').textContent).toContain(
      `роль «${roleLabels.shtab}»`,
    );
  });

  /**
   * Границу собственного знания витрина обязана назвать сама. Коды наборов у неё есть, состава
   * наборов — нет: сервер отдаёт объединение прав, и «это право, наверное, из этого набора» было бы
   * догадкой, по которой решают, что отзывать.
   */
  it('карточка показывает наборы учётки и признаётся, что их состава не знает', async () => {
    renderAccess([AUDITOR]);

    const card = await openCard(AUDITOR.fullName);
    expect(within(card).getByText('auditor')).toBeTruthy();
    expect(within(card).getByText(/какое право пришло каким набором/i)).toBeTruthy();
  });

  it('колонка «Наборы»: у системного набора подпись, у собранного — код', async () => {
    renderAccess([SHTAB, EQUIPMENT_OPERATOR, AUDITOR]);

    // Собранный администратором набор витрина знает только по коду — имён наборов ей пока никто не
    // отдаёт, и придумывать их по коду она не должна.
    expect(within(await rowWith(AUDITOR.fullName)).getByText('auditor')).toBeTruthy();

    // У системного стоит подпись его надстройки: тот же набор виден в колонке роли пометкой, и код
    // рядом с ней читался бы как второй, неизвестный набор.
    const system = await rowWith(EQUIPMENT_OPERATOR.fullName);
    expect(within(system).queryByText('office_equipment_operator')).toBeNull();
    expect(
      within(system).getAllByText(roleAddonLabels.office_equipment_operator).length,
    ).toBeGreaterThanOrEqual(2);

    // Учётка без выдач: пустая клетка, а не пометка — набора у неё нет, и это обычное дело.
    expect(within(await rowWith(SHTAB.fullName)).getAllByText('—').length).toBeGreaterThan(0);
  });

  /**
   * Модуль, открытый набором. До этапа 2б колонка спрашивала матрицу и показывала такой модуль
   * закрытым — то есть отвечала «раздела у него нет» про человека, которому раздел открыт.
   */
  it('колонка «Модули» показывает модуль, открытый набором', async () => {
    renderAccess([SHTAB, AUDITOR]);

    const auditor = await rowWith(AUDITOR.fullName);
    expect(within(auditor).getByText(permissionModuleLabels.admin)).toBeTruthy();
    // Та же роль без набора этот модуль не открывает: иначе проверка подтверждала бы не набор, а
    // права штаба.
    const shtab = await rowWith(SHTAB.fullName);
    expect(within(shtab).queryByText(permissionModuleLabels.admin)).toBeNull();
  });

  it('фильтр «у кого есть право» находит держателя от набора', async () => {
    renderAccess([SHTAB, AUDITOR]);
    await rowWith(SHTAB.fullName);

    await filterByPermission(PERMISSION_CATALOG['audit.read'].label);

    await waitFor(() => expect(screen.queryByText(SHTAB.fullName)).toBeNull());
    expect(screen.getByText(AUDITOR.fullName)).toBeTruthy();
  });

  /**
   * Отбор «с наборами» спрашивает коды наборов, а не пометки надстроек: пометка отвечает только за
   * два системных набора, и собранный администратором в неё не попадает вовсе — то есть отбор по
   * пометкам прятал бы ровно тех держателей, ради которых его открывают.
   */
  it('отбор «с наборами» оставляет держателей собранных наборов', async () => {
    renderAccess([SHTAB, AUDITOR]);
    await rowWith(SHTAB.fullName);

    fireEvent.click(screen.getByText('С наборами'));

    await waitFor(() => expect(screen.queryByText(SHTAB.fullName)).toBeNull());
    expect(screen.getByText(AUDITOR.fullName)).toBeTruthy();
  });

  it('той же роли без надстройки право не приписывает', async () => {
    renderAccess([SHTAB]);

    const card = await openCard(SHTAB.fullName);
    const granted = PERMISSION_CATALOG['officeEquipment.write'].label;
    const readOnly = PERMISSION_CATALOG['officeEquipment.read'].label;
    expect(within(card).queryAllByText(new RegExp(granted))).toHaveLength(0);
    expect(within(card).getAllByText(new RegExp(readOnly)).length).toBeGreaterThan(0);
  });

  /**
   * Область водителя — четвёртая ось (ADR 0102), и до починки витрина печатала ему «Все записи»:
   * ось у роли есть, а `scopeAxisOf` знал только три. Утверждение о самой широкой области из
   * возможных — про учётку, которая видит ровно своё задание, — не оговорка в подписи, а ответ на
   * тот единственный вопрос, ради которого срез читают.
   */
  it('область водителя показана осью «работник», а не «Все записи»', async () => {
    renderAccess([DRIVER]);

    const row = await rowWith(DRIVER.fullName);
    expect(within(row).getByText(`Работник: ${DRIVER.person!.fullName}`)).toBeTruthy();
    expect(within(row).queryByText('Все записи')).toBeNull();
    // И то же самое в карточке доступа: ось названа, значение у неё стоит.
    const card = await openCard(DRIVER.fullName);
    expect(within(card).getByText(/Работник:/)).toBeTruthy();
    expect(within(card).getByText(DRIVER.person!.fullName)).toBeTruthy();
    expect(within(card).queryByText(/областью не ограничен/i)).toBeNull();
  });

  it('помечает учётку, которой роль требует области, а области нет', async () => {
    renderAccess([WITHOUT_SCOPE]);

    const row = await rowWith(WITHOUT_SCOPE.fullName);
    expect(within(row).getByText(/объекты не заданы/i)).toBeTruthy();
  });

  /** Та же проверка для четвёртой оси: водитель без работника не видит даже своего задания. */
  it('помечает водителя, у которого не задан работник справочника', async () => {
    renderAccess([user({ ...DRIVER, person: null })]);

    const row = await rowWith(DRIVER.fullName);
    expect(within(row).getByText(/работник не задан/i)).toBeTruthy();
    expect(within(row).queryByText('Все записи')).toBeNull();
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

  /**
   * Строка вне матрицы со свободной сборкой полномочий — норма, а не расхождение: набор заводят в
   * проде, и учётка с набором ни в один профиль `ACCESS_PROFILES` не попадает **по построению**.
   * Поэтому проверяется не только наличие строки, но и то, чем она подписана: красная пометка на
   * обычной выдаче отправила бы администратора искать поломку, которой нет.
   */
  it('срез «Профили»: собранный наборами доступ показан строкой и не выглядит ошибкой', async () => {
    renderAccess([AUDITOR]);
    await rowWith(AUDITOR.fullName);
    openSlice('Профили');

    const assembled = await rowWith('собран наборами');
    expect(within(assembled).getByText(roleLabels.shtab)).toBeTruthy();
    // Прежняя формулировка звучала расхождением модели; ни её, ни красного тега на этой строке быть
    // не должно.
    expect(screen.queryByText('вне матрицы')).toBeNull();
    expect(within(assembled).queryByText('роль не назначена')).toBeNull();

    // И обратная сторона: профиль матрицы «Штаб» остался без учёток, но роль занята — иначе «не
    // занят» прочитали бы как «под этой ролью не работает никто».
    const empty = await rowWith('у роли учёток: 1');
    expect(within(empty).getByText(roleLabels.shtab)).toBeTruthy();
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

  /**
   * Пометка «только у администратора» — единственный экран, на котором видно нарушение инварианта
   * защищённых прав (§8), и промолчать она обязана ровно тогда, когда право досталось кому-то ещё.
   * Считай её витрина по матрице — набор, выданный в проде, она бы не заметила: в `ACCESS_PROFILES`
   * такого субъекта нет и не появится.
   *
   * Проверки две, и обе обязательны: без первой вторая подтверждала бы не расчёт по держателям, а то,
   * что пометки на этой строке не бывает вовсе. Рендерятся они врозь — вторая витрина не заменяет
   * первую на экране, а становится рядом, и строку нашлась бы из прежней таблицы.
   */
  it('срез «Права»: право журнала действий заперто у администратора, пока его никому не выдали', async () => {
    renderAccess([SHTAB]);
    await rowWith(SHTAB.fullName);
    openSlice('Права');

    const audit = await rowWith(PERMISSION_CATALOG['audit.read'].label);
    expect(within(audit).getByText(`Только «${roleLabels.admin}»`)).toBeTruthy();
  });

  it('срез «Права»: пометка «только у администратора» снимается, когда право выдано набором', async () => {
    const onlyAdmin = `Только «${roleLabels.admin}»`;
    renderAccess([SHTAB, AUDITOR]);
    await rowWith(AUDITOR.fullName);
    openSlice('Права');

    const audit = await rowWith(PERMISSION_CATALOG['audit.read'].label);
    expect(within(audit).queryByText(onlyAdmin)).toBeNull();
    // И сказано, откуда право у держателя: молчание здесь читалось бы как «право никому не выдано».
    expect(within(audit).getByText('Выдано набором')).toBeTruthy();
    // Соседняя строка пометку сохранила: снялась она у одного права, а не у таблицы целиком.
    const purge = await rowWith(PERMISSION_CATALOG['records.purge'].label);
    expect(within(purge).getByText(onlyAdmin)).toBeTruthy();
  });

  /**
   * Пометка «ни у кого из живых» — компенсация за потерю статического перебора субъектов (§10.1):
   * право, розданное набором, обязано перестать выглядеть невыданным.
   */
  it('срез «Права»: право, розданное набором, не считается невыданным', async () => {
    renderAccess([SHTAB, AUDITOR]);
    await rowWith(AUDITOR.fullName);
    openSlice('Права');

    const audit = await rowWith(PERMISSION_CATALOG['audit.read'].label);
    expect(within(audit).queryByText('Ни у кого из живых')).toBeNull();
    // Право, которого нет ни у одной живой учётки, пометку сохраняет.
    const purge = await rowWith(PERMISSION_CATALOG['records.purge'].label);
    expect(within(purge).getByText('Ни у кого из живых')).toBeTruthy();
  });
});
