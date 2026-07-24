import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';

export const RESOLUTION_STRATEGIES = ['direct', 'by_model', 'by_registry'] as const;
export const resolutionStrategySchema = z.enum(RESOLUTION_STRATEGIES);
export type ResolutionStrategy = (typeof RESOLUTION_STRATEGIES)[number];

export const VEHICLE_TYPE_SOURCE_MAPPING_SORT_FIELDS = [
  'sourceCode',
  'sourceName',
  'isActive',
] as const;

export const vehicleTypeSourceMappingListQuerySchema = baseListQuery(
  VEHICLE_TYPE_SOURCE_MAPPING_SORT_FIELDS,
).extend({
  sourceCode: z.string().trim().optional(),
  vehicleTypeId: uuidSchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const createVehicleTypeSourceMappingSchema = z.object({
  sourceCode: z.string().trim().min(1).max(100),
  sourceName: z.string().trim().min(1).max(255),
  normalizedSourceName: z.string().trim().min(1).max(255),
  vehicleTypeId: uuidSchema,
  resolutionStrategy: resolutionStrategySchema,
  requiresInstanceResolution: z.boolean().default(false),
  comment: z.string().trim().max(1000).optional().default(''),
  isActive: z.boolean().default(true),
});
export type CreateVehicleTypeSourceMappingInput = z.infer<
  typeof createVehicleTypeSourceMappingSchema
>;

export const updateVehicleTypeSourceMappingSchema =
  createVehicleTypeSourceMappingSchema.partial();
export type UpdateVehicleTypeSourceMappingInput = z.infer<
  typeof updateVehicleTypeSourceMappingSchema
>;

/**
 * Правило сопоставления исходного «Тип ТС» (из Excel) с типом/подтипом классификатора.
 * `direct` → конечный подтип; неоднозначные ведут на родителя с `requiresInstanceResolution=true`.
 */
export interface VehicleTypeSourceMappingDto {
  id: string;
  sourceCode: string;
  sourceName: string;
  normalizedSourceName: string;
  vehicleTypeId: string;
  vehicleTypeCode: string;
  resolutionStrategy: ResolutionStrategy;
  requiresInstanceResolution: boolean;
  comment: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
