import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, OfficeEquipmentRequestOptionDto } from '@technic/contracts';
import { openSelectOptions, selectOption } from './antd';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { departmentUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { equipmentSelectorOption, equipmentSelectorRoutes } from './factories/officeEquipment';
import { serviceCustomer, serviceOperator, serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { ServiceRequestForm } from '../src/pages/service/ServiceRequestForm';
import { ServiceRequestConsumablesModal } from '../src/pages/service/ServiceRequestConsumables';

/**
 * Предмет заявки на обслуживание: аппарат ВНЕ своей области и срочность по праву (план
 * `docs/office-equipment-request-subject-plan.md`, Р4–Р9).
 *
 * Поиск открыт по всему активному парку компании, и найденный аппарат сплошь и рядом числится не
 * там, где стоит: качественной базы по оргтехнике нет. Проверяется здесь то, чем это оборачивается
 * в форме и в теле запроса, — и ошибка в каждом пункте молчалива.
 *
 * 1. **Плашка называет расхождение словами.** Без имени площадки она не отвечает на единственный
 *    вопрос, ради которого её и читают: «тот ли это аппарат». Ничего при этом не требует и работу
 *    не блокирует — решение заказчика: запертое заведение означало бы заявку, которую не завести в
 *    тот день, когда аппарат встал.
 * 2. **Объектная ось: заказчик и место — одно решение (Р5).** Выбранная своя площадка уходит и
 *    заказчиком, и объектом пары поправки. Запиши портал заявку на площадку карточки — автор
 *    отправил бы её и не увидел: видимость объектной роли считается именно этой колонкой (Р4).
 * 3. **Отдельская ось: заказчик и место — разные вопросы (Р6).** Свой отдел уходит заказчиком, а
 *    площадка спрашивается отдельно и только из площадок своего отдела: на чужую сервер отвечает
 *    422, и предлагать в поле отвергаемое нельзя.
 * 4. **Чужой отдел-владелец сам по себе поправку не включает (Р2, Р6).** Объект карточки свой —
 *    расходиться не с чем, и пара не ставится вовсе; плашка говорит только про отдел.
 * 5. **Автоподстановка только единственного (Р7).** Своя площадка одна — подставляется; несколько
 *    — поле открыто и ждёт выбора: молча подставленная первая по алфавиту увела бы часть заявок на
 *    чужую площадку, и заметить это было бы некому.
 * 6. **Срочность — право (Р9).** У заведения без права пары нет вовсе, при правке галочка видна и
 *    заперта: исчезнувшая читалась бы как «срочность сняли».
 *
 * Роли по имени нигде не спрашиваются: сценарий задаёт учётку с осью, а признаки области приходят
 * ответом сервера (`inOwnScope`, `objectInOwnScope`) — второго мнения о ней у портала нет.
 */

const NORTH = objectDto();
const SOUTH = objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' });
/** Площадка, на которой аппарат числится и которой у заявителя нет. */
const WEST = objectDto({ id: 'obj-9', code: 'ОБ-9', name: 'ЖК Западный' });

const NORTH_LABEL = 'ОБ-1 — ЖК Северный';
const SOUTH_LABEL = 'ОБ-2 — ЖК Южный';
const PTO_LABEL = 'ПТО — Производственно-технический';

function department(id: string, code: string, name: string) {
  return {
    id,
    code,
    name,
    isActive: true,
    // Площадки набором (ADR 0144); `object` — устаревшая проекция набора.
    objects: [],
    object: null,
    heads: [],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  };
}

const PTO = department('dep-1', 'ПТО', 'Производственно-технический');
/**
 * Второй отдел справочника — чтобы объектной роли ничего не подставлялось само. Отделы ей
 * предлагаются полным списком («от чьего имени просят», Р11б), и с единственным из них поле
 * заполнилось бы им ещё до выбора аппарата: проверки про площадку смотрели бы тогда на отдел.
 */
const SNB = department('dep-2', 'СНБ', 'Снабжение');

const IT_DEPARTMENT = { id: 'dep-9', code: 'ИТ', name: 'Служба ИТ' };

/** Аппарат чужой площадки: обе области ложны — так его видит и объектная, и отдельская роль. */
const FOREIGN_SITE_UNIT = equipmentSelectorOption({
  object: { id: WEST.id, code: WEST.code, name: WEST.name },
  inOwnScope: false,
  objectInOwnScope: false,
});

/**
 * Аппарат СВОЕЙ площадки, но чужого отдела-владельца — тот самый случай, ради которого признаков
 * области два (Р2): карточка вне области, а объект её — свой.
 */
const FOREIGN_OWNER_UNIT = equipmentSelectorOption({
  object: { id: NORTH.id, code: NORTH.code, name: NORTH.name },
  ownerDepartment: IT_DEPARTMENT,
  inOwnScope: false,
});

/**
 * Аппарат своего отдела на чужой площадке: владелец свой (`inOwnScope: true`), а стоит он там, где
 * площадок у отдела нет. Пара поправки собирается отдельным полем (Р6).
 */
const OWN_DEPARTMENT_UNIT = equipmentSelectorOption({
  object: { id: WEST.id, code: WEST.code, name: WEST.name },
  ownerDepartment: { id: PTO.id, code: PTO.code, name: PTO.name },
  objectInOwnScope: false,
});

/** Заявитель площадки: срочность ему не положена — её назначает «Ведение» (Р9). */
const REQUESTER: AuthUser = serviceCustomer({
  constructionObjectIds: [NORTH.id],
  phone: '9001234567',
});

/** Тот же заявитель, но площадок у него две: подставлять за него портал не вправе (Р7). */
const TWO_SITES: AuthUser = serviceCustomer({
  constructionObjectIds: [NORTH.id, SOUTH.id],
  phone: '9001234567',
});

/** Ведёт заявки: срочность назначает он, и пара «галочка + причина» у него есть (Р9). */
const OPERATOR: AuthUser = serviceOperator({
  constructionObjectIds: [NORTH.id],
  phone: '9001234567',
});

/** Сотрудник отдела с единственной площадкой отдела (ADR 0062): она и подставляется (Р6, Р7). */
const DEP_USER: AuthUser = departmentUser('dep-1', [NORTH.id], { phone: '9001234567' });

function renderForm(
  user: AuthUser,
  options: {
    units?: OfficeEquipmentRequestOptionDto[];
    request?: Parameters<typeof serviceRequest>[0];
    routes?: RouteMap;
  } = {},
): HttpMock {
  const http = mockHttp({
    ...equipmentSelectorRoutes(options.units ?? [FOREIGN_SITE_UNIT]),
    'GET /objects': () => json(list([NORTH, SOUTH, WEST])),
    'GET /departments': () => json(list([PTO, SNB])),
    'POST /service-requests': () => json({ request: serviceRequest(), mail: 'queued' }, 201),
    ...options.routes,
  });
  renderWithUser(
    <ServiceRequestForm
      open
      request={options.request ? serviceRequest(options.request) : null}
      onClose={() => {}}
    />,
    { user },
  );
  return http;
}

/** Что стоит в поле «Для кого заявка»: подпись выбранного варианта; `null` — поле пустое. */
function shownCustomer(): string | null {
  const field = document.getElementById('customer')?.closest('.ant-select');
  return field?.querySelector('.ant-select-content')?.getAttribute('title') ?? null;
}

/** Заперто ли поле заказчика: antd отмечает это классом обёртки, а не признаком самого ввода. */
function customerLocked(): boolean {
  const field = document.getElementById('customer')?.closest('.ant-select');
  return !!field?.classList.contains('ant-select-disabled');
}

/** Заполнить обязательное и отправить: описание к предмету теста отношения не имеет. */
function submit(): void {
  fireEvent.change(screen.getByLabelText('Описание'), {
    target: { value: 'Не захватывает бумагу' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
}

function bodyOf(http: HttpMock): Record<string, unknown> {
  return http.lastCall('POST /service-requests')?.body as Record<string, unknown>;
}

describe('плашка о чужой площадке и чужом отделе (Р4–Р6)', () => {
  it('чужая площадка названа по имени и работу не запирает', async () => {
    renderForm(REQUESTER);
    await selectOption('Какой аппарат', /Kyocera/);

    expect(await screen.findByText('Аппарат числится не за вами')).toBeDefined();
    expect(screen.getByText(/стоит на площадке «ОБ-9 — ЖК Западный»/)).toBeDefined();
    // Плашка предупреждает, а не запрещает: заявка будет записана на самого заявителя (Р4).
    expect(screen.getByText(/будет записана на вас/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('чужой отдел-владелец назван отделом, а не площадкой', async () => {
    renderForm(DEP_USER, { units: [FOREIGN_OWNER_UNIT] });
    await selectOption('Какой аппарат', /Kyocera/);

    // Аппарат стоит там же, где работает отдел, — про площадку сказать нечего, и плашка про неё
    // молчит. Расходится только владелец, о нём и речь.
    expect(await screen.findByText(/закреплён за отделом «Служба ИТ»/)).toBeDefined();
    expect(screen.queryByText(/стоит на площадке/)).toBeNull();
  });

  it('у аппарата своей площадки плашки нет вовсе', async () => {
    renderForm(REQUESTER, {
      units: [
        equipmentSelectorOption({ object: { id: NORTH.id, code: NORTH.code, name: NORTH.name } }),
      ],
    });
    await selectOption('Какой аппарат', /Kyocera/);

    // Проверка отсутствия стоит рядом с проверками показа не для симметрии: плашка на каждой
    // заявке читалась бы как отказ и через неделю перестала бы читаться вовсе.
    await waitFor(() => expect(shownCustomer()).toBe(NORTH_LABEL));
    expect(screen.queryByText('Аппарат числится не за вами')).toBeNull();
  });
});

describe('объектная ось: заказчик и объект поправки — одно решение (Р5, Р7)', () => {
  it('единственная своя площадка подставляется и уходит парой поправки', async () => {
    const http = renderForm(REQUESTER);
    await selectOption('Какой аппарат', /Kyocera/);

    // Заказчиком предлагается СВОЯ площадка, а не та, за которой числится аппарат: на площадке
    // карточки заявку не увидел бы и сам автор.
    await waitFor(() => expect(shownCustomer()).toBe(NORTH_LABEL));

    submit();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));

    const body = bodyOf(http);
    expect(body.officeEquipmentId).toBe('oe-1');
    // Пара уходит целиком, и объект в ней — тот же, что назван заказчиком: два ответа на один
    // вопрос («куда записать заявку») разъехались бы на первой же правке формы.
    expect(body.objectOverridden).toBe(true);
    expect(body.objectId).toBe(NORTH.id);
    // Заказчик-площадка уходит явным `null` в отделе (Р12а): пропуск сервер прочёл бы подсказкой.
    expect(body.customerDepartmentId).toBeNull();
  });

  it('несколько своих площадок оставляют поле открытым и пустым', async () => {
    renderForm(TWO_SITES);
    await selectOption('Какой аппарат', /Kyocera/);

    // Не заперто и не заполнено: подставленная первая по алфавиту увела бы часть заявок на чужую
    // площадку молча (Р7).
    await waitFor(() => expect(customerLocked()).toBe(false));
    expect(shownCustomer()).toBeNull();

    // В списке — только свои площадки: чужая (та, за которой числится аппарат) в него не входит,
    // и отделов там нет вовсе — заявка объектной роли держится одной колонкой площадки.
    const options = (await openSelectOptions('Для кого заявка')).map((el) => el.textContent ?? '');
    expect(options).toEqual([NORTH_LABEL, SOUTH_LABEL]);
  });
});

describe('отдельская ось: заказчик отделом, площадка отдельным полем (Р6)', () => {
  it('единственная площадка отдела подставляется и уходит парой, заказчик — отделом', async () => {
    const http = renderForm(DEP_USER, { units: [OWN_DEPARTMENT_UNIT] });
    await selectOption('Какой аппарат', /Kyocera/);

    // Поле про место, а не про заказчика: их разводит сама подпись — «Для кого заявка» отвечает
    // отделом, а место аппарата отделом не задаётся вовсе.
    await waitFor(() => expect(shownCustomer()).toBe(PTO_LABEL));
    expect(await screen.findByLabelText('На какой вашей площадке он стоит')).toBeDefined();
    // Заявленного расхождения здесь не спрашивают: оно уже названо справочником, и галочка
    // означала бы «точно ли аппарат там, где он стоит».
    expect(screen.queryByRole('checkbox', { name: 'Аппарат стоит на другом объекте' })).toBeNull();

    submit();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));

    const body = bodyOf(http);
    expect(body.customerDepartmentId).toBe(PTO.id);
    expect(body.objectOverridden).toBe(true);
    expect(body.objectId).toBe(NORTH.id);
  });

  it('выбор площадки ограничен площадками своего отдела', async () => {
    // Две площадки у отдела: с одной `AutoSelect` подставил бы её сам, и «список ограничен» было
    // бы неотличимо от «в списке одна строка».
    const twoSites = departmentUser('dep-1', [NORTH.id, SOUTH.id], { phone: '9001234567' });
    renderForm(twoSites, { units: [OWN_DEPARTMENT_UNIT] });
    await selectOption('Какой аппарат', /Kyocera/);

    const options = (await openSelectOptions('На какой вашей площадке он стоит')).map(
      (el) => el.textContent ?? '',
    );
    // Справочник отдал три площадки, поле показывает две: на чужую сервер отвечает 422, и заявку
    // на ней некому исполнять — аппарат стоит не там.
    expect(options).toEqual([NORTH_LABEL, SOUTH_LABEL]);
  });

  it('чужой отдел при своей площадке поправку не включает (Р2)', async () => {
    const http = renderForm(DEP_USER, { units: [FOREIGN_OWNER_UNIT] });
    await selectOption('Какой аппарат', /Kyocera/);
    await waitFor(() => expect(shownCustomer()).toBe(PTO_LABEL));

    // Ни поля площадки, ни галочки: объект карточки свой, и расходиться не с чем.
    expect(screen.queryByLabelText('На какой вашей площадке он стоит')).toBeNull();

    submit();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));

    const body = bodyOf(http);
    // ГЛАВНОЕ: пары нет. Поставленная поправка завела бы в очередь расхождений ИТ-службы строку
    // «аппарат стоит не там», которой никто не заявлял, — и разбирал бы её живой человек.
    expect(body.objectOverridden).toBe(false);
    expect('objectId' in body).toBe(false);
    // Заявка держится в области отделом-заказчиком, а не площадкой (Р6).
    expect(body.customerDepartmentId).toBe(PTO.id);
  });
});

describe('срочность — право, а не украшение (Р9)', () => {
  it('заявителю пары «галочка + причина» нет вовсе', async () => {
    renderForm(REQUESTER);
    await screen.findByLabelText('Какой аппарат');

    // Не заперта, а отсутствует: запертая галочка обещала бы решение, которого заявитель не
    // принимает, — срочность назначает «Ведение», разбирая очередь.
    expect(screen.queryByRole('checkbox', { name: 'Срочная заявка' })).toBeNull();
  });

  it('держателю права галочка показывается и работает', async () => {
    renderForm(OPERATOR);
    const box = await screen.findByRole('checkbox', { name: 'Срочная заявка' });
    expect((box as HTMLInputElement).disabled).toBe(false);

    // Причина появляется вместе с галочкой и обязательна: без неё через месяц срочными окажутся
    // все заявки (Р56).
    fireEvent.click(box);
    expect(await screen.findByLabelText('Почему срочно')).toBeDefined();
  });

  it('без права заведение шлёт `isUrgent: false`, а не пропуск', async () => {
    const http = renderForm(REQUESTER);
    await selectOption('Какой аппарат', /Kyocera/);
    await waitFor(() => expect(shownCustomer()).toBe(NORTH_LABEL));

    submit();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));

    const body = bodyOf(http);
    // `false` — не запрос срочности, а её отсутствие, и сервер принимает его всегда; `true` без
    // права он отбивает 403 вместе со всей заявкой.
    expect(body.isUrgent).toBe(false);
  });

  it('при правке галочка видна и заперта', async () => {
    renderForm(REQUESTER, {
      request: { isUrgent: true, urgencyReason: 'встала выдача пропусков' },
      routes: { 'PATCH /service-requests/:id': () => json(serviceRequest()) },
    });

    const box = await screen.findByRole('checkbox', { name: 'Срочная заявка' });
    // Видна — заявитель обязан знать, срочная его заявка или нет; заперта — менять её отдельной
    // ручкой могут те, кто ведёт заявки.
    expect((box as HTMLInputElement).checked).toBe(true);
    expect((box as HTMLInputElement).disabled).toBe(true);
  });
});

describe('какие ручки спрашивает форма (Р1)', () => {
  it('поле техники ходит в селектор, а обычную выдачу справочника не трогает', async () => {
    const http = renderForm(REQUESTER);
    await selectOption('Какой аппарат', /Kyocera/);

    await waitFor(() => expect(http.countOf('GET /office-equipment/selector')).toBeGreaterThan(0));
    /*
     * Ноль обращений к справочнику — это и есть граница Р1: обычная выдача несёт комментарий,
     * закупку, состояние и характеристики, а по выбору предмета заявки виден весь активный парк
     * компании. Мока у неё в этом файле нет вовсе, так что запрос упал бы и сам.
     */
    expect(http.countOf('GET /office-equipment')).toBe(0);
  });
});

describe('окно расходников осталось на обычной выдаче (Р1)', () => {
  it('состав спрашивает справочник, а не селектор: подбор идёт по модели', async () => {
    // Модель — единственное, чем окно подбирает подходящие позиции, и в проекции селектора её нет
    // вовсе: перевести окно на неё значило бы оставить исполнителя без подбора.
    const http = mockHttp({
      'GET /office-equipment': () => json(emptyList()),
      'GET /office-equipment-consumables': () => json(emptyList()),
      'PUT /service-requests/:id/consumables': () => json(serviceRequest()),
    });
    renderWithUser(
      <ServiceRequestConsumablesModal
        request={serviceRequest({ kind: 'consumable' })}
        onClose={() => {}}
      />,
      { user: OPERATOR },
    );

    await waitFor(() => expect(http.countOf('GET /office-equipment')).toBeGreaterThan(0));
    expect(http.countOf('GET /office-equipment/selector')).toBe(0);
  });
});
