import { z } from 'zod';
import { containerKindSchema, type ContainerKind } from './enums';
import { baseListQuery } from './common';

export const CONTAINER_TYPE_SORT_FIELDS = ['code', 'name', 'sortOrder', 'type', 'isActive'] as const;

export const containerTypeListQuerySchema = baseListQuery(CONTAINER_TYPE_SORT_FIELDS).extend({
  type: containerKindSchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const createContainerTypeSchema = z
  .object({
    code: z.string().trim().min(1).max(50),
    name: z.string().trim().min(1).max(255),
    type: containerKindSchema.default('cont'),
    sortOrder: z.coerce.number().int().default(100),
    isActive: z.boolean().default(true),
  })
  .strict();
export type CreateContainerTypeInput = z.infer<typeof createContainerTypeSchema>;

// `code` — стабильный системный идентификатор, неизменяем после создания
// (единый принцип со справочником типов/подтипов ТС). Удаления нет: деактивация
// через isActive.
export const updateContainerTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    type: containerKindSchema.optional(),
    sortOrder: z.coerce.number().int().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateContainerTypeInput = z.infer<typeof updateContainerTypeSchema>;

export interface ContainerTypeDto {
  id: string;
  code: string;
  name: string;
  type: ContainerKind;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
