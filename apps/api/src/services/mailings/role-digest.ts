import {
  type SQL,
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import {
  type AudienceMode,
  can,
  COUNTERPARTY_SCOPED_ROLES,
  COUNTERPARTY_TYPE_PERMISSIONS,
  COUNTERPARTY_TYPES,
  type CounterpartyType,
  DEPARTMENT_SCOPED_ROLES,
  type DigestRequestScope,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isPermission,
  OBJECT_SCOPED_ROLES,
  type Permission,
  ROLE_PERMISSIONS,
  ROLES,
  type Role,
} from '@technic/contracts';
import { db } from '../../db/client';
import {
  constructionObjects,
  counterparties,
  departments,
  grantPermissions,
  grantRoles,
  grants,
  mailingScheduleRecipients,
  mailingSchedulePermissions,
  mailingScheduleScopes,
  roleEnum,
  userConstructionObjects,
  userDepartments,
  userGrants,
  users,
} from '../../db/schema';
import { loadPrincipal } from '../../auth/principal';
import type { MailBlock, MailContent } from '../mail-templates';
import type { DigestContext } from './digest-context';
import { digestOnsiteTable, digestTripsDays, type DigestTable } from './digest-waybills';
import { humanDate } from './driver-routes';

/**
 * Ролевая сводка (ADR 0078, ADR 0093; адресация правом — ADR 0111): что оформлено на дни окна,
 * каждому получателю — своё.
 *
 * Письмо у каждого разное, и это главное свойство: одни и те же таблицы под разными людьми
 * возвращают разные строки, потому что собираются их собственной областью видимости. Адрес в
 * расписании отвечает только на вопрос «кому отправлять», а «что показать» решает `Principal`.
 *
 * Пустая сводка не отправляется. «На завтра рейсов нет» — не новость, ради которой стоит писать
 * человеку каждый вечер: такие письма перестают читать, и вместе с ними перестают читать непустые.
 */

/** Получатель сводки: адрес и имя нужны письму, id — сборке его области видимости. */
export interface DigestRecipient {
  userId: string;
  fullName: string;
  email: string;
}

/** Аудитория расписания: три оси отбора, и все — выбор, а не исключение (ADR 0093). */
export interface DigestAudience {
  scopeMode: AudienceMode;
  objectIds: string[];
  departmentIds: string[];
  recipientMode: AudienceMode;
}

/** Отмеченные администратором площадки и отделы рассылки; при режиме «все» перечни пусты. */
export async function digestScopes(
  scheduleId: string,
): Promise<{ objectIds: string[]; departmentIds: string[] }> {
  const rows = await db
    .select({
      objectId: mailingScheduleScopes.objectId,
      departmentId: mailingScheduleScopes.departmentId,
    })
    .from(mailingScheduleScopes)
    .where(eq(mailingScheduleScopes.scheduleId, scheduleId));
  return {
    objectIds: rows.flatMap((r) => (r.objectId ? [r.objectId] : [])),
    departmentIds: rows.flatMap((r) => (r.departmentId ? [r.departmentId] : [])),
  };
}

/**
 * Права-адресаты расписания. Сирота — право, снятое из словаря выкатом, — отсеивается здесь, на
 * границе «база → код», тем же приёмом и по той же причине, что у наборов (`grantPermissionsByUserIds`):
 * никому не сопоставленная строка не должна ни расширять аудиторию, ни ронять рассылку.
 */
export async function schedulePermissions(scheduleId: string): Promise<Permission[]> {
  const rows = await db
    .select({ permission: mailingSchedulePermissions.permission })
    .from(mailingSchedulePermissions)
    .where(eq(mailingSchedulePermissions.scheduleId, scheduleId));
  return rows.map((r) => r.permission).filter(isPermission);
}

/**
 * Роли базы, дающие хотя бы одно из перечисленных прав.
 *
 * **Пересечение с `roleEnum.enumValues` обязательно, и это не перестраховка.** Словарь ролей в
 * контрактах опережает enum базы — роль заводится в коде тем релизом, который её ещё не мигрировал
 * (так сейчас живёт `site`), — а подставленное в `IN` значение, которого в enum'е нет, Postgres не
 * игнорирует: он отвечает «invalid input value for enum role» и роняет весь отбор. Рассылка,
 * падающая от роли, к которой она не имеет отношения, — цена одной пропущенной строки.
 */
function rolesWithAnyPermission(permissions: readonly Permission[]): Role[] {
  const known = new Set<string>(roleEnum.enumValues);
  return ROLES.filter(
    (role) => known.has(role) && permissions.some((p) => ROLE_PERMISSIONS[role].includes(p)),
  );
}

/** Типы контрагента, дающие хотя бы одно из прав, — четвёртый источник `can` (ADR 0038). */
function counterpartyTypesWithAnyPermission(
  permissions: readonly Permission[],
): CounterpartyType[] {
  return COUNTERPARTY_TYPES.filter((type) =>
    permissions.some((p) => COUNTERPARTY_TYPE_PERMISSIONS[type].includes(p)),
  );
}

/**
 * Условие «у учётки есть хотя бы одно из этих прав» — адресация сводки (ADR 0111).
 *
 * **«Любое из», а не «все сразу»**: набор прав складывает аудитории, как складывал их набор ролей.
 * Пересечение сузило бы отбор и прообраза в прежнем поведении не имело бы вовсе.
 *
 * Право считается **эффективным**, и слагаемых поэтому три — ровно те же источники и в том же
 * порядке, что у `can`: роль (`ROLE_PERMISSIONS`), назначенный набор (ADR 0106) и тип контрагента
 * (ADR 0038). Забыть любое значит выкинуть из рассылки человека, который право имеет: держатель
 * набора не получил бы письма, адресованного как раз его работе, а внешний исполнитель — сводки по
 * своему модулю. Матрица разворачивается в список имён ролей прямо в запросе, потому что живёт
 * статикой в коде; наборы и контрагент спрашиваются `EXISTS`-подзапросами.
 *
 * Надстроек роли (`user_role_addons`) здесь нет намеренно: с шага 1c перехода доступ считается по
 * `user_grants`, куда надстройки отражаются двойной записью (ADR 0106, шаг 1a). Второй источник
 * того же права давал бы тот же ответ и разошёлся бы с принципалом на шаге 1d.
 *
 * Экспортируется, потому что тем же условием форма показывает администратору, кого зацепит
 * расписание (`GET /admin/mail/recipient-candidates`), и им же считает обе стороны сверка
 * аудитории. Три похожих запроса на один вопрос разошлись бы молча.
 */
export function permissionAudienceWhere(permissions: readonly Permission[]): SQL {
  // Пустой адрес — «никому»: разослать всем при недосмотре хуже, чем не разослать никому.
  if (permissions.length === 0) return sql`false`;

  const roles = rolesWithAnyPermission(permissions);
  const types = counterpartyTypesWithAnyPermission(permissions);
  const parts: (SQL | undefined)[] = [];
  if (roles.length > 0) parts.push(inArray(users.role, roles));
  if (types.length > 0) {
    // Тип контрагента читается только у ролей от контрагента — как и в `can`: у остальных ролей
    // поле заполнено бывает (учётку переводили), но прав не даёт.
    parts.push(
      and(
        inArray(users.role, [...COUNTERPARTY_SCOPED_ROLES]),
        exists(
          db
            .select({ one: sql`1` })
            .from(counterparties)
            .where(
              and(eq(counterparties.id, users.counterpartyId), inArray(counterparties.type, types)),
            ),
        ),
      ),
    );
  }
  parts.push(
    exists(
      db
        .select({ one: sql`1` })
        .from(userGrants)
        .innerJoin(grants, eq(grants.id, userGrants.grantId))
        // Гейт совместимости с ролью — то же соединение и по той же причине, что в
        // `grantPermissionsExpr`: набор, выданный до смены роли, прав больше не даёт.
        .innerJoin(
          grantRoles,
          and(eq(grantRoles.grantId, userGrants.grantId), eq(grantRoles.role, users.role)),
        )
        .innerJoin(grantPermissions, eq(grantPermissions.grantId, userGrants.grantId))
        .where(
          and(
            eq(userGrants.userId, users.id),
            // Мягко удалённый набор не действует ни у кого — тем же правилом, что в `grantCodesExpr`.
            isNull(grants.deletedAt),
            inArray(grantPermissions.permission, [...permissions]),
          ),
        ),
    ),
  );
  return or(...parts)!;
}

/**
 * Кому уходит сводка по этому расписанию.
 *
 * Три отбора подряд, ровно в том порядке, в каком их задаёт форма: право, область, поимённый
 * перечень. Условие получателя сверх них одно и неизменное — действующая учётка с **подтверждённым
 * адресом** (ADR 0072): сводка это рабочие данные компании, и слать их «куда-то» нельзя.
 *
 * Отбор по площадкам и отделам не отсекает тех, у кого этой оси нет вовсе (диспетчер, менеджер,
 * руководитель строительства): вычитать из области, которой не существует, нечего, и «выбрал
 * Северный» не должно означать «выбросил диспетчера».
 *
 * **Адрес — право, а не имя роли** (ADR 0111, решение заказчика №3 от 17.08.2026; §11.1 плана
 * реструктуризации прав). Прежняя адресация ломалась от перевода ролей двумя тихими способами:
 * расписание с упразднённой ролью не сопоставлялось никому — письма переставали приходить, не
 * сообщив об этом ни разу, — а слияние ролей, отмеченных в расписании по отдельности («Штаб» без
 * «Коменданта»), расширяло аудиторию на тех, кого администратор из неё исключал. Право обоих
 * свойств не имеет: переименование и слияние ролей его не касаются, а появление новой роли меняет
 * аудиторию ровно тогда, когда роли выдали это самое право.
 */
export async function digestRecipients(
  scheduleId: string,
  audience: DigestAudience,
): Promise<DigestRecipient[]> {
  const permissions = await schedulePermissions(scheduleId);
  if (permissions.length === 0) return [];
  return digestRecipientsBy(scheduleId, audience, permissionAudienceWhere(permissions));
}

/**
 * Тот же отбор, но с произвольным условием адреса.
 *
 * Заведено ради сверки аудитории (`backfill:mailing-audience`): «до» и «после» обязаны считаться
 * одним и тем же кодом, отличаясь ровно одним — адресом. Собери сверка вторую копию отбора, и
 * совпадение списков доказывало бы совпадение двух её половин, а не переезда.
 */
export async function digestRecipientsBy(
  scheduleId: string,
  audience: DigestAudience,
  address: SQL,
): Promise<DigestRecipient[]> {
  const selected =
    audience.recipientMode === 'selected'
      ? (
          await db
            .select({ userId: mailingScheduleRecipients.userId })
            .from(mailingScheduleRecipients)
            .where(eq(mailingScheduleRecipients.scheduleId, scheduleId))
        ).map((r) => r.userId)
      : null;
  // Режим «перечисленные» с пустым перечнем контракт не пропускает; случись он в базе, письма не
  // уйдут никому — это честнее, чем разослать всем.
  if (selected !== null && selected.length === 0) return [];

  const rows = await db
    .select({ userId: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(
      and(
        address,
        eq(users.isActive, true),
        isNull(users.deletedAt),
        isNotNull(users.emailVerifiedAt),
        selected !== null ? inArray(users.id, selected) : undefined,
        recipientScopeWhere(audience),
      ),
    );
  return rows;
}

/**
 * Условие «учётка относится к отмеченным площадкам или отделам, либо этой оси у неё нет».
 *
 * Экспортируется, потому что тем же условием форма показывает администратору, кого зацепит
 * расписание (`GET /admin/mail/recipient-candidates`). Два похожих запроса на один вопрос
 * разошлись бы молча — и в форме стояла бы одна цифра, а письма ушли бы другим людям.
 */
export function recipientScopeWhere(
  audience: Pick<DigestAudience, 'scopeMode' | 'objectIds' | 'departmentIds'>,
) {
  if (audience.scopeMode !== 'selected') return undefined;
  const placeScoped = [...OBJECT_SCOPED_ROLES, ...DEPARTMENT_SCOPED_ROLES];
  const parts = [notInArray(users.role, placeScoped)];
  if (audience.objectIds.length > 0) {
    parts.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(userConstructionObjects)
          .where(
            and(
              eq(userConstructionObjects.userId, users.id),
              inArray(userConstructionObjects.constructionObjectId, audience.objectIds),
            ),
          ),
      ),
    );
  }
  if (audience.departmentIds.length > 0) {
    parts.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(userDepartments)
          .where(
            and(
              eq(userDepartments.userId, users.id),
              inArray(userDepartments.departmentId, audience.departmentIds),
            ),
          ),
      ),
    );
  }
  return or(...parts);
}

