import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, OfficeEquipmentDto, ServiceRequestDto } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { departmentUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import {
  serviceCustomer,
  serviceInHouseExecutor,
  serviceOperator,
  serviceRequest,
} from './factories/service';
import { objectDto } from './factories/waste';
import { openSelectOptions, selectOption } from './antd';
import { ServiceRequestForm } from '../src/pages/service/ServiceRequestForm';

/**
 * Заявка заводится БЕЗ аппарата (план `docs/office-equipment-consumables-and-purchase-plan.md`,
 * Р5, Р6, Р7; ADR 0146, решение 6).
 *
 * Половина работы модуля предметом в справочнике не описывается вовсе — «поставьте розетку»,
 * «настройте почту новому сотруднику», «принтер привезли, инвентарного номера ещё нет», — и до сих
 * пор такую заявку заводили на посторонний аппарат, после чего его история обслуживания врала.
 *
 * Проверяется то, что молча расходится с сервером и стоит человеку отказа после заполненной формы:
 *
 * 1. **звёздочка по праву** — рядовой заявитель обязан назвать аппарат, держатель
 *    `serviceRequests.createWithoutEquipment` — нет. Обязательность снимает портал: схема принимает
 *    пустой аппарат у всех, а отказывает по нему маршрут (403), и «заполните поле» в ответ
 *    рядовому означало бы «вы ошиблись формой» там, где человек не ошибся ничем;
 * 2. **ось роли в подборе заказчика** — роль площадки называет свои объекты, роль отдела свои
 *    отделы, ИТ-служба (сквозная область модуля) и то и другое. Это не удобство: без аппарата три
 *    колонки области заполняет сам человек, и выбор поперёк оси создал бы заявку **вне собственной
 *    области автора** — он потерял бы её сразу после отправки;
 * 3. **два смысла `objectId`** — с аппаратом это «где он стоит на самом деле» (пара с пометкой), а
 *    без аппарата **заказчик-площадка**. Тело запроса собирается по этому правилу, и перепутанные
 *    смыслы дали бы либо заявку без заказчика, либо ложную строку в очереди расхождений ИТ-службы;
 * 4. **две закрытые двери (Р7)** — гарантийного обращения и пометки «не тот объект» у заявки без
 *    аппарата не бывает вовсе: спорят и расходятся с КОНКРЕТНОЙ единицей, а её нет;
 * 5. **разбор отказов** — 403 говорится словами и под тем полем, которым отказ снимается.
 *
 * Роли по имени нигде не спрашиваются: сценарий задаёт учётку с осью и набором, а состав считают
 * те же хуки области, по которым живёт портал.
 */

const NORTH = objectDto({ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' });
const SOUTH = objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' });
/** Чужая площадка: в области объектной роли её нет, и предлагать её нельзя. */
const FOREIGN = objectDto({ id: 'obj-9', code: 'ОБ-9', name: 'ЖК Западный' });

const NORTH_LABEL = 'ОБ-1 — ЖК Северный';
const SOUTH_LABEL = 'ОБ-2 — ЖК Южный';
const PTO_LABEL = 'ПТО — Производственно-технический';
const SNB_LABEL = 'СНБ — Снабжение';

const DEPARTMENTS = [
  {
    id: 'dep-1',
    code: 'ПТО',
    name: 'Производственно-технический',
    isActive: true,
    objects: [],
    object: null,
    heads: [],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  },
  {
    id: 'dep-2',
    code: 'СНБ',
    name: 'Снабжение',
    isActive: true,
    objects: [],
    object: null,
    heads: [],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  },
];

/**
 * Единица под гарантией: без неё «блока гарантии нет» ничего не проверяло бы — поле показывается
 * только там, где обращаться есть по чему (Р26), и у аппарата без гарантии его не бывает и так.
 */
const UNIT: OfficeEquipmentDto = {
  id: 'oe-1',
  type: { id: 'oet-1', name: 'МФУ', isActive: true },
  name: 'Kyocera M3145',
  serialNumber: '',
  inventoryNumber: '0012345',
  object: { id: NORTH.id, code: NORTH.code, name: NORTH.name },
  department: null,
  location: 'Корпус 3, каб. 214',
  state: 'on_site',
  stateNote: '',
  purchasedOn: null,
  warrantyUntil: '2030-01-01',
  comment: '',
  isActive: true,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
  deletedAt: null,
} as OfficeEquipmentDto;

/** Вторая единица — чтобы `AutoSelect` не подставил первую сам: пустое поле и есть предмет теста. */
const SECOND: OfficeEquipmentDto = {
  ...UNIT,
  id: 'oe-2',
  name: 'Brother HL-1110R',
  inventoryNumber: '0000778',
};

/** Оператор оргтехники: объектная ось и право заводить заявку без аппарата (Р5). */
const OPERATOR: AuthUser = serviceOperator({
  constructionObjectIds: [NORTH.id, SOUTH.id],
  phone: '9001234567',
});

/** Рядовой заявитель: та же роль и та же площадка, но права оставить аппарат пустым нет. */
const REQUESTER: AuthUser = serviceCustomer({ phone: '9001234567' });

/**
 * Сотрудник отдела с набором «Оргтехника: ведение». Отделов два: с одним поле оказалось бы
 * запертым единственным вариантом, и «объектов в списке нет» было бы неотличимо от «списка нет».
 */
const DEP_OPERATOR: AuthUser = departmentUser('dep-1', [], {
  departmentIds: ['dep-1', 'dep-2'],
  addons: ['office_equipment_operator'],
  phone: '9001234567',
});

/** ИТ-служба: область модуля сквозная (ADR 0106, решение 2), и осей у неё нет ни одной. */
const IT_SERVICE: AuthUser = serviceInHouseExecutor({
  constructionObjectIds: [NORTH.id],
  phone: '9001234567',
});

function renderForm(
  user: AuthUser,
  routes: RouteMap = {},
  /** Правимая заявка; по умолчанию заводится новая — ради неё вся правка и делалась. */
  request: ServiceRequestDto | null = null,
): HttpMock {
  const http = mockHttp({
    'GET /office-equipment': () => json(list([UNIT, SECOND])),
    'GET /objects': () => json(list([NORTH, SOUTH, FOREIGN])),
    'GET /departments': () => json(list(DEPARTMENTS)),
    'POST /service-requests': () => json({ request: serviceRequest(), mail: 'queued' }, 201),
    ...routes,
  });
  renderWithUser(<ServiceRequestForm open request={request} onClose={() => {}} />, { user });
  return http;
}

/** Подпись поля — по ней antd и рисует звёздочку обязательности (`ant-form-item-required`). */
function labelOf(text: string): HTMLElement {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === text,
  );
  if (!label) throw new Error(`поля «${text}» на экране нет`);
  return label as HTMLElement;
}

/** Звёздочка у подписи: обязательное поле antd метит классом, а не символом в тексте. */
const required = (text: string) => labelOf(text).classList.contains('ant-form-item-required');

/** Причина отказа под полем — тем самым, которому она адресована. */
function fieldError(text: string): string | null {
  const item = labelOf(text).closest('.ant-form-item');
  return item?.querySelector('.ant-form-item-explain-error')?.textContent ?? null;
}

/** Заперто ли поле заказчика: antd отмечает это классом обёртки, а не признаком ввода. */
function customerLocked(): boolean {
  const field = document.getElementById('customer')?.closest('.ant-select');
  return !!field?.classList.contains('ant-select-disabled');
}

/** Дождаться собранного состава: до ответа справочников вариантов ноль и поле заперто (Р3а). */
async function customerReady(): Promise<void> {
  await waitFor(() => expect(customerLocked()).toBe(false));
}

/** Что предлагает подбор заказчика — подписи вариантов в порядке показа. */
async function customerOptions(): Promise<string[]> {
  await customerReady();
  const options = await openSelectOptions('Для кого заявка');
  return options.map((option) => option.textContent ?? '');
}

/** Заголовки групп подбора: по ним видно, какая ось открыта. */
async function customerGroups(): Promise<string[]> {
  await customerReady();
  const [first] = await openSelectOptions('Для кого заявка');
  const dropdown = first!.closest('.ant-select-dropdown')!;
  return [...dropdown.querySelectorAll('.ant-select-item-group')].map((el) => el.textContent ?? '');
}

/**
 * Заполнить обязательное и отправить.
 *
 * Полей два, и оба к предмету теста отношения не имеют: описание и подразделение заявителя. Второе
 * спрашивается потому, что привязок у сценарных учёток по две (Н11), — а две они ради проверок про
 * состав поля заказчика: с единственной привязкой «чужого в списке нет» было бы неотличимо от
 * «в справочнике одна строка».
 */
async function submit(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Описание'), {
    target: { value: 'Поставьте розетку у нового рабочего места' },
  });
  if (document.getElementById('requesterPlaceId')) {
    await selectOption('Откуда обращаетесь', /ЖК Северный|Производственно-технический/);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
}

function bodyOf(http: HttpMock): Record<string, unknown> {
  return http.lastCall('POST /service-requests')?.body as Record<string, unknown>;
}

describe('звёздочка у поля «Какой аппарат» — по праву (Р5)', () => {
  it('рядовой заявитель обязан назвать аппарат', async () => {
    renderForm(REQUESTER);
    await screen.findByLabelText('Описание');

    expect(required('Какой аппарат')).toBe(true);

    // И правило работает: отправка без аппарата останавливается формой, не дойдя до сервера.
    await submit();
    await waitFor(() => expect(fieldError('Какой аппарат')).toBe('Выберите единицу оргтехники'));
  });

  it('у держателя права звёздочки нет, и форма отправляется с пустым полем', async () => {
    const http = renderForm(OPERATOR);
    await screen.findByLabelText('Описание');

    expect(required('Какой аппарат')).toBe(false);

    await selectOption('Для кого заявка', NORTH_LABEL);
    await submit();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));
    expect(fieldError('Какой аппарат')).toBeNull();
  });
});

