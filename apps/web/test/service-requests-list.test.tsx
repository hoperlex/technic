import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto, ServiceRequestStatus } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * Список заявок на обслуживание оргтехники (ADR 0085): ролевые наборы колонок и действия,
 * построенные из коридора переходов.
 *
 * Проверяется именно связка «субъект → коридор → кнопка». Ошибка здесь тестом не падает: у
 * оператора появляется действие исполнителя (кнопка, ведущая в 403), а у исполнителя пропадает
 * его собственный шаг — и обнаруживают это люди, а не сборка. Субъекта два, потому что коридоров
 * три и различают их не роли: оператор оргтехники — надстройка над штабом (ADR 0086), сервис —
 * тип контрагента (ADR 0038).
 */

function serviceRequest(overrides: Partial<ServiceRequestDto> = {}): ServiceRequestDto {
  const status: ServiceRequestStatus = overrides.status ?? 'new';
  return {
    id: 'sr-1',
    num: 14,
    displayNumber: 'СО-14',
    status,
    statusChangedAt: '2026-08-05T09:00:00.000Z',
    waitingOn: 'operator',
    equipment: {
      id: 'oe-1',
      name: 'Kyocera M3145',
      serialNumber: 'SN-1',
      inventoryNumber: '0012345',
      typeName: 'МФУ',
      location: 'Корпус 3, каб. 214',
    },
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    customerDepartment: null,
    equipmentDepartment: null,
    description: 'Не захватывает бумагу',
    dueDate: '2026-08-12',
    responsibleName: 'Иванов И. И.',
    responsiblePhone: '9000000000',
    isUrgent: false,
    urgencyReason: '',
    service: null,
    itApproval: null,
    warrantyClaim: null,
    estimateRevision: 0,
    estimateSubmittedAt: null,
    estimatedTotalAmount: null,
    approval: null,
    items: [],
    completion: null,
    acceptedByName: '',
    acceptedAt: null,
    comment: '',
    serviceComment: '',
    files: [],
    createdByName: 'Штабов С. И.',
    createdAt: '2026-08-05T09:00:00.000Z',
    updatedAt: '2026-08-05T09:00:00.000Z',
    deletedAt: null,
    version: 3,
    ...overrides,
  };
}

/** Оператор оргтехники: штаб своего объекта плюс надстройка — она и даёт решения по заявкам. */
const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
});

/** Согласующий от ИТ (Р51): та же базовая роль, но своя надстройка — она даёт визу. */
const IT_APPROVER: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_it_approver'],
});

/** Исполнитель: роль «оператор» плюс контрагент типа `service` — второго коридора без него нет. */
const EXECUTOR: AuthUser = authUser({ role: 'operator', counterpartyType: 'service' });

function renderTab(user: AuthUser, items: ServiceRequestDto[], over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    // Справочники фильтров: объекты и отделы видны обеим сторонам, перечень оргтехники — только
    // тому, у кого есть право справочника (сервису он закрыт, Р7).
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<RequestsTab />, { user });
  return http;
}

/** Меню действий строки: на десктопе оно за кнопкой «Действия» в колонке действий. */
async function openRowActions(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
}

/**
 * Есть ли на экране такой текст. Именно «есть», а не «ровно один»: закреплённую шапку таблицы
 * antd рисует дважды — видимой строкой и скрытой мерной, — и точный поиск падал бы на любом
 * заголовке колонки, ничего не сообщая о самой колонке.
 */
const shown = (text: string) => screen.queryAllByText(text).length > 0;

describe('список заявок на обслуживание: колонки по ролям', () => {
  it('оператор видит исполнителя, очередь ожидания и документы', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    expect(await screen.findByText('СО-14')).toBeDefined();
    expect(shown('Сервис')).toBe(true);
    expect(shown('Ждёт')).toBe(true);
    expect(shown('Документы')).toBe(true);
    // Колонка исполнителя «что от вас требуется» оператору не показывается: шаги в ней чужие.
    expect(shown('От вас требуется')).toBe(false);
  });

  it('исполнитель видит объект, контакт и свой следующий шаг', async () => {
    renderTab(EXECUTOR, [serviceRequest({ status: 'assigned', waitingOn: 'service' })]);
    expect(await screen.findByText('СО-14')).toBeDefined();
    expect(shown('Объект')).toBe(true);
    expect(shown('Контакт')).toBe(true);
    expect(shown('Принять в работу')).toBe(true);
    // Сумма и документы — вопросы заказчика и оператора, исполнителю в списке они не нужны.
    expect(shown('Документы')).toBe(false);
  });
});

