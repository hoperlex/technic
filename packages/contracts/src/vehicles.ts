import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';

// ── Справочник «Техника»: конкретные ТС (ADR 0007) ──
// Тип обязателен, марка/модель опциональна (в источнике есть машины без марки). Согласованность
// «тип ТС = тип модели» гарантирует составной FK в БД. Госномер нормализуется и уникален среди живых.

export const VEHICLE_STATUSES = ['active', 'inactive', 'maintenance', 'retired'] as const;
export const vehicleStatusSchema = z.enum(VEHICLE_STATUSES);
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const vehicleStatusLabels: Record<VehicleStatus, string> = {
  active: 'Активна',
  inactive: 'Неактивна',
  maintenance: 'Обслуживание',
  retired: 'Списана',
};
export const vehicleStatusColors: Record<VehicleStatus, string> = {
  active: 'green',
  inactive: 'default',
  maintenance: 'gold',
  retired: 'red',
};

// Сортировка доступна во всех столбцах таблицы; ключ поля совпадает с ключом колонки.
export const VEHICLE_SORT_FIELDS = [
  'registrationNumber',
  'typeName',
  'modelName',
  'status',
  'createdAt',
] as const;

export const vehicleListQuerySchema = baseListQuery(VEHICLE_SORT_FIELDS).extend({
  vehicleTypeId: uuidSchema.optional(),
  status: vehicleStatusSchema.optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const createVehicleSchema = z
  .object({
    vehicleTypeId: uuidSchema,
    vehicleModelId: uuidSchema.nullish(),
    registrationNumber: z.string().trim().max(50).nullish(),
    passportNumber: z.string().trim().max(100).nullish(),
    status: vehicleStatusSchema.optional().default('active'),
    note: z.string().trim().max(2000).optional().default(''),
  })
  .strict();
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;

// `.partial()` делает поля необязательными, но НЕ снимает `.default()` — без переобъявления
// PATCH со сменой одного статуса возвращал бы note пустой строкой и затирал его в БД.
// Поэтому поля со значением по умолчанию объявлены здесь заново, без дефолта.
export const updateVehicleSchema = createVehicleSchema
  .partial()
  .extend({
    status: vehicleStatusSchema.optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;

export interface VehicleDto {
  id: string;
  vehicleTypeId: string;
  typeName: string;
  vehicleModelId: string | null;
  modelName: string | null;
  registrationNumber: string | null;
  passportNumber: string | null;
  status: VehicleStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

// ── Марки/модели: read-only список для выбора в форме техники (не отдельный справочник) ──
export const VEHICLE_MODEL_SORT_FIELDS = ['name', 'createdAt'] as const;

export const vehicleModelListQuerySchema = baseListQuery(VEHICLE_MODEL_SORT_FIELDS).extend({
  vehicleTypeId: uuidSchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export interface VehicleModelDto {
  id: string;
  vehicleTypeId: string;
  name: string;
  manufacturerName: string;
  isActive: boolean;
}
