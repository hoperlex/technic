import { z } from 'zod';
import { requestStatusSchema, statusChangeRequiresReason } from './enums';
import type { RequestStatus } from './enums';
import { baseListQuery, uuidSchema } from './common';
import type { FileDto } from './files';
import { WORK_TIME_MESSAGE, isWithinWorkTimeAt } from './time';

// ── Тип заявки на технику ──
export const VEHICLE_REQUEST_TYPES = ['special_equipment', 'freight_transport'] as const;
export const vehicleRequestTypeSchema = z.enum(VEHICLE_REQUEST_TYPES);
export type VehicleRequestType = (typeof VEHICLE_REQUEST_TYPES)[number];

export const vehicleRequestTypeLabels: Record<VehicleRequestType, string> = {
  special_equipment: 'Заказ спецтехники',
  freight_transport: 'Грузоперевозка',
};

export const vehicleRequestTypeColors: Record<VehicleRequestType, string> = {
  special_equipment: 'geekblue',
  freight_transport: 'green',
};

/** Отображаемый номер заявки ТС: «ТС-000123» (в БД хранится только число). */
export function formatVehicleRequestNumber(num: number): string {
  return `ТС-${String(num).padStart(6, '0')}`;
}

/** Разбор пользовательского ввода поиска: «123» / «ТС-123» / «ТС-000123» → 123. */
export function parseVehicleRequestNumberSearch(input: string): number | undefined {
  const digits = input.replace(/\D/g, '');
  if (!digits) return undefined;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

// ── Общие подсхемы ──
const commentSchema = z.string().trim().max(2000);
const locationSchema = z.string().trim().min(1).max(1000);
const fileIdsSchema = z.array(uuidSchema).max(20);

// ── Адрес: метаданные верификации (DaData «Подсказки») ──
// Каноническая строка адреса — в loadingLocation/unloadingLocation; здесь происхождение
// и ФИАС/гео. Жёсткая модель (ADR 0006): адрес погрузки/разгрузки ОБЯЗАТЕЛЕН и должен быть
// верифицирован (resolved+ФИАС либо object); неверифицированный/`manual` ввод на запись НЕ
// принимается. `manual` остаётся в enum только для чтения легаси-строк.
export const ADDRESS_SOURCES = ['resolved', 'manual', 'object'] as const;
export const addressSourceSchema = z.enum(ADDRESS_SOURCES);
export type AddressSource = (typeof ADDRESS_SOURCES)[number];

/** Метаданные адреса. `fiasId` — не строго UUID (DaData отдаёт разные GUID), поэтому просто строка. */
export const addressMetaSchema = z
  .object({
    source: addressSourceSchema,
    fiasId: z.string().trim().min(1).max(64).nullable().optional(),
    fiasLevel: z.number().int().min(-1).max(99).nullable().optional(),
    geoLat: z.number().min(-90).max(90).nullable().optional(),
    geoLon: z.number().min(-180).max(180).nullable().optional(),
  })
  .strict();
export type AddressMeta = z.infer<typeof addressMetaSchema>;

/** Адрес верифицирован: выбран из справочника объектов или из подсказок DaData (с ФИАС). */
export function isAddressVerified(meta: AddressMeta | null | undefined): boolean {
  if (!meta) return false;
  return meta.source === 'object' || (meta.source === 'resolved' && !!meta.fiasId);
}

/**
 * Верифицированный адрес для записи (жёсткая модель, ADR 0006): принимаем только адрес,
 * выбранный из подсказки DaData (resolved + ФИАС) либо из справочника объектов (object).
 */
export const verifiedAddressMetaSchema = addressMetaSchema.refine(isAddressVerified, {
  message: 'Адрес должен быть выбран из подсказок (верифицирован)',
});

/** Дата без времени, строго YYYY-MM-DD (не преобразуется через JS Date). */
const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD')
  .refine((s) => {
    const parts = s.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'Некорректная дата');

/** ISO 8601 с обязательным offset (напр. 2026-07-25T14:30:00+03:00). */
const scheduledAtSchema = z.string().datetime({ offset: true });

/** Положительное значение с не более чем 3 знаками после запятой (numeric(12,3)). */
const amountSchema = z
  .number()
  .positive('Значение должно быть больше 0')
  .max(999_999_999.999, 'Слишком большое значение')
  .refine(
    (v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6,
    'Не более 3 знаков после запятой',
  );

// ── Создание (discriminatedUnion по requestType, strict) ──
// Заявка ссылается на плоский тип ТС (ADR 0005): vehicleTypeId.
export const createSpecialEquipmentRequestSchema = z
  .object({
    requestType: z.literal('special_equipment'),
    objectId: uuidSchema,
    vehicleTypeId: uuidSchema,
    dateFrom: dateOnlySchema,
    dateTo: dateOnlySchema.nullable().optional(),
    comment: commentSchema.optional().default(''),
    fileIds: fileIdsSchema.optional().default([]),
  })
  .strict();

export const createFreightTransportRequestSchema = z
  .object({
    requestType: z.literal('freight_transport'),
    objectId: uuidSchema,
    vehicleTypeId: uuidSchema,
    scheduledAt: scheduledAtSchema,
    /**
     * Время подачи не задано: `scheduledAt` несёт только дату (00:00 МСК), рабочее окно
     * не проверяется. Дата и время в БД остаются одним timestamptz.
     */
    scheduledTimeUnspecified: z.boolean().optional().default(false),
    volumeM3: amountSchema.nullable().optional(),
    weightTons: amountSchema.nullable().optional(),
    loadingLocation: locationSchema,
    unloadingLocation: locationSchema,
    loadingAddress: verifiedAddressMetaSchema,
    unloadingAddress: verifiedAddressMetaSchema,
    comment: commentSchema.optional().default(''),
    fileIds: fileIdsSchema.optional().default([]),
  })
  .strict();

export const createVehicleRequestSchema = z
  .discriminatedUnion('requestType', [
    createSpecialEquipmentRequestSchema,
    createFreightTransportRequestSchema,
  ])
  .superRefine((v, ctx) => {
    if (v.requestType === 'special_equipment') {
      if (v.dateTo && v.dateTo < v.dateFrom) {
        ctx.addIssue({
          code: 'custom',
          path: ['dateTo'],
          message: 'Дата окончания раньше даты начала',
        });
      }
    } else {
      if (v.volumeM3 == null && v.weightTons == null) {
        ctx.addIssue({ code: 'custom', path: ['volumeM3'], message: 'Укажите объём или массу' });
      }
      if (!v.scheduledTimeUnspecified && !isWithinWorkTimeAt(new Date(v.scheduledAt))) {
        ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: WORK_TIME_MESSAGE });
      }
    }
  });
export type CreateSpecialEquipmentRequestInput = z.infer<
  typeof createSpecialEquipmentRequestSchema
>;
export type CreateFreightTransportRequestInput = z.infer<
  typeof createFreightTransportRequestSchema
>;
export type CreateVehicleRequestInput = z.infer<typeof createVehicleRequestSchema>;

// ── Обновление (discriminatedUnion; requestType неизменяем — сверяется backend) ──
// Кросс-полевые правила (dateTo>=dateFrom, объём|масса) добьёт backend после мержа + CHECK БД.
export const updateSpecialEquipmentRequestSchema = z
  .object({
    requestType: z.literal('special_equipment'),
    version: z.number().int().nonnegative(),
    objectId: uuidSchema.optional(),
    vehicleTypeId: uuidSchema.optional(),
    dateFrom: dateOnlySchema.optional(),
    dateTo: dateOnlySchema.nullable().optional(),
    comment: commentSchema.optional(),
    addFileIds: fileIdsSchema.optional(),
    removeFileIds: z.array(uuidSchema).optional(),
  })
  .strict();

export const updateFreightTransportRequestSchema = z
  .object({
    requestType: z.literal('freight_transport'),
    version: z.number().int().nonnegative(),
    objectId: uuidSchema.optional(),
    vehicleTypeId: uuidSchema.optional(),
    scheduledAt: scheduledAtSchema.optional(),
    // Передаётся вместе со `scheduledAt` — рабочее окно проверяется только при заданном времени.
    scheduledTimeUnspecified: z.boolean().optional(),
    volumeM3: amountSchema.nullable().optional(),
    weightTons: amountSchema.nullable().optional(),
    loadingLocation: locationSchema.optional(),
    unloadingLocation: locationSchema.optional(),
    loadingAddress: verifiedAddressMetaSchema.optional(),
    unloadingAddress: verifiedAddressMetaSchema.optional(),
    comment: commentSchema.optional(),
    addFileIds: fileIdsSchema.optional(),
    removeFileIds: z.array(uuidSchema).optional(),
  })
  .strict();

export const updateVehicleRequestSchema = z
  .discriminatedUnion('requestType', [
    updateSpecialEquipmentRequestSchema,
    updateFreightTransportRequestSchema,
  ])
  .superRefine((v, ctx) => {
    // Жёсткая модель (ADR 0006): строка адреса и его метаданные передаются вместе.
    if (v.requestType === 'freight_transport') {
      if ((v.loadingLocation === undefined) !== (v.loadingAddress === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['loadingAddress'],
          message: 'Адрес и строка погрузки передаются вместе',
        });
      }
      if ((v.unloadingLocation === undefined) !== (v.unloadingAddress === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['unloadingAddress'],
          message: 'Адрес и строка разгрузки передаются вместе',
        });
      }
      if (
        v.scheduledAt !== undefined &&
        v.scheduledTimeUnspecified !== true &&
        !isWithinWorkTimeAt(new Date(v.scheduledAt))
      ) {
        ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: WORK_TIME_MESSAGE });
      }
    }
  });
