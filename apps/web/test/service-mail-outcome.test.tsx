import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  AuthUser,
  ModuleMailOutcome,
  OfficeEquipmentDto,
  OfficeEquipmentTypeDto,
  ServiceRequestDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { ServiceRequestForm } from '../src/pages/service/ServiceRequestForm';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * Судьба письма службе (Р67, Р70): что портал говорит, когда действие удалось, а письма нет.
 *
 * Проверяется то, что теряется незаметно. Исход письма приходит **ответом действия** и больше не
 * приходит ниоткуда: в карточке его нет, в списке нет, повторно спросить нечем. Проглоти портал
 * этот ответ — и заказчик уйдёт уверенным, что службу позвали, а узнает обратное на следующий
 * день, когда за заявкой не приедут.
 *
 * Отдельно закреплено, что это **тост, а не пометка поля** (ADR 0094). Операция прошла целиком,
 * виновного поля у неё нет, и подсветить в форме нечего — правило проверки `check-form-blockers`
 * знает про это исключение по одному модулю `serviceMailNotice`, а не по всей форме заявки.
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

/** Единица в справочнике одна: `AutoSelect` подставит её сам — заполнять в форме нужно описание. */
const EQUIPMENT: OfficeEquipmentDto = {
  id: 'oe-1',
  type: { id: TYPE.id, name: TYPE.name, isActive: true },
  name: 'Kyocera M3145',
  serialNumber: '',
  inventoryNumber: '0012345',
  object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
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
};

/**
 * Заявка этого сценария стоит на той самой единице, что лежит в справочнике: письмо службе
 * называет технику, и расхождение фикстур пряталось бы в тексте письма.
 */
function request(overrides: Partial<ServiceRequestDto> = {}): ServiceRequestDto {
  return serviceRequest({
    equipment: {
      id: EQUIPMENT.id,
      name: EQUIPMENT.name,
      serialNumber: '',
      inventoryNumber: EQUIPMENT.inventoryNumber,
      typeName: TYPE.name,
      location: EQUIPMENT.location,
    },
    responsibleName: 'Штабов С. И.',
    responsiblePhone: '9001234567',
    ...overrides,
  });
}

/** Оператор оргтехники: штаб своего объекта плюс надстройка — заявки заводит и ведёт он. */
const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  lastName: 'Штабов',
  firstName: 'Сергей',
  middleName: 'Иванович',
  fullName: 'Штабов Сергей Иванович',
  // Контакт заявителя подставляется из учётки: без телефона форма встала бы на его правиле, и
  // проверка про письмо не дошла бы до отправки.
  phone: '9001234567',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
});

/** Заведение заявки: ответ несёт заявку и исход письма — оба нужны форме. */
function renderForm(mail: ModuleMailOutcome): HttpMock {
  const http = mockHttp({
    'GET /office-equipment': () => json(list([EQUIPMENT])),
    'GET /office-equipment-types': () => json(list([TYPE])),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'POST /service-requests': () => json({ request: request(), mail }, 201),
  });
  renderWithUser(<ServiceRequestForm open request={null} onClose={() => {}} />, { user: OPERATOR });
  return http;
}

/**
 * Заполнить и отправить форму. Ожидание подставленной техники — не вежливость: `AutoSelect`
 * ставит единственный вариант, когда справочник доехал, и нажатие до этого встаёт на правиле поля,
 * а не на письме.
 */
async function submitForm(): Promise<void> {
  await screen.findAllByText('Kyocera M3145 · инв. 0012345');
  // Подпись описания одна на оба вида — «Описание» (Р2): кинд-зависимые «Что случилось / Что
  // нужно» из Р17 ADR 0145 отменены. Здесь поле нужно лишь как дорога до кнопки — сам разбор
  // подписей в service-consumables.
  fireEvent.change(screen.getByLabelText('Описание'), {
    target: { value: 'Не захватывает бумагу' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
}

function renderTab(items: ServiceRequestDto[], over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(list([EQUIPMENT])),
    'GET /office-equipment-types': () => json(list([TYPE])),
    ...over,
  });
  renderWithUser(<RequestsTab />, { user: OPERATOR });
  return http;
}

/** Меню действий строки: на десктопе оно за кнопкой «Действия» в колонке действий. */
async function openRowActions(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
}

describe('заведение заявки: письмо службе', () => {
  it('выключенная почта названа вслух — заявка заведена, а служба не оповещена', async () => {
    renderForm('mail_disabled');
    await submitForm();

    expect(await screen.findByText('Заявка заведена')).toBeDefined();
    expect(await screen.findByText('Отправка писем выключена — служба не оповещена')).toBeDefined();
  });

  it('очередь — обычный ход: предупреждения нет', async () => {
    const http = renderForm('queued');
    await submitForm();

    expect(await screen.findByText('Заявка заведена')).toBeDefined();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));
    // Ни слова про неоповещённую службу: письмо ушло, и предупреждать не о чем.
    expect(screen.queryByText(/не оповещена/)).toBeNull();
  });
});

describe('отмена заявки: письмо «не выезжайте»', () => {
  it('ненастроенный канал виден там же, где отмена, а не в логе сервера', async () => {
    renderTab([request()], {
      'PATCH /service-requests/:id/status': () =>
        json({ request: request({ status: 'cancelled' }), mail: 'channel_missing' }),
    });
    await openRowActions();
    fireEvent.click(await screen.findByText('Отменить заявку'));

    fireEvent.change(await screen.findByLabelText('Причина отмены'), {
      target: { value: 'Технику списали' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Отменить заявку' }));

    expect(await screen.findByText('Заявка отменена')).toBeDefined();
    expect(
      await screen.findByText('Почтовый канал службы не настроен — служба не оповещена'),
    ).toBeDefined();
  });
});

describe('повторная отправка письма службе', () => {
  it('удавшийся повтор называет адресатов: за ними и шли', async () => {
    renderTab([request()], {
      'POST /service-requests/:id/notify': () =>
        json({ mail: 'queued', recipients: ['service@example.test'] }),
    });
    await openRowActions();
    fireEvent.click(await screen.findByText('Отправить письмо службе ещё раз'));

    expect(
      await screen.findByText('Письмо службе поставлено в очередь: service@example.test'),
    ).toBeDefined();
  });

  it('несобравшееся письмо отправляет к администратору, а не оставляет молчание', async () => {
    renderTab([request()], {
      'POST /service-requests/:id/notify': () => json({ mail: 'mail_failed', recipients: [] }),
    });
    await openRowActions();
    fireEvent.click(await screen.findByText('Отправить письмо службе ещё раз'));

    expect(await screen.findByText('Письмо не собралось — сообщите администратору')).toBeDefined();
  });
});
