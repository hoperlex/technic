import { z } from 'zod';
import { ARCHIVE_FILTERS, baseListQuery, booleanFlagSchema, uuidSchema } from './common';
import { roleLabels, roleSchema, type Role } from './enums';
import {
  registrationRoleRequestLabels,
  type RegistrationRoleRequest,
} from './registration-request';
import { roleAddonLabels, type RoleAddon } from './role-addons';

// ── Журнал изменений учётных записей (ADR 0088, ADR 0109) ──
// Журнал `audit_log` пишется всем порталом, но читают его по-разному: история одной заявки едет в
// её карточку (`request-history.ts`), а здесь — что происходило с учётными записями. Реестр
// действий закрытый и лежит в контрактах: подвкладка показывает не «весь журнал с фильтром», а
// перечисленный список событий, и перечень обязан быть один на сервер, таблицу и будущий экспорт.
//
// Событие журнала отвечает на три вопроса сразу: что за учётка, что в ней стало другим и кто это
// сделал. Второй вопрос — тот, ради которого экран переделан (ADR 0109): раньше правка ложилась в
// журнал булевыми признаками («что-то в области видимости меняли»), и разбор упирался в них.

/** Строка журнала. `target*` — учётка, над которой действовали (join по `entityId`). */
export interface AuditEntryDto {
  id: string;
  /** Момент события (ISO). */
  createdAt: string;
  action: string;
  /** Кто сделал; `null` — учётка автора удалена или действие выполнено самим человеком до входа. */
  actorUserId: string | null;
  actorName: string | null;
  entityType: string | null;
  entityId: string | null;
  /**
   * Над кем действовали. `null` — цель не учётка (`entityType !== 'user'`) или её уже удалили
   * насовсем: без ФИО строка «user.delete 8f0c…» не отвечает ни на один вопрос разбора.
   */
  targetName: string | null;
  targetEmail: string | null;
  /**
   * Чем учётка стала **сейчас** — роль, доступ, архив. Это не состояние на момент события: журнал
   * значений не хранит снимками, и подмешивать сюда прошлое было бы обманом. Нужно оно затем,
   * чтобы строка называла человека так же, как список учёток, — «Механик, в архиве», — иначе одно
   * ФИО не отличает действующего сотрудника от давно уволенного.
   */
  targetRole: Role | null;
  targetIsActive: boolean | null;
  targetDeletedAt: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Действия по учётным записям — закрытый реестр (Р10 плана `docs/registration-reject-mail-plan.md`).
 *
 * `auth.login` в него не входит намеренно: входов тысячи в неделю, и они утопят тот десяток
 * административных действий, ради которых подвкладка и заводится. Журнал входов — отдельная задача
 * со своей выборкой и своими фильтрами, а не строка в этом перечне.
 *
 * Порядок — по жизненному пути учётки: заявка, заведение, правка, рассмотрение, архив, пароли.
 * Он же порядок в фильтре подвкладки, поэтому алфавитным его делать нельзя — читают перечень как
 * список событий, а не как справочник кодов.
 */
export const USER_AUDIT_ACTIONS = [
  'user.register',
  'user.create',
  'user.update',
  'user.approve_registration',
  'user.reject_registration',
  'user.delete',
  'user.restore',
  'user.purge',
  'user.reset_password',
  'user.change_email',
  // Смена привязанного работника (ADR 0102): у учётки водителя это не «правка полей», а замена
  // того, чьи задания и показания она открывает, — и в фильтре аудита такое событие ищут отдельно.
  'user.driver_person_relinked',
  'auth.email_verified',
  'auth.password_reset_requested',
  'auth.password_reset',
  'auth.password_change',
] as const;
export type UserAuditAction = (typeof USER_AUDIT_ACTIONS)[number];

/**
 * Подписи действий — то, что стоит в фильтре и остаётся строкой таблицы, когда metadata пустая.
 *
 * Формулировки называют событие, а не таблицу: `user.delete` — это soft delete в архив, а не
 * удаление насовсем (им занят `user.purge`, ADR 0063), и подписи обязаны их различать. Смена
 * активности своего действия не имеет: она приезжает правкой учётки, и «деактивирована» собирает
 * описатель по metadata.
 */
export const userAuditActionLabels: Record<UserAuditAction, string> = {
  'user.register': 'Заявка на регистрацию подана',
  'user.create': 'Учётная запись создана',
  'user.update': 'Учётная запись изменена',
  'user.approve_registration': 'Заявка одобрена',
  'user.reject_registration': 'Заявка отклонена',
  'user.delete': 'Учётная запись отправлена в архив',
  'user.restore': 'Учётная запись восстановлена из архива',
  'user.purge': 'Учётная запись удалена насовсем',
  'user.reset_password': 'Пароль сброшен администратором',
  'user.change_email': 'Адрес электронной почты изменён',
  'user.driver_person_relinked': 'Работник учётной записи заменён',
  'auth.email_verified': 'Адрес электронной почты подтверждён',
  'auth.password_reset_requested': 'Запрошено восстановление пароля',
  'auth.password_reset': 'Пароль восстановлен по ссылке из письма',
  'auth.password_change': 'Пароль изменён владельцем учётной записи',
};

// ── Действия по назначаемым полномочиям (ADR 0106, этап 3) ──
//
// Отдельным реестром от действий учётки, а не пятью строками в нём. Причина не в стиле: у событий
// разная цель. `USER_AUDIT_ACTIONS` перечисляет то, что случилось **с учёткой**, и подвкладка
// «Пользователи → Аудит» строит по нему свои галочки фильтра; каталог наборов живёт на вкладке
// «Права», и его события отвечают на другой вопрос — «кто менял состав полномочия». Слитые в один
// перечень, они добавили бы в фильтр учёток пять галочек, к учёткам не относящихся.
//
// Читаются же оба реестра одинаково: журнал в портале один (ADR 0088), новой сущности аудита
// реформа не заводит (§12), и отбор по действию, описатель строки и будущий экспорт обязаны знать
// оба перечня — за это отвечает `AUDIT_ACTIONS` ниже.
//
// **Цель события у трёх первых действий — набор, у двух последних — учётка.** Правка каталога
// пишется с `entityType: 'grant'` и `entityId` набора: у неё нет одного пострадавшего, их столько,
// сколько держателей. Выдача и отзыв, наоборот, пишутся на учётку — так их находит разбор «что
// меняли у этого человека», — а набор называют в metadata. Оба действия заведены **этой** волной
// намеренно, хотя писать их будет следующая: код действия, придуманный в момент, когда его уже надо
// писать, обычно оказывается вторым именем для того же события (`grant.add` рядом с `grant.assign`),
// и разобрать журнал по двум именам одного события потом нечем.
export const GRANT_AUDIT_ACTIONS = [
  'grant.create',
  'grant.update',
  'grant.delete',
  'grant.assign',
  'grant.revoke',
] as const;
export type GrantAuditAction = (typeof GRANT_AUDIT_ACTIONS)[number];

/**
 * Подписи действий каталога. «Полномочие», а не «набор прав», — тем же словом набор называется в
 * ADR, в плане и в карточке учётки; журнал не должен вводить третье название одной сущности.
 */
export const grantAuditActionLabels: Record<GrantAuditAction, string> = {
  'grant.create': 'Полномочие создано',
  'grant.update': 'Полномочие изменено',
  'grant.delete': 'Полномочие удалено',
  'grant.assign': 'Полномочие выдано',
  'grant.revoke': 'Полномочие отозвано',
};

/** Весь закрытый реестр журнала: события учёток и события каталога полномочий. */
export const AUDIT_ACTIONS = [...USER_AUDIT_ACTIONS, ...GRANT_AUDIT_ACTIONS] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Подписи всех действий реестра — одна карта на фильтр, описатель и экспорт. */
export const auditActionLabels: Record<AuditAction, string> = {
  ...userAuditActionLabels,
  ...grantAuditActionLabels,
};

const GRANT_ACTION_SET: ReadonlySet<string> = new Set(GRANT_AUDIT_ACTIONS);

/** Событие каталога полномочий, а не учётки: у них разный разбор metadata. */
export function isGrantAuditAction(action: string): action is GrantAuditAction {
  return GRANT_ACTION_SET.has(action);
}

// ── Изменённые поля учётки ──

/**
 * Изменение одного поля учётной записи: «было → стало» готовым текстом на момент правки.
 *
 * Текстом, а не ссылками на справочники, по той же причине, что и в истории заявки: объект могут
 * переименовать, работника — уволить, а журнал обязан показывать то, что администратор видел в
 * форме, когда нажимал «Сохранить».
 *
 * Три состояния краёв, и путать их нельзя:
 *  - `from` и `to` заполнены — обычная правка;
 *  - `from === null` — значение появилось (учётку завели, доступ выдали): слева показывать нечего;
 *  - `to === null` — значение не сохранено. Так читаются записи, сделанные до ADR 0109: портал
 *    писал тогда один признак «менялось», и придумать пропущенное значение задним числом нельзя.
 */
export interface AuditChangeDto {
  field: string;
  from: string | null;
  to: string | null;
}

/**
 * Поля учётки, попадающие в журнал. Порядок — как в форме учётной записи, он же порядок строк в
 * событии: читатель сверяет журнал с карточкой глазами, и переставленные местами поля заставляли
 * бы искать каждое заново.
 *
 * Наборы (объекты, отделы, надстройки) занимают по два поля — «добавлены» и «сняты», а не одну
 * пару «было → стало»: составы по десять площадок в двух колонках сравнивать глазами невозможно, а
 * вопрос у читателя всегда про разницу — что человеку открыли и что закрыли.
 *
 * `scope` и `addons` — только для старых записей (ADR 0109): портал так больше не пишет, но
 * прочитанное из архива журнала обязано чем-то называться.
 */
export const USER_AUDIT_FIELDS = [
  'lastName',
  'firstName',
  'middleName',
  'email',
  'phone',
  'role',
  'isActive',
  'counterparty',
  'objectsAdded',
  'objectsRemoved',
  'departmentsAdded',
  'departmentsRemoved',
  'addonsGranted',
  'addonsRevoked',
  'person',
  'scope',
  'addons',
] as const;
export type UserAuditField = (typeof USER_AUDIT_FIELDS)[number];

/** Подпись строки изменения. */
export const userAuditFieldLabels: Record<UserAuditField, string> = {
  lastName: 'Фамилия',
  firstName: 'Имя',
  middleName: 'Отчество',
  email: 'Адрес (логин)',
  phone: 'Телефон',
  role: 'Роль',
  isActive: 'Доступ в портал',
  counterparty: 'Контрагент',
  objectsAdded: 'Объекты добавлены',
  objectsRemoved: 'Объекты сняты',
  departmentsAdded: 'Отделы добавлены',
  departmentsRemoved: 'Отделы сняты',
  addonsGranted: 'Надстройки выданы',
  addonsRevoked: 'Надстройки сняты',
  person: 'Работник',
  scope: 'Объекты и отделы',
  addons: 'Надстройки доступа',
};

/**
 * Как поле называется в заголовке события («изменены роль и объекты»). Отдельно от подписи строки,
 * потому что перечисление собирает группы: «объекты добавлены» и «объекты сняты» — одна правка
 * состава, и в заголовке она обязана называться один раз, а три части ФИО — просто «ФИО».
 */
const fieldSummaries: Record<UserAuditField, string> = {
  lastName: 'ФИО',
  firstName: 'ФИО',
  middleName: 'ФИО',
  email: 'адрес',
  phone: 'телефон',
  role: 'роль',
  isActive: 'доступ',
  counterparty: 'контрагент',
  objectsAdded: 'объекты',
  objectsRemoved: 'объекты',
  departmentsAdded: 'отделы',
  departmentsRemoved: 'отделы',
  addonsGranted: 'надстройки доступа',
  addonsRevoked: 'надстройки доступа',
  person: 'работник',
  scope: 'объекты и отделы',
  addons: 'надстройки доступа',
};

/** Доступ словами: `is_active` в журнале читают как «пустят ли человека в портал». */
export const userAuditActiveTitles = { on: 'открыт', off: 'закрыт' } as const;

/**
 * Набор действий в query-строке — через запятую.
 *
 * Приёма «список в query» в портале до сих пор не было: все списочные схемы принимают по одному
 * значению фильтра (`status`, `requestType`, `formCode`). Из двух способов взят CSV, а не
 * повторённый параметр `actions=a&actions=b`: повтор Fastify разбирает в массив только пока
 * значений больше одного, и на единственном `actions=user.delete` схема получила бы строку —
 * то есть тип фильтра зависел бы от того, сколько галочек поставил человек.
 *
 * Пустая строка означает «фильтра нет», а не ошибку: снятые галочки — обычное состояние формы, и
 * отвечать на него 400-й значило бы заставлять портал вычищать параметр. Неизвестное действие,
 * наоборот, отвергается — реестр закрытый (Р10), и опечатка в коде действия должна быть видна.
 */
export const auditActionsSchema = z
  .string()
  // Длина от самого реестра: даже весь перечень целиком короче этого предела, а произвольно
  // длинная строка сюда попадать не должна вовсе.
  .max(AUDIT_ACTIONS.join(',').length + 20)
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  // Оба перечня: журнал в портале один, и события каталога полномочий отбираются тем же фильтром,
  // что события учёток. Реестр при этом остаётся закрытым — опечатка в коде действия видна отказом.
  .pipe(z.array(z.enum(AUDIT_ACTIONS)).max(AUDIT_ACTIONS.length));

export const AUDIT_SORT_FIELDS = ['createdAt', 'action'] as const;

/**
 * Фильтры журнала. Период — моментами, а не календарными сутками: записи ложатся с точностью до
 * секунды, и «за сегодня» в подвкладке задаётся границами дня, посчитанными в часовом поясе
 * читателя. Тем же приёмом отбирается период доставки у вывоза мусора.
 */
export const auditQuerySchema = baseListQuery(AUDIT_SORT_FIELDS).extend({
  actions: auditActionsSchema.optional(),
  /** Цель действия: тип сущности и её идентификатор — «вся история вот этого человека». */
  entityType: z.string().trim().max(100).optional(),
  entityId: z.string().trim().max(100).optional(),
  /** Кто действовал: разбор часто начинается с администратора, а не с пострадавшей учётки. */
  actorUserId: uuidSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // ── Отбор по данным учётной записи, над которой действовали (ADR 0109) ──
  // Отбирают по состоянию учётки **сейчас**, а не на момент события: снимка учётки в записи
  // журнала нет, и «кто тогда был механиком» портал не помнит. Читателю это и нужно — вопросы
  // задают про нынешних людей («что меняли у механиков», «что меняли у людей СУ-10»), — но в
  // подвкладке оговорено подписью, чтобы отбор не читался как машина времени.
  targetRole: roleSchema.optional(),
  targetIsActive: booleanFlagSchema,
  targetObjectId: uuidSchema.optional(),
  targetDepartmentId: uuidSchema.optional(),
  targetCounterpartyId: uuidSchema.optional(),
  /**
   * Архивные учётки. Умолчание — `include`, а не общий для списков `exclude` (ADR 0070): журнал
   * по построению рассказывает о прошлом, и самый частый вопрос к нему — «что стало с учёткой,
   * которой больше нет». Список, скрывающий её по умолчанию, отвечал бы «записей нет».
   */
  targetArchive: z.enum(ARCHIVE_FILTERS).default('include'),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

// ── Описатель строки ──
// Строку собирает контракт, а не вёрстка (Р11): правило одно на таблицу, будущий экспорт и любое
// второе место показа, а в вёрстке оно раздвоилось бы при первом же новом действии. Заодно это
// чистая функция от записи — её можно проверить тестом, чего про ячейку таблицы не скажешь.

/** Роль словами; `null` — в metadata её нет или лежит незнакомое значение (переименованная роль). */
function roleTitle(value: unknown): string | null {
  if (value === null) return 'без роли';
  if (typeof value === 'string' && value in roleLabels) return roleLabels[value as Role];
  return null;
}

/** Пара «было → стало». Старые записи хранят только булев признак изменения — там пары нет. */
function changePair(value: unknown): { from: unknown; to: unknown } | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('from' in value) || !('to' in value)) return null;
  return value as { from: unknown; to: unknown };
}

/** Надстройки роли словами; пустой список — «сняты все», и это тоже событие. */
function addonsTitle(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const names = value
    .filter((a): a is RoleAddon => typeof a === 'string' && a in roleAddonLabels)
    .map((a) => roleAddonLabels[a]);
  return names.length > 0 ? `надстройки: ${names.join(', ')}` : 'надстройки сняты';
}

/** Доступ словами: «открыт»/«закрыт». `null` — в metadata лежит не булево значение. */
function activeTitle(value: unknown): string | null {
  if (typeof value !== 'boolean') return null;
  return value ? userAuditActiveTitles.on : userAuditActiveTitles.off;
}

/** Изменение с известными краями; несобравшаяся пара событием не считается. */
function pairChange(
  field: UserAuditField,
  pair: { from: unknown; to: unknown },
  title: (v: unknown) => string | null,
): AuditChangeDto | null {
  const from = title(pair.from);
  const to = title(pair.to);
  return from === null || to === null ? null : { field, from, to };
}

/** «Менялось, а что именно — не записано»: правая часть пустая (ADR 0109). */
function unrecorded(field: UserAuditField): AuditChangeDto {
  return { field, from: null, to: null };
}

/**
 * Изменения, восстановленные из записей, сделанных до ADR 0109.
 *
 * Тогда портал писал в journal либо готовую пару (роль, активность, адрес), либо один признак
 * «менялось» — по нему видно, что трогали, но не видно чего. Признак и превращается в строку с
 * пустой правой частью: экран покажет «Объекты и отделы — значения не сохранены». Придумывать
 * пропущенное нельзя, а молчать о том, что правка была, — значит потерять её из истории вовсе.
 */
function legacyChanges(action: string, metadata: Record<string, unknown>): AuditChangeDto[] {
  const out: AuditChangeDto[] = [];
  const role = changePair(metadata.role);
  if (role) {
    const change = pairChange('role', role, roleTitle);
    out.push(change ?? unrecorded('role'));
  } else if (typeof metadata.role === 'string' || metadata.role === null) {
    // Заведение учётки и одобрение заявки: роль записана одним значением — это «стало».
    const title = roleTitle(metadata.role);
    if (title !== null) out.push({ field: 'role', from: null, to: title });
  } else if (metadata.roleChanged === true) {
    out.push(unrecorded('role'));
  }

  const active = changePair(metadata.isActive);
  if (active) {
    const change = pairChange('isActive', active, activeTitle);
    out.push(change ?? unrecorded('isActive'));
  } else if (typeof metadata.isActive === 'boolean') {
    out.push({ field: 'isActive', from: null, to: activeTitle(metadata.isActive) });
  } else if (metadata.deactivated === true) {
    // Деактивация писалась одним признаком, но значение из него известно: «стало закрыто».
    out.push({ field: 'isActive', from: null, to: userAuditActiveTitles.off });
  }

  // Прежний адрес больше нигде не лежит — в учётке уже новый, и пара из metadata единственная.
  if (typeof metadata.oldEmail === 'string' && typeof metadata.newEmail === 'string') {
    out.push({ field: 'email', from: metadata.oldEmail, to: metadata.newEmail });
  }

  if (metadata.scopeChanged === true) out.push(unrecorded('scope'));
  if (metadata.counterpartyChanged === true) out.push(unrecorded('counterparty'));

  const addons = addonsTitle(metadata.addons);
  if (addons !== null) {
    // Записывался остаток, а не разница: «что у учётки есть теперь». Так и показываем.
    out.push({ field: 'addons', from: null, to: addons });
  } else if (metadata.addonsChanged === true) {
    out.push(unrecorded('addons'));
  }

  // Работник писался идентификаторами: показывать их человеку бессмысленно, но факт замены важен.
  if (action === 'user.driver_person_relinked' && changePair(metadata.person)) {
    out.push(unrecorded('person'));
  }
  return out;
}

/** Строка изменения из `metadata.changes`: поле обязательно, края — строки либо пусто. */
function isChange(value: unknown): value is AuditChangeDto {
  if (!value || typeof value !== 'object') return false;
  const c = value as AuditChangeDto;
  const side = (v: unknown) => v === null || typeof v === 'string';
  return typeof c.field === 'string' && side(c.from) && side(c.to);
}

/**
 * Что событие изменило в учётке — единственный источник расшифровки для таблицы, панели пути и
 * будущего экспорта (ADR 0109).
 *
 * С момента внедрения портал кладёт готовый перечень в `metadata.changes`; всё, что записано
 * раньше, восстанавливается из прежних форм записи. Читателю разница не видна — а именно она и
 * была целью: журнал не должен объяснять, в каком году его писали.
 */
export function auditChangesOf(entry: AuditEntryDto): AuditChangeDto[] {
  const metadata = entry.metadata ?? {};
  const written = metadata.changes;
  if (Array.isArray(written)) return written.filter(isChange);
  return legacyChanges(entry.action, metadata);
}

// ── Описатель событий каталога полномочий ──
//
// Собирается из metadata, а не из `metadata.changes`, и это осознанный отказ от общего механизма.
// Перечень изменений показывает подвкладка учёток, подписывая поля по `userAuditFieldLabels`; поля
// набора (состав прав, совместимые роли) там взяться не могут — это поля другой сущности, и
// незнакомый код поля вёрстка печатает как есть. Поэтому событие каталога отвечает за себя целиком
// одной строкой заголовка: «Полномочие изменено: «Приёмка топлива» — состав прав (+2, −1)».

/** Названия наборов и кодов в metadata — строкой либо ничем: журнал читают и по старым записям. */
function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Длина списка из metadata; не список — «изменений в этой группе не записано». */
function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Группа правки с числами: «состав прав (+2, −1)». Без чисел группа не называется вовсе. */
function group(title: string, added: number, removed: number): string | null {
  if (added === 0 && removed === 0) return null;
  const parts = [added > 0 ? `+${added}` : '', removed > 0 ? `−${removed}` : ''].filter(Boolean);
  return `${title} (${parts.join(', ')})`;
}

/**
 * Что правка сделала с набором — группами, как заголовок правки учётки перечисляет группы полей.
 * Пустой перечень законен: правка одного описания групп не даёт, и заголовок остаётся заголовком.
 */
function grantUpdateGroups(metadata: Record<string, unknown>): string[] {
  const out: string[] = [];
  // Пара «было → стало», как у роли и активности учётки: правка названия — единственная правка
  // набора, у которой обе стороны короткие и читаются целиком.
  if (changePair(metadata.name)) out.push('название');
  if (metadata.descriptionChanged === true) out.push('описание');
  const permissions = group(
    'состав прав',
    countOf(metadata.permissionsAdded),
    countOf(metadata.permissionsRemoved),
  );
  if (permissions) out.push(permissions);
  const roles = group(
    'совместимые роли',
    countOf(metadata.rolesAdded),
    countOf(metadata.rolesRemoved),
  );
  if (roles) out.push(roles);
  return out;
}

/**
 * Строка события каталога. Название набора идёт в заголовок всегда, когда оно записано: у выдачи и
 * отзыва цель события — учётка, её ФИО таблица показывает своей колонкой, и без названия набора
 * строка «Полномочие выдано» не отвечала бы на главный вопрос — какое.
 */
function describeGrantEntry(
  action: GrantAuditAction,
  label: string,
  metadata: Record<string, unknown>,
): string {
  const name = textOf(metadata.grantName) ?? textOf(metadata.grantCode);
  const head = name === null ? label : `${label}: «${name}»`;
  if (action !== 'grant.update') return head;
  const groups = grantUpdateGroups(metadata);
  return groups.length > 0 ? `${head} — ${groups.join(', ')}` : head;
}

/**
 * Заголовок события: что произошло с учёткой или с полномочием, без значений — их показывает
 * `auditChangesOf`.
 *
 * У правки заголовок перечисляет затронутое («изменена: роль, объекты»), потому что правок в один
 * приём бывает по пять-шесть: без перечня строка журнала говорила бы «изменена» обо всём подряд, а
 * со всеми значениями — не помещалась бы в строку таблицы. Перечисляются группы полей, а не сами
 * поля: «объекты добавлены» и «объекты сняты» — одно и то же решение администратора.
 *
 * Действие вне реестра (заявки, техника, справочники) возвращается своим кодом — подвкладка их не
 * показывает, но описатель не должен молчать.
 */
export function describeAuditEntry(entry: AuditEntryDto): string {
  const label = auditActionLabels[entry.action as AuditAction];
  if (label === undefined) return entry.action;
  const metadata = entry.metadata ?? {};
  if (isGrantAuditAction(entry.action)) {
    return describeGrantEntry(entry.action, label, metadata);
  }
  const action = entry.action as UserAuditAction;

  if (action === 'user.register') {
    const requested = metadata.requestedRole;
    const wish =
      typeof requested === 'string' && requested in registrationRoleRequestLabels
        ? registrationRoleRequestLabels[requested as RegistrationRoleRequest]
        : null;
    return wish === null ? label : `${label}: пожелание «${wish}»`;
  }
  if (action !== 'user.update') return label;

  const groups: string[] = [];
  for (const change of auditChangesOf(entry)) {
    const summary = fieldSummaries[change.field as UserAuditField];
    if (summary !== undefined && !groups.includes(summary)) groups.push(summary);
  }
  return groups.length > 0 ? `${label}: ${groups.join(', ')}` : label;
}
