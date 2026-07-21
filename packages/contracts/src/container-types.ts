import { z } from 'zod';
import { baseListQuery } from './common';

export const CONTAINER_TYPE_SORT_FIELDS = ['code', 'name', 'sortOrder', 'isActive'] as const;

export const containerTypeListQuerySchema = baseListQuery(CONTAINER_TYPE_SORT_FIELDS).extend({
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const createContainerTypeSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(255),
  sortOrder: z.coerce.number().int().default(100),
  isActive: z.boolean().default(true),
});
export type CreateContainerTypeInput = z.infer<typeof createContainerTypeSchema>;

export const updateContainerTypeSchema = createContainerTypeSchema.partial();
export type UpdateContainerTypeInput = z.infer<typeof updateContainerTypeSchema>;

export interface ContainerTypeDto {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
