import { z } from 'zod';
import { baseListQuery } from './common';

export const VEHICLE_KIND_SORT_FIELDS = ['code', 'name', 'sortOrder', 'isActive'] as const;

export const vehicleKindListQuerySchema = baseListQuery(VEHICLE_KIND_SORT_FIELDS).extend({
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const createVehicleKindSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(255),
  sortOrder: z.coerce.number().int().default(100),
  isActive: z.boolean().default(true),
});
export type CreateVehicleKindInput = z.infer<typeof createVehicleKindSchema>;

export const updateVehicleKindSchema = createVehicleKindSchema.partial();
export type UpdateVehicleKindInput = z.infer<typeof updateVehicleKindSchema>;

/** Верхнеуровневый вид ТС: «Спецтехника» / «Грузоперевозки» (управляемый справочник). */
export interface VehicleKindDto {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
