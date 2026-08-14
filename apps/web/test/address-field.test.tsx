import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { VehicleRequestDto, WarehouseDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { typeDate } from './antd';
import {
  classification,
  freightRequest,
  freightTrip,
  vehicleFeed,
  vehicleRequest,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';
import { VehicleRelocationModal } from '../src/pages/vehicle/VehicleRelocationModal';
import { ObjectsTab } from '../src/pages/directories/ObjectsTab';

/**
 * Адрес из справочника (ADR 0069): чекбокс напротив заголовка меняет набор с подсказками на выбор
 * записи, и в заявку уходит адрес выбранного объекта или склада.
 *
 * Проверяется то, чего не видно ни в контрактах, ни на сервере: что человек может этот адрес
 * выбрать и что выбранное доезжает до запроса вместе со ссылкой на запись. Ссылка здесь не
 * подробность — ею одной адрес из справочника и подтверждается: ФИАС у него нет.
 *
 * Отдельно проверяются подсказки. Их смысл в том, что список открывается уже на нужной площадке, —
 * и в том, что они уходят, как только человек начал искать другое: иначе первые строки списка
 * отодвигали бы найденное.
 */

// `operators` — часть карточки объекта: справочник показывает их колонкой, и без них он падает.
const OWN_OBJECT = objectDto({
  operators: [],
  id: 'obj-1',
  code: 'ОБ-1',
  name: 'ЖК Северный',
  address: 'г Москва, ул Северная, д 1',
});
const OTHER_OBJECT = objectDto({
  operators: [],
  id: 'obj-2',
  code: 'ОБ-2',
  name: 'ЖК Южный',
  address: 'г Москва, ул Южная, д 2',
});
/** Объект без адреса: в списке мест ему нечего называть, и его там быть не должно. */
const NO_ADDRESS_OBJECT = objectDto({
  operators: [],
  id: 'obj-3',
  code: 'ОБ-3',
  name: 'Без адреса',
  address: '',
});

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

/** Склад приостановленного поставщика: активен сам, но возить к нему уже не к кому. */
const WAREHOUSE_OF_STOPPED_SUPPLIER = {
  ...WAREHOUSE,
  id: 'wh-2',
  address: 'г Москва, ул Заброшенная, д 3',
  supplier: { ...WAREHOUSE.supplier, id: 'cp-2', name: 'ООО «Бывший»', isActive: false },
} as WarehouseDto;

function renderTab(over: RouteMap = {}, items: VehicleRequestDto[] = []): HttpMock {
  const http = mockHttp({
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: items.length })),
    'GET /vehicle-requests/feed': () => json(vehicleFeed(items)),
    'GET /objects': () => json(list([OWN_OBJECT, OTHER_OBJECT, NO_ADDRESS_OBJECT])),
    'GET /departments': () => json(emptyList()),
    'GET /warehouses': () => json(list([WAREHOUSE, WAREHOUSE_OF_STOPPED_SUPPLIER])),
    // Справочник техники — фильтр по назначенной машине (ADR 0098); тест про адреса, он пуст.
    'GET /vehicles': () => json(emptyList()),
    // Классификатор грузового вида: заявку на грузоперевозку другим и не заведёшь.
    'GET /vehicle-classifications': () =>
      json(
        list([
          classification({
            key: 'vt-2:',
            vehicleTypeId: 'vt-2',
            vehicleCategoryId: null,
            kindId: 'vk-freight',
            kindCode: 'freight_transport',
            kindName: 'Грузовая техника',
            typeCode: 'dump',
            typeName: 'Самосвалы',
            categoryName: null,
            label: 'Самосвалы',
            specCount: 0,
          }),
        ]),
      ),
    'POST /vehicle-requests': ({ body }) => json({ ...freightRequest(), ...(body as object) }, 201),
    ...over,
  });
  // Штаб своей площадки: у него есть и объект заявки, и своя площадка — на них и строятся
  // подсказки. Диспетчеру подсказывать нечем: объектов у роли нет.
  renderWithUser(<VehicleRequestsTab />, {
    user: authUser({ role: 'shtab', constructionObjectIds: ['obj-1'] }),
  });
  return http;
}