describe('заказчик обязателен и собирается по оси роли (Р6)', () => {
  it('поле не заперто до выбора аппарата: заказчик и есть ответ на «чья заявка»', async () => {
    renderForm(OPERATOR);
    await screen.findByLabelText('Описание');

    // Прежнее правило («до выбора единицы поле заперто», Р11) держалось площадкой, производной от
    // аппарата. Без аппарата запирать нечем — иначе заявку нельзя было бы завести вовсе.
    await customerReady();
    expect(required('Для кого заявка')).toBe(true);
  });

  it('не выбрав заказчика, заявку не отправить', async () => {
    const http = renderForm(OPERATOR);
    await customerReady();

    await submit();

    await waitFor(() => expect(fieldError('Для кого заявка')).toBe('Выберите заказчика заявки'));
    expect(http.countOf('POST /service-requests')).toBe(0);
  });

  it('роли площадки предлагаются её объекты и не предлагаются отделы', async () => {
    renderForm(OPERATOR);

    // Отделов нет ни одного: заявка «от отдела» держится в области одним `customer_department_id`,
    // и роль площадки, назвавшая отдел, завела бы её вне своей области — сервер отвечает 422.
    expect(await customerGroups()).toEqual(['Объекты']);
    // Чужой площадки нет тоже: справочник отдал три, предлагаются две свои.
    expect(await customerOptions()).toEqual([NORTH_LABEL, SOUTH_LABEL]);
  });

  it('роли отдела предлагаются её отделы и не предлагаются объекты', async () => {
    renderForm(DEP_OPERATOR);

    expect(await customerGroups()).toEqual(['Отделы']);
    expect(await customerOptions()).toEqual([PTO_LABEL, SNB_LABEL]);
  });

  it('ИТ-службе предлагаются обе оси: сквозная область не сужает ни одну', async () => {
    renderForm(IT_SERVICE);

    expect(await customerGroups()).toEqual(['Объекты', 'Отделы']);
    // Площадка у учётки одна, а предлагаются все три: область модуля у набора сквозная, и заявку
    // ИТ-служба заводит по всей компании — сервер её ось тоже не сужает.
    expect(await customerOptions()).toEqual([
      NORTH_LABEL,
      SOUTH_LABEL,
      'ОБ-9 — ЖК Западный',
      PTO_LABEL,
      SNB_LABEL,
    ]);
  });

  it('выбранный аппарат возвращает прежний состав: площадка от него, отделы полным списком', async () => {
    renderForm(OPERATOR);
    await customerReady();

    await selectOption('Какой аппарат', /Kyocera/);

    // С аппаратом ось заказчика другая (Р11, Р11б): площадка приходит снимком единицы, а отделы
    // отвечают на «от чьего имени просят» — заявку всё равно держит объект аппарата.
    expect(await customerGroups()).toEqual(['Площадка', 'Отделы']);
    expect(await customerOptions()).toEqual([NORTH_LABEL, PTO_LABEL, SNB_LABEL]);
  });
});

