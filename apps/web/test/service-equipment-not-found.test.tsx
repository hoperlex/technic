import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  AuthUser,
  CreateOfficeEquipmentInput,
  OfficeEquipmentDto,
  OfficeEquipmentModelDto,
  OfficeEquipmentTypeDto,
} from '@technic/contracts';
import { selectOption } from './antd';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { ServiceRequestForm } from '../src/pages/service/ServiceRequestForm';

/**
 * Тупик «нужной техники нет в справочнике» в форме заявки на обслуживание (этап 7, Р40).
 *
 * Ответов на один вопрос два, и различает их не роль, а право вести справочник: ведущий его
 * заводит карточку не выходя из заявки, остальные идут в техподдержку. Ошибка здесь тестом не
 * ловится ничем другим: перепутанное условие показало бы заказчику форму заведения (её сервер
 * встретит 403 после того, как человек заполнит одиннадцать полей), а оператору — совет написать
 * в поддержку про справочник, который он ведёт сам.
 *
 * Отдельно закреплено то, чего в этой ветке быть **не должно**: контакт «оператора вашей
 * площадки». Связи «оператор ↔ площадка» в данных нет (критика К3), и обещание такого контакта
 * отменено — тест держит отмену, чтобы её не «доделали» обратно.
 */

const TYPE: OfficeEquipmentTypeDto = {
  id: 'oet-1',
  code: 'mfu',
  name: 'МФУ',
  sortOrder: 1,
  isActive: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

/**
 * Модели того же типа — их две намеренно: с единственным вариантом `AutoSelect` заполнил бы поле
 * сам, и проверка «в тело ушла выбранная модель» прошла бы независимо от того, выбирал её кто-то
 * или нет (план `docs/office-equipment-consumables-plan.md`, Р1).
 */
function modelDto(id: string, name: string): OfficeEquipmentModelDto {
  return {
    id,
    type: { id: TYPE.id, name: TYPE.name, isActive: true },
    specs: [],
    name,
    manufacturer: '',
    isActive: true,
    comment: '',
    isUsed: false,
    equipmentCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

const MODELS = [modelDto('oem-1', 'Kyocera M3145'), modelDto('oem-2', 'Canon i-SENSYS')];

function equipmentDto(over: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: TYPE.id, name: TYPE.name, isActive: true },
    specs: [],
    name: 'Canon i-SENSYS',
    serialNumber: '',
    inventoryNumber: '0000777',
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    department: null,
    location: '',
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
 * Ответ `POST /office-equipment`: сервер отдаёт карточку целиком — ею и заполняется поле.
 *
 * Имя карточки берётся из модели, а не из тела запроса: с выпуска A `name` — зеркало имени
 * модели, которое ведёт база (Р3), и форма его не шлёт вовсе.
 */
function createdDto(input: CreateOfficeEquipmentInput): OfficeEquipmentDto {
  const model = MODELS.find((m) => m.id === input.modelId)!;
  return equipmentDto({
    id: 'oe-new',
    type: { id: input.equipmentTypeId, name: TYPE.name, isActive: true },
    specs: [],
    model: { id: model.id, name: model.name },
    name: model.name,
    serialNumber: input.serialNumber ?? '',
    inventoryNumber: input.inventoryNumber ?? '',
    object: { id: input.objectId, code: 'ОБ-1', name: 'ЖК Северный' },
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-10T09:00:00.000Z',
  });
}

/** Оператор оргтехники: штаб плюс надстройка (ADR 0086) — справочник ведёт он. */
const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
});

/** Заказчик: тот же штаб, но без надстройки — заявку заводит, справочник только читает. */
const CUSTOMER: AuthUser = authUser({ role: 'shtab', constructionObjectIds: ['obj-1'] });

/**
 * В справочнике есть чужие единицы, но не та, что сломалась, — это и есть разбираемый тупик.
 * Именно две: с единственным вариантом `AutoSelect` заполнил бы поле техники сам, и проверка
 * «единица встала в поле» прошла бы независимо от того, подставил её кто-нибудь или нет.
 *
 * Заведённое по ходу теста складывается в тот же список: перезапрос после заведения обязан
 * принести новую единицу и всем прочим спискам справочника.
 */
function renderForm(user: AuthUser, over: RouteMap = {}): HttpMock {
  const units: OfficeEquipmentDto[] = [
    equipmentDto(),
    equipmentDto({ id: 'oe-2', name: 'Brother HL-1110R', inventoryNumber: '0000778' }),
  ];
  const http = mockHttp({
    'GET /office-equipment': () => json(list(units)),
    'GET /office-equipment-types': () => json(list([TYPE])),
    // Форма модели спрашивает характеристики типа (цветность печати); здесь их нет.
    'GET /office-equipment-types/:id/specs': () => json([]),
    'GET /office-equipment-models': () => json(list(MODELS)),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'POST /office-equipment': ({ body }) => {
      const dto = createdDto(body as CreateOfficeEquipmentInput);
      units.push(dto);
      return json(dto, 201);
    },
    ...over,
  });
  renderWithUser(<ServiceRequestForm open request={null} onClose={() => {}} />, { user });
  return http;
}

/** antd связывает подпись с полем через `for`/`id` — ищем так же, как читает человек. */
function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Набранное в поле техники: строка уходит контекстом в обращение к поддержке. */
function searchEquipment(text: string) {
  const input = document.querySelector<HTMLInputElement>('#officeEquipmentId')!;
  const field = input.closest('.ant-select')!;
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
  fireEvent.change(input, { target: { value: text } });
}

describe('«Не нашли технику?» у того, кто ведёт справочник', () => {
  it('заводит карточку поверх заявки и подставляет её в поле', async () => {
    const http = renderForm(OPERATOR);
    fireEvent.click(await screen.findByText('Не нашли технику?'));

    expect(await screen.findByText('Новая единица оргтехники')).toBeDefined();
    // Тип и объект по единственному варианту подставляет `AutoSelect`: проверяется здесь не он, а
    // то, что окно получило справочники и собирает тело запроса из полей карточки.
    //
    // Модель выбирается из справочника, а не набирается словами (Р1): картридж подходит модели, и
    // «Kyocera M3145», написанная по памяти, оставила бы аппарат без ответа на «чем заправлять».
    await selectOption('Модель', 'Kyocera M3145');
    fill('Инвентарный номер', '0012345');
    fireEvent.click(screen.getByRole('button', { name: 'Завести и выбрать' }));

    await waitFor(() => expect(http.countOf('POST /office-equipment')).toBe(1));
    const body = http.lastCall('POST /office-equipment')?.body as CreateOfficeEquipmentInput;
    expect(body.equipmentTypeId).toBe('oet-1');
    expect(body.objectId).toBe('obj-1');
    expect(body.modelId).toBe('oem-1');
    // Имени карточки форма не шлёт совсем: его пишет зеркало модели в базе (Р3), и второе
    // «название» в теле означало бы два ответа на вопрос, что это за аппарат.
    expect(body.name).toBeUndefined();

    // Заявка продолжается с того же места: заведённая единица стоит выбранной, и стоит подписью
    // портала («модель · инв. номер»), а не идентификатором.
    expect(await screen.findByText('Kyocera M3145 · инв. 0012345')).toBeDefined();
    // Список вариантов перезапрошен — единица есть и у всех прочих списков справочника.
    await waitFor(() => expect(http.countOf('GET /office-equipment')).toBeGreaterThan(1));
    // Разобранный тупик убирает и саму ссылку: техника выбрана, искать больше нечего.
    expect(screen.queryByText('Не нашли технику?')).toBeNull();
  });
});

describe('«Не нашли технику?» у заказчика без прав справочника', () => {
  it('ведёт в техподдержку с готовым контекстом, а не в заведение карточки', async () => {
    renderForm(CUSTOMER);
    await screen.findByText('Не нашли технику?');
    searchEquipment('HP LaserJet 107w');
    fireEvent.click(screen.getByText('Не нашли технику?'));

    expect(screen.getByText('Карточки нет в справочнике')).toBeDefined();
    // Форма заведения заказчику не показывается вовсе: право на неё даёт надстройка, а не роль.
    expect(screen.queryByText('Новая единица оргтехники')).toBeNull();
    expect(screen.queryByText('Завести и выбрать')).toBeNull();

    // Контекст собран за человека: что искал и где стоит техника — иначе первым ответом поддержки
    // будет вопрос об этом же.
    expect(await screen.findByText(/Искал: HP LaserJet 107w/)).toBeDefined();
    expect(screen.getByText(/Объект: ОБ-1 — ЖК Северный/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Написать в техподдержку/ }));
    expect(await screen.findByText('Техподдержка')).toBeDefined();
  });

  it('не обещает контакт оператора площадки: такой связи в данных нет (К3)', async () => {
    renderForm(CUSTOMER);
    fireEvent.click(await screen.findByText('Не нашли технику?'));
    await screen.findByText('Карточки нет в справочнике');

    // Ни слова про «вашего оператора» и ни одного запроса за ФИО и телефонами сотрудников: канал
    // ровно один — техподдержка (Р40).
    expect(screen.queryByText(/оператор/i)).toBeNull();
    expect(screen.getByText('Написать в техподдержку')).toBeDefined();
  });
});

describe('режимы, в которых технику не выбирают', () => {
  it('в обращении по гарантии ссылки нет: единицу назвал реестр', async () => {
    const claim = {
      equipmentId: 'oe-1',
      source: 'item' as const,
      itemId: 'it-1',
      subject: 'Замена узла',
    };
    mockHttp({
      'GET /office-equipment': () => json(emptyList()),
      'GET /departments': () => json(emptyList()),
    });
    renderWithUser(<ServiceRequestForm open request={null} claim={claim} onClose={() => {}} />, {
      user: CUSTOMER,
    });

    expect(await screen.findByText('Новая заявка на обслуживание')).toBeDefined();
    // Техника задана и правке не подлежит — разбирать тут нечего, и ссылка сбивала бы с толку.
    expect(screen.queryByText('Не нашли технику?')).toBeNull();
  });
});
