import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';
import { formatSpecValue, specLabel, specValueSchema } from './vehicle-specs';

// ── Категории типа ТС: условные подтипы (ADR 0016) ──
// Идентичность категории — набор значений всех ТТХ типа, а не наименование. Комбинации не
// генерируются перебором: категории заводит человек либо приносит seed-миграция.

export const VEHICLE_CATEGORY_SORT_FIELDS = [
  'name',
  'typeName',
  'sortOrder',
  'isActive',
  'createdAt',
] as const;

const boolFromQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const vehicleCategoryListQuerySchema = baseListQuery(VEHICLE_CATEGORY_SORT_FIELDS).extend({
  vehicleTypeId: uuidSchema.optional(),
  isActive: boolFromQuery,
});

export const vehicleCategoryValueInputSchema = z
  .object({ specId: uuidSchema, value: specValueSchema })
  .strict();
export type VehicleCategoryValueInput = z.infer<typeof vehicleCategoryValueInputSchema>;

/**
 * Набор значений должен покрывать ровно все ТТХ типа — сверка с типом на сервере; здесь только
 * непустота и отсутствие повторов одного ТТХ.
 */
const valuesSchema = z
  .array(vehicleCategoryValueInputSchema)
  .min(1)
  .max(50)
  .refine((v) => new Set(v.map((x) => x.specId)).size === v.length, {
    message: 'Один ТТХ указан дважды',
  });

export const createVehicleCategorySchema = z
  .object({
    vehicleTypeId: uuidSchema,
    values: valuesSchema,
    /** Пусто — наименование генерируется из типа и значений (isAutoName = true). */
    name: z.string().trim().min(1).max(255).optional(),
    sortOrder: z.coerce.number().int().optional().default(100),
    isActive: z.boolean().optional().default(true),
  })
  .strict();
export type CreateVehicleCategoryInput = z.infer<typeof createVehicleCategorySchema>;

// Тип категории неизменяем: смена типа — это другая сущность. Пустая строка в `name` возвращает
// автогенерацию наименования.
export const updateVehicleCategorySchema = z
  .object({
    values: valuesSchema.optional(),
    name: z.string().trim().max(255).optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateVehicleCategoryInput = z.infer<typeof updateVehicleCategorySchema>;

/** Значение ТТХ у категории вместе со справочными полями ТТХ (чтобы клиент не собирал их сам). */
export interface VehicleCategoryValueDto {
  specId: string;
  code: string;
  name: string;
  shortName: string;
  unit: string;
  decimals: number;
  sortOrder: number;
  value: number;
}

export interface VehicleCategoryDto {
  id: string;
  vehicleTypeId: string;
  typeName: string;
  kindName: string;
  name: string;
  isAutoName: boolean;
  /** Канонический слепок набора значений: «boom_length=21;lift_capacity=25». */
  specSignature: string;
  values: VehicleCategoryValueDto[];
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Наименование категории: «Автокраны, г/п 25 т, стрела 21 м». Значения идут в порядке ТТХ у типа.
 * Хранится материализованно (имя в отчётах не должно «плыть»), перегенерируется только при
 * isAutoName = true.
 */
export function buildVehicleCategoryName(
  typeName: string,
  values: readonly VehicleCategoryValueDto[],
): string {
  const parts = [...values]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru'))
    .map((v) => `${specLabel(v)} ${formatSpecValue(v.value, v)}`);
  return parts.length > 0 ? `${typeName}, ${parts.join(', ')}` : typeName;
}
