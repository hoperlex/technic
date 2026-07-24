import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';

export const VEHICLE_TYPE_SORT_FIELDS = ['code', 'name', 'sortOrder', 'isActive'] as const;

const boolFromQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const vehicleTypeListQuerySchema = baseListQuery(VEHICLE_TYPE_SORT_FIELDS).extend({
  kindId: uuidSchema.optional(),
  parentId: uuidSchema.optional(),
  isSelectable: boolFromQuery,
  isActive: boolFromQuery,
});

export const createVehicleTypeSchema = z.object({
  kindId: uuidSchema,
  /** null/undefined — верхнеуровневый тип. */
  parentId: uuidSchema.nullish(),
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(1000).optional().default(''),
  isSelectable: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(100),
  isActive: z.boolean().default(true),
});
export type CreateVehicleTypeInput = z.infer<typeof createVehicleTypeSchema>;

export const updateVehicleTypeSchema = createVehicleTypeSchema.partial();
export type UpdateVehicleTypeInput = z.infer<typeof updateVehicleTypeSchema>;

/**
 * Тип/подтип ТС из иерархического справочника.
 * Родительский тип: parentId=null, isSelectable=false; конечный подтип: isSelectable=true.
 * Конкретное ТС (следующий этап) сможет ссылаться только на selectable-подтип.
 */
export interface VehicleTypeDto {
  id: string;
  kindId: string;
  kindCode: string;
  kindName: string;
  parentId: string | null;
  code: string;
  name: string;
  description: string;
  isSelectable: boolean;
  /** Есть ли дочерние типы (вычисляется, не хранится). */
  hasChildren: boolean;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
