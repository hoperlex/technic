import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  AuthUser,
  DepartmentDto,
  OfficeEquipmentDto,
  ServiceRequestDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser, departmentUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { serviceRequest } from './factories/service';
import { openSelectOptions, selectOption } from './antd';
import { ServiceRequestForm } from '../src/pages/service/ServiceRequestForm';

/**
 * Заказчик заявки на обслуживание оргтехники (план `docs/department-requests-plan.md`, Р11, Р11а,
 * Р11б, Р12, Р12а): «Отдел-заказчик» стал подбором «Заказчик» с площадкой выбранной единицы.
 *
 * Проверяется то, что молча расходится с сервером. Площадку в этом поле не выбирают — она приходит
 * снимком техники, и оставшаяся от прежней единицы отнесла бы заявку не на тот объект (К10).
 * Правка читает снимки самой заявки, а не действующий справочник: карточку могли перевезти и
 * перезакрепить (Р11а). Роли отдела площадка положена только по технике её отдела — на прочую
 * сервер отвечает 403 (Р12), и предложенный порталом пункт стал бы отказом после заполнения формы.
 * И наконец, заказчик уходит в тело запроса **всегда**: пропуск сервер прочёл бы подсказкой и
 * подставил отдел за человека (Р12а, Р12б).
 *
 * Роли по имени нигде не спрашиваются: сценарий задаёт учётку с отдельской осью либо без неё, а
 * состав поля считают те же `useObjectScope`/`useDepartmentScope`, по которым живёт портал.
 * Идентификаторы фикстур условны (`obj-1`, `dep-1`) — тем и ценны: ключ собирается и разбирается
 * по данным опции, а не разбором строки, который на не-UUID вернул бы пустоту (Р2а).
 */

