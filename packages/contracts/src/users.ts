import { z } from 'zod';
import { isCounterpartyScopedRole, isObjectScopedRole, roleSchema, type Role } from './enums';
import type { CounterpartyType } from './counterparties';
import { baseListQuery, uuidSchema } from './common';
import { passwordIdentityIssue, passwordSchema } from './password';
import { personNameFields, personNamePartialFields, type PersonNameParts } from './person-name';
import type { RegistrationRoleRequest } from './registration-request';

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

const booleanFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const userListQuerySchema = baseListQuery(USER_SORT_FIELDS).extend({
  role: roleSchema.optional(),
  isActive: booleanFlag,
  /**
   * Заявки на регистрацию: неактивная учётка без роли. Роль при саморегистрации не назначается,
   * поэтому «нет роли + не активна» отличает заявку от учётки, деактивированной администратором.
   */
  pending: booleanFlag,
});

export const createUserSchema = z
  .object({
    email: z.string().email().max(255),
    ...personNameFields,
    role: roleSchema,
    password: passwordSchema,
    isActive: z.boolean().default(true),
    constructionObjectId: uuidSchema.nullish(),
    /**
     * Контрагент учётки: обязателен для внешнего исполнителя — задаёт и чьи заявки он видит
     * (ADR 0010), и в каком модуле работает, потому что модуль следует из типа контрагента
     * (ADR 0038).
     */
    counterpartyId: uuidSchema.nullish(),
  })
  // Объектные роли («Штаб», «Руководитель строительства») работают в пределах своего объекта —
  // без него у учётки нет ни области видимости, ни ограничения (ADR 0025).
  .refine((v) => !isObjectScopedRole(v.role) || !!v.constructionObjectId, {
    message: 'Роль работает в пределах объекта — укажите объект',
    path: ['constructionObjectId'],
  })
  .refine((v) => !isCounterpartyScopedRole(v.role) || !!v.counterpartyId, {
    message: 'Роль работает от контрагента — укажите контрагента',
    path: ['counterpartyId'],
  })
  .superRefine((v, ctx) => {
    const issue = passwordIdentityIssue(v.password, [v.email, v.lastName, v.firstName]);
    if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['password'] });
  });
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  ...personNamePartialFields,
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  constructionObjectId: uuidSchema.nullish(),
  counterpartyId: uuidSchema.nullish(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const setUserPasswordSchema = z.object({
  newPassword: passwordSchema,
});

/** Отказ по заявке на регистрацию: причина попадает в аудит, учётка уходит в soft delete. */
export const rejectUserSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type RejectUserInput = z.infer<typeof rejectUserSchema>;

export interface UserDto extends PersonNameParts {
  id: string;
  email: string;
  /** Считается базой из частей ФИО; отдельно не редактируется. */
  fullName: string;
  /**
   * Кем человек назвал себя при регистрации (ADR 0034) и что уточнил. `null` — учётку заводил
   * администратор, пожелания нет. Права из этого не следуют: их даёт только `role`.
   */
  requestedRole: RegistrationRoleRequest | null;
  requestedObject: string;
  requestedCompany: string;
  role: Role | null;
  isActive: boolean;
  mustChangePassword: boolean;
  constructionObjectId: string | null;
  constructionObjectName: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  /** Тип контрагента: у внешнего исполнителя им заданы модуль и набор прав (ADR 0038). */
  counterpartyType: CounterpartyType | null;
  createdAt: string;
  updatedAt: string;
}