export type UpdateVehicleRequestInput = z.infer<typeof updateVehicleRequestSchema>;

// Комментарий пишется в историю (vehicle_request_status_history.comment); при отмене
// он обязателен и играет роль причины — как и у заявок на вывоз мусора.
export const changeVehicleRequestStatusSchema = z
  .object({
    status: requestStatusSchema,
    comment: commentSchema.optional().default(''),
    version: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (statusChangeRequiresReason(v.status) && !v.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите причину отмены' });
    }
  });
export type ChangeVehicleRequestStatusInput = z.infer<typeof changeVehicleRequestStatusSchema>;

// ── Список ──
export const VEHICLE_REQUEST_SORT_FIELDS = ['num', 'objectName', 'status', 'createdAt'] as const;

export const vehicleRequestListQuerySchema = baseListQuery(VEHICLE_REQUEST_SORT_FIELDS).extend({
  // Необязателен: раздел «Заказ автотехники» — единый список обоих типов.
  // Задан — список сужается до одного типа (фильтр в интерфейсе, вкладка «На объекте»).
  requestType: vehicleRequestTypeSchema.optional(),
  status: requestStatusSchema.optional(),
  objectId: uuidSchema.optional(),
  vehicleTypeId: uuidSchema.optional(),
  num: z.coerce.number().int().positive().optional(),
  // Календарный диапазон (YYYY-MM-DD): для спецтехники — пересечение периодов,
  // для грузоперевозки — день в Europe/Moscow (интерпретирует backend).
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/**
 * Сводка по статусам для виджета над списком. Из фильтров таблицы учитываются объект и тип
 * заявки — те же, что сужают сам список; фильтр по статусу свёл бы сводку к самой себе,
 * а по номеру — к одной заявке.
 */
export const vehicleRequestSummaryQuerySchema = z.object({
  objectId: uuidSchema.optional(),
  requestType: vehicleRequestTypeSchema.optional(),
});
export type VehicleRequestSummaryQuery = z.infer<typeof vehicleRequestSummaryQuerySchema>;

/** Количество видимых заявок в каждом статусе (удалённые не считаются). */
export type VehicleRequestSummaryDto = Record<RequestStatus, number>;

// ── DTO ──
export interface VehicleRequestBaseDto {
  id: string;
  num: number;
  /** «ТС-000123». */
  displayNumber: string;
  requestType: VehicleRequestType;

  objectId: string;
  objectCode: string;
  objectName: string;

  /** Тип ТС (физически vehicle_requests.vehicle_type_id). Плоская модель (ADR 0005). */
  vehicleTypeId: string;
  vehicleTypeName: string;

  status: RequestStatus;
  comment: string;
  /** Причина отмены из истории статусов; заполнена только у отменённых заявок. */
  cancelReason: string | null;
  files: FileDto[];
  version: number;

  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface SpecialEquipmentRequestDto extends VehicleRequestBaseDto {
  requestType: 'special_equipment';
  dateFrom: string;
  dateTo: string | null;
}

export interface FreightTransportRequestDto extends VehicleRequestBaseDto {
  requestType: 'freight_transport';
  scheduledAt: string;
  /** Время подачи не задано — в `scheduledAt` значима только дата (00:00 МСК). */
  scheduledTimeUnspecified: boolean;
  volumeM3: number | null;
  weightTons: number | null;
  loadingLocation: string;
  unloadingLocation: string;
  /** Метаданные верификации адреса погрузки (null = не верифицирован / введён вручную). */
  loadingAddress: AddressMeta | null;
  /** Метаданные верификации адреса разгрузки. */
  unloadingAddress: AddressMeta | null;
}

export type VehicleRequestDto = SpecialEquipmentRequestDto | FreightTransportRequestDto;
