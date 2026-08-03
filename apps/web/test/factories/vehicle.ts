import type {
  SpecialEquipmentRequestDto,
  VehicleClassificationDto,
  VehicleRequestSummaryDto,
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
    vehicleCategoryId: 'vc-1',
    vehicleCategoryName: 'г/п 25 т',
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
    version: 1,
    createdBy: 'user-1',
    createdByName: 'Диспетчеров Д. П.',
    createdAt: '2026-08-01T06:00:00.000Z',
    updatedAt: '2026-08-01T06:00:00.000Z',
    deletedAt: null,
    ...overrides,
  } as SpecialEquipmentRequestDto;
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
