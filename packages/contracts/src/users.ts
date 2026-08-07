import { z } from 'zod';
import {
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  roleLabels,
  roleSchema,
  type Role,
} from './enums';
import {
  incompatibleAddon,
  roleAddonLabels,
  roleAddonsSchema,
  ROLE_ADDON_BASE_ROLES,
  type RoleAddon,
} from './role-addons';
import type { CounterpartyType } from './counterparties';
import { baseListQuery, dateOnlySchema, optionalPhoneSchema, uuidSchema } from './common';
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

/**
 * Почему набор надстроек не годится этой роли (ADR 0086) — одним текстом на форму и на сервер.
 *
 * Сообщение называет виноватую надстройку и роли, которым она положена: «сохранить не вышло» без
 * имени читается как отказ всей карточки, а список надстроек в портале один на все роли, и почему
 * именно эта не подошла, из формы не видно.
 */
export function roleAddonIssue(
  role: Role | null | undefined,
  addons: readonly RoleAddon[],
): string | null {
  const bad = incompatibleAddon(role, addons);
  if (!bad) return null;
  const allowed = ROLE_ADDON_BASE_ROLES[bad].map((r) => `«${roleLabels[r]}»`).join(' или ');
  return role
    ? `Надстройка «${roleAddonLabels[bad]}» не прикрепляется к роли «${roleLabels[role]}»: она для ${allowed}`
    : `Надстройка «${roleAddonLabels[bad]}» выдаётся вместе с ролью — сначала назначьте ${allowed}`;
}

export const createUserSchema = z
  .object({
    email: z.string().email().max(255),
    ...personNameFields,
    /** Телефон учётки (ADR 0043): необязателен и здесь — контакт сотрудника, а не реквизит входа. */
    phone: optionalPhoneSchema.optional().default(''),
    role: roleSchema,
    password: passwordSchema,
    isActive: z.boolean().default(true),
    constructionObjectIds: constructionObjectIdsSchema.optional().default([]),
    departmentIds: departmentIdsSchema.optional().default([]),
    /**
     * Надстройки роли (ADR 0086): набор дополнительных прав поверх роли, область он не меняет
     * (Р4). Полным списком, как объекты и отделы, — сервер синхронизирует набор.
     */
    addons: roleAddonsSchema.optional().default([]),
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
  })
  // Надстройка прикрепляется не к любой роли (ADR 0086, `ROLE_ADDON_BASE_ROLES`): «Оператор
  // (оргтехника)» на арендодателе ТС — доступ, которого никто не назначал. На форме, а не только
  // на сервере, по той же причине, что и остальные пары «роль ↔ набор»: иначе ошибка придёт общим
  // 400 без указания поля.
  .superRefine((v, ctx) => {
    const issue = roleAddonIssue(v.role, v.addons);
    if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['addons'] });
  });
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    ...personNamePartialFields,
    /** Отсутствие поля — не трогать телефон; пустая строка — стереть (номер сменился на «не знаю»). */
    phone: optionalPhoneSchema.optional(),
    role: roleSchema.optional(),
    isActive: z.boolean().optional(),
    /** Полный список объектов; отсутствие поля — не трогать привязки (как у operatorIds объекта). */
    constructionObjectIds: constructionObjectIdsSchema.optional(),
    /** Полный список отделов; отсутствие поля — не трогать привязки (ADR 0040). */
    departmentIds: departmentIdsSchema.optional(),
    /** Полный список надстроек; отсутствие поля — не трогать выданные (ADR 0086). */
    addons: roleAddonsSchema.optional(),
    counterpartyId: uuidSchema.nullish(),
  })
  // Совместимость сверяется только когда в правке есть и роль, и набор: иначе судить не о чем —
  // недостающую половину знает лишь сервер, и он же отвечает 400 по итоговому состоянию учётки.
  // Смена роли на несовместимую при живой надстройке отсюда не видна намеренно: молча снимать
  // доступ нельзя, и отказ приходит с сервера.
  .superRefine((v, ctx) => {
    if (v.role === undefined || v.addons === undefined) return;
    const issue = roleAddonIssue(v.role, v.addons);
    if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['addons'] });
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
   * Контактный телефон (ADR 0043). Пусто — не указан: поле необязательное, и заполнено оно
   * далеко не у всех. Свободный текст того же вида, что телефон ответственного по заявке.
   */
  phone: string;
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
  /**
   * Когда человек подтвердил адрес по ссылке из письма (ADR 0072); `null` — не подтверждён, и
   * активировать такую заявку нельзя. У учёток, заведённых администратором, стоит время создания:
   * адрес вводил он сам.
   */
  emailVerifiedAt: string | null;
  /** Объекты учётки (ADR 0039); порядок — по наименованию. Пусто — область объектами не задана. */
  constructionObjects: UserObjectRefDto[];
  /** Отделы учётки (ADR 0040); непусты только у ролей отдела — вместе с объектами не бывают. */
  departments: UserDepartmentRefDto[];
  /**
   * Надстройки роли (ADR 0086) — кодами, а не подписями: подпись у надстройки одна на портал
   * (`roleAddonLabels`), и вторая её копия в ответе сервера разошлась бы с первой. Пустой массив —
   * надстроек нет; список учёток по нему решает, рисовать ли пометку рядом с ролью.
   */
  addons: RoleAddon[];
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
