import type {
  DriverDto,
  FreightTransportRequestDto,
  SpecialEquipmentRequestDto,
  VehicleClassificationDto,
  VehicleFeedListDto,
  VehicleFeedRow,
  VehicleRequestDto,
  VehicleRequestSummaryDto,
  WeeklyRequestItemDto,
  WeeklyVehicleRequestDto,
} from '@technic/contracts';

/**
 * Записи раздела «Заказ ТС».
 *
 * По умолчанию — заказ спецтехники на объект в статусе «Новая» и без визы: именно в этом
 * состоянии заявку и визируют, и правят, и переводят в работу, поэтому сценариям чаще всего
 * нужна она.
 */
export function vehicleRequest(
  overrides: Partial<SpecialEquipmentRequestDto> = {},
): SpecialEquipmentRequestDto {
  return {
    id: 'vr-1',
    num: 42,
    displayNumber: 'Т-42',
    requestType: 'special_equipment',
    objectId: 'obj-1',
    objectCode: 'ОБ-1',
    objectName: 'ЖК Северный',
    objectAddress: 'г. Москва, ул. Северная, 1',
    departmentId: null,
    departmentCode: null,
    departmentName: null,
    vehicleTypeId: 'vt-1',
    vehicleTypeName: 'Автокраны',
    // Вид — граница замены (ADR 0059): им окно назначения спрашивает технику, а ТТХ заказанной
    // категории — левая сторона сравнения «крупнее или меньше заказанного».
    vehicleKindId: 'vk-special',
    vehicleCategoryId: 'vc-1',
    vehicleCategoryName: 'г/п 25 т',
    vehicleCategorySpecs: { lift_capacity: 25 },
    // Линейность заказанного типа (ADR 0100): по умолчанию нет — обычный заказ стоит на площадке
    // весь срок, и именно он нужен большинству сценариев. Линейный включается в самом сценарии.
    isLinear: false,
    status: 'new',
    comment: 'разгрузка плит',
    cancelReason: null,
    // Виза руководителя строительства (ADR 0025): её наличие портал определяет по approvedAt.
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    assignment: null,
    completion: null,
    route: null,
    files: [],
    dateFrom: '2026-08-05',
    dateTo: '2026-08-07',
    responsibleName: 'Петров П. П.',
    responsiblePhone: '+7 900 000-00-02',
    earlyEnd: null,
    // Сводка смен: по умолчанию долга нет — заявку ещё не вели по дням.
    shifts: { approvedDays: 0, unapprovedPastDays: 0 },
    version: 1,
    createdBy: 'user-1',
    createdByName: 'Диспетчеров Д. П.',
    createdAt: '2026-08-01T06:00:00.000Z',
    updatedAt: '2026-08-01T06:00:00.000Z',
    deletedAt: null,
    deletedByName: null,
    ...overrides,
  } as SpecialEquipmentRequestDto;
}

/**
 * Грузоперевозка: у неё не период работы, а момент подачи, и два конца маршрута — со своим
 * адресом и своим ответственным на каждом. Нужна там, где проверяют именно вторую ветку типа
 * заявки: контакты в строке списка, объём/масса, рейс.
 */