export interface RoleDigestMail {
  subject: string;
  content: MailContent;
  /** Сколько строк вошло в письмо: по нему видно, ради чего оно отправлено. */
  rowCount: number;
}

/**
 * Собирает сводку для одного получателя. `null` — показывать нечего: либо учётка не действует, либо
 * модуль ей не положен, либо под его областью в окне ничего не оформлено.
 */
export async function buildRoleDigestMail(input: {
  recipient: DigestRecipient;
  windowFrom: string;
  windowTo: string;
  requestScope: DigestRequestScope;
  showTrips: boolean;
  showOnsite: boolean;
  scopeMode: AudienceMode;
  objectIds: string[];
  departmentIds: string[];
}): Promise<RoleDigestMail | null> {
  // Principal читается в момент сборки, а не берётся из кэша: область видимости меняют правкой
  // учётки, и вчерашний набор объектов сегодня уже может быть другим.
  const principal = await loadPrincipal(input.recipient.userId);
  if (!principal) return null;
  // Сводка целиком про заявки на технику: нет права на модуль — письма нет вовсе. Проверка стоит
  // до запросов, потому что «пусто» и «нельзя» — разные состояния, и путать их значит однажды
  // показать чужие данные из-за одной забытой строчки.
  if (!can(principal, 'vehicleRequests.read')) return null;

  const ctx: DigestContext = {
    principal,
    windowFrom: input.windowFrom,
    windowTo: input.windowTo,
    requestScope: input.requestScope,
    scopeMode: input.scopeMode,
    objectIds: input.objectIds,
    departmentIds: input.departmentIds,
  };

  const [days, onsite] = await Promise.all([
    input.showTrips ? digestTripsDays(ctx) : Promise.resolve([]),
    input.showOnsite ? digestOnsiteTable(ctx) : Promise.resolve(null),
  ]);
  const trips = days.reduce((sum, d) => sum + d.table.total, 0);
  const units = onsite?.total ?? 0;
  if (trips === 0 && units === 0) return null;

  const singleDay = input.windowFrom === input.windowTo;
  const blocks: MailBlock[] = [{ kind: 'paragraph', text: await scopeLine(ctx) }];

  for (const day of days) {
    blocks.push({
      kind: 'heading',
      // У окна в один день дата уже стоит в теме и в заголовке письма — второй раз она не нужна.
      text: singleDay
        ? `${day.table.title} — ${trips}`
        : `${humanDate(day.date)} — ${day.table.total} ${plural(day.table.total, TRIPS_WORDS)}`,
    });
    blocks.push(...tableBlocks(day.table));
  }
  if (onsite) {
    blocks.push({ kind: 'heading', text: `${onsite.title} — ${onsite.total}` });
    blocks.push(...tableBlocks(onsite));
  }

  const period = singleDay
    ? `на ${humanDate(input.windowFrom)}`
    : `на ${humanDate(input.windowFrom, false)} — ${humanDate(input.windowTo, false)}`;
  const counts = [
    trips > 0 ? `${trips} ${plural(trips, TRIPS_WORDS)}` : '',
    units > 0 ? `${units} ${plural(units, UNITS_WORDS)} на объектах` : '',
  ]
    .filter(Boolean)
    .join(', ');

  return {
    subject: `Сводка ${period}: ${counts}`,
    content: {
      title: `Сводка ${period}`,
      blocks,
      footer: 'Письмо отправлено порталом «Техник». Состав сводки настраивает администратор.',
    },
    rowCount: trips + units,
  };
}

