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
import { emailSchema } from './email';
import { passwordIdentityIssue, passwordSchema, PASSWORD_MAX } from './password';
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
    /**
     * Сообщить ли человеку, что для него завели учётную запись. Просьба, а не команда: письмо
     * уходит только активной учётке — звать в портал, который не пустит, хуже молчания.
     */
    notifyUser: z.boolean().optional().default(true),
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
/** Тело запроса до умолчаний: клиенту незачем присылать то, что схема проставит сама. */
export type CreateUserBody = z.input<typeof createUserSchema>;

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
    /**
     * Эта правка — рассмотрение заявки на регистрацию, а не обычное сохранение карточки.
     *
     * Намерение объявляется, а не выводится сервером из тела запроса. Без него два администратора,
     * открывшие одну заявку, оба бы её «одобрили»: второй, дождавшись первого, переписал бы его
     * решение о роли и области и оставил бы в журнале лишнюю запись. С объявленным намерением
     * сервер сверяет его с состоянием строки под блокировкой и отвечает второму конфликтом.
     *
     * Умолчание обратное остальным флагам — `false`: одобрение объявляют, а не получают по
     * умолчанию.
     */
    approveRegistration: z.boolean().optional().default(false),
    /** Сообщить ли человеку о выданном доступе; учитывается только при рассмотрении заявки. */
    notifyUser: z.boolean().optional().default(true),
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
export type UpdateUserBody = z.input<typeof updateUserSchema>;

export const setUserPasswordSchema = z.object({
  newPassword: passwordSchema,
});

/**
 * Смена адреса учётной записи администратором (ADR 0092).
 *
 * Отдельной схемой и отдельной ручкой, а не полем правки карточки: адрес — это логин, и смена
 * тянет за собой отзыв сессий, гашение живых ссылок из писем и два уведомления. Приехав «ещё
 * одним полем формы», всё это происходило бы мимоходом при сохранении телефона.
 *
 * `currentPassword` спрашивается ровно в одном случае — когда администратор меняет адрес **себе**:
 * подтверждение паролем удостоверяет, что за клавиатурой владелец учётки, а не тот, кому досталась
 * оставленная открытой сессия. Обязательность проверяет сервер: он один знает, чья это учётка.
 */
export const changeUserEmailSchema = z
  .object({
    newEmail: emailSchema,
    currentPassword: z.string().min(1).max(PASSWORD_MAX).optional(),
  })
  .strict();
export type ChangeUserEmailInput = z.infer<typeof changeUserEmailSchema>;
export type ChangeUserEmailBody = z.input<typeof changeUserEmailSchema>;

/**
 * Что стало с письмом операции: его либо не требовалось, либо поставили в очередь, либо почта
 * выключена.
 *
 * Булев флаг здесь не годится: «письма не было, потому что администратор так решил» и «письмо не
 * ушло, хотя его ждали» — разные новости, а внешне одинаковы. Портал по этому значению выбирает,
 * что сказать после сохранения, и `mail_disabled` он обязан произнести вслух: иначе администратор
 * уйдёт уверенным, что человека предупредили.
 */
export const MAIL_OUTCOMES = ['not_requested', 'queued', 'mail_disabled'] as const;
export type MailOutcome = (typeof MAIL_OUTCOMES)[number];

/**
 * Отказ по заявке на регистрацию: причина попадает в аудит, учётка уходит в soft delete.
 *
 * Полей причины два, и они не дублируют друг друга. `reason` — служебная запись для разбора внутри
 * («дубль, человек уже заведён под другим адресом»), она видна только в аудите портала.
 * `applicantMessage` — то, что прочитает сам заявитель. Одно общее поле заставляло бы писать
 * обтекаемо, и запись в аудите перестала бы отвечать на вопрос, почему доступ не дали.
 */
export const rejectUserSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
    /**
     * Сообщить ли заявителю. По умолчанию да: человек ждёт ответа. Снимают его на регистрациях
     * ботов и явном мусоре — обязательное письмо превратило бы уборку очереди заявок в рассылку
     * по случайным адресам.
     */
    notifyApplicant: z.boolean().optional().default(true),
    /** Текст письма. Обязателен ровно тогда, когда письмо просят; иначе игнорируется. */
    applicantMessage: z.string().trim().min(3).max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.notifyApplicant && !v.applicantMessage) {
      ctx.addIssue({
        code: 'custom',
        message: 'Напишите ответ заявителю или снимите отметку об отправке письма',
        path: ['applicantMessage'],
      });
    }
  });
export type RejectUserInput = z.infer<typeof rejectUserSchema>;
export type RejectUserBody = z.input<typeof rejectUserSchema>;

/** Результат отказа: письма могло и не быть, и портал должен сказать об этом честно. */
export interface RejectUserResult {
  ok: true;
  notified: MailOutcome;
}

/**
 * Результат создания и правки учётки. Голый `UserDto` больше не годится: у обеих операций есть
 * второй исход — письмо о выданном доступе, — и портал не может о нём умолчать. Поле лежит рядом
 * с карточкой, а не внутри неё: это исход операции, а не свойство учётной записи.
 */
export interface UserMutationResult {
  user: UserDto;
  notified: MailOutcome;
}

/**
 * Результат смены адреса (ADR 0092). Исходов отправки два, потому что письма два и уходят они на
 * разные ящики: сообщить человеку новый логин и предупредить прежний ящик — разные новости, и
 * «письма отправлены» одним словом скрыло бы, что одно из них не ушло.
 *
 * `shadowsArchived` — новый адрес занят архивной учёткой. Смене это не мешает (архив адрес не
 * занимает, ADR 0063), но у архивной с этого момента нет пути назад: восстановление требует
 * свободного адреса. Администратор узнаёт об этом в момент решения, а не через полгода при
 * попытке восстановить.
 */
export interface ChangeEmailResult {
  user: UserDto;
  notifiedNew: MailOutcome;
  notifiedOld: MailOutcome;
  shadowsArchived: boolean;
}

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

/**
 * Карточка работника, к которой привязана учётная запись (ADR 0102).
 *
 * Ссылка, а не копия справочника: списку учёток нужно показать, кем именно закрыт водитель, и
 * предупредить, что карточка ушла в архив, — восстановить учётку с такой уже нельзя, нужен другой
 * работник. Всё остальное о человеке спрашивают у справочника, где оно и живёт.
 */
export interface UserPersonRefDto extends PersonNameParts {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  /** Карточка в архиве: учётка водителя с такой не восстанавливается. */
  deletedAt: string | null;
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

/**
 * Учётка вместе с привязанным работником. Отдельный тип, а не поле в `UserDto`: связь с карточкой
 * есть только у части учёток (у водителя она обязательна, у остальных — по желанию), и списки, где
 * человек не нужен, не должны платить за него запросом.
 */
export interface UserAccountDto extends UserDto {
  person: UserPersonRefDto | null;
}
