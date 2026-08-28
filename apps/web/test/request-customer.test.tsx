import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Form, type FormInstance } from 'antd';
import type { AuthUser, DepartmentDto, ObjectDto } from '@technic/contracts';
import {
  RequestCustomerSelect,
  ServiceRequestCustomerField,
  useRequestCustomerFilter,
  useRequestCustomerOptions,
  useServiceRequestCustomer,
  type RequestCustomerFilter,
  type RequestCustomerInput,
  type RequestCustomerOptions,
  type ServiceRequestCustomer,
  type ServiceRequestCustomerEquipment,
  type ServiceRequestCustomerSnapshot,
} from '@features/request-customer';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser, departmentUser, shtabUser } from './factories/auth';
import { list } from './factories/common';
import { objectDto } from './factories/waste';
import { openSelectOptions, selectOption } from './antd';

/**
 * Подбор заказчика «Объект/отдел» (план `docs/department-requests-plan.md`, §9 п. 1).
 *
 * Проверяется то, что модуль обещает потребителям: состав групп по оси учётки (Р3), запертость и
 * единственный вариант (Р3а, К6), сохранённое значение записи (К7), исключение отделов у
 * спецтехники (Р4) и граница разбора ключа (Р2а). Формы и списки подключают его своей волной,
 * поэтому смотрим на сам модуль — на хуки и на поля, а не на страницы.
 *
 * Единиц в нём четыре, и каждая отвечает своему потребителю: `useRequestCustomerOptions` — состав,
 * `RequestCustomerSelect` — само поле, `useRequestCustomerFilter` — фильтр списка одной парой
 * параметров (Р9), `useServiceRequestCustomer` с `ServiceRequestCustomerField` — заказчик заявки
 * на обслуживание оргтехники со своей осью и своей площадкой (Р11, Р11а, Р11б, Р12).
 *
 * Роли не перечисляются нигде: сценарий задаёт учётку с осью (штаб, сотрудник отдела) либо без
 * неё, а правило считает `useObjectScope`/`useDepartmentScope` — те же, по которым живёт портал.
 */

const FIELD_LABEL = 'Объект/отдел';