/**
 * Таблица и, если строк больше лимита, счётчик со ссылкой на полный список. Счётчик стоит после
 * таблицы, а не вместо неё: письмо — повод открыть портал, но первые строки человек читает здесь.
 */
function tableBlocks(table: DigestTable): MailBlock[] {
  const blocks: MailBlock[] = [];
  // Пояснение стоит перед таблицей, а не под ней: оно отвечает на вопрос, который у читателя
  // возникнет на первой же паре строк, и снизу оно опоздает.
  if (table.note) blocks.push({ kind: 'paragraph', text: table.note });
  blocks.push({ kind: 'table', head: table.head, rows: table.rows });
  if (table.total > table.rows.length) {
    const rest = table.total - table.rows.length;
    blocks.push({ kind: 'paragraph', text: `…и ещё ${rest} — смотреть в портале` });
    blocks.push({ kind: 'link', href: table.link, label: `${table.title}: полный список` });
  }
  return blocks;
}

/**
 * Первая строка письма: чьими глазами оно собрано. Без неё сводка штаба и сводка диспетчера
 * выглядят одинаково, а разница между ними — в том, чего в письме нет.
 */
async function scopeLine(ctx: DigestContext): Promise<string> {
  if (ctx.requestScope === 'author') return 'Охват: заявки, поданные вами';

  const names = await ownScopeNames(ctx);
  if (names.length > 0) return `Охват: ${names.join(', ')}`;
  return ctx.requestScope === 'all' && ctx.scopeMode === 'selected'
    ? 'Охват: отмеченные в рассылке площадки и отделы'
    : 'Охват: все площадки и отделы рассылки';
}

/** Названия своих площадок или отделов: у ролей без такой оси их нет, и строка будет общей. */
async function ownScopeNames(ctx: DigestContext): Promise<string[]> {
  const { principal } = ctx;
  if (isObjectScopedRole(principal.role) && principal.constructionObjectIds.length > 0) {
    const rows = await db
      .select({ name: constructionObjects.name })
      .from(constructionObjects)
      .where(inArray(constructionObjects.id, principal.constructionObjectIds));
    return rows.length > 0 ? [`ваши площадки — ${rows.map((r) => r.name).join(', ')}`] : [];
  }
  if (isDepartmentScopedRole(principal.role) && principal.departmentIds.length > 0) {
    const rows = await db
      .select({ name: departments.name })
      .from(departments)
      .where(inArray(departments.id, principal.departmentIds));
    return rows.length > 0 ? [`ваши отделы — ${rows.map((r) => r.name).join(', ')}`] : [];
  }
  return [];
}

const TRIPS_WORDS = ['перевозка', 'перевозки', 'перевозок'] as const;
const UNITS_WORDS = ['единица', 'единицы', 'единиц'] as const;

function plural(count: number, words: readonly [string, string, string]): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return words[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return words[1];
  return words[2];
}
