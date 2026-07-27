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
// Переходный период к плоскому классификатору (ADR 0005, Фаза 1): новый клиент шлёт
// `vehicleTypeId` (плоский тип), старый — `vehicleSubtypeId` (подтип). Ровно одно из полей
// обязательно — проверяет superRefine у createVehicleRequestSchema. Оба записываются в
// vehicle_requests.vehicle_type_id; backend валидирует соответствующей resolve-функцией.
export const createSpecialEquipmentRequestSchema = z
  .object({
    requestType: z.literal('special_equipment'),
    objectId: uuidSchema,
    vehicleTypeId: uuidSchema.optional(),
    vehicleSubtypeId: uuidSchema.optional(),
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
    vehicleTypeId: uuidSchema.optional(),
    vehicleSubtypeId: uuidSchema.optional(),
    scheduledAt: scheduledAtSchema,
    volumeM3: amountSchema.nullable().optional(),
    weightTons: amountSchema.nullable().optional(),
    loadingLocation: locationSchema,
    unloadingLocation: locationSchema,
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
    // Ровно одно из vehicleTypeId / vehicleSubtypeId (переходный период, ADR 0005).
    if (!v.vehicleTypeId === !v.vehicleSubtypeId) {
      ctx.addIssue({
        code: 'custom',
        path: ['vehicleTypeId'],
        message: 'Укажите тип ТС (ровно одно из полей: vehicleTypeId или vehicleSubtypeId)',
      });
    }
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
    vehicleTypeId: uuidSchema.optional(),
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
    vehicleTypeId: uuidSchema.optional(),
    vehicleSubtypeId: uuidSchema.optional(),
    scheduledAt: scheduledAtSchema.optional(),
    volumeM3: amountSchema.nullable().optional(),
    weightTons: amountSchema.nullable().optional(),
    loadingLocation: locationSchema.optional(),
    unloadingLocation: locationSchema.optional(),
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
    // Тип ТС меняем максимум одним полем (переходный период, ADR 0005).
    if (v.vehicleTypeId && v.vehicleSubtypeId) {
      ctx.addIssue({
        code: 'custom',
        path: ['vehicleTypeId'],
        message: 'Укажите только одно поле типа ТС (vehicleTypeId или vehicleSubtypeId)',
      });
    }
  });
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
  // Новый плоский фильтр (Фаза 1) + старые подтип/родитель — совместимость на переходный период.
  vehicleTypeId: uuidSchema.optional(),
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

  /** Тип ТС (физически vehicle_requests.vehicle_type_id). Плоская модель (ADR 0005). */
  vehicleTypeId: string;
  vehicleTypeName: string;
  /**
   * Поля переходного периода (Фаза 1) для старого фронта. Для плоского типа дублируют
   * vehicleTypeId/Name (parentType* — тоже, чтобы старая колонка «Тип ТС» осталась осмысленной).
   * Удаляются в фазе 3.
   */
  parentTypeId: string;
  parentTypeName: string;
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
}

export type VehicleRequestDto = SpecialEquipmentRequestDto | FreightTransportRequestDto;