/**
 * Элемент ввода адреса. Именно из блока управления: первый `input` блока — это чекбокс «Из
 * справочника», он стоит выше по разметке, и набор ушёл бы в него.
 */
function addressInput(field: HTMLElement): HTMLInputElement {
  return field.querySelector('.ant-form-item-control input') as HTMLInputElement;
}

/** Поле формы по подписи: у адреса это блок `.address-field`, а не один элемент ввода. */
function addressField(label: string): HTMLElement {
  const labelNode = [...document.querySelectorAll('.ant-modal .address-field label')].find(
    (l) => l.textContent === label,
  );
  return labelNode!.closest('.address-field') as HTMLElement;
}

/** Открывает форму новой заявки и переключает её на грузоперевозку. */
async function openFreightForm(): Promise<void> {
  fireEvent.click(await screen.findByText('Создать заявку'));
  await screen.findByText('Новая заявка на автотехнику');
  const type = document.querySelector('#requestType')!;
  fireEvent.mouseDown(type);
  fireEvent.click(await screen.findByTitle('Грузоперевозка'));
  await screen.findByText('Место погрузки');
}

/** Включает режим справочника у поля и открывает его список. */
async function openDirectory(label: string): Promise<HTMLElement> {
  const field = addressField(label);
  fireEvent.click(within(field).getByText('Из справочника'));
  // Список открывается нажатием по самому полю: в antd 6 это `.ant-select-content`.
  fireEvent.mouseDown(
    field.querySelector('.ant-select-content') ?? field.querySelector('.ant-select')!,
  );
  // Справочники грузятся лениво — первое открытие ждёт ответа, и до него выбирать не из чего.
  await waitFor(() => expect(optionTexts().length).toBeGreaterThan(0));
  return field;
}

/**
 * Открытый выпадающий список. Ищется среди всех: antd рисует их в порталах и, однажды открыв,
 * держит в разметке скрытыми — без отбора по видимости в проверку попадали бы и чужие списки.
 */
function openDropdown(): HTMLElement {
  const visible = [...document.querySelectorAll('.ant-select-dropdown')].filter(
    (d) => !d.classList.contains('ant-select-dropdown-hidden'),
  );
  return visible[visible.length - 1] as HTMLElement;
}

/** Подписи вариантов открытого списка — в том порядке, в каком их видит человек. */
function optionTexts(): string[] {
  return [...openDropdown().querySelectorAll('.ant-select-item-option')].map(
    (o) => o.textContent ?? '',
  );
}

/** Заголовки групп открытого списка: «Подсказки», «Объекты», «Склады поставщиков». */
function groupTexts(): string[] {
  return [...openDropdown().querySelectorAll('.ant-select-item-group')].map(
    (g) => g.textContent ?? '',
  );
}

/** Режим поля виден по чекбоксу: он и переключает набор адреса на выбор из справочника. */
function fromDirectory(field: HTMLElement): boolean {
  return !!field.querySelector('.ant-checkbox-checked');
}

