import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { VehicleClassificationDto, WarehouseDto } from '@technic/contracts';
import {
  FREIGHT_VEHICLE_KIND_CODE,
  REQUEST_CUSTOMER_LOCKED_MESSAGE,
  vehicleClassificationKey,
} from '@technic/contracts';
import { openSelectOptions, selectOption } from './antd';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { freightRequest, vehicleFeed, vehicleSummary } from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * Подбор «Объект/отдел» в разделе «Заказ автотехники» (план `docs/department-requests-plan.md`,
 * Р2—Р4, Р7, Р9, Р9а).
 *
 * Состав групп и границы самого подбора проверяет `request-customer` — здесь смотрим на то, что
 * добавляет к нему страница: заявку от лица отдела действительно заводят (и в теле уходит
 * `departmentId`, а не площадка), заказчика не меняют у заявки, вышедшей из «Новой», смена типа
 * на спецтехнику уносит выбранный отдел, а фильтр ленты пишет ровно в одну половину пары и тем же
 * значением сужает сводку.
 *
 * Смотрит офис (диспетчер): у него нет своей оси, и обе группы подбора видны целиком — ровно та
 * учётка, ради которой затевалась фича. Роль по имени нигде не спрашивается: сценарий задаёт
 * учётку, а правило считают `useObjectScope`/`useDepartmentScope`.
 */

const CUSTOMER_FIELD = 'Объект/отдел';

const LOADING_OBJECT = objectDto({
  operators: [],
  id: 'obj-1',
  code: 'ОБ-1',
  name: 'ЖК Северный',
  address: 'г Москва, ул Северная, д 1',
});
const UNLOADING_OBJECT = objectDto({
  operators: [],
  id: 'obj-2',
  code: 'ОБ-2',
  name: 'ЖК Южный',
  address: 'г Москва, ул Южная, д 2',
});
const DEPARTMENT = { id: 'dep-1', code: 'СНБ', name: 'Снабжение', isActive: true };

/** Склад поставщика: второй конец маршрута берётся из справочника мест (ADR 0069). */
const WAREHOUSE = {
  id: 'wh-1',
  supplier: { id: 'cp-1', name: 'ООО «Поставщик»', inn: '7736050003', isActive: true },
  address: 'г Москва, ул Складская, д 7',
  name: 'Основной',
  contactPerson: '',
  contactPhone: '',
  comment: '',
  isActive: true,
  createdAt: '2026-08-01T06:00:00.000Z',
  updatedAt: '2026-08-01T06:00:00.000Z',
} as WarehouseDto;

/**
 * Позиция классификатора грузового вида: только она годится обоим типам заявки, и без неё поле
 * типа заперто — переоформление спрашивает вид заказанной техники (ADR 0091).
 */
const DUMP = {
  key: vehicleClassificationKey('vt-2', null),
  vehicleTypeId: 'vt-2',
  vehicleCategoryId: null,
  kindId: 'vk-freight',
  kindCode: FREIGHT_VEHICLE_KIND_CODE,
  kindName: 'Грузовой транспорт',
  typeCode: 'dump',
  typeName: 'Самосвалы',
  categoryName: null,
  label: 'Самосвалы',
  specCount: 0,
  waybillFormCode: '4p',
} as unknown as VehicleClassificationDto;

/** Грузоперевозка отдела, «Новая»: её и переоформляют в заказ на площадку. */
const DEPARTMENT_FREIGHT = freightRequest({
  id: 'vr-dep',
  num: 45,
  displayNumber: 'ТС-45',
  objectId: null,
  objectCode: null,
  objectName: null,
  objectAddress: null,
  departmentId: 'dep-1',
  departmentCode: 'СНБ',
  departmentName: 'Снабжение',
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  vehicleCategorySpecs: null,
  costTarget: { kind: 'department', id: 'dep-1', code: 'СНБ', name: 'Снабжение' },
});

/** Та же заявка в работе: её объект затрат уже ушёл снимком в задание путевого листа (Р7). */
const WORKING_FREIGHT = freightRequest({
  id: 'vr-work',
  num: 46,
  displayNumber: 'ТС-46',
  status: 'confirmed',
  vehicleCategoryId: null,
  vehicleCategoryName: null,
  vehicleCategorySpecs: null,
});