describe('тело запроса: у `objectId` второй смысл (Р6)', () => {
  it('заказчик-площадка уходит объектом, а аппарат — явным `null`', async () => {
    const http = renderForm(OPERATOR);
    await selectOption('Для кого заявка', SOUTH_LABEL);

    await submit();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));

    const body = bodyOf(http);
    // `null`, а не пропуск: «аппарата у заявки нет» — ответ, а не умолчание клиента.
    expect(body.officeEquipmentId).toBeNull();
    // Тот же `objectId`, которым у заявки с аппаратом называют «не тот объект», здесь называет
    // заказчика: областью роли площадки заведует именно эта колонка.
    expect(body.objectId).toBe(SOUTH.id);
    // Заказчик ровно один (`CHECK` предмета, Р7): вторая половина пары уходит пустой.
    expect(body.customerDepartmentId).toBeNull();
    // И пометка «не тот объект» не поднимается: без единицы расходиться не с чем.
    expect(body.objectOverridden).toBe(false);
  });

  it('заказчик-отдел уходит отделом, а объект не уходит вовсе', async () => {
    const http = renderForm(DEP_OPERATOR);
    await selectOption('Для кого заявка', SNB_LABEL);

    await submit();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));

    const body = bodyOf(http);
    expect(body.customerDepartmentId).toBe('dep-2');
    // Оба заказчика сразу схема отбивает: заявку считали бы своей и роль площадки, и роль отдела.
    expect('objectId' in body).toBe(false);
  });
});

