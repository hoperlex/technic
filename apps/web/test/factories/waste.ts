import type {
  ContainerTypeDto,
  CounterpartyDto,
  ObjectDto,
  WasteRequestDto,
  WasteRequestSummaryDto,
  WasteTypeDto,
} from '@technic/contracts';

/**
 * Записи раздела «Вывоз мусора» для сценарных тестов.
 *
 * Значения по умолчанию описывают самый обычный случай — новую заявку на вывоз с назначенным
 * объектом; всё, что сценарию важно (статус, оператор, факт), передаётся overrides. Править сами
 * фабрики после начала работы не нужно: тест, которому не хватает поля, обычно проверяет не то.
 */
export function wasteRequest(overrides: Partial<WasteRequestDto> = {}): WasteRequestDto {
  return {
    id: 'wr-1',
    num: 128,
    displayNumber: 'М-128',
    objectId: 'obj-1',
    objectCode: 'ОБ-1',
    objectName: 'ЖК Северный',
    objectAddress: 'г. Москва, ул. Северная, 1',
    requestType: 'waste_removal',
    containerTypeId: null,
    containerTypeName: null,
    // Количество контейнеров (ADR 0054): больше одного бывает у контейнерных операций, а вывоз
    // мусора считается объёмом — у него значение остаётся единичным, как и задаёт контракт.
    containersCount: 1,
    containerOwnerCounterpartyId: null,
    containerOwnerName: null,
    wasteTypeId: 'wt-1',
    wasteTypeName: 'Строительный мусор',
    volumeM3: 20,
    pricePerM3: 500,
    amount: 10_000,
    completion: null,
    operatorCounterpartyId: null,
    operatorName: null,
    deliveryAt: '2026-08-03T09:00:00.000Z',
    deliveryTimeUnspecified: false,
    responsibleName: 'Петров П. П.',
    responsiblePhone: '+7 900 000-00-01',
    comment: '',
    operatorComment: '',
    status: 'new',
    cancelReason: null,
    files: [],
    tickets: [],
    vehicles: [],
    version: 1,
    createdBy: 'user-1',
    createdByName: 'Диспетчеров Д. П.',
    createdAt: '2026-08-01T06:00:00.000Z',
    updatedAt: '2026-08-01T06:00:00.000Z',
    deletedAt: null,
    deletedByName: null,
    ...overrides,
  };
}

/** Счётчики над списком: сколько заявок в каком статусе. */
export function wasteSummary(
  overrides: Partial<WasteRequestSummaryDto> = {},
): WasteRequestSummaryDto {
  return { new: 0, confirmed: 0, done: 0, cancelled: 0, ...overrides };
}

export function objectDto(overrides: Partial<ObjectDto> = {}): ObjectDto {
  return {
    id: 'obj-1',
    code: 'ОБ-1',
    name: 'ЖК Северный',
    address: 'г. Москва, ул. Северная, 1',
    isActive: true,
    ...overrides,
  } as ObjectDto;
}

export function containerType(overrides: Partial<ContainerTypeDto> = {}): ContainerTypeDto {
  return {
    id: 'ct-1',
    name: 'Контейнер 8 м³',
    type: 'cont',
    isActive: true,
    sortOrder: 1,
    ...overrides,
  } as ContainerTypeDto;
}

export function wasteType(overrides: Partial<WasteTypeDto> = {}): WasteTypeDto {
  return {
    id: 'wt-1',
    name: 'Строительный мусор',
    isActive: true,
    sortOrder: 1,
    ...overrides,
  } as WasteTypeDto;
}

/** Контрагент-оператор вывоза: исполнитель заявки (ADR 0010). */
export function operator(overrides: Partial<CounterpartyDto> = {}): CounterpartyDto {
  return {
    id: 'cp-1',
    name: 'ООО «Чистый двор»',
    type: 'operator',
    isActive: true,
    objects: [],
    ...overrides,
  } as CounterpartyDto;
}
