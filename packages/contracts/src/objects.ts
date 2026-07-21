import { z } from 'zod';
import { baseListQuery } from './common';

export const OBJECT_SORT_FIELDS = ['code', 'name', 'address', 'isActive', 'createdAt'] as const;

export const objectListQuerySchema = baseListQuery(OBJECT_SORT_FIELDS).extend({
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const createObjectSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(255),
  address: z.string().trim().max(500).optional().default(''),
  isActive: z.boolean().default(true),
});
export type CreateObjectInput = z.infer<typeof createObjectSchema>;

export const updateObjectSchema = createObjectSchema.partial();
export type UpdateObjectInput = z.infer<typeof updateObjectSchema>;

export interface ObjectDto {
  id: string;
  code: string;
  name: string;
  address: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
