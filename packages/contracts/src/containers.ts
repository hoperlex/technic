import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';

export const CONTAINER_SORT_FIELDS = [
  'label',
  'containerTypeName',
  'isActive',
  'createdAt',
] as const;

export const containerListQuerySchema = baseListQuery(CONTAINER_SORT_FIELDS).extend({
  objectId: uuidSchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const createContainerSchema = z.object({
  objectId: uuidSchema,
  containerTypeId: uuidSchema,
  label: z.string().trim().max(100).optional().default(''),
  isActive: z.boolean().default(true),
});
export type CreateContainerInput = z.infer<typeof createContainerSchema>;

export const updateContainerSchema = z.object({
  containerTypeId: uuidSchema.optional(),
  label: z.string().trim().max(100).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateContainerInput = z.infer<typeof updateContainerSchema>;

/** Экземпляр контейнера, привязанный к объекту строительства. */
export interface ContainerDto {
  id: string;
  objectId: string;
  containerTypeId: string;
  containerTypeName: string;
  label: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