export function freightRequest(
  overrides: Partial<FreightTransportRequestDto> = {},
): FreightTransportRequestDto {
  return {
    id: 'vr-2',
    num: 43,
    displayNumber: 'Т-43',
    requestType: 'freight_transport',
    objectId: 'obj-1',
    objectCode: 'ОБ-1',
    objectName: 'ЖК Северный',
    objectAddress: 'г. Москва, ул. Северная, 1',
    departmentId: null,
    departmentCode: null,
    departmentName: null,
    vehicleTypeId: 'vt-2',
    vehicleTypeName: 'Самосвалы',
    vehicleKindId: 'vk-truck',
    vehicleCategoryId: 'vc-2',
    vehicleCategoryName: '20 м³',
    vehicleCategorySpecs: { body_volume: 20 },
    isLinear: false,
    status: 'new',
    comment: 'плиты перекрытия ПК 60-15, 12 шт',
    cancelReason: null,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    assignment: null,
    completion: null,
    route: null,
    files: [],
    scheduledAt: '2026-08-06T05:00:00.000Z',
    scheduledTimeUnspecified: false,
    volumeM3: 12,
    weightTons: null,
    loadingLocation: 'г. Москва, ул. Складская, 4',
    unloadingLocation: 'г. Москва, ул. Северная, 1',
    // Метаданные верификации адреса (ADR 0006) сценариям списка не нужны: в строке стоит текст.
    loadingAddress: null,
    unloadingAddress: null,
    loadingResponsibleName: 'Сидоров С. С.',
    loadingResponsiblePhone: '+7 900 000-00-03',
    unloadingResponsibleName: 'Кузнецов К. К.',
    unloadingResponsiblePhone: '+7 900 000-00-04',
    version: 1,
    createdBy: 'user-1',
    createdByName: 'Диспетчеров Д. П.',
    createdAt: '2026-08-01T06:00:00.000Z',
    updatedAt: '2026-08-01T06:00:00.000Z',
    deletedAt: null,
    deletedByName: null,
    ...overrides,
  } as FreightTransportRequestDto;
}

/**
 * Завизированная заявка: у неё заполнены кто и когда поставил визу.
 *
 * Виза проставляется ПОСЛЕ overrides намеренно: иначе `approvedVehicleRequest({ ...vehicleRequest() })`
 * молча снимал бы её — `approvedAt: null` из распакованной незавизированной заявки перекрывал бы
 * значение фабрики, и тест «виза стоит» проверял бы ровно противоположное.
 */
export function approvedVehicleRequest(
  overrides: Partial<SpecialEquipmentRequestDto> = {},
): SpecialEquipmentRequestDto {
  return vehicleRequest({
    ...overrides,
    approvedBy: overrides.approvedBy ?? 'user-ruk',
    approvedByName: overrides.approvedByName ?? 'Рукстроев Р. С.',
    approvedAt: overrides.approvedAt ?? '2026-08-02T07:00:00.000Z',
  });
}

/**
 * Строка состава недельной заявки. По умолчанию — продление заказа до воскресенья недели: это
 * основной вид строки, ради которого документ и заводят (ADR 0085).
 */
export function weeklyItem(overrides: Partial<WeeklyRequestItemDto> = {}): WeeklyRequestItemDto {
  return {
    id: 'wi-1',
    position: 1,
    kind: 'extend',
    sourceRequestId: 'vr-1',
    sourceRequestNum: 42,
    sourceDisplayNumber: 'ТС-42',
    sourceStatus: 'confirmed',
    sourceDateFrom: '2026-08-05',
    sourceDateTo: '2026-08-14',
    vehicleTypeId: null,
    vehicleTypeName: null,
    vehicleCategoryId: null,
    vehicleCategoryName: null,
    dateFrom: null,
    dateTo: '2026-08-23',
    responsibleName: '',
    responsiblePhone: '',
    deliveryNeeded: false,
    deliveryFrom: '',
    comment: '',
    expectedDateTo: '2026-08-14',
    previousDateTo: null,
    appliedSourceVersion: null,
    snapshotVehicleId: null,
    currentVehicleId: 'v-1',
    currentVehicleLabel: 'Экскаватор JCB · А123АА77',
    createdRequestId: null,
    createdRequestNum: null,
    result: 'pending',
    skipReason: '',
    warnings: [],
    ...overrides,
  };
}

/**
 * Недельная заявка (ADR 0085) — документ-основание над заказами: строка ленты «Заказ автотехники»
 * наравне с ними. По умолчанию ждёт визы: в этом состоянии её и читают в списке.
 */
