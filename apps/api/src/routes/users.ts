import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import {
  can,
  type ChangeEmailResult,
  changeUserEmailSchema,
  type CounterpartyType,
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  counterpartyTypeHasAccounts,
  counterpartyTypeLabels,
  createUserSchema,
  EMAIL_VERIFICATION_ENABLED,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isPersonScopedRole,
  permissionsFor,
  rejectUserSchema,
  retiringRoleIssue,
  roleAddonIssue,
  roleLabels,
  setUserPasswordSchema,
  updateUserSchema,
  userListQuerySchema,
  type MailOutcome,
  type Permission,
  type RoleAddon,
  type UserDto,
  type UserAccountDto,
  type UserPersonRefDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  counterparties,
  personEmployments,
  persons,
  userConstructionObjects,
  users,
} from '../db/schema';
import { config } from '../config';
import { queueMail, type MailKind } from '../services/mail';
import { maskEmail, type MailContent } from '../services/mail-templates';
import {
  ACCOUNT_CREATED_SUBJECT,
  accountCreatedContent,
  EMAIL_CHANGED_SUBJECT,
  emailChangedContent,
  emailChangedNoticeContent,
  REGISTRATION_APPROVED_SUBJECT,
  REGISTRATION_REJECTED_SUBJECT,
  registrationApprovedContent,
  registrationRejectedContent,
} from '../services/mail-auth';
import { revokeEmailTokens } from '../services/email-tokens';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { hashPassword, verifyPassword } from '../auth/password';
import { revokeAllForUser } from '../auth/sessions';
import { orderByFrom, pageParams, phoneSearchCondition, searchCondition } from '../lib/pagination';
import {
  addonsOfUser,
  departmentIdsOfUser,
  departmentsByUserIds,
  grantCodesByUserIds,
  grantPermissionsByUserIds,
  objectIdsOfUser,
  objectsByUserIds,
  replaceUserAddons,
  replaceUserDepartments,
  replaceUserObjects,
  systemAddonsOf,
} from '../services/user-scopes';
import { assertEmailFree, asEmailConflict } from '../services/user-email';
import { userAuditChanges } from '../services/user-audit-diff';
import { registerPurgeRoute } from '../services/directory-purge';

const idParams = z.object({ id: z.string().uuid() });

/**
 * Работник учётки в теле запроса (ADR 0102). Общая часть заведения и правки: у роли «Водитель»
 * человек обязателен (Р2), у остальных ролей связь справочная и ни на что не влияет.
 *
 * `null` и отсутствие поля — разные просьбы: первое снимает связь, второе её не трогает.
 * Различать их обязательно — отвязка живой водительской учётки запрещена (Р6), и «не прислали
 * поле» не должно читаться как «отвяжите».
 */
const driverPersonFields = {
  personId: z.string().uuid().nullish(),
  /**
   * «Это один человек» — подтверждение расхождения ФИО (Р30). Смена фамилии дело обычное,
   * случайный однофамилец — редкое, и различить их может только человек: молчаливая привязка
   * отдала бы заявителю чужие задания вместе с телефонами заказчиков.
   */
  confirmNameMismatch: z.boolean().optional().default(false),
};

const createUserBodySchema = createUserSchema.extend(driverPersonFields);
const updateUserBodySchema = updateUserSchema.extend(driverPersonFields);

/**
 * Тело восстановления из архива (Р8). Необязательно: у всех учёток, кроме водительских без
 * человека, восстановление ничего не спрашивает — и заставлять портал слать пустой объект ради
 * одного случая незачем.
 */
const restoreUserSchema = z
  .object({
    personId: z.string().uuid().optional(),
    confirmNameMismatch: z.boolean().optional().default(false),
  })
  .strict()
  .optional();