describe('две закрытые двери у заявки без аппарата (Р7)', () => {
  it('блоков гарантии и пометки «не тот объект» нет вовсе', async () => {
    renderForm(OPERATOR);
    await customerReady();

    expect(screen.queryByLabelText('Обращение по гарантии')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Аппарат стоит на другом объекте' })).toBeNull();

    // Оба появляются вместе с аппаратом — и тем доказывают, что скрыты они не потому, что их нет
    // в форме вовсе: гарантия у единицы действует, а пометка спорит с её карточкой.
    await selectOption('Какой аппарат', /Kyocera/);
    expect(await screen.findByLabelText('Обращение по гарантии')).toBeDefined();
    expect(
      await screen.findByRole('checkbox', { name: 'Аппарат стоит на другом объекте' }),
    ).toBeDefined();
  });

  it('заявленное по аппарату не уезжает вместе с его очисткой', async () => {
    const http = renderForm(OPERATOR);
    await selectOption('Какой аппарат', /Kyocera/);
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Аппарат стоит на другом объекте' }),
    );
    await selectOption('Где он на самом деле', /ЖК Южный/);
    await selectOption('Обращение по гарантии', 'Гарантия на технику');

    // Убрали аппарат — блок реквизитов ушёл с экрана вместе со своим сбросом, но значения его
    // полей остались бы в форме: antd их не выбрасывает. Уйди они на сервер — заявка получила бы
    // отказ схемы по полям, которых человек на экране уже не видит.
    // Крестик именно у поля техники: он появляется только у держателя права (Р5), и «оставьте
    // поле пустым» без него было бы советом, невыполнимым после первого же клика.
    const equipmentField = document.getElementById('officeEquipmentId')!.closest('.ant-select')!;
    const clear = equipmentField.querySelector('.ant-select-clear')!;
    fireEvent.mouseDown(clear);
    fireEvent.click(clear);
    await waitFor(() => expect(screen.queryByLabelText('Где он на самом деле')).toBeNull());
    await selectOption('Для кого заявка', NORTH_LABEL);

    await submit();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));

    const body = bodyOf(http);
    expect(body.officeEquipmentId).toBeNull();
    expect(body.objectOverridden).toBe(false);
    expect(body.warrantyClaim).toBeUndefined();
    // А `objectId` в теле есть — но это уже заказчик, а не заявленное «стоит не там».
    expect(body.objectId).toBe(NORTH.id);
  });
});

