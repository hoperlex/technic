import { z } from 'zod';
import {
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  roleSchema,
  type Role,
} from './enums';
import type { CounterpartyType } from './counterparties';
import { baseListQuery, dateOnlySchema, uuidSchema } from './common';
import { passwordIdentityIssue, passwordSchema } from './password';
import { personNameFields, personNamePartialFields, type PersonNameParts } from './person-name';
import {
  registrationRoleRequestSchema,
  type RegistrationRoleRequest,
} from './registration-request';

// Сортировка доступна во всех столбцах таблицы; ключ поля совпадает с ключом колонки.
// Объектов у учётки набор (ADR 0039), и сортировать по нему нечем: «Объект1, Объект7» и
// «Объект2» сравнимы только выбранным наугад представителем набора. Колонка осталась, сортировка
// по ней — нет.
export const USER_SORT_FIELDS = [
  'email',
  'fullName',
  'role',
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
  /** Объект в наборе учётки (ADR 0039): «кто работает на этой площадке», а не «чей он один». */
  constructionObjectId: uuidSchema.optional(),
  counterpartyId: uuidSchema.optional(),
  /**
   * Пожелание из заявки на регистрацию (ADR 0034) — очередь разбирают пачками: сначала все
   * сотрудники объекта, потом все исполнители. Осмыслен только вместе с `pending`, но собственной
   * зависимости не требует: у рассмотренной учётки пожелание сохраняется, и по нему тоже ищут.
   */
  requestedRole: registrationRoleRequestSchema.optional(),
  /** Дата регистрации, календарные сутки Europe/Moscow: границы включительно. */
  createdFrom: dateOnlySchema.optional(),
  createdTo: dateOnlySchema.optional(),
  /** Архив: удалённые учётки и отклонённые заявки. Отдаётся только праву `archive.read`. */
  includeDeleted: booleanFlag,
});

/**
 * Объекты учётки (ADR 0039) — многие-ко-многим. Передаются полным списком: сервер синхронизирует
 * набор, как с операторами объекта и синонимами контрагента. Пятидесяти площадок на одну учётку
 * не бывает — предел стоит от опечатки в клиенте, а не от рабочего случая.
 */
export const constructionObjectIdsSchema = z.array(uuidSchema).max(50);

/**
 * Отделы учётки (ADR 0040) — вторая ось области, устроенная так же, как объекты. Заполнена
 * всегда одна из двух: отдел — офисное подразделение, и с площадками он не пересекается.
 */
export const departmentIdsSchema = z.array(uuidSchema).max(50);

export const createUserSchema = z
  .object({
    email: z.string().email().max(255),
    ...personNameFields,
    role: roleSchema,
    password: passwordSchema,
    isActive: z.boolean().default(true),
    constructionObjectIds: constructionObjectIdsSchema.optional().default([]),
    departmentIds: departmentIdsSchema.optional().default([]),
    /**
     * Контрагент учётки: обязателен для внешнего исполнителя — задаёт и чьи заявки он видит
     * (ADR 0010), и в каком модуле работает, потому что модуль следует из типа контрагента
     * (ADR 0038).
     */
    counterpartyId: uuidSchema.nullish(),
  })
  // Объектные роли («Штаб», «Руководитель строительства») работают в пределах своих объектов —
  // без них у учётки нет ни области видимости, ни ограничения (ADR 0025, ADR 0039).
  .refine((v) => !isObjectScopedRole(v.role) || v.constructionObjectIds.length > 0, {
    message: 'Роль работает в пределах объекта — укажите хотя бы один',
    path: ['constructionObjectIds'],
  })
  // Роли отдела («Отдел», «Руководитель отдела») — то же самое второй осью (ADR 0040).
  .refine((v) => !isDepartmentScopedRole(v.role) || v.departmentIds.length > 0, {
    message: 'Роль работает в пределах отдела — укажите хотя бы один',
    path: ['departmentIds'],
  })
  // Двух областей сразу не бывает: отдел — офис, объект — площадка, и учётка работает либо там,
  // либо там. Проверка на форме, а не только на сервере: иначе несовместимый набор дошёл бы до
  // 400 без указания поля.
  .refine((v) => v.constructionObjectIds.length === 0 || v.departmentIds.length === 0, {
    message: 'Учётка работает либо на объектах, либо в отделах — не одновременно',
    path: ['departmentIds'],
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
  /** Полный список объектов; отсутствие поля — не трогать привязки (как у operatorIds объекта). */
  constructionObjectIds: constructionObjectIdsSchema.optional(),
  /** Полный список отделов; отсутствие поля — не трогать привязки (ADR 0040). */
  departmentIds: departmentIdsSchema.optional(),
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

/** Объект в карточке учётки: столько, сколько нужно для показа и повторного выбора. */
export interface UserObjectRefDto {
  id: string;
  code: string;
  name: string;
}

/** Отдел в карточке учётки — вторая ось области, той же формы (ADR 0040). */
export interface UserDepartmentRefDto {
  id: string;
  code: string;
  name: string;
}

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
  /** Объекты учётки (ADR 0039); порядок — по наименованию. Пусто — область объектами не задана. */
  constructionObjects: UserObjectRefDto[];
  /** Отделы учётки (ADR 0040); непусты только у ролей отдела — вместе с объектами не бывают. */
  departments: UserDepartmentRefDto[];
  counterpartyId: string | null;
  counterpartyName: string | null;
  /** Тип контрагента: у внешнего исполнителя им заданы модуль и набор прав (ADR 0038). */
  counterpartyType: CounterpartyType | null;
  /**
   * Учётка в архиве: удалённый сотрудник или отклонённая заявка. В списке появляется только по
   * `includeDeleted`, и строку нужно чем-то пометить — иначе архивная запись читается как живая.
   */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