export function weeklyRequest(
  overrides: Partial<WeeklyVehicleRequestDto> = {},
): WeeklyVehicleRequestDto {
  const items = overrides.items ?? [weeklyItem()];
  return {
    id: 'wr-1',
    num: 12,
    displayNumber: 'НЗ-12',
    objectId: 'obj-1',
    objectCode: 'ОБ-1',
    objectName: 'ЖК Северный',
    weekStart: '2026-08-17',
    weekEnd: '2026-08-23',
    weekLabel: '17–23 августа 2026',
    status: 'pending',
    comment: 'продлеваем всё, кроме крана',
    cancelReason: '',
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    appliedAt: null,
    counts: {
      extend: items.filter((i) => i.kind === 'extend').length,
      new: items.filter((i) => i.kind === 'new').length,
      leave: items.filter((i) => i.kind === 'leave').length,
    },
    createdBy: 'user-shtab',
    createdByName: 'Штабов Ш. Ш.',
    createdAt: '2026-08-10T06:00:00.000Z',
    updatedByName: null,
    updatedAt: '2026-08-10T06:00:00.000Z',
    version: 1,
    ...overrides,
    items,
  };
}

/**
 * Ответ ленты «Заказ автотехники» (`GET /vehicle-requests/feed`): заказы ТС и недельные заявки
 * одним списком (ADR 0085).
 *
 * Вид строки дописывает сама фабрика: сценариям, где недельного документа нет, незачем помнить,
 * что заказ теперь приезжает завёрнутым, — а тем, где он есть, недельные строки передаются
 * готовыми через `weekly`.
 */
export function vehicleFeed(
  orders: VehicleRequestDto[],
  weekly: WeeklyVehicleRequestDto[] = [],
  overrides: Partial<VehicleFeedListDto> = {},
): VehicleFeedListDto {
  const items: VehicleFeedRow[] = [
    ...orders.map((order): VehicleFeedRow => ({ kind: 'order', order })),
    ...weekly.map((week): VehicleFeedRow => ({ kind: 'weekly', weekly: week })),
  ];
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 100,
    weeklyPendingCount: weekly.filter((w) => w.status === 'pending').length,
    ...overrides,
  };
}

/** Счётчики над списком: статусы плюс «ждут визы» — по статусам это состояние не видно. */
export function vehicleSummary(
  overrides: Partial<VehicleRequestSummaryDto> = {},
): VehicleRequestSummaryDto {
  return { new: 0, confirmed: 0, done: 0, cancelled: 0, awaitingApproval: 0, ...overrides };
}

/**
 * Позиция классификатора (ADR 0028): категория типа либо сам тип, если категорий у него нет.
 * Ею заполняются и форма заказа, и фильтр списка.
 */
export function classification(
  overrides: Partial<VehicleClassificationDto> = {},
): VehicleClassificationDto {
  return {
    vehicleTypeId: 'vt-1',
    vehicleTypeName: 'Автокраны',
    vehicleCategoryId: 'vc-1',
    vehicleCategoryName: 'г/п 25 т',
    kindCode: 'special',
    ...overrides,
  } as VehicleClassificationDto;
}

/**
 * Машинист для листов ЭСМ-2 (миграция 0087) — запись справочника водителей.
 *
 * Отбора у неё нет никакого, и это главное: в бланке ЭСМ-2 нет ни СНИЛС, ни водительского
 * удостоверения — экскаваторщик работает по удостоверению тракториста-машиниста, которого портал
 * не ведёт (ADR 0055). Поэтому в форме перевода в работу список приходит из `GET /drivers`, а не
 * из отбора под машину, и человек без документов годится в него наравне с прочими.
 */
export function machinist(overrides: Partial<DriverDto> = {}): DriverDto {
  return {
    id: 'p-machinist',
    lastName: 'Семёнов',
    firstName: 'Семён',
    middleName: 'Семёнович',
    fullName: 'Семёнов Семён Семёнович',
    birthDate: null,
    phone: '',
    snils: '',
    comment: '',
    personnelNo: '4021',
    jobTitle: 'Машинист экскаватора',
    employedSince: null,
    licenses: [],
    version: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  } as DriverDto;
}
