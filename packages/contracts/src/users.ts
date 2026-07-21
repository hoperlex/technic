import { z } from 'zod';
import { roleSchema, type Role } from './enums';
import { baseListQuery, uuidSchema } from './common';

export const USER_SORT_FIELDS = [
  'email',
  'fullName',
  'role',
  'isActive',
  'createdAt',
] as const;

export const userListQuerySchema = baseListQuery(USER_SORT_FIELDS).extend({
  role: roleSchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const createUserSchema = z
  .object({
    email: z.string().email().max(255),
    fullName: z.string().trim().min(2).max(255),
    role: roleSchema,
    password: z.string().min(10).max(200),
    isActive: z.boolean().default(true),
    constructionObjectId: uuidSchema.nullish(),
  })
  .refine((v) => v.role !== 'shtab' || !!v.constructionObjectId, {
    message: 'Для роли «Штаб» обязателен объект',
    path: ['constructionObjectId'],
  });
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(255).optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  constructionObjectId: uuidSchema.nullish(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const setUserPasswordSchema = z.object({
  newPassword: z.string().min(10).max(200),
});

export interface UserDto {
  id: string;
  email: string;
  fullName: string;
  role: Role | null;
  isActive: boolean;
  mustChangePassword: boolean;
  constructionObjectId: string | null;
  constructionObjectName: string | null;
  createdAt: string;
  updatedAt: string;
}