const OBJECTS = [
  objectDto({ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' }),
  objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' }),
];

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

const DEPARTMENTS = [department(), department({ id: 'dep-2', code: 'СНБ', name: 'Снабжение' })];

/** Последний результат хука: сценарии спрашивают у него группы, ключ и пару для тела запроса. */
let customer: RequestCustomerOptions;
let form: FormInstance;

function Harness({ input, value }: { input: RequestCustomerInput; value?: string }) {
  const [instance] = Form.useForm();
  form = instance;
  customer = useRequestCustomerOptions(input);
  return (
    <Form form={instance} layout="vertical" initialValues={value ? { customer: value } : undefined}>
      <Form.Item name="customer" label={FIELD_LABEL}>
        <RequestCustomerSelect
          options={customer.options}
          loading={customer.loading}
          disabled={customer.disabled}
        />
      </Form.Item>
    </Form>
  );
}

function renderCustomer(options: {
  user: AuthUser;
  input?: RequestCustomerInput;
  value?: string;
  objects?: ObjectDto[];
  departments?: DepartmentDto[];
}): HttpMock {
  const http = mockHttp({
    'GET /objects': () => json(list(options.objects ?? OBJECTS)),
    'GET /departments': () => json(list(options.departments ?? DEPARTMENTS)),
  });
  renderWithUser(<Harness input={options.input ?? {}} value={options.value} />, {
    user: options.user,
  });
  return http;
}

/** Состав подбора: группы и их значения — в порядке показа. */
const groups = () => customer.options.map((g) => [g.label, g.options.map((o) => o.value)] as const);

/** Дождаться состава: справочники приезжают запросом, и до ответа групп нет вовсе. */
async function expectGroups(expected: (readonly [string, string[]])[]): Promise<void> {
  await waitFor(() => expect(groups()).toEqual(expected));
}

/** Что показано в поле — подпись выбранного варианта; `null` — поле пустое. */
const shownLabel = () =>
  document.querySelector('.ant-select-content')?.getAttribute('title') ?? null;

const OFFICE = authUser({ role: 'manager' });

describe('состав подбора в заказе ТС (Р3)', () => {
  it('офис видит обе группы целиком', async () => {
    renderCustomer({ user: OFFICE });

    await expectGroups([
      ['Объекты', ['object:obj-1', 'object:obj-2']],
      ['Отделы', ['department:dep-1', 'department:dep-2']],
    ]);

    // Группы видны и в самом поле: заголовок отделяет площадки от подразделений, иначе список
    // читался бы как один справочник с двумя видами кодов.
    const options = await openSelectOptions(FIELD_LABEL);
    expect(options).toHaveLength(4);
    expect(
      [...document.querySelectorAll('.ant-select-item-group')].map((el) => el.textContent),
    ).toEqual(['Объекты', 'Отделы']);
  });

  it('объектная роль: свои объекты, отделов нет вовсе', async () => {
    const http = renderCustomer({ user: shtabUser('obj-1') });

    await expectGroups([['Объекты', ['object:obj-1']]]);
    // Справочник отделов не спрашивается вовсе: показывать из него нечего.
    expect(http.countOf('GET /departments')).toBe(0);
  });

  it('роль отдела: свои отделы, объектов нет вовсе', async () => {
    const http = renderCustomer({ user: departmentUser('dep-1') });

    await expectGroups([['Отделы', ['department:dep-1']]]);
    expect(http.countOf('GET /objects')).toBe(0);
  });
});

describe('спецтехника отделов не знает (Р4, К8)', () => {
  it('группы «Отделы» нет, а стоящий отдел наружу отдаётся пустым', async () => {
    renderCustomer({
      user: OFFICE,
      input: { departments: 'none' },
      value: 'department:dep-1',
    });

    await expectGroups([['Объекты', ['object:obj-1', 'object:obj-2']]]);
    // Значения, которого поле не предлагает, в теле запроса не будет: иначе переоформленная в
    // спецтехнику заявка ушла бы на сервер с отделом и вернулась отказом CHECK.
    expect(customer.customerPairOf('department:dep-1')).toEqual({
      objectId: null,
      departmentId: null,
    });
    expect(shownLabel()).toBeNull();
  });
});

describe('единственный вариант ставит форма (Р3а, К6)', () => {
  it('заперто, ключ отдан наружу, само поле пустое', async () => {
    renderCustomer({ user: shtabUser('obj-1'), objects: [OBJECTS[0]!] });

    await waitFor(() => expect(customer.soleCustomerKey).toBe('object:obj-1'));
    expect(customer.disabled).toBe(true);
    // Заблокированное поле `AutoSelect` не заполняет намеренно — потому ключ и отдан наружу.
    expect(form.getFieldValue('customer')).toBeUndefined();
  });

  it('вариантов больше одного — поле открыто и ничего не предрешает', async () => {
    renderCustomer({ user: OFFICE });

    await waitFor(() => expect(customer.disabled).toBe(false));
    expect(customer.soleCustomerKey).toBeNull();
  });
});

describe('сохранённый заказчик записи (К7)', () => {
  it('расформированный отдел остаётся в своей группе', async () => {
    renderCustomer({
      user: departmentUser('dep-1'),
      value: 'department:dep-9',
      input: {
        saved: { target: { kind: 'department', id: 'dep-9' }, label: 'СНБ — Снабжение' },
      },
    });

    await expectGroups([['Отделы', ['department:dep-9', 'department:dep-1']]]);
    expect(customer.customerPairOf('department:dep-9')).toEqual({
      objectId: null,
      departmentId: 'dep-9',
    });
    expect(shownLabel()).toBe('СНБ — Снабжение');
  });

  it('закрытый объект попадает в «Объекты», а не к отделам', async () => {
    renderCustomer({
      user: OFFICE,
      input: { saved: { target: { kind: 'object', id: 'obj-9' }, label: 'ОБ-9 — Склад' } },
    });

    await expectGroups([
      ['Объекты', ['object:obj-9', 'object:obj-1', 'object:obj-2']],
      ['Отделы', ['department:dep-1', 'department:dep-2']],
    ]);
  });
});

describe('значение извне проверяется разбором (Р2а)', () => {
  it('не ключ — поле пустое и наружу идёт пустая пара', async () => {
    // Так выглядит старое сохранённое значение фильтра: голый идентификатор объекта без рода.
    renderCustomer({ user: OFFICE, value: 'obj-1' });

    await expectGroups([
      ['Объекты', ['object:obj-1', 'object:obj-2']],
      ['Отделы', ['department:dep-1', 'department:dep-2']],
    ]);
    expect(shownLabel()).toBeNull();
    expect(customer.customerPairOf('obj-1')).toEqual({ objectId: null, departmentId: null });
  });

  it('ключ из опции разбирается в пару для тела запроса', async () => {
    renderCustomer({ user: OFFICE });

    await expectGroups([
      ['Объекты', ['object:obj-1', 'object:obj-2']],
      ['Отделы', ['department:dep-1', 'department:dep-2']],
    ]);
    expect(customer.customerPairOf('object:obj-2')).toEqual({
      objectId: 'obj-2',
      departmentId: null,
    });
    expect(customer.customerPairOf('department:dep-1')).toEqual({
      objectId: null,
      departmentId: 'dep-1',
    });
  });
});

describe('оргтехника: своя ось заказчика (Р11, Р11б)', () => {
  it('площадка приходит снаружи, а отделы объектной роли видны все', async () => {
    const http = renderCustomer({
      user: shtabUser('obj-1'),
      input: {
        objects: { id: 'obj-7', label: 'ОБ-7 — Склад-2' },
        departments: 'requester',
      },
    });

    await expectGroups([
      ['Площадка', ['object:obj-7']],
      ['Отделы', ['department:dep-1', 'department:dep-2']],
    ]);
    // Справочник объектов здесь не спрашивается: площадка — снимок выбранной единицы, а не выбор.
    expect(http.countOf('GET /objects')).toBe(0);
    expect(customer.customerPairOf('object:obj-7')).toEqual({
      objectId: 'obj-7',
      departmentId: null,
    });
  });
});

describe('род, отменённый правилом состава, сохранённым не возвращается (К7 против К8)', () => {
  it('прежний отдел не появляется у спецтехники', async () => {
    // Так выглядит переоформление заявки отдела в заказ на площадку (ADR 0091): запись держит
    // отдел, а тип заявки отделов уже не знает (Р4).
    renderCustomer({
      user: OFFICE,
      input: {
        departments: 'none',
        saved: { target: { kind: 'department', id: 'dep-9' }, label: 'СНБ — Снабжение' },
      },
      value: 'department:dep-9',
    });

    // Группы «Отделы» нет вовсе — в том числе одним сохранённым пунктом: выбранный там снова, он
    // ушёл бы пустой парой, и заявка отправилась бы вообще без заказчика.
    await expectGroups([['Объекты', ['object:obj-1', 'object:obj-2']]]);
    expect(customer.customerPairOf('department:dep-9')).toEqual({
      objectId: null,
      departmentId: null,
    });
    expect(shownLabel()).toBeNull();
  });

  it('прежний объект у той же спецтехники в списке остаётся', async () => {
    // Правило отменяет род, а не сохранённый вариант вообще: заказчик-площадка закрытого объекта
    // держится и здесь — иначе правка началась бы с пустого обязательного поля.
    renderCustomer({
      user: OFFICE,
      input: {
        departments: 'none',
        saved: { target: { kind: 'object', id: 'obj-9' }, label: 'ОБ-9 — Склад' },
      },
    });

    await expectGroups([['Объекты', ['object:obj-9', 'object:obj-1', 'object:obj-2']]]);
  });

  it('чужой отдел правимой заявки держится: ось сужает справочник, а не отменяет род', async () => {
    // Заявка, видимая по сквозной области «Согласования ИТ» (Р11б): её заказчик в состав поля этой
    // учётки не входит — и ровно ради него К7 и заведён.
    renderCustomer({
      user: departmentUser('dep-1'),
      input: {
        objects: null,
        departments: 'requester',
        saved: { target: { kind: 'department', id: 'dep-9' }, label: 'ИТ — Служба ИТ' },
      },
      value: 'department:dep-9',
    });

    await expectGroups([['Отделы', ['department:dep-9', 'department:dep-1']]]);
    expect(customer.customerPairOf('department:dep-9')).toEqual({
      objectId: null,
      departmentId: 'dep-9',
    });
    expect(shownLabel()).toBe('ИТ — Служба ИТ');
  });
});

/** Параметры списка в том виде, в каком их держит вкладка: заполнена не больше чем одна половина. */
type FilterParams = { objectId?: string; departmentId?: string };

let filterParams: FilterParams;
let filter: RequestCustomerFilter;

function FilterHarness({ initial }: { initial: FilterParams }) {
  const [params, setParams] = useState<FilterParams>(initial);
  filterParams = params;
  filter = useRequestCustomerFilter({
    objectId: params.objectId,
    departmentId: params.departmentId,
    // Патч применяется поверх прежних параметров — ровно так, как это делают вкладки. Не чисти
    // хук вторую половину сам, она осталась бы здесь: выдача сузилась бы до пересечения объекта с
    // отделом, то есть до пустоты.
    onChange: (patch) => setParams((p) => ({ ...p, ...patch })),
  });
  return <>{filter.controls}</>;
}

function renderFilter(initial: FilterParams = {}, user: AuthUser = OFFICE): void {
  mockHttp({
    'GET /objects': () => json(list(OBJECTS)),
    'GET /departments': () => json(list(DEPARTMENTS)),
  });
  renderWithUser(<FilterHarness initial={initial} />, { user });
}

/**
 * Выбор в фильтре: подписи у контрола нет — в панели над таблицей поля стоят подсказками, а не
 * подписями, поэтому поле ищется по роли, а не по `label`.
 */
async function pickInFilter(text: string): Promise<void> {
  // Пока справочник едет, вариантов ноль и поле заперто — по нажатию оно ничего не откроет.
  await waitFor(() => expect(mobileSelect().disabled).toBe(false));
  fireEvent.mouseDown(await screen.findByRole('combobox'));
  fireEvent.click(
    await screen.findByText(text, {
      selector: '.ant-select-item-option-content, .ant-select-item-option-content *',
    }),
  );
}

/** Описание фильтра для шита на телефоне — им же выбор применяется со стороны телефона. */
function mobileSelect() {
  const mobile = filter.mobileFilter;
  if (mobile.kind !== 'select') throw new Error('заказчик — одиночный выбор, а не набор');
  return mobile;
}

describe('фильтр списка одной парой параметров (Р9)', () => {
  it('выбор отдела пишет свою половину и чистит вторую', async () => {
    renderFilter({ objectId: 'obj-1' });

    await pickInFilter('ПТО — Производственно-технический');

    await waitFor(() => expect(filterParams.departmentId).toBe('dep-1'));
    expect(filterParams.objectId).toBeUndefined();
  });

  it('выбор объекта чистит отдел', async () => {
    renderFilter({ departmentId: 'dep-1' });

    await pickInFilter('ОБ-2 — ЖК Южный');

    await waitFor(() => expect(filterParams.objectId).toBe('obj-2'));
    expect(filterParams.departmentId).toBeUndefined();
  });

  it('заданная половина показана ключом, а состав — тот же, что у формы', async () => {
    renderFilter({ departmentId: 'dep-1' });

    await waitFor(() => expect(shownLabel()).toBe('ПТО — Производственно-технический'));
    expect(mobileSelect().value).toBe('department:dep-1');
    expect(mobileSelect().options.map((g) => g.label)).toEqual(['Объекты', 'Отделы']);
    // Фильтр по заказчику у всех трёх списков один, и ключ у него тот же: описание для шита
    // отвечает тем же значением, что и поле над таблицей.
    expect(mobileSelect().key).toBe('customer');
  });

  it('шит на телефоне применяет и снимает выбор тем же правилом', async () => {
    renderFilter({ objectId: 'obj-1' });
    await waitFor(() => expect(mobileSelect().disabled).toBe(false));
    expect(mobileSelect().value).toBe('object:obj-1');

    act(() => mobileSelect().onChange('department:dep-2'));
    await waitFor(() => expect(filterParams.departmentId).toBe('dep-2'));
    expect(filterParams.objectId).toBeUndefined();

    // Пустое значение фильтра означает «все» — и снимает обе половины сразу.
    act(() => mobileSelect().onChange(undefined));
    await waitFor(() => expect(mobileSelect().value).toBeUndefined());
    expect(filterParams).toEqual({});
  });

  it('единственный заказчик учётки фильтр запирает, а не предлагает выбором', async () => {
    renderFilter({ objectId: 'obj-1' }, shtabUser('obj-1'));

    await waitFor(() => expect(mobileSelect().options).toHaveLength(1));
    expect(mobileSelect().disabled).toBe(true);
  });
});

/** Заказчик заявки на обслуживание: своя ось, своя площадка и своя запертость (Р11, Р11а, Р12). */
const SERVICE_FIELD_LABEL = 'Заказчик';

const KYOCERA: ServiceRequestCustomerEquipment = {
  objectId: 'obj-1',
  objectLabel: 'ОБ-1 — ЖК Северный',
  departmentId: null,
};
const BROTHER: ServiceRequestCustomerEquipment = {
  objectId: 'obj-2',
  objectLabel: 'ОБ-2 — ЖК Южный',
  departmentId: null,
};

let service: ServiceRequestCustomer;
let pickUnit: (unit: ServiceRequestCustomerEquipment | null) => void;

function ServiceHarness({
  request,
  unit,
}: {
  request: ServiceRequestCustomerSnapshot | null;
  unit: ServiceRequestCustomerEquipment | null;
}) {
  const [instance] = Form.useForm();
  const [current, setCurrent] = useState(unit);
  form = instance;
  pickUnit = setCurrent;
  service = useServiceRequestCustomer({ request, equipment: current });
  // Состав спрашивается теми же помощниками, что и у заказа ТС: механизм у них общий, разные —
  // правила состава.
  customer = service;
  return (
    <Form form={instance} layout="vertical">
      <Form.Item name="customer" label={SERVICE_FIELD_LABEL}>
        <ServiceRequestCustomerField customer={service} open />
      </Form.Item>
    </Form>
  );
}

function renderService(options: {
  user: AuthUser;
  request?: ServiceRequestCustomerSnapshot | null;
  unit?: ServiceRequestCustomerEquipment | null;
}): HttpMock {
  const http = mockHttp({
    'GET /objects': () => json(list(OBJECTS)),
    'GET /departments': () => json(list(DEPARTMENTS)),
  });
  renderWithUser(<ServiceHarness request={options.request ?? null} unit={options.unit ?? null} />, {
    user: options.user,
  });
  return http;
}

/** Что стоит в поле — значением формы: тело запроса собирается из него же. */
const fieldValue = () => form.getFieldValue('customer');

describe('оргтехника: смена единицы пересобирает площадку (Р11а, К10)', () => {
  it('площадка становится объектом выбранной сейчас единицы', async () => {
    const http = renderService({ user: OFFICE, unit: KYOCERA });

    await waitFor(() => expect(fieldValue()).toBe('object:obj-1'));
    // Справочник объектов не спрашивается: площадка — снимок единицы, а не выбор из справочника.
    expect(http.countOf('GET /objects')).toBe(0);

    act(() => pickUnit(BROTHER));

    // Прежний ключ остался бы заявкой на объект, где аппарата уже нет.
    await waitFor(() => expect(fieldValue()).toBe('object:obj-2'));
    await expectGroups([
      ['Площадка', ['object:obj-2']],
      ['Отделы', ['department:dep-1', 'department:dep-2']],
    ]);
  });

  it('отдел-заказчик сменой единицы не трогается', async () => {
    renderService({ user: OFFICE, unit: KYOCERA });
    await waitFor(() => expect(fieldValue()).toBe('object:obj-1'));

    await selectOption(SERVICE_FIELD_LABEL, 'ПТО — Производственно-технический');
    act(() => pickUnit(BROTHER));

    // Отдел про то, кто просит, а не про то, где стоит аппарат: единицу сменили — заказчик прежний.
    await expectGroups([
      ['Площадка', ['object:obj-2']],
      ['Отделы', ['department:dep-1', 'department:dep-2']],
    ]);
    expect(fieldValue()).toBe('department:dep-1');
  });

  it('до выбора единицы поле заперто: площадки без неё нет вовсе', async () => {
    renderService({ user: OFFICE });

    await expectGroups([['Отделы', ['department:dep-1', 'department:dep-2']]]);
    expect(service.disabled).toBe(true);
    expect(service.siteKey).toBeNull();
    expect(fieldValue()).toBeUndefined();
  });
});

describe('оргтехника: площадка роли отдела ограничена принадлежностью техники (Р12)', () => {
  it('по технике своего отдела площадка предлагается', async () => {
    renderService({
      user: departmentUser('dep-1'),
      unit: { ...KYOCERA, departmentId: 'dep-1' },
    });

    await expectGroups([
      ['Площадка', ['object:obj-1']],
      ['Отделы', ['department:dep-1']],
    ]);
  });

  it('по чужой технике площадки нет: сервер ответил бы на неё 403', async () => {
    renderService({
      user: departmentUser('dep-1'),
      unit: { ...KYOCERA, departmentId: 'dep-9' },
    });

    await expectGroups([['Отделы', ['department:dep-1']]]);
    expect(service.siteKey).toBeNull();
  });

  it('по неразмеченной технике площадки нет тоже', async () => {
    // Без отдела-заказчика такую заявку не держит ни одна отдельская колонка: автор перестал бы
    // видеть то, что сам завёл, — потому сервер и отвечает на неё 403.
    renderService({ user: departmentUser('dep-1'), unit: KYOCERA });

    await expectGroups([['Отделы', ['department:dep-1']]]);
    expect(service.siteKey).toBeNull();
  });
});

describe('оргтехника: ключи открытия окна собирает хук (Р11а, К7)', () => {
  const FOREIGN: ServiceRequestCustomerSnapshot = {
    object: { id: 'obj-7', code: 'ОБ-7', name: 'Склад-2' },
    customerDepartment: { id: 'dep-9', code: 'ИТ', name: 'Служба ИТ' },
    equipmentDepartment: null,
  };

  it('заказчик-отдел читается отделом, а не объектом заявки', async () => {
    // Ловушка `costTargetOf`: он смотрит объект раньше отдела, а у сервисной заявки заполнены оба —
    // прогнанный через него заказчик-отдел показался бы площадкой.
    renderService({ user: departmentUser('dep-1'), request: FOREIGN });

    await expectGroups([['Отделы', ['department:dep-9', 'department:dep-1']]]);
    expect(service.savedKey).toBe('department:dep-9');
    // Значение поля ставит форма: поле не выдумывает заказчика за неё и чужого не сбрасывает.
    expect(fieldValue()).toBeUndefined();
  });

  it('заказчик-площадка читается объектом заявки, а не действующим справочником', async () => {
    renderService({
      user: departmentUser('dep-1'),
      request: { ...FOREIGN, customerDepartment: null },
    });

    // Площадка чужой заявки этой учётке не положена (Р12) — предлагать её нечем, и `siteKey` пуст.
    // Но заведённого заказчика правка не сбрасывает: сохранённый вариант держится в списке своей
    // группой, иначе форма отправила бы изменение, которого человек не делал.
    await expectGroups([
      ['Площадка', ['object:obj-7']],
      ['Отделы', ['department:dep-1']],
    ]);
    expect(service.savedKey).toBe('object:obj-7');
    expect(service.siteKey).toBeNull();
  });

  it('единственный отдел учётки отдан ключом — им форма и открывает новую заявку', async () => {
    renderService({ user: departmentUser('dep-1'), unit: KYOCERA });

    await waitFor(() => expect(service.soleDepartmentKey).toBe('department:dep-1'));
  });
});