const personCandidatesQuerySchema = z
  .object({
    /** Что набрал администратор: часть ФИО, адрес или цифры телефона. */
    query: z.string().trim().max(100).optional(),
    /** Учётка, которой ищут работника: по её приметам собирается подсказка (Р30). */
    userId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Сколько кандидатов показывать. Десять — это ровно тот список, который человек прочитает
 * глазами: подсказка помогает узнать своего работника, а не заменяет справочник, и длинная
 * выдача превратила бы выбор в пролистывание с той же вероятностью ошибки.
 */
const PERSON_CANDIDATE_LIMIT = 10;

/** Транзакция drizzle: письмо о доступе ставится вместе с решением, ради которого отправляется. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Поставить письмо о решении по учётной записи и назвать исход отправки.
 *
 * Три письма — отказ, одобрение, заведение учётки — отличаются только содержимым, а правило
 * отправки у них одно, и живёт оно здесь, а не трижды в маршрутах. Правило такое: письма не было,
 * потому что его не просили; письмо поставлено; письмо просили, но почта выключена. Последний
 * случай нельзя проглотить молча — администратор уйдёт уверенным, что человека предупредили, —
 * и нельзя превратить в отказ: решение по учётке административное и от состояния почтового
 * контура зависеть не должно.
 *
 * Содержимое строится лениво: при выключенной почте собирать его незачем, а сборка письма о
 * доступе ещё и проверяет адрес портала (`assertOwnOrigin`) и падала бы на неверном
 * `PUBLIC_ORIGIN` там, где письма всё равно не будет.
 */
async function queueAccessMail(
  tx: Tx,
  input: {
    requested: boolean;
    kind: MailKind;
    dedupeKey: string;
    to: string;
    subject: string;
    content: () => MailContent;
    userId: string;
  },
): Promise<MailOutcome> {
  if (!input.requested) return 'not_requested';
  if (!config.mail.enabled) return 'mail_disabled';
  await queueMail(
    {
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      to: input.to,
      subject: input.subject,
      content: input.content(),
      userId: input.userId,
      entityType: 'user',
      entityId: input.userId,
    },
    { tx },
  );
  return 'queued';
}

/**
 * Заявка на регистрацию: учётка, которую завёл сам пользователь и которую администратор ещё не
 * рассмотрел. Отличается от деактивированной именно отсутствием роли — роль назначают вместе с
 * активацией, а саморегистрация её не ставит (ADR 0034).
 */
const unreviewedRegistration = and(eq(users.isActive, false), isNull(users.role));

/**
 * То же среди действующих записей — для счётчика и для списка без архива. Отклонённая заявка
 * ушла в soft delete и в очереди не висит, но остаётся заявкой: с `includeDeleted` список
 * показывает и её, поэтому признак «удалена» стоит отдельным условием, а не внутри этого.
 */
const pendingRegistration = and(isNull(users.deletedAt), unreviewedRegistration);

/**
 * Работник, которому принадлежит учётка (ADR 0008). У роли «Водитель» связь обязательна и держится
 * CHECK `users_driver_person_check` (ADR 0102, Р2): кабинет отвечает на вопросы про человека —
 * какое у него задание, на какой машине он работал, — и без карточки не ответит ни на один.
 *
 * ФИО и телефон здесь не дублируют поля учётки, а показывают вторую сторону пары: после привязки
 * владелец этих полей — справочник (Р31), и форма учётки обязана показать расхождение, а не
 * молча выбрать, чьё значение правдивее.
 */
interface UserRowJoined {
  id: string;
  email: string;
  lastName: string;
  firstName: string;
  middleName: string;
  fullName: string;
  phone: string;
  requestedRole: UserDto['requestedRole'];
  requestedObject: string;
  requestedCompany: string;
  requestedComment: string;
  role: UserDto['role'];
  isActive: boolean;
  mustChangePassword: boolean;
  emailVerifiedAt: Date | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  counterpartyType: CounterpartyType | null;
  personId: string | null;
  personLastName: string | null;
  personFirstName: string | null;
  personMiddleName: string | null;
  personFullName: string | null;
  personPhone: string | null;
  personEmail: string | null;
  personDeletedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Работник строки. Проверяется `personFullName`, а не `personId`: связь объявлена
 * `ON DELETE SET NULL` без типизированного FK (цикл `users` ↔ `persons`), и одного
 * идентификатора мало, чтобы утверждать, что карточка нашлась.
 */
function personRefOf(r: UserRowJoined): UserPersonRefDto | null {
  if (!r.personId || r.personFullName === null) return null;
  return {
    id: r.personId,
    lastName: r.personLastName ?? '',
    firstName: r.personFirstName ?? '',
    middleName: r.personMiddleName ?? '',
    fullName: r.personFullName,
    phone: r.personPhone ?? '',
    email: r.personEmail ?? '',
    deletedAt: r.personDeletedAt?.toISOString() ?? null,
  };
}

/**
 * Карточка учётки из прочитанного: строка плюс наборы, посчитанные пачкой.
 *
 * Наборы приходят сюда **кодами и правами**, а не готовыми полями ответа, потому что все три поля
 * доступа выводятся из них одним и тем же способом и обязаны быть согласованы между собой: пометки
 * рядом с ролью — пересечение кодов с системными (`systemAddonsOf`), колонка «наборы» — сами коды,
 * список прав — `permissionsFor` от субъекта. Собери их врозь у карточки и у списка — и два ответа
 * на один вопрос разошлись бы в первую же правку.
 *
 * **Субъект собирается здесь целиком, и обрезать его нельзя** (ADR 0106, решение 5): роль, тип
 * контрагента, надстройки, права наборов. Недостающий источник выглядел бы не ошибкой, а просто
 * более коротким списком прав — то есть витрина показывала бы «этого он не может» там, где сервер
 * разрешает. Тип контрагента здесь особенно легко потерять: у роли внешнего исполнителя весь его
 * модуль приходит именно от типа (ADR 0038), а роль без типа отвечает за одно `directories.read`.
 */
function toDto(
  r: UserRowJoined,
  objects: UserDto['constructionObjects'],
  departments: UserDto['departments'],
  grantCodes: string[],
  grantPermissions: Permission[],
): UserAccountDto {
  const addons = systemAddonsOf(grantCodes);
  return {
    id: r.id,
    email: r.email,
    lastName: r.lastName,
    firstName: r.firstName,
    middleName: r.middleName,
    fullName: r.fullName,
    phone: r.phone,
    requestedRole: r.requestedRole,
    requestedObject: r.requestedObject,
    requestedCompany: r.requestedCompany,
    requestedComment: r.requestedComment,
    role: r.role,
    isActive: r.isActive,
    mustChangePassword: r.mustChangePassword,
    emailVerifiedAt: r.emailVerifiedAt?.toISOString() ?? null,
    constructionObjects: objects,
    departments,
    addons,
    grantCodes,
    /*
     * Эффективные права учётки (план реструктуризации §12, этап 2б): считает их сервер, потому что
     * витрина больше не может — состав набора лежит в базе, а не в матрице.
     *
     * **Порядок словарный (`PERMISSIONS`), и это часть контракта, а не побочный эффект.** Его задаёт
     * сам `permissionsFor` — `PERMISSIONS.filter(…)`, — и здесь список не переупорядочивается ни
     * алфавитом, ни ответом базы: витрина сравнивает наборы прав между учётками, и нестабильный
     * порядок давал бы разный ответ на одинаковый состав.
     *
     * Копия, а не `readonly` из контрактов: это тело ответа, и держать в нём ссылку на массив,
     * который вернула матрица, незачем.
     */
    permissions: [
      ...permissionsFor({
        role: r.role,
        counterpartyType: r.counterpartyType,
        addons,
        grantPermissions,
      }),
    ],
    counterpartyId: r.counterpartyId,
    counterpartyName: r.counterpartyName,
    counterpartyType: r.counterpartyType,
    person: personRefOf(r),
    deletedAt: r.deletedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const selectCols = {
  id: users.id,
  email: users.email,
  lastName: users.lastName,
  firstName: users.firstName,
  middleName: users.middleName,
  fullName: users.fullName,
  phone: users.phone,
  requestedRole: users.requestedRole,
  requestedObject: users.requestedObject,
  requestedCompany: users.requestedCompany,
  requestedComment: users.requestedComment,
  role: users.role,
  isActive: users.isActive,
  mustChangePassword: users.mustChangePassword,
  emailVerifiedAt: users.emailVerifiedAt,
  counterpartyId: users.counterpartyId,
  counterpartyName: counterparties.name,
  counterpartyType: counterparties.type,
  personId: users.personId,
  personLastName: persons.lastName,
  personFirstName: persons.firstName,
  personMiddleName: persons.middleName,
  personFullName: persons.fullName,
  personPhone: persons.phone,
  personEmail: persons.email,
  personDeletedAt: persons.deletedAt,
  deletedAt: users.deletedAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

function usersQuery() {
  return (
    db
      .select(selectCols)
      .from(users)
      .leftJoin(counterparties, eq(users.counterpartyId, counterparties.id))
      // Карточка работника — тем же запросом, что и контрагент, и по той же причине: список учёток
      // должен различать водителя с привязкой и водителя без неё, не спрашивая справочник построчно.
      .leftJoin(persons, eq(users.personId, persons.id))
  );
}

/**
 * Карточка учётки всегда идёт с областью: клиент правит набор, а не отдельные привязки.
 *
 * Пометки рядом с ролью, коды наборов и список прав читаются из назначенных полномочий (ADR 0106,
 * шаг 1c) — тем же источником, которым считается доступ. Второй ответ на «что учётке выдано»
 * разошёлся бы с первым в тот же момент, когда таблицы перехода разъедутся, и карточка показывала бы
 * не то, чем человек работает.
 *
 * Читается всё **пачкой на одну учётку** — теми же функциями, что и список: карточка и строка списка
 * обязаны отвечать одинаково, а два разных чтения одного и того же расходятся ровно тогда, когда
 * правят одно из них.
 */
async function fetchUserDto(id: string): Promise<UserAccountDto | null> {
  const [row] = await usersQuery().where(eq(users.id, id));
  if (!row) return null;
  const [objects, departments, grantCodes, grantPermissions] = await Promise.all([
    objectsByUserIds([id]),
    departmentsByUserIds([id]),
    grantCodesByUserIds(db, [id]),
    grantPermissionsByUserIds(db, [id]),
  ]);
  return toDto(
    row,
    objects.get(id) ?? [],
    departments.get(id) ?? [],
    grantCodes.get(id) ?? [],
    grantPermissions.get(id) ?? [],
  );
}

/**
 * Контрагент учётки (ADR 0010, 0038). Для внешнего исполнителя он обязателен и задаёт сразу
 * две вещи: чьи заявки видны и в каком модуле учётка работает — модуль следует из типа
 * контрагента (оператор вывоза ведёт вывоз, арендодатель ТС — заказ техники).
 *
 * Годятся только типы, за которых в портале кто-то работает (`COUNTERPARTY_TYPES_WITH_ACCOUNTS`,
 * выводятся из матрицы прав): учётка на генподрядчике не получила бы ни одного модульного права
 * и вошла бы в портал, где ей нечего делать. Для остальных ролей поле пустое — область видимости
 * у них задаётся иначе (объект у «Штаба») или не ограничена.
 */
async function resolveCounterpartyId(
  role: UserDto['role'],
  counterpartyId: string | null | undefined,
): Promise<string | null> {
  if (!isCounterpartyScopedRole(role)) return null;
  if (!counterpartyId) {
    throw err.badRequest(`Для роли «${roleLabels[role!]}» обязателен контрагент`, {
      counterpartyId: 'Выберите контрагента',
    });
  }
  const [cp] = await db
    .select({
      type: counterparties.type,
      isActive: counterparties.isActive,
      deletedAt: counterparties.deletedAt,
    })
    .from(counterparties)
    .where(eq(counterparties.id, counterpartyId));
  if (!cp || cp.deletedAt) throw err.badRequest('Контрагент не найден');
  if (!counterpartyTypeHasAccounts(cp.type)) {
    const allowed = COUNTERPARTY_TYPES_WITH_ACCOUNTS.map(
      (t) => `«${counterpartyTypeLabels[t]}»`,
    ).join(' или ');
    throw err.badRequest(`Учётку исполнителя можно привязать к контрагенту типа ${allowed}`, {
      counterpartyId: `Нужен контрагент типа ${allowed}`,
    });
  }
  if (!cp.isActive) throw err.badRequest('Контрагент неактивен');
  return counterpartyId;
}

/**
 * Объекты учётки (ADR 0039). Инвариант «объектной роли обязателен объект» держится здесь:
 * с переходом на множественную привязку CHECK `users_rukstroy_object_check` снят — он читал
 * колонку своей строки, а набор лежит в отдельной таблице (миграция 0063).
 *
 * У остальных ролей набор пуст, как и контрагент: область у них задана иначе или не ограничена,
 * а привязка, ни на что не влияющая, в карточке читается как действующее ограничение.
 */
function resolveObjectIds(role: UserDto['role'], objectIds: string[]): string[] {
  if (!isObjectScopedRole(role)) return [];
  if (objectIds.length === 0) {
    throw err.badRequest(`Для роли «${roleLabels[role!]}» обязателен объект`, {
      constructionObjectIds: 'Укажите хотя бы один объект',
    });
  }
  return objectIds;
}

/**
 * Отделы учётки (ADR 0040) — вторая ось области, по тому же правилу, что объекты. Пустой набор
 * у остальных ролей означает и второй инвариант: объекты и отделы вместе не встречаются, потому
 * что роль работает ровно на одной оси — обнулением набора чужой оси он и держится.
 *
 * В БД это не выражается: CHECK читает колонки своей строки, а наборы лежат в двух отдельных
 * таблицах. Отсюда же требование к клиенту не присылать оба набора — оно проверяется схемой
 * (`createUserSchema`), чтобы ошибка указала на поле, а не пришла общим 400.
 */
function resolveDepartmentIds(role: UserDto['role'], departmentIds: string[]): string[] {
  if (!isDepartmentScopedRole(role)) return [];
  if (departmentIds.length === 0) {
    throw err.badRequest(`Для роли «${roleLabels[role!]}» обязателен отдел`, {
      departmentIds: 'Укажите хотя бы один отдел',
    });
  }
  return departmentIds;
}

/**
 * Надстройки учётки (ADR 0086) — третья ось субъекта доступа, а не третья ось области: набор
 * обнулять по роли, как это делают `resolve*` выше, здесь нечего. Проверяется одно — что каждая
 * надстройка прикрепляется к этой роли (`ROLE_ADDON_BASE_ROLES`).
 *
 * Сверяется **итоговое** состояние учётки: и присланный набор с присланной ролью, и оставшийся от
 * прежней правки набор с новой ролью. Поэтому смена роли на несовместимую при живой надстройке —
 * 400, а не тихое снятие: снять доступ молча значило бы отобрать его так, что этого никто не
 * заметит, и администратор снимает надстройку явно.
 */
/**
 * Упраздняемая роль больше не назначается — закрытый вход шага prepare (план §13.2, ADR 0113).
 *
 * Проверка стоит здесь, а не в схеме запроса, ровно потому, что решает не значение, а **переход**:
 * `shtab` в теле правки означает «оставить как было» у действующего штаба и «завести нового» у
 * всех остальных, и запретить надо только второе. Схема различить их не может — она не видит
 * прежней строки.
 *
 * Зачем это в релизе, который никого не переводит: между выдачей замещающих наборов (миграции 0155
 * и 0156) и самим переводом проходит релиз, и всё это время работающая версия старую роль знает.
 * Заведи она нового «штаба» — перевод, который идёт по снимку, о нём не узнает, а `UPDATE` молча
 * отберёт у человека заказ техники.
 */
function assertRoleAssignable(next: UserDto['role'], current: UserDto['role']): void {
  const issue = retiringRoleIssue(next, current);
  if (issue) throw err.badRequest(issue, { role: issue });
}

function resolveAddons(role: UserDto['role'], addons: RoleAddon[]): RoleAddon[] {
  // Дубль убирается здесь, а не только при записи: этот же набор уходит в журнал, и «выдано
  // дважды» рассказывало бы о клиенте, а не о правах учётки.
  const next = [...new Set(addons)];
  const issue = roleAddonIssue(role, next);
  if (issue) throw err.badRequest(issue, { addons: issue });
  return next;
}

/**
 * Пусто — это пустая строка, а не NULL: и `users`, и `persons` хранят отчество, телефон и адрес
 * именно так. От этого зависит правило дозаполнения (Р31), поэтому проверка одна на все поля.
 */
const isBlank = (v: string): boolean => v.trim() === '';

/**
 * Одно ли это имя. Сравнение без регистра и лишних пробелов: «иванов » и «Иванов» — один человек,
 * и требовать за такое различие подтверждения администратора значило бы приучить его ставить
 * галочку не глядя — ровно там, где она единственная защита от однофамильца.
 */
const sameName = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase('ru') === b.trim().toLocaleLowerCase('ru');

/** Учётка глазами привязки: то, с чем сверяется карточка работника (Р30, Р31). */
interface AccountFacts {
  /** `null` — учётку только заводят: занятость работника считается без исключения по себе. */
  id: string | null;
  lastName: string;
  firstName: string;
  middleName: string;
  phone: string;
  email: string;
}

/** Что дала привязка: кого поставить, что дозаполнить в учётке и что записать в журнал. */
interface PersonBinding {
  personId: string | null;
  /** Поля учётки, взятые из карточки: применяются тем же UPDATE, что и сама привязка. */
  userFields: { middleName?: string; phone?: string };
  /** Что и куда перенесено — единственный след молчаливого дозаполнения (Р31). */
  filled: Record<string, 'user' | 'person'>;
  /** Расхождение ФИО подтверждено администратором (Р30): факт подтверждения идёт в журнал. */
  nameMismatchConfirmed: boolean;
}

/**
 * Работник учётки (ADR 0102): проверка выбора и перенос недостающих полей — одним местом на
 * заведение, правку и восстановление из архива.
 *
 * Обязательность здесь ровно та же, что в CHECK `users_driver_person_check` (Р2), а не мягче:
 * живая учётка водителя без карточки не ответит ни на один вопрос кабинета, а обнаружится это в
 * шесть утра, когда человек полез смотреть задание.
 *
 * Отвязки живой водительской учётки не бывает (Р6): ошибочно привязанного **заменяют** одним
 * действием, потому что между шагами «отвязать» и «привязать» строка нарушала бы CHECK, а
 * транзакция из двух запросов портала не гарантируется ничем. Отвязка допустима только вместе со
 * сменой роли — тогда условие снимается само.
 */
async function resolvePersonBinding(
  tx: Tx,
  input: {
    /** Роль после правки: обязательность работника считается по ней, а не по прежней. */
    role: UserDto['role'];
    /** Работник до правки; `null` у новой учётки. */
    currentPersonId: string | null;
    /** Присланный работник: `undefined` — поле не трогали, `null` — просят отвязать. */
    personId: string | null | undefined;
    account: AccountFacts;
    confirmNameMismatch: boolean;
    actorId: string;
  },
): Promise<PersonBinding> {
  const { account } = input;
  const nextPersonId = input.personId !== undefined ? input.personId : input.currentPersonId;
  const unchanged: PersonBinding = {
    personId: nextPersonId,
    userFields: {},
    filled: {},
    nameMismatchConfirmed: false,
  };
  if (!nextPersonId) {
    if (isPersonScopedRole(input.role)) {
      throw err.badRequest(`Для роли «${roleLabels.driver}» обязателен работник справочника`, {
        personId: 'Выберите работника',
      });
    }
    return unchanged;
  }
  // Тот же работник — сверять нечего. Повторная сверка при каждом сохранении карточки затирала бы
  // правки кадров: после привязки владелец ФИО и телефона — справочник (Р31), и учётка их не
  // переписывает, даже когда администратор набрал в форме что-то своё.
  if (nextPersonId === input.currentPersonId) return unchanged;

  // Карточка читается под блокировкой: между проверкой «учётки на него нет» и записью связи
  // второй администратор успел бы завести свою, и от двух живых учёток на одного человека остался
  // бы только отказ частичного индекса пятисоткой.
  const [person] = await tx
    .select()
    .from(persons)
    .where(eq(persons.id, nextPersonId))
    .for('update');
  if (!person) {
    throw err.badRequest('Работник не найден в справочнике', {
      personId: 'Выберите работника из справочника',
    });
  }
  if (person.deletedAt) {
    throw err.badRequest('Карточка работника в архиве — восстановите её или выберите другого', {
      personId: 'Карточка работника в архиве',
    });
  }
  const [taken] = await tx
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.personId, nextPersonId),
        // Архивная учётка человека не занимает (ADR 0063): вернувшийся сотрудник иначе не получил
        // бы новой, а старую всё равно восстанавливают с человеком (Р8).
        isNull(users.deletedAt),
        account.id ? ne(users.id, account.id) : undefined,
      ),
    );
  if (taken) {
    throw err.badRequest(
      `На этого работника уже заведена учётная запись ${taken.email} — сначала заархивируйте её`,
      { personId: 'У работника уже есть учётная запись' },
    );
  }

  // Расхождение фамилии или имени — отдельный разговор (Р30), а не одно из полей сверки. Отчества
  // здесь нет намеренно: его пишут по-разному и часто не пишут вовсе, и подтверждение по нему
  // спрашивалось бы у половины привязок — то есть перестало бы что-либо значить.
  const nameMismatch =
    !sameName(person.lastName, account.lastName) || !sameName(person.firstName, account.firstName);
  if (nameMismatch && !input.confirmNameMismatch) {
    throw err.badRequest(
      `ФИО учётки (${account.lastName} ${account.firstName}) и карточки (${person.fullName}) различаются — подтвердите, что это один человек`,
      { confirmNameMismatch: 'Подтвердите, что это один человек' },
    );
  }

  // Дозаполнение (Р31): пусто с одной стороны — переносим молча, отметив в журнале; заполнено с
  // обеих и различается — не трогаем ничего, различие показывает форма. Фамилии и имени в переносе
  // нет: они обязательны с обеих сторон (CHECK `*_not_blank`), переносить там нечего, а различие
  // разбирается подтверждением выше.
  const userFields: PersonBinding['userFields'] = {};
  const personFields: { middleName?: string; phone?: string; email?: string } = {};
  const filled: PersonBinding['filled'] = {};
  if (isBlank(account.middleName) && !isBlank(person.middleName)) {
    userFields.middleName = person.middleName;
    filled.middleName = 'user';
  } else if (!isBlank(account.middleName) && isBlank(person.middleName)) {
    personFields.middleName = account.middleName;
    filled.middleName = 'person';
  }
  if (isBlank(account.phone) && !isBlank(person.phone)) {
    userFields.phone = person.phone;
    filled.phone = 'user';
  } else if (!isBlank(account.phone) && isBlank(person.phone)) {
    personFields.phone = account.phone;
    filled.phone = 'person';
  }
  // Адрес переносится только в карточку: владелец адреса — учётка (Р31), а на `persons.email`
  // шлёт письма рассылка «Задание водителю» — пустой адрес там означает, что задание не уйдёт
  // вовсе. Обратного переноса нет: адрес учётки это логин, и менять его привязкой нельзя.
  if (isBlank(person.email)) {
    personFields.email = account.email;
    filled.email = 'person';
  }

  if (Object.keys(personFields).length > 0) {
    await tx
      .update(persons)
      .set({
        ...personFields,
        updatedBy: input.actorId,
        // Версия карточки растёт: правку сделали мы, и открытая рядом карточка водителя должна
        // упереться в конфликт, а не сохраниться поверх перенесённого.
        version: person.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(persons.id, person.id));
  }

  return { personId: nextPersonId, userFields, filled, nameMismatchConfirmed: nameMismatch };
}

/**
 * Гонка двух привязок доходит до частичного UNIQUE `users_person_unique` — проверка выше её не
 * ловит: между `SELECT` и записью связь мог занять параллельный запрос. Без разбора `23505`
 * администратор получил бы 500 там, где ему нужно то же сообщение, что и при обычной занятости.
 */
function asPersonConflict(e: unknown): unknown {
  const pg = pgErrorOf(e);
  if (pg?.code === '23505' && pg.constraint === 'users_person_unique') {
    return err.conflict('На этого работника только что завели учётную запись — обновите список');
  }
  return e;
}

/**
 * Что рассказать журналу о привязке. Дозаполнение идёт молча (Р31), и запись здесь — единственный
 * его след: без неё «откуда у учётки взялся телефон» осталось бы вопросом без ответа. Подтверждение
 * расхождения ФИО (Р30) — по той же причине: решение принял человек, и оно должно быть названо.
 */
function bindingMetadata(binding: PersonBinding): Record<string, unknown> {
  return {
    ...(binding.personId ? { personId: binding.personId } : {}),
    ...(Object.keys(binding.filled).length > 0 ? { filledFields: binding.filled } : {}),
    ...(binding.nameMismatchConfirmed ? { nameMismatchConfirmed: true } : {}),
  };
}

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = { preHandler: [app.authenticate, app.requirePermission('users.manage')] };

  r.get('/', { ...guards, schema: { querystring: userListQuerySchema } }, async (req) => {
    const q = req.query;
    // Архив просит право `archive.read`, как и в остальных списках: право вести учётки и право
    // видеть удалённое — разные, и одно другого не подразумевает.
    const showDeleted = q.includeDeleted && can(requirePrincipal(req), 'archive.read');
    const where = and(
      showDeleted ? undefined : isNull(users.deletedAt),
      q.role === undefined ? undefined : eq(users.role, q.role),
      q.isActive === undefined ? undefined : eq(users.isActive, q.isActive),
      q.pending ? unreviewedRegistration : undefined,
      // Объект в наборе учётки (ADR 0039): EXISTS, а не join, — иначе строка размножилась бы по
      // числу объектов и `total` считал бы привязки вместо людей.
      q.constructionObjectId === undefined
        ? undefined
        : exists(
            db
              .select({ one: sql`1` })
              .from(userConstructionObjects)
              .where(
                and(
                  eq(userConstructionObjects.userId, users.id),
                  eq(userConstructionObjects.constructionObjectId, q.constructionObjectId),
                ),
              ),
          ),
      q.counterpartyId === undefined ? undefined : eq(users.counterpartyId, q.counterpartyId),
      q.requestedRole === undefined ? undefined : eq(users.requestedRole, q.requestedRole),
      // Дата регистрации — календарные сутки Europe/Moscow: `created_at` хранит момент времени, и
      // без явных границ дня «с 1 июля» отрезало бы утро первого числа по UTC.
      q.createdFrom === undefined
        ? undefined
        : gte(users.createdAt, new Date(`${q.createdFrom}T00:00:00.000+03:00`)),
      q.createdTo === undefined
        ? undefined
        : lte(users.createdAt, new Date(`${q.createdTo}T23:59:59.999+03:00`)),
      // Поиск идёт по трём полям сразу: адрес и ФИО — подстрокой как есть, телефон — по цифрам,
      // потому что записан он свободно и «9261234567» обязано находить «+7 926 123-45-67».
      or(
        searchCondition(q.search, [users.email, users.fullName]),
        phoneSearchCondition(q.search, users.phone),
      ),
    );
    const sortCols = {
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      counterpartyName: counterparties.name,
      isActive: users.isActive,
      createdAt: users.createdAt,
    };
    const p = pageParams(q);
    const [rows, totalRows] = await Promise.all([
      usersQuery()
        .where(where)
        .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'))
        .limit(p.limit)
        .offset(p.offset),
      db.select({ c: count() }).from(users).where(where),
    ]);
    const ids = rows.map((row) => row.id);
    // Пометки, коды наборов и права — из назначенных полномочий, как и в карточке: списком и по одной
    // учётке ответ обязан быть одним и тем же.
    //
    // Четыре запроса на страницу, а не на строку, и права здесь ничего к этому счёту не добавляют
    // сверх пятого: витрина «Права» перебирает живые учётки целиком — по ним считаются держатели
    // права, группировка по фактическому набору и пометка «только у администратора», — и запрос на
    // учётку превратил бы такой перебор в сотню обращений к базе.
    const [objects, departments, grantCodes, grantPermissions] = await Promise.all([
      objectsByUserIds(ids),
      departmentsByUserIds(ids),
      grantCodesByUserIds(db, ids),
      grantPermissionsByUserIds(db, ids),
    ]);
    return {
      items: rows.map((row) =>
        toDto(
          row,
          objects.get(row.id) ?? [],
          departments.get(row.id) ?? [],
          grantCodes.get(row.id) ?? [],
          grantPermissions.get(row.id) ?? [],
        ),
      ),
      total: Number(totalRows[0]!.c),
      page: p.page,
      pageSize: p.pageSize,
    };
  });

  /**
   * Счётчик для бейджа в меню. Отдельным маршрутом, а не полем в списке: бейдж рисуется на
   * каждой странице портала, и тянуть ради него страницу пользователей — лишний трафик.
   */
  r.get('/pending-count', guards, async () => {
    const [row] = await db.select({ c: count() }).from(users).where(pendingRegistration);
    return { count: Number(row!.c) };
  });

  /**
   * Кандидаты на привязку к учётке водителя (ADR 0102, Р30).
   *
   * Ручка живёт здесь, под `users.manage`, а не в справочнике водителей: справочник наружу не
   * отдаётся (§8 плана), а подсказка нужна ровно в форме учётки и отвечает десятком строк.
   *
   * Ищется двумя способами, и это не удобство. Пока администратор ничего не набрал, приметы
   * берутся из самой заявки: точный телефон и точный адрес стоят выше похожего ФИО, потому что
   * фамилия совпадает у однофамильцев, а номер и ящик — почти никогда. Набранный запрос подсказку
   * отменяет: его набрали как раз потому, что предложенное не подошло.
   *
   * Занятый человек в предложения не попадает: живая учётка на него уже есть
   * (`users_person_unique`), и выбрать его всё равно нельзя. Своя учётка не в счёт — она и есть
   * та, которую сейчас правят, и без исключения по себе поле показывало бы пустой список там, где
   * работник уже выбран.
   */
  r.get(
    '/person-candidates',
    { ...guards, schema: { querystring: personCandidatesQuerySchema } },
    async (req) => {
      const { query, userId } = req.query;
      const term = query?.trim() ?? '';
      const [account] = userId
        ? await db
            .select({ fullName: users.fullName, phone: users.phone, email: users.email })
            .from(users)
            .where(eq(users.id, userId))
        : [];
      // Ни запроса, ни учётки — искать не по чему: выдать «первых десятерых из справочника»
      // значило бы предложить привязать случайного человека.
      if (!term && !account) return { items: [] };

      // Совпадение примет: точный номер и точный адрес читаются как «это он», похожее ФИО — как
      // «посмотрите». Признаки считаются в запросе, а не в памяти: по ним же идёт порядок строк.
      const phoneMatch = sql<boolean>`${persons.phone} <> '' AND ${persons.phone} = ${account?.phone ?? ''}`;
      const emailMatch = sql<boolean>`${persons.email} <> '' AND ${persons.email} = ${account?.email ?? ''}`;
      // Похожесть ФИО — оператором `%` из pg_trgm: он идёт по индексу `persons_full_name_trgm` и
      // находит смену фамилии и опечатку, которых подстрока не найдёт. Пустое сравнение (учётку не
      // назвали) даёт «не похоже» у всех — и остаётся выражением по колонке: константу в ORDER BY
      // Postgres не принимает вовсе («non-integer constant in ORDER BY»).
      const nameMatch = sql<boolean>`${persons.fullName} % ${account?.fullName ?? ''}`;

      const rows = await db
        .select({
          id: persons.id,
          lastName: persons.lastName,
          firstName: persons.firstName,
          middleName: persons.middleName,
          fullName: persons.fullName,
          phone: persons.phone,
          email: persons.email,
          // Должность действующего трудового отношения: однофамильцев различают по ней и по
          // номеру телефона, а не по идентификатору, которого администратор не знает.
          jobTitle: sql<string>`COALESCE((SELECT e.job_title FROM ${personEmployments} e WHERE e.person_id = ${persons.id} AND e.ended_on IS NULL AND e.job_title <> '' LIMIT 1), '')`,
          phoneMatch,
          emailMatch,
          nameMatch,
        })
        .from(persons)
        .where(
          and(
            isNull(persons.deletedAt),
            notExists(
              db
                .select({ one: sql`1` })
                .from(users)
                .where(
                  and(
                    eq(users.personId, persons.id),
                    isNull(users.deletedAt),
                    userId ? ne(users.id, userId) : undefined,
                  ),
                ),
            ),
            term
              ? or(
                  searchCondition(term, [persons.fullName, persons.email]),
                  phoneSearchCondition(term, persons.phone),
                )
              : or(phoneMatch, emailMatch, nameMatch),
          ),
        )
        .orderBy(desc(phoneMatch), desc(emailMatch), desc(nameMatch), asc(persons.fullName))
        .limit(PERSON_CANDIDATE_LIMIT);

      return {
        items: rows.map(
          ({ phoneMatch: byPhone, emailMatch: byEmail, nameMatch: byName, ...p }) => ({
            ...p,
            // Порядок пометок тот же, что порядок строк: сначала то, что решает дело.
            matchedBy: [
              ...(byPhone ? (['phone'] as const) : []),
              ...(byEmail ? (['email'] as const) : []),
              ...(byName ? (['name'] as const) : []),
            ],
          }),
        ),
      };
    },
  );

  /**
   * Карточка одной учётки. Заведена ради панели пути в журнале изменений (ADR 0109): она
   * показывает, чем учётка стала к сегодняшнему дню — роль, доступ, объекты, отделы, надстройки,
   * работник, — и без этого путь обрывался бы на последнем событии, не отвечая «а что сейчас».
   *
   * Архив здесь не спрятан, в отличие от списка: путь чаще всего спрашивают как раз у отправленной
   * в архив учётки, и 404 на неё означал бы пустую панель там, где разбор и начинается.
   */
  r.get('/:id', { ...guards, schema: { params: idParams } }, async (req) => {
    const user = await fetchUserDto(req.params.id);
    if (!user) throw err.notFound('Пользователь не найден');
    return { user };
  });

  r.post('/', { ...guards, schema: { body: createUserBodySchema } }, async (req, reply) => {
    const actor = requirePrincipal(req);
    const body = req.body;
    const passwordHash = await hashPassword(body.password);
    // Новой учётке сравнивать не с чем: любая упраздняемая роль здесь — заведение нового человека
    // на роль, которой через релиз не станет.
    assertRoleAssignable(body.role, null);
    const counterpartyId = await resolveCounterpartyId(body.role, body.counterpartyId);
    const objectIds = resolveObjectIds(body.role, body.constructionObjectIds);
    const departmentIds = resolveDepartmentIds(body.role, body.departmentIds);
    const addons = resolveAddons(body.role, body.addons);
    let created;
    let binding: PersonBinding = {
      personId: null,
      userFields: {},
      filled: {},
      nameMismatchConfirmed: false,
    };
    let notified: MailOutcome = 'not_requested';
    try {
      created = await db.transaction(async (tx) => {
        // Архив адрес не занимает (ADR 0063) — та же проверка, что у саморегистрации.
        await assertEmailFree(tx, body.email);
        // Работник — до вставки и той же транзакцией: живая учётка водителя без него нарушает
        // CHECK, и порядок «сначала завести, потом привязать» оставлял бы её невозможной.
        binding = await resolvePersonBinding(tx, {
          role: body.role,
          currentPersonId: null,
          personId: body.personId,
          account: {
            id: null,
            lastName: body.lastName,
            firstName: body.firstName,
            middleName: body.middleName,
            phone: body.phone,
            email: body.email,
          },
          confirmNameMismatch: body.confirmNameMismatch,
          actorId: actor.id,
        });
        const [row] = await tx
          .insert(users)
          .values({
            email: body.email,
            lastName: body.lastName,
            firstName: body.firstName,
            // Отчество и телефон — с оглядкой на карточку: пустое поле формы заполняется из неё
            // молча (Р31), заполненное остаётся как ввели.
            middleName: binding.userFields.middleName ?? body.middleName,
            phone: binding.userFields.phone ?? body.phone,
            role: body.role,
            passwordHash,
            isActive: body.isActive,
            counterpartyId,
            personId: binding.personId,
            // Учётку завёл администратор — адрес он ввёл и проверил сам (ADR 0072). Требовать
            // подтверждения здесь значило бы блокировать активацию до того, как человек прочтёт
            // письмо, — а такие учётки и заводят затем, чтобы выдать доступ немедленно.
            emailVerifiedAt: new Date(),
          })
          .returning({ id: users.id });
        await replaceUserObjects(tx, row!.id, objectIds, actor.id);
        await replaceUserDepartments(tx, row!.id, departmentIds, actor.id);
        await replaceUserAddons(tx, row!.id, addons, actor.id);
        // Письмо только активной учётке: звать человека в портал, который его не пустит, хуже
        // молчания. Ключ без времени — учётку заводят один раз, различать в нём нечего.
        notified = await queueAccessMail(tx, {
          requested: body.notifyUser && body.isActive,
          kind: 'account_created',
          dedupeKey: `account-created:${row!.id}`,
          to: body.email,
          subject: ACCOUNT_CREATED_SUBJECT,
          content: () => accountCreatedContent(body.role),
          userId: row!.id,
        });
        return row!;
      });
    } catch (e) {
      throw asPersonConflict(asEmailConflict(e));
    }
    const createdDto = (await fetchUserDto(created.id))!;
    await writeAudit({
      actorUserId: actor.id,
      action: 'user.create',
      entityType: 'user',
      entityId: created.id,
      // Надстройка — выданный доступ (ADR 0086), и в журнале она стоит рядом с ролью: вопрос «кто
      // сделал человека оператором оргтехники» задают так же, как «кто выдал ему роль».
      // Активность записывается тут же: заведённая сразу активной учётка и заготовка «на потом» —
      // разные события, а по одной лишь роли они неразличимы.
      metadata: {
        role: body.role,
        addons,
        isActive: body.isActive,
        notified,
        ...bindingMetadata(binding),
        // Состав заведённой учётки словами (ADR 0109): роль, доступ, объекты, отделы, надстройки,
        // работник. Признаки выше остаются рядом — их читают записи, сделанные до этого перечня.
        changes: userAuditChanges(null, createdDto),
      },
    });
    reply.code(201);
    return { user: createdDto, notified };
  });

  r.patch(
    '/:id',
    { ...guards, schema: { params: idParams, body: updateUserBodySchema } },
    async (req) => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const body = req.body;

      /**
       * Карточка «до» — для журнала изменений (ADR 0109): пары «было → стало» собираются по
       * названиям объектов, отделов и работника, а не по идентификаторам, и взять их можно только
       * из собранного DTO.
       *
       * Снимок берётся до транзакции, а не внутри неё: выборка карточки идёт своими запросами, и
       * тащить в неё `tx` пришлось бы через половину модуля. Плата за это — гонка двух
       * администраторов: если чужая правка легла между снимком и блокировкой строки, в нашей
       * записи журнала она попадёт в левую часть пары. Обе правки при этом остаются в журнале
       * своими событиями, и порядок их виден по времени.
       */
      const before = await fetchUserDto(id);

      const {
        scopeChanged,
        addonsChanged,
        addons,
        roleChanged,
        counterpartyChanged,
        personChanged,
        personBefore,
        binding,
        deactivated,
        approving,
        notified,
        roleBefore,
        roleAfter,
        activeBefore,
        activeAfter,
        activeChanged,
      } = await db.transaction(async (tx) => {
        // Строка учётки читается под блокировкой и внутри транзакции, а не перед ней: решение по
        // заявке считается по её состоянию, и снимок, взятый до транзакции, устаревает ровно в тот
        // момент, когда двое рассматривают одну заявку одновременно. Тот же приём — у номера
        // путевого листа и у состава рейса.
        const [existing] = await tx.select().from(users).where(eq(users.id, id)).for('update');
        if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');

        // защита от самоблокировки
        if (actor.id === id) {
          if (body.isActive === false)
            throw err.badRequest('Нельзя деактивировать собственный аккаунт');
          if (body.role && body.role !== existing.role) {
            throw err.badRequest('Нельзя менять собственную роль');
          }
        }

        const nextRole = body.role ?? existing.role;
        // Прежняя роль сохраняется: отказ ловит смену роли на упраздняемую, а не саму упраздняемую
        // роль в теле — иначе действующего штаба нельзя было бы даже переименовать.
        assertRoleAssignable(nextRole, existing.role);
        const nextIsActive = body.isActive ?? existing.isActive;
        // Активная учётка без роли не попадает ни под одно ограничение доступа: проверки
        // сформулированы от конкретных ролей («штаб — свой объект», «оператор — свой контрагент»),
        // и учётка без роли видит все заявки вывоза. Роль назначается вместе с активацией.
        if (nextIsActive && !nextRole) {
          throw err.badRequest('Нельзя активировать учётку без роли', { role: 'Выберите роль' });
        }
        // Доступ выдаётся тому, кто доказал, что ящик его (ADR 0072). Иначе заявку мог подать кто
        // угодно на чужой адрес, и портал выдал бы права по одному лишь совпадению ФИО с ожидаемым.
        // Учётки, заведённые администратором, подтверждены по факту создания и сюда не упираются.
        // Пока подтверждение выключено (EMAIL_VERIFICATION_ENABLED), проверка снята — иначе заявки,
        // поданные до отключения, остались бы неактивируемыми.
        const activating = body.isActive === true && !existing.isActive;
        if (EMAIL_VERIFICATION_ENABLED && activating && !existing.emailVerifiedAt) {
          throw err.badRequest(
            'Адрес не подтверждён — активировать учётку нельзя. Попросите пользователя перейти по ссылке из письма.',
          );
        }

        // Рассмотрение заявки — объявленное намерение, а не догадка по телу запроса (ADR 0087).
        //
        // Одной блокировки мало: `PATCH` здесь маршрут общей правки, и второй администратор,
        // дождавшись первого, спокойно переписал бы его решение о роли и области, оставив в
        // журнале вторую запись. Поэтому намерение сверяется с состоянием строки и с итогом
        // правки, а не с одним лишь состоянием.
        const wasRegistration = !existing.isActive && existing.role === null;
        const approvingNow = wasRegistration && nextIsActive && nextRole !== null;
        // Назначить заявке роль, не активируя её, нельзя вместе с тем же запретом на активацию:
        // иначе запись перестала бы быть заявкой, а следующая правка активировала бы её уже как
        // обычную учётку — мимо журнала одобрения и мимо письма.
        const decidesRegistration =
          wasRegistration && (body.role !== undefined || body.isActive === true);
        if (body.approveRegistration) {
          if (!wasRegistration) {
            throw err.conflict('Заявку уже рассмотрел другой администратор — обновите список');
          }
          if (!approvingNow) {
            throw err.badRequest(
              'Заявку рассматривают целиком: назначьте роль и включите «Активен» — или оставьте заявку в очереди',
            );
          }
        } else if (decidesRegistration) {
          throw err.badRequest(
            'Роль и активность заявки меняются только её рассмотрением: откройте карточку заявки и рассмотрите её целиком',
          );
        }

        // Чтение справочника контрагентов идёт своим соединением и блокировок не ждёт: строка
        // `users` заблокирована нами, а `counterparties` эта операция не трогает вовсе.
        const nextCounterpartyId = await resolveCounterpartyId(
          nextRole,
          body.counterpartyId !== undefined ? body.counterpartyId : existing.counterpartyId,
        );

        const roleWasChanged = body.role !== undefined && body.role !== existing.role;
        const wasDeactivated = body.isActive === false && existing.isActive;
        // Смена контрагента у исполнителя — это смена и модуля, и области видимости (ADR 0038):
        // права учётки после неё другие, поэтому выданные токены гасятся так же, как при смене роли.
        const counterpartyWasChanged = nextCounterpartyId !== existing.counterpartyId;

        // Отсутствие поля — «не трогать привязки»; при этом смена роли на объектную или
        // отдельскую требует области и без поля: набор, оставшийся от прежней роли, проверяется
        // наравне с присланным. Смена оси при этом обнуляет чужой набор сама — `resolve*`
        // возвращают пустой список всем, кроме своей роли.
        const [currentObjects, currentDepartments, currentAddons] = await Promise.all([
          objectIdsOfUser(tx, id),
          departmentIdsOfUser(tx, id),
          addonsOfUser(tx, id),
        ]);
        const nextObjectIds = resolveObjectIds(
          nextRole,
          body.constructionObjectIds ?? currentObjects,
        );
        const nextDepartmentIds = resolveDepartmentIds(
          nextRole,
          body.departmentIds ?? currentDepartments,
        );
        // Тем же правилом, но с другим исходом: выданная надстройка от смены роли не отваливается,
        // а запрещает саму смену — 400 из `resolveAddons`. Транзакция при этом откатывается, и
        // учётка остаётся ровно такой, какой была.
        const nextAddons = resolveAddons(nextRole, body.addons ?? currentAddons);
        // Работник — четвёртая ось области (ADR 0102), и живёт она по своим правилам: набор
        // чужой оси `resolve*` обнуляют молча, а человека у водителя обнулить нельзя вовсе (Р6).
        // Сверяется он с учёткой **после** правки — иначе исправленная в том же запросе опечатка
        // в фамилии выглядела бы расхождением с карточкой.
        const nextBinding = await resolvePersonBinding(tx, {
          role: nextRole,
          currentPersonId: existing.personId,
          personId: body.personId,
          account: {
            id,
            lastName: body.lastName ?? existing.lastName,
            firstName: body.firstName ?? existing.firstName,
            middleName: body.middleName ?? existing.middleName,
            phone: body.phone ?? existing.phone,
            email: existing.email,
          },
          confirmNameMismatch: body.confirmNameMismatch,
          actorId: actor.id,
        });
        const personWasChanged = nextBinding.personId !== existing.personId;
        const objectsChanged = await replaceUserObjects(tx, id, nextObjectIds, actor.id);
        const departmentsChanged = await replaceUserDepartments(
          tx,
          id,
          nextDepartmentIds,
          actor.id,
        );
        const changed = objectsChanged || departmentsChanged;
        const addonsSetChanged = await replaceUserAddons(tx, id, nextAddons, actor.id);
        try {
          await tx
            .update(users)
            .set({
              lastName: body.lastName ?? existing.lastName,
              firstName: body.firstName ?? existing.firstName,
              // Отчество и телефон — с оглядкой на карточку: пустое поле заполняется из неё
              // молча (Р31), заполненное остаётся тем, что прислали.
              middleName:
                nextBinding.userFields.middleName ?? body.middleName ?? existing.middleName,
              // Телефон правится как ФИО: поле не прислали — не трогаем, прислали пустым — стёрли.
              phone: nextBinding.userFields.phone ?? body.phone ?? existing.phone,
              role: nextRole,
              isActive: nextIsActive,
              counterpartyId: nextCounterpartyId,
              personId: nextBinding.personId,
              authVersion:
                roleWasChanged ||
                counterpartyWasChanged ||
                wasDeactivated ||
                changed ||
                addonsSetChanged ||
                // Смена работника меняет всё, что учётка видит в кабинете: это другой человек с
                // другими рейсами. Токены гасятся так же, как при смене роли и контрагента.
                personWasChanged
                  ? existing.authVersion + 1
                  : existing.authVersion,
              updatedAt: new Date(),
            })
            .where(eq(users.id, id));
        } catch (e) {
          // Гонка двух привязок доходит до индекса: между выбором работника и этой записью его
          // мог занять параллельный запрос, и разобрать `23505` больше негде.
          throw asPersonConflict(e);
        }

        // Письмо об открытом доступе — той же транзакцией, что и само одобрение: заявка,
        // рассмотренная без письма, и письмо по нерассмотренной заявке одинаково недопустимы.
        // Ключ дедупликации без времени: одобрение по построению однократно (после него роль уже
        // назначена), и постоянный ключ вдобавок ловит повтор, если строка успела измениться дважды.
        const mailed = await queueAccessMail(tx, {
          requested: approvingNow && body.notifyUser,
          kind: 'registration_approved',
          dedupeKey: `registration-approved:${id}`,
          to: existing.email,
          subject: REGISTRATION_APPROVED_SUBJECT,
          content: () => registrationApprovedContent(nextRole!),
          userId: id,
        });

        return {
          scopeChanged: changed,
          addonsChanged: addonsSetChanged,
          addons: nextAddons,
          roleChanged: roleWasChanged,
          counterpartyChanged: counterpartyWasChanged,
          personChanged: personWasChanged,
          personBefore: existing.personId,
          binding: nextBinding,
          deactivated: wasDeactivated,
          approving: approvingNow,
          notified: mailed,
          roleBefore: existing.role,
          roleAfter: nextRole,
          activeBefore: existing.isActive,
          activeAfter: nextIsActive,
          activeChanged: nextIsActive !== existing.isActive,
        };
      });

      // Сменившаяся область гасит токены наравне со сменой роли и контрагента: учётке стали
      // видны другие заявки. Сменившийся набор надстроек (ADR 0086) — то же самое с другой
      // стороны: заявки те же, но действий над ними стало больше или меньше. Сменившийся работник
      // (Р6) — самое сильное из этого: кабинет начинает показывать чужие рейсы.
      const bumpAuth =
        roleChanged ||
        counterpartyChanged ||
        deactivated ||
        scopeChanged ||
        addonsChanged ||
        personChanged;
      if (bumpAuth) await revokeAllForUser(id);
      const after = (await fetchUserDto(id))!;
      // Перепривязка — своё событие журнала со старым и новым человеком (Р6). Внутри общей правки
      // от неё остался бы один флаг «что-то поменяли»: разбор «кому ушли задания Иванова» задают
      // именно парой «был — стал», а искать её потом по соседним записям нечем.
      if (personChanged && personBefore && binding.personId) {
        await writeAudit({
          actorUserId: actor.id,
          action: 'user.driver_person_relinked',
          entityType: 'user',
          entityId: id,
          metadata: {
            person: { from: personBefore, to: binding.personId },
            ...bindingMetadata(binding),
            // Идентификаторы рядом с именами, а не вместо них (ADR 0109): «кому ушли задания
            // Иванова» спрашивают про человека, а `8f0c…` на этот вопрос не отвечает.
            changes: [
              {
                field: 'person',
                from: before?.person?.fullName ?? null,
                to: after.person?.fullName ?? null,
              },
            ],
          },
        });
      }
      // У рассмотрения заявки своё действие журнала, а не признак внутри общей правки: одобрение и
      // отказ — два исхода одного решения, и в журнале они обязаны стоять рядом и одинаково
      // фильтроваться. Заодно «одобрение было ровно одно» становится проверяемым в один запрос.
      await writeAudit({
        actorUserId: actor.id,
        action: approving ? 'user.approve_registration' : 'user.update',
        entityType: 'user',
        entityId: id,
        metadata: approving
          ? {
              role: roleAfter,
              addons,
              notified,
              ...bindingMetadata(binding),
              // Одобрение — та же правка учётки, только с назначением роли: заявка была без роли и
              // без доступа, и пары «было → стало» показывают ровно это.
              changes: userAuditChanges(before, after),
            }
          : {
              roleChanged,
              counterpartyChanged,
              deactivated,
              scopeChanged,
              addonsChanged,
              // Привязка водителя (Р30) стоит рядом с остальными признаками правки, а
              // перепривязка вдобавок пишется своим событием: первая учётку открывает, вторая
              // переносит её к другому человеку, и в разборе это разные вопросы.
              ...(personChanged ? bindingMetadata(binding) : {}),
              // Не только «роль менялась», но и чем она была и стала: подвкладка аудита обязана
              // отвечать «кто сделал человека диспетчером», а по одному булеву флагу это вопрос
              // без ответа. Тем же правилом — активность: раньше в журнале была видна только
              // деактивация, и включение доступа не оставляло следа вовсе.
              ...(roleChanged ? { role: { from: roleBefore, to: roleAfter } } : {}),
              ...(activeChanged ? { isActive: { from: activeBefore, to: activeAfter } } : {}),
              // Что именно осталось у учётки — только когда набор менялся: снятие надстройки уносит
              // из `user_role_addons` и строку с `granted_by`, и без этой записи в журнале не
              // осталось бы следа, чем доступ был до правки.
              ...(addonsChanged ? { addons } : {}),
              // Полный перечень изменённого (ADR 0109). Признаки выше остаются рядом: по ним
              // читаются записи, сделанные до перечня, и ломать их разбор незачем.
              changes: userAuditChanges(before, after),
            },
      });
      return { user: after, notified };
    },
  );

  r.post(
    '/:id/password',
    { ...guards, schema: { params: idParams, body: setUserPasswordSchema } },
    async (req) => {
      const { id } = req.params;
      const [existing] = await db.select().from(users).where(eq(users.id, id));
      if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');
      const passwordHash = await hashPassword(req.body.newPassword);
      await db
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: true,
          authVersion: existing.authVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(users.id, id));
      await revokeAllForUser(id);
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'user.reset_password',
        entityType: 'user',
        entityId: id,
      });
      return { ok: true };
    },
  );

  /**
   * Смена адреса учётной записи (ADR 0092).
   *
   * Своей ручкой, а не полем `PATCH`: адрес — это логин, и смена тянет за собой отзыв сессий,
   * гашение живых ссылок из писем и два уведомления. Приехав «ещё одним полем формы», всё это
   * случалось бы мимоходом при сохранении телефона — и неотличимо от него в журнале.
   *
   * Порядок проверок здесь — это порядок отказов, который увидит администратор, и он выстроен от
   * «кого трогать нельзя» к «на что менять нельзя»: сперва запреты по самой учётке, потом по
   * новому адресу. Обратный порядок сообщал бы «адрес занят» про учётку, которую всё равно не
   * дали бы тронуть.
   */
  r.post(
    '/:id/email',
    { ...guards, schema: { params: idParams, body: changeUserEmailSchema } },
    async (req): Promise<ChangeEmailResult> => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const { newEmail, currentPassword } = req.body;
      const self = actor.id === id;

      let result;
      try {
        result = await db.transaction(async (tx) => {
          // Под блокировкой и внутри транзакции — по той же причине, что и рассмотрение заявки:
          // решение принимается по состоянию строки, а снимок, взятый до транзакции, устаревает
          // ровно тогда, когда двое правят одну учётку одновременно.
          const [existing] = await tx.select().from(users).where(eq(users.id, id)).for('update');
          if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');

          // Учётку с полными правами уводит только её владелец: смена логина отдаёт доступ
          // целиком и тихо — владелец узнаёт о ней лишь письмом, — а администраторов в портале
          // несколько. Роль читается из заблокированной строки, а не из карточки, показанной
          // порталу: роль, выданную секундой раньше параллельной правкой, снимок бы не увидел.
          // Потерявшему доступ к ящику администратору путь остаётся прежний: второй сбрасывает
          // ему пароль, тот входит и меняет адрес себе.
          if (!self && existing.role === 'admin') {
            throw err.forbidden(
              'Адрес учётной записи администратора меняет только её владелец. Если доступ к ящику утрачен — сбросьте пароль и попросите сменить адрес самостоятельно',
            );
          }

          // Заявка на регистрацию — утверждение заявителя о себе, включая ящик. Переписав адрес и
          // одобрив заявку, администратор выдал бы доступ ящику, который заявку не подавал, а
          // подтверждение адреса (ADR 0072) перестало бы что-либо значить. Такую заявку отклоняют.
          if (!existing.isActive && existing.role === null) {
            throw err.badRequest(
              'У заявки на регистрацию адрес не меняют: отклоните её — человек подаст новую со своего адреса',
            );
          }

          // Сравнение регистронезависимое: адрес лежит в `citext`, и «Ivan@su10.ru» — тот же
          // адрес, что и «ivan@su10.ru». Письмо о несостоявшейся смене и запись в журнале о ней
          // одинаково вводят в заблуждение, поэтому это отказ, а не тихий успех.
          if (existing.email.toLowerCase() === newEmail.toLowerCase()) {
            throw err.badRequest('Адрес совпадает с текущим', {
              newEmail: 'Это и есть текущий адрес',
            });
          }

          // Свой адрес — с подтверждением паролем: он удостоверяет, что за клавиатурой владелец
          // учётки, а не тот, кому досталась оставленная открытой сессия. Проверка идёт под уже
          // взятой блокировкой — строка своя же, и ждать её больше некому.
          if (self) {
            if (!currentPassword) {
              throw err.badRequest('Подтвердите смену своего адреса текущим паролем', {
                currentPassword: 'Введите текущий пароль',
              });
            }
            const ok = await verifyPassword(existing.passwordHash, currentPassword);
            if (!ok) {
              throw err.badRequest('Текущий пароль неверен', {
                currentPassword: 'Неверный пароль',
              });
            }
          }

          // Архив адрес не занимает (ADR 0063) — та же проверка, что у создания и восстановления.
          await assertEmailFree(tx, newEmail);
          // ...но архивная учётка с таким адресом после смены станет невосстановимой:
          // восстановление требует свободного адреса. Мешать этому незачем — адрес освободила она
          // сама, — а вот узнать об этом администратор должен в момент решения.
          const shadowed = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.email, newEmail), isNotNull(users.deletedAt)));

          const changedAt = new Date();
          await tx
            .update(users)
            .set({
              email: newEmail,
              // Адрес, который ввёл администратор, он же и проверил — то же правило, что при
              // заведении учётки (ADR 0072). Сброс в `null` тихо выключил бы человеку ролевые
              // дайджесты: они рассылаются только подтверждённым.
              emailVerifiedAt: changedAt,
              // Сменился логин — выданные токены гасятся, как при смене пароля: адрес меняют в
              // том числе тогда, когда прежний ящик потерян или скомпрометирован.
              authVersion: existing.authVersion + 1,
              updatedAt: changedAt,
            })
            .where(eq(users.id, id));

          // Адрес карточки идёт следом (ADR 0102, Р31): владелец адреса — учётка, а на
          // `persons.email` шлёт письма рассылка «Задание водителю». Без переноса смена логина
          // оставила бы её писать на прежний ящик — то есть в пустоту, и обнаружилось бы это
          // тем, что человек просто перестал получать задания.
          //
          // Переносится только совпадавший или пустой: свой адрес карточки, заведённый кадрами,
          // смена логина не касается — он принадлежит справочнику, а не учётке. Версия растёт
          // выражением, а не чтением строки: карточка здесь только дописывается, и ради одного
          // поля брать её под блокировку незачем.
          if (existing.personId) {
            await tx
              .update(persons)
              .set({
                email: newEmail,
                updatedBy: actor.id,
                version: sql`${persons.version} + 1`,
                updatedAt: changedAt,
              })
              .where(
                and(
                  eq(persons.id, existing.personId),
                  or(eq(persons.email, existing.email), eq(persons.email, '')),
                ),
              );
          }

          // Живые ссылки из уже отправленных писем гасятся обе. Иначе ссылка сброса, ушедшая на
          // прежний ящик, остаётся действующим ключом от учётки — теперь уже с новым адресом.
          await revokeEmailTokens(id, 'password_reset', { tx });
          await revokeEmailTokens(id, 'verify_email', { tx });

          // Письма — правило, а не просьба администратора: на новый адрес человеку сообщают, чем
          // теперь входить, на прежний уходит сигнал владельцу ящика. Галочка «уведомить» здесь
          // превратила бы сигнал в необязательный — а снимут её как раз в том случае, ради
          // которого он и нужен. Время в ключе: адрес меняют и обратно, и это новое событие.
          const stamp = changedAt.getTime();
          const notifiedNew = await queueAccessMail(tx, {
            requested: true,
            kind: 'email_changed',
            dedupeKey: `email-changed:${id}:${stamp}:new`,
            to: newEmail,
            subject: EMAIL_CHANGED_SUBJECT,
            content: () => emailChangedContent(newEmail),
            userId: id,
          });
          const notifiedOld = await queueAccessMail(tx, {
            requested: true,
            kind: 'email_changed',
            dedupeKey: `email-changed:${id}:${stamp}:old`,
            to: existing.email,
            subject: EMAIL_CHANGED_SUBJECT,
            content: () => emailChangedNoticeContent(maskEmail(newEmail)),
            userId: id,
          });

          return {
            oldEmail: existing.email,
            notifiedNew,
            notifiedOld,
            shadowsArchived: shadowed.length > 0,
          };
        });
      } catch (e) {
        // Между проверкой и записью адрес мог занять параллельный запрос — удержать это может
        // только сам индекс, и человеку нужно то же сообщение, что и при обычном дубле.
        throw asEmailConflict(e);
      }

      // Сессии отзываются после фиксации: они живут своей транзакцией, и откат основной не должен
      // оставлять учётку без них. Сменивший адрес себе выходит из портала здесь же — и входит
      // заново уже по новому адресу.
      await revokeAllForUser(id);
      await writeAudit({
        actorUserId: actor.id,
        action: 'user.change_email',
        entityType: 'user',
        entityId: id,
        // Оба адреса: прежнего после смены нет больше нигде — в учётке лежит уже новый, — а
        // вопрос разбора звучит «с какого адреса и на какой увели вход». Тем же составом пишется
        // удаление учётки насовсем.
        metadata: {
          oldEmail: result.oldEmail,
          newEmail,
          notifiedNew: result.notifiedNew,
          notifiedOld: result.notifiedOld,
          shadowsArchived: result.shadowsArchived,
          self,
          // Та же пара перечнем изменений (ADR 0109): журнал показывает смену адреса такой же
          // строкой, что и смену роли, — читателю незачем знать, какой ручкой её сделали.
          changes: [{ field: 'email', from: result.oldEmail, to: newEmail }],
        },
      });

      return {
        user: (await fetchUserDto(id))!,
        notifiedNew: result.notifiedNew,
        notifiedOld: result.notifiedOld,
        shadowsArchived: result.shadowsArchived,
      };
    },
  );

  /**
   * Отказ по заявке на регистрацию. Технически это тот же soft delete, что и удаление учётки,
   * но отдельным действием: в аудите «отклонена заявка, потому что <причина>» и «удалён
   * сотрудник» — разные события, и разбирать их потом приходится по-разному.
   */
  r.post(
    '/:id/reject',
    { ...guards, schema: { params: idParams, body: rejectUserSchema } },
    async (req) => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const { reason, notifyApplicant, applicantMessage } = req.body;

      const { email, notified } = await db.transaction(async (tx) => {
        // Под блокировкой и внутри транзакции — по той же причине, что и правка учётки: два
        // одновременных отказа иначе прошли бы оба и поставили два письма. Дедупликация здесь не
        // спасает — ключ содержит время отказа, и у двух запросов оно разное.
        const [existing] = await tx.select().from(users).where(eq(users.id, id)).for('update');
        if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');
        // Отклонять можно только нерассмотренную заявку: у действующей учётки для этого есть
        // деактивация и удаление, и подменять их отказом — терять смысл записи в аудите.
        if (existing.isActive || existing.role) {
          throw err.badRequest('Отклонить можно только заявку, которая ещё не рассмотрена');
        }
        const rejectedAt = new Date();
        await tx
          .update(users)
          .set({
            deletedAt: rejectedAt,
            authVersion: existing.authVersion + 1,
            updatedAt: rejectedAt,
          })
          .where(eq(users.id, id));
        // Время отказа в ключе: восстановленную из архива заявку (ADR 0063) могут отклонить снова,
        // и это новое событие с новым письмом. От одновременных запросов защищает блокировка выше.
        const mailed = await queueAccessMail(tx, {
          requested: notifyApplicant,
          kind: 'registration_rejected',
          dedupeKey: `registration-rejected:${id}:${rejectedAt.getTime()}`,
          to: existing.email,
          subject: REGISTRATION_REJECTED_SUBJECT,
          content: () => registrationRejectedContent(applicantMessage!),
          userId: id,
        });
        return { email: existing.email, notified: mailed };
      });

      await revokeAllForUser(id);
      await writeAudit({
        actorUserId: actor.id,
        action: 'user.reject_registration',
        entityType: 'user',
        entityId: id,
        // Текст ответа — только если он действительно ушёл: сохранённая формулировка, которой
        // никто не получил, в разборе означала бы обратное тому, что было.
        metadata: {
          reason,
          email,
          notified,
          ...(notified === 'queued' ? { applicantMessage } : {}),
        },
      });
      return { ok: true, notified };
    },
  );

  r.delete('/:id', { ...guards, schema: { params: idParams } }, async (req) => {
    const actor = requirePrincipal(req);
    const { id } = req.params;
    if (actor.id === id) throw err.badRequest('Нельзя удалить собственный аккаунт');
    const [existing] = await db.select().from(users).where(eq(users.id, id));
    if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');
    await db
      .update(users)
      .set({
        isActive: false,
        deletedAt: new Date(),
        authVersion: existing.authVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));
    await revokeAllForUser(id);
    await writeAudit({
      actorUserId: actor.id,
      action: 'user.delete',
      entityType: 'user',
      entityId: id,
    });
    return { ok: true };
  });

  /**
   * Возврат учётки из архива (ADR 0063) — отдельной ручкой и отдельным правом (`archive.restore`),
   * как у контрагентов и техники: вести учётки и распоряжаться архивом — разные полномочия.
   *
   * Активность не поднимается. Восстановленный отказ снова становится нерассмотренной заявкой и
   * возвращается в очередь администратора — то есть проходит рассмотрение заново, а не получает
   * доступ обходным путём; у восстановленного сотрудника учётка деактивирована, и включает её
   * обычная правка карточки.
   *
   * У водителя (ADR 0102, Р8) восстановление спрашивает работника. Архивная учётка `person_id`
   * иметь не обязана — при удалении человека связь обнуляется (`ON DELETE SET NULL`), — поэтому
   * вернуть её вслепую нельзя: CHECK `users_driver_person_check` ответил бы пятисоткой ровно так
   * же, как раньше отвечал бы занятый адрес. Человек ставится той же транзакцией, что и снятие
   * `deleted_at`, и проходит те же проверки, что при обычной привязке: пока учётка лежала в
   * архиве, работника могли уволить или завести ему другую.
   */
  r.post(
    '/:id/restore',
    {
      preHandler: [app.authenticate, app.requirePermission('archive.restore')],
      // Тело схемой маршрута НЕ объявлено намеренно: у Fastify валидация идёт раньше стража, и
      // объявленное тело отвечало бы 400 на пустой запрос — в том числе неаутентифицированному,
      // который должен получить 401, и чужому, который должен получить 403. Восстановление же
      // тела не требует вовсе (Р8): его шлёт только водительская учётка без человека. Поэтому
      // разбор перенесён в обработчик — после проверки входа и права.
      schema: { params: idParams },
    },
    async (req) => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const parsed = restoreUserSchema.safeParse(req.body ?? undefined);
      if (!parsed.success) {
        const fields: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          fields[issue.path.join('.') || 'body'] = issue.message;
        }
        throw err.validation(fields);
      }
      const body = parsed.data;
      const binding = await db
        .transaction(async (tx) => {
          const [existing] = await tx.select().from(users).where(eq(users.id, id)).for('update');
          if (!existing) throw err.notFound('Пользователь не найден');
          if (!existing.deletedAt) return null;
          // Пока учётка лежала в архиве, её адрес мог занять другой человек (ADR 0063 решение 1):
          // восстанавливать вслепую нельзя — упрёмся в тот же индекс, но уже пятисоткой.
          await assertEmailFree(tx, existing.email, {
            exceptId: id,
            message: `Email ${existing.email} занят другой учётной записью — восстановить нельзя`,
          });
          // Связь водителя проверяется заново, как при первой привязке (`currentPersonId: null`):
          // для архивной строки прежний работник не «уже привязан», а такой же кандидат, как
          // любой другой — за время в архиве его могли уволить или завести ему свою учётку.
          // У прочих ролей связь справочная (ADR 0008), восстановления не касается и остаётся как
          // была — пока работника не прислали явно.
          const revalidatePerson =
            isPersonScopedRole(existing.role) || body?.personId !== undefined;
          const restored = await resolvePersonBinding(tx, {
            role: existing.role,
            currentPersonId: revalidatePerson ? null : existing.personId,
            personId: revalidatePerson ? (body?.personId ?? existing.personId) : undefined,
            account: {
              id,
              lastName: existing.lastName,
              firstName: existing.firstName,
              middleName: existing.middleName,
              phone: existing.phone,
              email: existing.email,
            },
            confirmNameMismatch: body?.confirmNameMismatch ?? false,
            actorId: actor.id,
          });
          await tx
            .update(users)
            .set({
              deletedAt: null,
              personId: restored.personId,
              middleName: restored.userFields.middleName ?? existing.middleName,
              phone: restored.userFields.phone ?? existing.phone,
              // Строка побывала в архиве: выданных до неё токенов у неё быть не должно.
              authVersion: existing.authVersion + 1,
              updatedAt: new Date(),
            })
            .where(eq(users.id, id));
          return restored;
        })
        .catch((e: unknown) => {
          throw asPersonConflict(e);
        });
      await writeAudit({
        actorUserId: actor.id,
        action: 'user.restore',
        entityType: 'user',
        entityId: id,
        metadata: binding ? bindingMetadata(binding) : {},
      });
      return (await fetchUserDto(id))!;
    },
  );

  /**
   * Удаление учётки насовсем (ADR 0063) — общая механика справочников (ADR 0060), право
   * `records.purge`, только из архива.
   *
   * Кто держит учётку, решает БД: заявки, история статусов, назначения, путевые листы и рейсы
   * ссылаются на неё `ON DELETE RESTRICT` — учётка работавшего человека не удалится, и это
   * правильно. Объекты, отделы, надстройки роли и refresh-сессии уходят каскадом: они существуют
   * только при ней.
   */
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db.select().from(users).where(eq(users.id, id));
      return row;
    },
    isDown: (row) => !!row.deletedAt,
    remove: async (tx, row) => {
      await tx.delete(users).where(eq(users.id, row.id));
    },
    notFound: 'Пользователь не найден',
    stillLive: 'Учётная запись не в архиве — сначала удалите её',
    subject: 'учётную запись',
    audit: {
      action: 'user.purge',
      entityType: 'user',
      // Адрес и ФИО — то, чем человека называют: после удаления по entityId искать уже нечего,
      // а вопрос «куда делась учётка Иванова» задают именно так.
      metadata: (row) => ({ email: row.email, fullName: row.fullName, role: row.role }),
    },
  });
}