const NORTH = { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' };
const STORE = { id: 'obj-2', code: 'ОБ-2', name: 'Склад-2' };

const NORTH_LABEL = 'ОБ-1 — ЖК Северный';
const STORE_LABEL = 'ОБ-2 — Склад-2';
const PTO_LABEL = 'ПТО — Производственно-технический';
const SNB_LABEL = 'СНБ — Снабжение';
const IT_LABEL = 'ИТ — Служба ИТ';

const IT_DEPARTMENT = { id: 'dep-9', code: 'ИТ', name: 'Служба ИТ' };

function department(over: Partial<DepartmentDto> = {}): DepartmentDto {
  return {
    id: 'dep-1',
    code: 'ПТО',
    name: 'Производственно-технический',
    isActive: true,
    // Площадки набором (ADR 0144); `object` — устаревшая проекция набора: при пустом
    // наборе и при наборе из нескольких сервер отдаёт в ней `null`.
    objects: [],
    object: null,
    heads: [],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

const DEPARTMENTS = [
  department(),
  department({ id: 'dep-2', code: 'СНБ', name: 'Снабжение' }),
  department({ id: 'dep-9', code: 'ИТ', name: 'Служба ИТ' }),
];

function equipment(over: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: 'oet-1', name: 'МФУ', isActive: true },
    name: 'Kyocera M3145',
    serialNumber: '',
    inventoryNumber: '0012345',
    object: NORTH,
    department: null,
    location: 'Корпус 3, каб. 214',
    state: 'on_site',
    stateNote: '',
    purchasedOn: null,
    warrantyUntil: null,
    comment: '',
    isActive: true,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

/**
 * Единиц две и стоят они на разных площадках: смена одной на другую — это и есть проверяемое
 * событие (К10). С единственной единицей `AutoSelect` подставил бы её сам, и менять было бы нечего.
 */
const UNITS = [
  equipment(),
  equipment({ id: 'oe-2', name: 'Brother HL-1110R', inventoryNumber: '0000778', object: STORE }),
];

/**
 * Заявка на технику `oe-1`, стоящую на «ЖК Северном»: правка читает снимки самой заявки, и
 * различать их с действующим справочником — половина проверяемого (Р11а).
 */
function request(over: Partial<ServiceRequestDto> = {}): ServiceRequestDto {
  return serviceRequest({
    equipment: {
      id: 'oe-1',
      name: 'Kyocera M3145',
      serialNumber: '',
      inventoryNumber: '0012345',
      typeName: 'МФУ',
      location: 'Корпус 3, каб. 214',
    },
    object: NORTH,
    responsibleName: 'Штабов С. И.',
    responsiblePhone: '9001234567',
    ...over,
  });
}

/**
 * Оператор оргтехники: объектная ось, отдельской нет. Телефон в учётке — не украшение: заявитель и
 * его номер обязательны (Р49), и без него форма встала бы на своём правиле, а не на заказчике.
 */
const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
  phone: '9001234567',
});

/**
 * Сотрудник отдела с двумя своими отделами. Именно с двумя: с одним поле оказалось бы запертым
 * единственным вариантом (Р3а), и «площадки в списке нет» было бы неотличимо от «списка нет вовсе».
 */
const DEP_USER: AuthUser = departmentUser('dep-1', [], {
  departmentIds: ['dep-1', 'dep-2'],
  phone: '9001234567',
});

function renderForm(
  user: AuthUser,
  options: { request?: ServiceRequestDto; units?: OfficeEquipmentDto[]; routes?: RouteMap } = {},
): HttpMock {
  const http = mockHttp({
    'GET /office-equipment': () => json(list(options.units ?? UNITS)),
    'GET /departments': () => json(list(DEPARTMENTS)),
    // Площадка учётки — контекст обращения в поддержку, к подбору заказчика отношения не имеет.
    'GET /objects': () => json(emptyList()),
    ...options.routes,
  });
  renderWithUser(<ServiceRequestForm open request={options.request ?? null} onClose={() => {}} />, {
    user,
  });
  return http;
}

/** Что стоит в поле подбора: подпись выбранного варианта; `null` — поле пустое. */
function shownCustomer(): string | null {
  const field = document.getElementById('customer')?.closest('.ant-select');
  return field?.querySelector('.ant-select-content')?.getAttribute('title') ?? null;
}

/** Заперто ли поле: antd отмечает это классом обёртки, а не признаком самого ввода. */
function customerLocked(): boolean {
  const field = document.getElementById('customer')?.closest('.ant-select');
  return !!field?.classList.contains('ant-select-disabled');
}

/** Подписи вариантов подбора — в порядке показа, из выпадашки этого поля. */
async function customerOptions(): Promise<string[]> {
  const options = await openSelectOptions('Заказчик');
  return options.map((option) => option.textContent ?? '');
}

/** Заголовки групп подбора: «Площадка» и «Отделы» — по ним и видно состав поля. */
async function customerGroups(): Promise<string[]> {
  const [first] = await openSelectOptions('Заказчик');
  const dropdown = first!.closest('.ant-select-dropdown')!;
  return [...dropdown.querySelectorAll('.ant-select-item-group')].map((el) => el.textContent ?? '');
}

/** Тело последнего запроса — им и проверяется, что ушло на сервер. */
function bodyOf(http: HttpMock, route: string): Record<string, unknown> {
  return http.lastCall(route)?.body as Record<string, unknown>;
}

describe('смена единицы пересобирает площадку (Р11а, К10)', () => {
  it('заказчик-площадка переезжает на объект выбранной сейчас единицы', async () => {
    renderForm(OPERATOR);
    // До выбора единицы площадки нет вовсе, и поле заперто (Р11).
    expect(customerLocked()).toBe(true);

    await selectOption('Техника', /Kyocera/);
    await waitFor(() => expect(customerLocked()).toBe(false));
    await waitFor(() => expect(shownCustomer()).toBe(NORTH_LABEL));

    // Прежний ключ (`object:obj-1`) остался бы заявкой на чужой объект: техника уже на другой
    // площадке, а объект в заявку уходит снимком выбранной единицы.
    await selectOption('Техника', /Brother/);
    await waitFor(() => expect(shownCustomer()).toBe(STORE_LABEL));
  });

  it('отдел-заказчик сменой единицы не трогается', async () => {
    renderForm(OPERATOR);

    await selectOption('Техника', /Kyocera/);
    await selectOption('Заказчик', PTO_LABEL);
    await selectOption('Техника', /Brother/);

    // Отдел про то, кто просит, а не про то, где стоит аппарат: единицу сменили — заказчик прежний.
    expect(shownCustomer()).toBe(PTO_LABEL);
    // А площадка в списке при этом уже новая — предлагается объект выбранной сейчас единицы.
    expect(await customerOptions()).toEqual([STORE_LABEL, PTO_LABEL, SNB_LABEL, IT_LABEL]);
  });

  it('объектной роли видны все действующие отделы (Р11б)', async () => {
    renderForm(OPERATOR);
    await selectOption('Техника', /Kyocera/);

    // Ось учётки объектная, но заказчиком она называет отдел: это «от чьего имени просят», а не
    // «чья площадка», и сужать состав своей осью здесь нечем.
    expect(await customerGroups()).toEqual(['Площадка', 'Отделы']);
    expect(await customerOptions()).toEqual([NORTH_LABEL, PTO_LABEL, SNB_LABEL, IT_LABEL]);
  });
});

describe('умолчание поля', () => {
  it('единственный отдел учётки остаётся умолчанием, а не площадка своей техники', async () => {
    // Сотрудник отдела с одним отделом: до подбора его отдел подставлялся сам (ADR 0085 §8), и
    // площадка на этом месте молча превратила бы заявку отдела о своём же принтере в заявку от
    // площадки — заказчик у неё стал бы пустым.
    const sole = departmentUser('dep-1', [], { phone: '9001234567' });
    renderForm(sole, {
      units: [equipment({ department: { id: 'dep-1', code: 'ПТО', name: 'ПТО' } })],
    });

    await waitFor(() => expect(shownCustomer()).toBe(PTO_LABEL));
    // Площадка при этом доступна — техника отдела своя (Р12): умолчание её не отменяет.
    expect(await customerOptions()).toEqual([NORTH_LABEL, PTO_LABEL]);
  });
});

describe('правка читает снимок заявки (Р11а)', () => {
  it('заказчик-отдел показан отделом, а не объектом заявки', async () => {
    renderForm(OPERATOR, {
      request: request({
        customerDepartment: { id: 'dep-1', code: 'ПТО', name: 'Производственно-технический' },
      }),
    });

    /*
     * Ловушка `costTargetOf`: он смотрит `objectId` раньше `departmentId`, а у сервисной заявки
     * объект и отдел заполнены одновременно — три снимка, а не альтернатива. Прогнанный через него
     * заказчик-отдел показался бы площадкой, и сохранение перенесло бы заявку на объект.
     */
    await waitFor(() => expect(shownCustomer()).toBe(PTO_LABEL));
    expect(shownCustomer()).not.toBe(NORTH_LABEL);
  });
});

describe('площадка роли отдела ограничена принадлежностью техники (Р12)', () => {
  const own = equipment({ department: { id: 'dep-1', code: 'ПТО', name: 'ПТО' } });
  const foreign = equipment({
    id: 'oe-3',
    name: 'HP LaserJet 107w',
    inventoryNumber: '0000779',
    department: IT_DEPARTMENT,
  });
  const unmarked = equipment({ id: 'oe-2', name: 'Brother HL-1110R', inventoryNumber: '0000778' });

  it('по технике своего отдела площадка предлагается', async () => {
    renderForm(DEP_USER, { units: [own, foreign, unmarked] });
    await selectOption('Техника', /Kyocera/);

    expect(await customerGroups()).toEqual(['Площадка', 'Отделы']);
    expect(await customerOptions()).toEqual([NORTH_LABEL, PTO_LABEL, SNB_LABEL]);
  });

  it('по чужой технике площадки нет: сервер ответил бы на неё 403', async () => {
    renderForm(DEP_USER, { units: [own, foreign, unmarked] });
    await selectOption('Техника', /HP LaserJet/);

    expect(await customerGroups()).toEqual(['Отделы']);
    expect(await customerOptions()).toEqual([PTO_LABEL, SNB_LABEL]);
  });

  it('по неразмеченной технике площадки нет тоже', async () => {
    renderForm(DEP_USER, { units: [own, foreign, unmarked] });
    await selectOption('Техника', /Brother/);

    // Без отдела-заказчика такую заявку не держит ни одна отдельская колонка: автор перестал бы
    // видеть то, что сам завёл, — потому сервер и отвечает на неё 403.
    expect(await customerGroups()).toEqual(['Отделы']);
    expect(await customerOptions()).toEqual([PTO_LABEL, SNB_LABEL]);
  });
});

describe('правка без касания поля шлёт прежнего заказчика (Р12а, Р12б, К7)', () => {
  const patch = { 'PATCH /service-requests/:id': () => json(request()) };

  it('чужой отдел держится в поле и уходит прежним идентификатором', async () => {
    // Так выглядит заявка, видимая по сквозной области «Согласования ИТ»: её заказчик в состав
    // поля этой учётки не входит вовсе (Р11б).
    const http = renderForm(DEP_USER, {
      request: request({ customerDepartment: IT_DEPARTMENT }),
      routes: patch,
    });
    await waitFor(() => expect(shownCustomer()).toBe(IT_LABEL));

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id')).toBe(1));

    const body = bodyOf(http, 'PATCH /service-requests/:id');
    // Присутствующим, а не пропущенным: пропуск ушёл бы в серверную ветку `undefined`, и связка
    // «портал шлёт всегда → сервер проверяет только изменившееся» осталась бы непроверенной.
    expect('customerDepartmentId' in body).toBe(true);
    expect(body.customerDepartmentId).toBe('dep-9');
  });

  it('заявка от площадки по чужой технике сохраняется явным `null`', async () => {
    const http = renderForm(DEP_USER, {
      request: request({
        customerDepartment: null,
        equipmentDepartment: IT_DEPARTMENT,
      }),
      routes: patch,
    });
    // Площадка этой учётке по чужой технике не положена (Р12), но заведённого заказчика правка не
    // сбрасывает: иначе правка телефона роняла бы заказчика заявки или отвечала бы 403.
    await waitFor(() => expect(shownCustomer()).toBe(NORTH_LABEL));

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id')).toBe(1));

    const body = bodyOf(http, 'PATCH /service-requests/:id');
    expect('customerDepartmentId' in body).toBe(true);
    expect(body.customerDepartmentId).toBeNull();
  });
});

/**
 * Подразделение заявителя (Н11) — «откуда человек», а не «от чьего имени просят».
 *
 * Проверяется то, что иначе ловится только отказом сервера: у учётки с двумя отделами одно
 * значение не подставить, и сервер отвечает 422 «Укажите отдел, в котором числится заявитель».
 * Не спроси форма — заявка не заводилась бы вовсе, а человек видел бы отказ по полю, которого в
 * ней нет. Там же, где привязка одна, поля быть не должно: сервер подставит её сам, и
 * обязательное поле с единственным вариантом стоило бы человеку клика.
 */
describe('подразделение заявителя (Н11)', () => {
  const create = {
    'POST /service-requests': () => json({ request: request(), mail: 'queued' }, 201),
  };

  it('у двух отделов форма спрашивает свой и шлёт его идентификатором', async () => {
    const http = renderForm(DEP_USER, { routes: create });
    await selectOption('Техника', /Kyocera/);
    await selectOption('Заказчик', PTO_LABEL);
    fireEvent.change(screen.getByLabelText('Неисправность'), {
      target: { value: 'Не захватывает бумагу' },
    });
    await selectOption('Отдел заявителя', PTO_LABEL);

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));

    const body = bodyOf(http, 'POST /service-requests');
    expect(body.requesterDepartmentId).toBe('dep-1');
    // Площадка не уходит вовсе: подразделение — либо отдел, либо она, и оба сразу сервер отбивает.
    expect('requesterObjectId' in body).toBe(false);
  });

  it('единственная привязка не спрашивается: её подставит сервер', async () => {
    // Оператор с одним объектом и без отделов — самый частый случай, и лишнее поле в форме тут
    // означало бы вопрос, ответ на который известен заранее.
    renderForm(OPERATOR, { routes: create });
    await selectOption('Техника', /Kyocera/);

    expect(document.getElementById('requesterPlaceId')).toBeNull();
  });
});