describe('адресное поле: выбор из справочника (ADR 0069)', () => {
  it('чекбокс меняет набор адреса на список объектов и складов', async () => {
    renderTab();
    await openFreightForm();
    await openDirectory('Место погрузки');

    const texts = optionTexts().join('\n');
    // Запись называет себя наименованием и адресом сразу: по адресу её ищут, по названию узнают.
    expect(texts).toContain('ОБ-2 — ЖК Южный — г Москва, ул Южная, д 2');
    expect(texts).toContain('Основной — г Москва, ул Складская, д 7');
    // Площадке без адреса в списке мест делать нечего, как и складу приостановленного поставщика.
    expect(texts).not.toContain('Без адреса');
    expect(texts).not.toContain('ул Заброшенная');
  });

  it('поиск находит запись и по адресу, и по наименованию', async () => {
    renderTab();
    await openFreightForm();
    const field = await openDirectory('Место погрузки');
    const input = addressInput(field);

    fireEvent.change(input, { target: { value: 'Складская' } });
    await waitFor(() => expect(optionTexts().join()).toContain('Основной'));
    expect(optionTexts().join()).not.toContain('ЖК Южный');

    fireEvent.change(input, { target: { value: 'Южный' } });
    await waitFor(() => expect(optionTexts().join()).toContain('ЖК Южный'));
    expect(optionTexts().join()).not.toContain('Основной');
  });

  it('выбранная запись уходит в заявку адресом и ссылкой на себя', async () => {
    const http = renderTab();
    await openFreightForm();

    for (const [label, address] of [
      ['Место погрузки', 'г Москва, ул Складская, д 7'],
      ['Место разгрузки', 'г Москва, ул Южная, д 2'],
    ] as const) {
      const field = await openDirectory(label);
      const input = addressInput(field);
      fireEvent.change(input, { target: { value: address } });
      fireEvent.click(within(openDropdown()).getByTitle(new RegExp(address.slice(-12))));
    }

    // Остальные обязательные поля формы — заявке нужен ещё и груз с контактами.
    const classificationSelect = document
      .querySelector('#classificationKey')!
      .closest('.ant-select')!;
    fireEvent.mouseDown(classificationSelect.querySelector('.ant-select-content')!);
    // Позиция классификатора рисуется своей разметкой (наименование плюс приписка), и `title`
    // у такого варианта нет — ищем по тексту.
    await waitFor(() => expect(optionTexts().join()).toContain('Самосвалы'));
    fireEvent.click(within(openDropdown()).getByText(/Самосвалы/));
    fireEvent.change(document.querySelector('#volumeM3')!, { target: { value: '12' } });
    for (const [id, value] of [
      ['loadingResponsibleName', 'Сидоров Сергей'],
      ['loadingResponsiblePhone', '9260000002'],
      ['unloadingResponsibleName', 'Кузнецов Кирилл'],
      ['unloadingResponsiblePhone', '9260000003'],
    ] as const) {
      fireEvent.change(document.querySelector(`#${id}`)!, { target: { value } });
    }

    fireEvent.click(screen.getByText('Сохранить'));
    await waitFor(() => expect(http.countOf('POST /vehicle-requests')).toBe(1));
    const body = http.lastCall('POST /vehicle-requests')!.body as Record<string, unknown>;
    // Адреса уехали с заявки на ездку (Р2): у заведённой их ровно одна, и пара с метаданными
    // приходит в ней. Верификация проверяется тем же: строка и метаданные ходят вместе.
    const [trip] = body.trips as Record<string, unknown>[];
    expect(trip!.fromLocation).toBe('г Москва, ул Складская, д 7');
    expect(trip!.fromAddress).toEqual({ source: 'warehouse', refId: 'wh-1' });
    expect(trip!.toLocation).toBe('г Москва, ул Южная, д 2');
    expect(trip!.toAddress).toEqual({ source: 'object', refId: 'obj-2' });
  });

  it('правка заявки открывает поле в том режиме, каким адрес и заводили', async () => {
    const saved = freightRequest({
      id: 'vr-9',
      displayNumber: 'Т-9',
      trips: [
        freightTrip({
          fromLocation: OWN_OBJECT.address,
          fromAddress: { source: 'object', refId: OWN_OBJECT.id },
          toLocation: 'г Москва, ул Тверская, д 5',
          toAddress: { source: 'resolved', fiasId: 'fias-1' },
        }),
      ],
    });
    renderTab({}, [saved]);
    fireEvent.click(
      (await screen.findByText('Т-9')).closest('tr')!.querySelector('.anticon-edit')!,
    );
    await screen.findByText('Заявка Т-9');

    // Выбранный из справочника — списком с подписью записи; набранный с подсказками — строкой.
    const picked = addressField('Место погрузки');
    expect(fromDirectory(picked)).toBe(true);
    expect(within(picked).getByTitle(/ЖК Северный/)).toBeDefined();
    expect(fromDirectory(addressField('Место разгрузки'))).toBe(false);
  });
});

