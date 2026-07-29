import { z } from 'zod';
import { isObjectScopedRole, roleSchema, type Role } from './enums';
import { baseListQuery, uuidSchema } from './common';

// Сортировка доступна во всех столбцах таблицы; ключ поля совпадает с ключом колонки.
export const USER_SORT_FIELDS = [
  'email',
  'fullName',
  'role',
  'constructionObjectName',
  'counterpartyName',
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
    /** Контрагент учётки: обязателен для «Оператора» — задаёт, чьи заявки он видит (ADR 0010). */
    counterpartyId: uuidSchema.nullish(),
  })
  // Объектные роли («Штаб», «Руководитель строительства») работают в пределах своего объекта —
  // без него у учётки нет ни области видимости, ни ограничения (ADR 0025).
  .refine((v) => !isObjectScopedRole(v.role) || !!v.constructionObjectId, {
    message: 'Роль работает в пределах объекта — укажите объект',
    path: ['constructionObjectId'],
  })
  .refine((v) => v.role !== 'operator' || !!v.counterpartyId, {
    message: 'Для роли «Оператор» обязателен контрагент',
    path: ['counterpartyId'],
  });
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(255).optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  constructionObjectId: uuidSchema.nullish(),
  counterpartyId: uuidSchema.nullish(),
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
  counterpartyId: string | null;
  counterpartyName: string | null;
  createdAt: string;
  updatedAt: string;
}