function renderTab(over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: 1, confirmed: 1 })),
    'GET /vehicle-requests/feed': () => json(vehicleFeed([DEPARTMENT_FREIGHT, WORKING_FREIGHT])),
    'GET /objects': () => json(list([LOADING_OBJECT, UNLOADING_OBJECT])),
    'GET /departments': () => json(list([DEPARTMENT])),
    'GET /warehouses': () => json(list([WAREHOUSE])),
    'GET /vehicle-classifications': () => json(list([DUMP])),
    'GET /vehicles': () => json(emptyList()),
    'POST /vehicle-requests': ({ body }) =>
      json({ ...DEPARTMENT_FREIGHT, ...(body as object) }, 201),
    ...over,
  });
  renderWithUser(<VehicleRequestsTab />, { user: authUser() });
  return http;
}

/** Поле формы вместе со своим блоком: у него читаются и состояние, и подсказка под ним. */
function formItem(label: string): HTMLElement {
  const item = [...document.querySelectorAll('.ant-modal .ant-form-item')].find(
    (el) => el.querySelector('label')?.textContent === label,
  );
  if (!item) throw new Error(`Поле «${label}» в форме не найдено`);
  return item as HTMLElement;
}

/** Что показано в поле подбора; `null` — оно пустое. */
function customerValue(): string | null {
  return (
    formItem(CUSTOMER_FIELD).querySelector('.ant-select-content')?.getAttribute('title') ?? null
  );
}

/** Открыть правку заявки по её номеру. */
async function openEdit(displayNumber: string): Promise<void> {
  const row = (await screen.findByText(displayNumber)).closest('tr')!;
  fireEvent.click(row.querySelector('.anticon-edit')!.closest('button')!);
  await waitFor(() => expect(screen.getByText(`Заявка ${displayNumber}`)).toBeDefined());
}

/** Открыть форму новой заявки и выбрать в ней грузоперевозку — отдел заказывает только её. */
async function openCreateFreight(): Promise<void> {
  fireEvent.click(await screen.findByText('Создать заявку'));
  await screen.findByText('Новая заявка на автотехнику');
  await selectOption('Тип заявки', 'Грузоперевозка');
  await screen.findByText('Место погрузки');
}

/**
 * Выбрать адрес из справочника (ADR 0069): чекбокс меняет набор адреса на список записей, и
 * выбранная приходит уже верифицированной — иначе жёсткая модель адресов не пустит форму дальше.
 */
async function pickAddress(label: string, text: string): Promise<void> {
  // Блок адреса ищется по своей подписи, а не по первой в нём: первая — у чекбокса режима.
  const labelNode = [...document.querySelectorAll('.ant-modal .address-field label')].find(
    (l) => l.textContent === label,
  );
  const field = labelNode!.closest('.address-field') as HTMLElement;
  fireEvent.click(within(field).getByText('Из справочника'));
  fireEvent.mouseDown(
    field.querySelector('.ant-select-content') ?? field.querySelector('.ant-select')!,
  );
  const option = await waitFor(() => {
    const dropdowns = [...document.querySelectorAll('.ant-select-dropdown')].filter(
      (d) => !d.classList.contains('ant-select-dropdown-hidden'),
    );
    const found = [
      ...dropdowns[dropdowns.length - 1]!.querySelectorAll<HTMLElement>('.ant-select-item-option'),
    ].find((o) => o.textContent?.includes(text));
    if (!found) throw new Error(`варианта «${text}» в списке «${label}» нет`);
    return found;
  });
  fireEvent.click(option);
}

/** Фильтр панели опознаётся подсказкой либо выбранным значением: подписи у фильтров нет. */
async function pickFilter(shown: string, option: string): Promise<void> {
  const field = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('.ant-select')].find(
      (el) => el.textContent?.trim() === shown,
    );
    if (!found) throw new Error(`фильтра «${shown}» на экране нет`);
    return found;
  });
  fireEvent.mouseDown(field.querySelector('.ant-select-content') ?? field);
  await waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find((o) =>
      o.textContent?.includes(option),
    );
    expect(match, `вариант «${option}»`).toBeTruthy();
    fireEvent.click(match!);
  });
}