describe('подсказки первой строкой (ADR 0069)', () => {
  it('пока поиск не начат, сверху стоят площадка заявки и площадки учётки', async () => {
    renderTab();
    await openFreightForm();
    // Объект заявки штаб подставляет себе сам — он у роли один.
    await openDirectory('Место погрузки');

    expect(groupTexts()[0]).toBe('Подсказки');
    expect(optionTexts()[0]).toContain('ЖК Северный');
    // Предложенная площадка не задваивается: в общей группе её уже нет.
    expect(optionTexts().filter((t) => t.includes('ЖК Северный'))).toHaveLength(1);
    // Само поле при этом пустое: подсказка — первая строка списка, а не подставленный ответ.
    expect(addressInput(addressField('Место погрузки')).value).toBe('');
  });

  it('после набора группа подсказок уходит, а записи остаются доступны', async () => {
    renderTab();
    await openFreightForm();
    const field = await openDirectory('Место погрузки');

    fireEvent.change(addressInput(field), { target: { value: 'ЖК' } });
    await waitFor(() => expect(groupTexts()).not.toContain('Подсказки'));
    // Найдено обе площадки, включая ту, что стояла подсказкой: из списка она никуда не делась.
    expect(optionTexts().join()).toContain('ЖК Северный');
    expect(optionTexts().join()).toContain('ЖК Южный');
  });
});

describe('перегон и справочники: тот же компонент, другие правила', () => {
  /** Заявка на спецтехнику в работе: перегон заводится только у неё, и машина уже назначена. */
  const IN_WORK = vehicleRequest({
    id: 'vr-7',
    status: 'confirmed',
    objectId: OWN_OBJECT.id,
    objectName: OWN_OBJECT.name,
    objectAddress: OWN_OBJECT.address,
    assignment: { vehicleId: 'v-1' },
  } as never);

  it('у перегона работают оба режима, а метаданные никуда не уходят', async () => {
    const http = mockHttp({
      'GET /objects': () => json(list([OWN_OBJECT, OTHER_OBJECT])),
      'GET /warehouses': () => json(list([WAREHOUSE])),
      'GET /drivers/available': () => json({ drivers: [], vehicle: null }),
      'POST /vehicle-requests/:id/relocations': ({ body }) =>
        json({ id: 'route-1', displayNumber: 'Р-1', ...(body as object) }, 201),
    });
    renderWithUser(
      <VehicleRelocationModal
        request={IN_WORK}
        purpose="delivery"
        onClose={() => {}}
        onDone={() => {}}
      />,
      { user: authUser() },
    );

    // «Куда» подставлено адресом площадки заявки и остаётся свободной строкой (ADR 0069, Р12).
    await screen.findByText('Откуда');
    const to = addressField('Куда');
    expect(addressInput(to).value).toBe(OWN_OBJECT.address);
    expect(fromDirectory(to)).toBe(false);

    // «Откуда» — из справочника: база в списке мест не значится, а склад поставщика значится.
    const from = await openDirectory('Откуда');
    fireEvent.change(addressInput(from), { target: { value: 'Складская' } });
    fireEvent.click(within(openDropdown()).getByTitle(/Складская/));

    // Дату перегона называет человек: она больше не подставляется границей срока работ.
    typeDate('Дата перегона', '10.08.2026');
    fireEvent.click(screen.getByText('Завести перегон'));
    await waitFor(() => expect(http.countOf('POST /vehicle-requests/:id/relocations')).toBe(1));
    const body = http.lastCall('POST /vehicle-requests/:id/relocations')!.body as Record<
      string,
      unknown
    >;
    expect(body.moveFrom).toBe(WAREHOUSE.address);
    expect(body.moveTo).toBe(OWN_OBJECT.address);
    // Метаданных у маршрута нет: хранить их негде, и слать их незачем (ADR 0069, Р11).
    expect(JSON.stringify(body)).not.toContain('source');
  });

  it('в справочнике объектов у адреса чекбокса нет: он сам источник списка', async () => {
    mockHttp({
      'GET /objects': () => json(list([OWN_OBJECT])),
      'GET /counterparties': () => json(emptyList()),
    });
    renderWithUser(<ObjectsTab />, { user: authUser() });

    fireEvent.click(await screen.findByText('Добавить объект'));
    await screen.findByText('Новый объект');
    expect(within(addressField('Адрес')).queryByText('Из справочника')).toBeNull();
  });
});