describe('разбор отказов сервера', () => {
  it('403 сказан словами под тем полем, которым отказ снимается', async () => {
    const denial =
      'Заявку без аппарата заводит тот, кому это разрешено отдельно — выберите аппарат из справочника';
    renderForm(OPERATOR, {
      // Право могли отозвать между открытием формы и нажатием: список прав портал спрашивает у
      // сервера, но не переспрашивает на каждое действие.
      'POST /service-requests': () => apiError(403, { code: 'forbidden', message: denial }),
    });
    await selectOption('Для кого заявка', NORTH_LABEL);

    await submit();

    // Полей в 403 нет и быть не может — отвечает страж права, а не проверка значения. Слова
    // ставятся к полю аппарата: оно тут не виновник, а выход.
    await waitFor(() => expect(fieldError('Какой аппарат')).toBe(denial));
  });

  it('422 маршрута встаёт под подбором заказчика: там его и правят', async () => {
    const reason = 'Заявку можно завести только от своего объекта';
    renderForm(OPERATOR, {
      'POST /service-requests': () =>
        apiError(422, {
          code: 'unprocessable_entity',
          message: reason,
          fields: { objectId: 'Чужой объект' },
        }),
    });
    await selectOption('Для кого заявка', NORTH_LABEL);

    await submit();

    // Сервер знает пару колонок, человек видит один подбор: без перевода имени отказ ушёл бы в
    // тост — то есть в угол экрана, ничего не пометив.
    await waitFor(() => expect(fieldError('Для кого заявка')).toBe('Чужой объект'));
  });

  it('400 схемы разбирается по именам полей', async () => {
    renderForm(OPERATOR, {
      'POST /service-requests': () =>
        apiError(400, {
          code: 'validation_error',
          message: 'Ошибка валидации данных',
          fields: { description: 'Напишите подробнее' },
        }),
    });
    await selectOption('Для кого заявка', NORTH_LABEL);

    await submit();

    await waitFor(() => expect(fieldError('Описание')).toBe('Напишите подробнее'));
  });
});

describe('правка заведённой заявки без аппарата', () => {
  it('пустое поле техники не запирает сохранение тому, у кого права нет', async () => {
    // Заявку без аппарата заводит держатель права, а правит её (пока она «Новая») обычный
    // заявитель своей области. Требуй портал аппарат у него — правка встала бы отказом по
    // выключенному полю, заполнить которое человек не может ничем.
    const http = renderForm(
      REQUESTER,
      { 'PATCH /service-requests/:id': () => json(serviceRequest({ equipment: null })) },
      serviceRequest({ equipment: null }),
    );

    expect(await screen.findByText('Без аппарата')).toBeDefined();
    expect(required('Какой аппарат')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id')).toBe(1));
    expect(fieldError('Какой аппарат')).toBeNull();
  });
});

describe('рядового заявителя правка не касается', () => {
  it('без права поле заказчика заперто до выбора аппарата, как и прежде (Р11)', async () => {
    renderForm(REQUESTER, { 'GET /objects': () => json(emptyList()) });
    await screen.findByLabelText('Описание');

    // Площадки без единицы нет вовсе, а отделы у объектной роли — состав «от чьего имени просят»:
    // выбирать не из чего, пока не назван аппарат.
    await waitFor(() => expect(customerLocked()).toBe(true));
  });
});