describe('заведение шлёт осознанное значение (Р12а)', () => {
  const create = {
    'POST /service-requests': () => json({ request: request(), mail: 'queued' }, 201),
  };

  it('заявка от площадки уходит явным `null`', async () => {
    const http = renderForm(OPERATOR, { routes: create });
    await selectOption('Техника', /Kyocera/);
    await waitFor(() => expect(shownCustomer()).toBe(NORTH_LABEL));
    fireEvent.change(screen.getByLabelText('Неисправность'), {
      target: { value: 'Не захватывает бумагу' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));

    const body = bodyOf(http, 'POST /service-requests');
    // `null` здесь значит «заявка от площадки», а не «поле не заполнили»: подсказку по этому
    // ответу сервер не применяет.
    expect('customerDepartmentId' in body).toBe(true);
    expect(body.customerDepartmentId).toBeNull();
  });

  it('выбранный отдел уходит идентификатором из опции', async () => {
    const http = renderForm(OPERATOR, { routes: create });
    await selectOption('Техника', /Kyocera/);
    await selectOption('Заказчик', PTO_LABEL);
    fireEvent.change(screen.getByLabelText('Неисправность'), {
      target: { value: 'Не захватывает бумагу' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));

    // Род и идентификатор берутся из выбранной опции (Р2а): разбор ключа на условном `dep-1` не
    // прошёл бы проверку UUID, и отдел молча уехал бы на сервер площадкой.
    expect(bodyOf(http, 'POST /service-requests').customerDepartmentId).toBe('dep-1');
  });
});