describe('форма: заказчиком становится подразделение (Р2, Р3)', () => {
  it('офис видит обе группы и заводит грузоперевозку от лица отдела', async () => {
    const http = renderTab();
    await openCreateFreight();

    // Обе группы целиком: заявку от лица отдела заводит и тот, кто в этом отделе не работает.
    const options = await openSelectOptions(CUSTOMER_FIELD);
    expect(options.map((o) => o.textContent)).toEqual([
      'ОБ-1 — ЖК Северный',
      'ОБ-2 — ЖК Южный',
      'СНБ — Снабжение',
    ]);
    expect(
      [...document.querySelectorAll('.ant-select-item-group')].map((el) => el.textContent),
    ).toEqual(['Объекты', 'Отделы']);
    fireEvent.click(options[2]!);

    // Остальное форме нужно, чтобы дойти до запроса: техника, места обоих концов, груз и контакты.
    await selectOption('Тип/категория ТС', /Самосвалы/);
    await pickAddress('Место погрузки', 'ул Складская');
    await pickAddress('Место разгрузки', 'ул Южная');
    fireEvent.change(document.querySelector('#trips_0_volumeM3')!, { target: { value: '12' } });
    for (const [id, value] of [
      ['trips_0_fromResponsibleName', 'Сидоров Сергей'],
      ['trips_0_fromResponsiblePhone', '9260000002'],
      ['trips_0_toResponsibleName', 'Кузнецов Кирилл'],
      ['trips_0_toResponsiblePhone', '9260000003'],
    ] as const) {
      fireEvent.change(document.querySelector(`#${id}`)!, { target: { value } });
    }

    fireEvent.click(screen.getByText('Сохранить'));

    await waitFor(() => expect(http.countOf('POST /vehicle-requests')).toBe(1));
    const body = http.lastCall('POST /vehicle-requests')!.body as Record<string, unknown>;
    // Заказчик — ровно одна половина пары: обе сразу не примет ни CHECK, ни схема запроса.
    expect(body.departmentId).toBe('dep-1');
    expect(body.objectId).toBeUndefined();
  });

  it('у заявки не в «Новой» заказчик заперт и поле говорит почему (Р7)', async () => {
    renderTab();
    await openEdit('ТС-46');

    const item = formItem(CUSTOMER_FIELD);
    expect(item.querySelector('.ant-select-disabled')).not.toBeNull();
    // Текст — тот же, которым сервер отвечает 422: разойдись они, поле объясняло бы запрет иначе,
    // чем отказ на попытку его обойти.
    expect(item.textContent).toContain(REQUEST_CUSTOMER_LOCKED_MESSAGE);
  });

  it('смена типа на спецтехнику уносит выбранный отдел (Р4, К8)', async () => {
    renderTab();
    await openEdit('ТС-45');
    expect(customerValue()).toBe('СНБ — Снабжение');

    await selectOption('Тип заявки', 'Техника для работы на объекте');

    // Спецтехника выходит на площадку: отдела в подборе не остаётся вовсе — ни группой, ни
    // сохранённым значением заявки, — и поле спрашивает объект заново.
    await waitFor(() => expect(customerValue()).toBeNull());
    const options = await openSelectOptions(CUSTOMER_FIELD);
    expect(options.map((o) => o.textContent)).toEqual(['ОБ-1 — ЖК Северный', 'ОБ-2 — ЖК Южный']);
  });
});

describe('фильтр ленты и сводка над ней (Р9, Р9а)', () => {
  it('выбор отдела чистит объект и тем же значением сужает сводку', async () => {
    const http = renderTab();
    await screen.findByText('ТС-45');

    await pickFilter('Все заказчики', 'ОБ-1 — ЖК Северный');
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/feed')!.query.get('objectId')).toBe('obj-1'),
    );

    await pickFilter('ОБ-1 — ЖК Северный', 'СНБ — Снабжение');

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/feed')!;
      expect(call.query.get('departmentId')).toBe('dep-1');
      // Вторая половина пары снимается той же правкой: оставленный объект сузил бы выдачу до
      // пустой — заявок, у которых заполнены обе колонки, не бывает.
      expect(call.query.get('objectId')).toBeNull();
      // Список возвращается на первую страницу: та же страница при другом отборе — другие заявки.
      expect(call.query.get('page')).toBe('1');
    });
    // Цифры над таблицей считаются по тому же отбору, что видно в ней самой.
    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/summary')!;
      expect(call.query.get('departmentId')).toBe('dep-1');
      expect(call.query.get('objectId')).toBeNull();
    });
  });
});
