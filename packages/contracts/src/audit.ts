import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';
import { roleLabels, type Role } from './enums';
import {
  registrationRoleRequestLabels,
  type RegistrationRoleRequest,
} from './registration-request';
import { roleAddonLabels, type RoleAddon } from './role-addons';

// ── Аудит действий с учётными записями (ADR 0088) ──
// Журнал `audit_log` пишется всем порталом, но читают его по-разному: история одной заявки едет в
// её карточку (`request-history.ts`), а здесь — административные действия над учётками. Реестр
// действий закрытый и лежит в контрактах: подвкладка показывает не «весь журнал с фильтром», а
// перечисленный список событий, и перечень обязан быть один на сервер, таблицу и будущий экспорт.

/** Строка журнала. `targetName`/`targetEmail` — учётка, над которой действовали (join по `entityId`). */
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
  'auth.email_verified': 'Адрес электронной почты подтверждён',
  'auth.password_reset_requested': 'Запрошено восстановление пароля',
  'auth.password_reset': 'Пароль восстановлен по ссылке из письма',
  'auth.password_change': 'Пароль изменён владельцем учётной записи',
};

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
  .max(USER_AUDIT_ACTIONS.join(',').length + 20)
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  .pipe(z.array(z.enum(USER_AUDIT_ACTIONS)).max(USER_AUDIT_ACTIONS.length));

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

/** Что именно изменила правка учётки — по значениям, а не по булевым флагам. */
function describeUpdate(metadata: Record<string, unknown>): string[] {
  const parts: string[] = [];
  const role = changePair(metadata.role);
  if (role) {
    const from = roleTitle(role.from);
    const to = roleTitle(role.to);
    if (from !== null && to !== null) parts.push(`Смена роли: ${from} → ${to}`);
  }
  const active = changePair(metadata.isActive);
  if (active && typeof active.to === 'boolean') {
    parts.push(active.to ? 'Учётная запись активирована' : 'Учётная запись деактивирована');
  }
  const addons = addonsTitle(metadata.addons);
  if (addons !== null) parts.push(`Изменён доступ: ${addons}`);
  return parts;
}

/**
 * Строка журнала для человека: подпись действия плюс то, что удалось прочитать из metadata.
 *
 * Записи, сделанные до дополнения журнала (Р12), значений не хранят — у них остаётся общая подпись
 * действия («Учётная запись изменена»). Задним числом их не дополняют и здесь не додумывают:
 * честное «изменена» лучше выдуманной роли. Действие вне реестра (заявки, техника, справочники)
 * возвращается своим кодом — подвкладка их не показывает, но описатель не должен молчать.
 */
export function describeAuditEntry(entry: AuditEntryDto): string {
  const action = entry.action as UserAuditAction;
  const label = userAuditActionLabels[action];
  if (label === undefined) return entry.action;
  const metadata = entry.metadata ?? {};

  switch (action) {
    case 'user.register': {
      const requested = metadata.requestedRole;
      const wish =
        typeof requested === 'string' && requested in registrationRoleRequestLabels
          ? registrationRoleRequestLabels[requested as RegistrationRoleRequest]
          : null;
      return wish === null ? label : `${label}: пожелание «${wish}»`;
    }
    case 'user.create':
    case 'user.approve_registration': {
      const role = roleTitle(metadata.role);
      // «Назначена роль» — общая формулировка обоих событий: и заведённая администратором учётка,
      // и одобренная заявка отвечают читателю на один вопрос — какой доступ человек получил.
      const parts = role === null ? [] : [`назначена роль ${role}`];
      const addons = addonsTitle(metadata.addons);
      // Пустой набор надстроек при заведении учётки — не событие: снимать было нечего.
      if (addons !== null && Array.isArray(metadata.addons) && metadata.addons.length > 0) {
        parts.push(addons);
      }
      return parts.length > 0 ? `${label}: ${parts.join(', ')}` : label;
    }
    case 'user.update': {
      const parts = describeUpdate(metadata);
      return parts.length > 0 ? parts.join('; ') : label;
    }
    default:
      return label;
  }
}
