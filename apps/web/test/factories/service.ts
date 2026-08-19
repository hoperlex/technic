import {
  type AuthUser,
  type Role,
  type ServiceFileKind,
  type ServiceRequestDto,
  type ServiceRequestFileDto,
  serviceWaitingOn,
} from '@technic/contracts';
import { authUser } from './auth';

/**
 * Заявка на обслуживание оргтехники (ADR 0085) для сценарных тестов.
 *
 * Фабрика общая на весь модуль намеренно: своя копия из сорока полей в каждом файле означает, что
 * очередная правка DTO чинится в четырёх местах, — так и вышло с уходом «Желаемого срока» и
 * приходом полей заморозки (Р115, Р104).
 *
 * `waitingOn` не задаётся руками, а считается тем же `serviceWaitingOn`, которым отвечает сервер:
 * подпись состояния (`serviceStatusLine`) читает именно это поле, и фикстура «статус „Диагностика“,
 * ждут оператора» описывала бы заявку, которой в портале не бывает. Сценарию, который проверяет
 * расхождение, никто не мешает передать `waitingOn` явно.
 */
export function serviceRequest(overrides: Partial<ServiceRequestDto> = {}): ServiceRequestDto {
  const status = overrides.status ?? 'new';
  return {
    id: 'sr-1',
    num: 14,
    displayNumber: 'СО-14',
    status,
    statusChangedAt: '2026-08-05T09:00:00.000Z',
    waitingOn: serviceWaitingOn(status),
    // Заморозка (Р104, Р107): поля ходят парой и в обычных статусах пусты оба — это и есть CHECK
    // базы, перенесённый в фикстуру.
    heldFromStatus: null,
    holdReason: '',
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

/** Отложенная заявка: статус, исходный статус и причина — три факта, которые не бывают порознь. */
export function heldServiceRequest(
  heldFrom: ServiceRequestDto['status'] = 'diagnostics',
  overrides: Partial<ServiceRequestDto> = {},
): ServiceRequestDto {
  return serviceRequest({
    status: 'on_hold',
    heldFromStatus: heldFrom,
    holdReason: 'ждём запчасть от поставщика',
    ...overrides,
  });
}

/** Подшитый документ: вид — единственное, чем они различаются для планки приёмки (Р112). */
export function serviceRequestFile(
  kind: ServiceFileKind = 'act',
  overrides: Partial<ServiceRequestFileDto> = {},
): ServiceRequestFileDto {
  return {
    id: `file-${kind}`,
    filename: `${kind}.pdf`,
    contentType: 'application/pdf',
    size: 1024,
    kind,
    attachedAt: '2026-08-06T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Оператор оргтехники: штаб своего объекта плюс надстройка — она и даёт решения по заявкам
 * (ADR 0086). Именно надстройка, а не роль: списком ролей эту сторону не описать.
 */
export function serviceOperator(overrides: Partial<AuthUser> = {}): AuthUser {
  return authUser({
    role: 'shtab' as Role,
    constructionObjectIds: ['obj-1'],
    addons: ['office_equipment_operator'],
    ...overrides,
  });
}

/** Исполнитель: роль «оператор» плюс контрагент типа `service` — второго коридора без него нет. */
export function serviceExecutor(overrides: Partial<AuthUser> = {}): AuthUser {
  return authUser({ role: 'operator' as Role, counterpartyType: 'service', ...overrides });
}

/** Согласующий от ИТ (Р51): та же базовая роль, но своя надстройка — она даёт визу. */
export function serviceItApprover(overrides: Partial<AuthUser> = {}): AuthUser {
  return authUser({
    role: 'shtab' as Role,
    constructionObjectIds: ['obj-1'],
    addons: ['office_equipment_it_approver'],
    ...overrides,
  });
}

/** Заказчик: тот же штаб, но без надстройки — заявки заводит, решений по ним не принимает. */
export function serviceCustomer(overrides: Partial<AuthUser> = {}): AuthUser {
  return authUser({ role: 'shtab' as Role, constructionObjectIds: ['obj-1'], ...overrides });
}
