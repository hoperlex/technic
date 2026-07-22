import { z } from 'zod';
import { baseListQuery } from './common';

export const MACHINE_TYPE_SORT_FIELDS = ['code', 'name', 'sortOrder', 'isActive'] as const;

export const machineTypeListQuerySchema = baseListQuery(MACHINE_TYPE_SORT_FIELDS).extend({
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const createMachineTypeSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(255),
  sortOrder: z.coerce.number().int().default(100),
  isActive: z.boolean().default(true),
});
export type CreateMachineTypeInput = z.infer<typeof createMachineTypeSchema>;

export const updateMachineTypeSchema = createMachineTypeSchema.partial();
export type UpdateMachineTypeInput = z.infer<typeof updateMachineTypeSchema>;

export interface MachineTypeDto {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
