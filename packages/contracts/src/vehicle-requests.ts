import { z } from 'zod';
import { requestStatusSchema } from './enums';
import type { RequestStatus } from './enums';
import { baseListQuery, uuidSchema } from './common';
import type { FileDto } from './files';

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
// Каноническая строка адреса хранится отдельно (loadingLocation/unloadingLocation);
// здесь — только происхождение и ФИАС/гео. Мягкая модель (ADR 0005): backend доверяет
// `fiasId` из подсказки, внешних вызовов в write-path нет; `manual` помечается, не блокируется.
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
export const createSpecialEquipmentRequestSchema = z
  .object({
    requestType: z.literal('special_equipment'),
    objectId: uuidSchema,
    vehicleSubtypeId: uuidSchema,
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
    vehicleSubtypeId: uuidSchema,
    scheduledAt: scheduledAtSchema,
    volumeM3: amountSchema.nullable().optional(),
    weightTons: amountSchema.nullable().optional(),
    loadingLocation: locationSchema,
    unloadingLocation: locationSchema,
    loadingAddress: addressMetaSchema.nullable().optional(),
    unloadingAddress: addressMetaSchema.nullable().optional(),
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
    } else if (v.volumeM3 == null && v.weightTons == null) {
      ctx.addIssue({ code: 'custom', path: ['volumeM3'], message: 'Укажите объём или массу' });
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
    vehicleSubtypeId: uuidSchema.optional(),
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
    vehicleSubtypeId: uuidSchema.optional(),
    scheduledAt: scheduledAtSchema.optional(),
    volumeM3: amountSchema.nullable().optional(),
    weightTons: amountSchema.nullable().optional(),
    loadingLocation: locationSchema.optional(),
    unloadingLocation: locationSchema.optional(),
    loadingAddress: addressMetaSchema.nullable().optional(),
    unloadingAddress: addressMetaSchema.nullable().optional(),
    comment: commentSchema.optional(),
    addFileIds: fileIdsSchema.optional(),
    removeFileIds: z.array(uuidSchema).optional(),
  })
  .strict();

export const updateVehicleRequestSchema = z.discriminatedUnion('requestType', [
  updateSpecialEquipmentRequestSchema,
  updateFreightTransportRequestSchema,
]);
export type UpdateVehicleRequestInput = z.infer<typeof updateVehicleRequestSchema>;

export const changeVehicleRequestStatusSchema = z
  .object({
    status: requestStatusSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();
export type ChangeVehicleRequestStatusInput = z.infer<typeof changeVehicleRequestStatusSchema>;

// ── Список ──
export const VEHICLE_REQUEST_SORT_FIELDS = ['num', 'objectName', 'status', 'createdAt'] as const;

export const vehicleRequestListQuerySchema = baseListQuery(VEHICLE_REQUEST_SORT_FIELDS).extend({
  // Обязателен: список всегда в контексте вкладки (спецтехника/грузоперевозки).
  requestType: vehicleRequestTypeSchema,
  status: requestStatusSchema.optional(),
  objectId: uuidSchema.optional(),
  vehicleSubtypeId: uuidSchema.optional(),
  parentTypeId: uuidSchema.optional(),
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

  /** Родительский тип ТС (через JOIN от подтипа) — для отображения/фильтра. */
  parentTypeId: string;
  parentTypeName: string;
  /** Конечный выбираемый подтип (физически vehicle_requests.vehicle_type_id). */
  vehicleSubtypeId: string;
  vehicleSubtypeName: string;

  status: RequestStatus;
  comment: string;
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