describe('действия строятся из коридора переходов', () => {
  it('оператору «Новая» назначения не предлагает: сначала виза ИТ', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    await openRowActions();
    expect(await screen.findByText('Отменить заявку')).toBeDefined();
    // До визы отдела ИТ дуги «Новая → Назначен сервис» нет ни у кого (Р51).
    expect(screen.queryByText('Назначить сервис')).toBeNull();
    // Виза — не его решение: подписывать заявку самому себе оператор не может (Р55).
    expect(screen.queryByText('Согласование ИТ')).toBeNull();
    // Шаги исполнителя оператору недоступны ни через портал, ни через сервер (Р17).
    expect(screen.queryByText('Взять в диагностику')).toBeNull();
  });

  it('согласованную ИТ заявку оператор назначает', async () => {
    renderTab(OPERATOR, [serviceRequest({ status: 'it_approved', waitingOn: 'operator' })]);
    await openRowActions();
    expect(await screen.findByText('Назначить сервис')).toBeDefined();
  });

  it('визу предлагают согласующему от ИТ и только на «Новой»', async () => {
    renderTab(IT_APPROVER, [serviceRequest()]);
    await openRowActions();
    expect(await screen.findByText('Согласование ИТ')).toBeDefined();
    // Дальше цикл ведут другие: назначения у него нет.
    expect(screen.queryByText('Назначить сервис')).toBeNull();
  });

  it('исполнителю назначенная заявка предлагает диагностику и отказ, но не назначение', async () => {
    renderTab(EXECUTOR, [serviceRequest({ status: 'assigned', waitingOn: 'service' })]);
    await openRowActions();
    expect(await screen.findByText('Взять в диагностику')).toBeDefined();
    expect(screen.getByText('Отказаться от заявки')).toBeDefined();
    expect(screen.queryByText('Назначить сервис')).toBeNull();
    expect(screen.queryByText('Отменить заявку')).toBeNull();
  });
});

/**
 * Приём заявки и срочность (план модернизации, Р49, Р56, Р57).
 *
 * Проверяется то, что раньше зависело от роли смотрящего: объект видел только исполнитель, а
 * признака срочности не было вовсе. Оба ответа — про список, а не про сервер: сервер эти поля
 * отдаёт всем, и потерять их можно ровно здесь.
 */
describe('объект и срочность в списке', () => {
  it('объект виден и заказчику, и оператору — колонка перестала быть набором исполнителя', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    await screen.findByText('СО-14');
    expect(shown('Объект')).toBe(true);
    // Место внутри объекта — подписью под ним: по нему едет мастер.
    expect(shown('Корпус 3, каб. 214')).toBe(true);
  });

  it('срочная заявка помечена в списке, обычная — нет', async () => {
    renderTab(OPERATOR, [
      serviceRequest({ isUrgent: true, urgencyReason: 'Единственный принтер на площадке' }),
    ]);
    expect(await screen.findByText('СО-14')).toBeDefined();
    expect(shown('Срочная')).toBe(true);
  });

  it('оператор ставит и снимает срочность, исполнитель — не трогает вовсе', async () => {
    renderTab(OPERATOR, [serviceRequest({ status: 'assigned', waitingOn: 'service' })]);
    await openRowActions();
    // Срочность — не переход: она доступна оператору и после назначения сервиса.
    expect(await screen.findByText('Отметить срочной')).toBeDefined();
  });

  it('исполнителю срочности не предлагают: признак заказывающей стороны', async () => {
    renderTab(EXECUTOR, [serviceRequest({ status: 'assigned', waitingOn: 'service' })]);
    await openRowActions();
    await screen.findByText('Взять в диагностику');
    expect(screen.queryByText('Отметить срочной')).toBeNull();
    expect(screen.queryByText('Снять срочность')).toBeNull();
  });

  it('у помеченной заявки действие называется снятием', async () => {
    renderTab(OPERATOR, [serviceRequest({ isUrgent: true, urgencyReason: 'встала бухгалтерия' })]);
    await openRowActions();
    expect(await screen.findByText('Снять срочность')).toBeDefined();
  });

  it('фильтр «Только срочные» уходит на сервер признаком', async () => {
    const http = renderTab(OPERATOR, [serviceRequest()]);
    await screen.findByText('СО-14');
    fireEvent.click(screen.getByLabelText('Только срочные'));
    await screen.findByText('СО-14');
    expect(http.lastCall('GET /service-requests')?.query.get('urgent')).toBe('true');
  });
});

describe('очереди-пресеты', () => {
  it('«Требуют решения» спрашивает у сервера только ждущие меня заявки', async () => {
    const http = renderTab(OPERATOR, [serviceRequest()]);
    fireEvent.click(await screen.findByText('Требуют решения'));
    await screen.findByText('СО-14');
    const last = http.lastCall('GET /service-requests');
    expect(last?.query.get('waitingOnMe')).toBe('true');
    // Порядок по умолчанию — возраст в статусе: список открывают вопросом «что стоит дольше всех».
    expect(last?.query.get('sortBy')).toBe('statusChangedAt');
    expect(last?.query.get('sortOrder')).toBe('asc');
  });
});
