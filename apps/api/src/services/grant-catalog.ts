import { createHash } from 'node:crypto';
import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  effectiveDelta,
  grantImpactCanonical,
  isPermission,
  permissionsFor,
  PERMISSIONS,
  ROLES,
  validateGrantAssignment,
  type AccessSubject,
  type CounterpartyType,
  GRANT_CONFLICT_CODES,
  MAX_ASSIGNED_GRANTS,
  roleLabels,
  type GrantAssignmentOperation,
  type GrantCardDto,
  type GrantDto,
  type GrantHolderDto,
  type GrantHolderViolationsDto,
  type GrantImpactDto,
  type GrantImpactInput,
  type GrantImpactUserDto,
  type GrantOrigin,
  type GrantStatement,
  type GrantViolation,
  type Permission,
  type PermissionDelta,
  type Role,
} from '@technic/contracts';
import { err } from '../lib/errors';
import type { db } from '../db/client';
import {
  counterparties,
  grantPermissions,
  grantRoles,
  grants,
  type GrantRow,
  userGrants,
  users,
} from '../db/schema';
import { grantCodesByUserIds, systemAddonsOf } from './user-scopes';

/**
 * Каталог назначаемых полномочий со стороны сервера (ADR 0106, этап 3): чтение состава, реестр
 * выдач, блокировки и пересчёт эффективных прав держателей.
 *
 * **Зачем отдельный файл от маршрута.** Маршрут отвечает за порядок шагов операции, а здесь лежит
 * то, что обязано быть одинаковым у всех операций каталога и у будущей выдачи назначения: порядок
 * блокировок «набор → учётки», гейт совместимости с ролью при пересчёте прав и разбор строк-сирот.
 * Разложенные по обработчикам, эти три правила расходятся с первой же новой ручкой — так уже вышло
 * с `FOR UPDATE` у заявок ТС (ADR 0050 п. 12), после чего порядок захвата свели в один модуль.
 *
 * Чего здесь нет: самих проверок выдачи. Барьеры считает `validateGrantAssignment` в контрактах —
 * один ответ на API, конструктор и тесты; здесь только собирается его вход.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читатель: список наборов спрашивают вне транзакции, правка — внутри своей. */
type Reader = typeof db | Tx;

/** Автор выдачи в реестре: `users` в том же запросе занят держателем. */
const grantors = alias(users, 'grant_grantors');

/** Состав набора, разобранный словарём прав: действующие права и строки-сироты по отдельности. */
export interface GrantComposition {
  /** Порядок — словарный (`PERMISSIONS`): каталог читают глазами, и он не должен переставляться. */
  permissions: Permission[];
  /** Право, которого в словаре больше нет (выкат снял его, строка осталась): доступа не даёт. */
  unknownPermissions: string[];
  /** Порядок — по словарю `ROLES`, а не по ответу базы: `role` — enum, и база сортирует его своим. */
  roles: Role[];
}

function emptyComposition(): GrantComposition {
  return { permissions: [], unknownPermissions: [], roles: [] };
}

/**
 * Права и роли пачки наборов двумя запросами, а не запросом на строку каталога.
 *
 * Разбор строк-сирот стоит здесь, на границе «база → код», — тем же приёмом и в том же месте, что у
 * принципала (`loadPrincipal`): дальше по коду фильтровать нечего, и тип это обещает.
 */
export async function compositionByGrantIds(
  reader: Reader,
  grantIds: readonly string[],
): Promise<Map<string, GrantComposition>> {
  const map = new Map<string, GrantComposition>();
  if (grantIds.length === 0) return map;
  const ids = [...grantIds];
  const composition = (grantId: string): GrantComposition => {
    const found = map.get(grantId);
    if (found) return found;
    const fresh = emptyComposition();
    map.set(grantId, fresh);
    return fresh;
  };
  const [permissionRows, roleRows] = await Promise.all([
    reader
      .select({ grantId: grantPermissions.grantId, permission: grantPermissions.permission })
      .from(grantPermissions)
      .where(inArray(grantPermissions.grantId, ids)),
    reader
      .select({ grantId: grantRoles.grantId, role: grantRoles.role })
      .from(grantRoles)
      .where(inArray(grantRoles.grantId, ids)),
  ]);
  // Собирается по множествам, а сортируется перебором словарей: у обоих словарей порядок закрыт и
  // осмыслен (модули витрины у прав, старшинство у ролей), а `sort()` дал бы алфавит кодов.
  const permissionSets = new Map<string, Set<string>>();
  for (const row of permissionRows) {
    const set = permissionSets.get(row.grantId) ?? new Set<string>();
    set.add(row.permission);
    permissionSets.set(row.grantId, set);
  }
  for (const [grantId, set] of permissionSets) {
    const target = composition(grantId);
    target.permissions = PERMISSIONS.filter((permission) => set.has(permission));
    target.unknownPermissions = [...set].filter((permission) => !isPermission(permission)).sort();
  }
  const roleSets = new Map<string, Set<Role>>();
  for (const row of roleRows) {
    const set = roleSets.get(row.grantId) ?? new Set<Role>();
    set.add(row.role);
    roleSets.set(row.grantId, set);
  }
  for (const [grantId, set] of roleSets) {
    composition(grantId).roles = ROLES.filter((role) => set.has(role));
  }
  for (const id of ids) if (!map.has(id)) map.set(id, emptyComposition());
  return map;
}

/**
 * Число держателей у пачки наборов. Считаются **все** живые назначения, включая выданные учёткам в
 * архиве и без доступа в портал: восстановление такой учётки возвращает ей права набора, и удаление
 * набора «пока держатель выключен» отобрало бы их молча. То же число объясняет отказ удаления (§13.1).
 */
export async function holderCountByGrantIds(
  reader: Reader,
  grantIds: readonly string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (grantIds.length === 0) return map;
  const rows = await reader
    .select({ grantId: userGrants.grantId, c: count() })
    .from(userGrants)
    .where(inArray(userGrants.grantId, [...grantIds]))
    .groupBy(userGrants.grantId);
  for (const row of rows) map.set(row.grantId, Number(row.c));
  return map;
}

/** Держатель набора вместе с тем, что нужно пересчёту прав: роль и тип контрагента. */
export interface HolderRow extends GrantHolderDto {
  /** Тип контрагента держателя: без него `can` не посчитает права внешнего исполнителя (ADR 0038). */
  counterpartyType: CounterpartyType | null;
  /**
   * Версия токенов держателя — слагаемое отпечатка последствий (решение 7): ею ловится смена роли
   * или другого набора у держателя между предпросмотром и сохранением. Читается той же строкой, что
   * роль: второй запрос за ней прочитал бы значение, к которому расчёт уже не относится.
   */
  authVersion: number;
}

/**
 * Реестр выдач одного набора — держатели по возрастанию `user_id`.
 *
 * **Порядок не косметический: по нему берутся блокировки.** Правило блокировок (ADR 0106,
 * решение 7) требует захватывать учётки по возрастанию идентификатора, и порядок обхода реестра —
 * тот же самый список. Отсортируй витрину по ФИО, а блокировки по `user_id` — и два порядка
 * разъедутся при первой правке, которая начнёт брать строки в порядке показа.
 *
 * `roleMismatch` считается здесь, а не экраном: роль, убранная из `grant_roles`, оставляет выдачу
 * живой (§13.1), но прав по ней набор больше не даёт — гейт совместимости стоит в самом выражении
 * чтения (`grantPermissionsExpr`).
 */
export async function holdersOfGrant(
  reader: Reader,
  grantId: string,
  allowedRoles: readonly Role[],
): Promise<HolderRow[]> {
  const allowed = new Set<Role>(allowedRoles);
  const rows = await reader
    .select({
      assignmentId: userGrants.id,
      userId: userGrants.userId,
      fullName: users.fullName,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      deletedAt: users.deletedAt,
      counterpartyType: counterparties.type,
      authVersion: users.authVersion,
      grantedAt: userGrants.grantedAt,
      grantedByName: grantors.fullName,
      origin: userGrants.origin,
    })
    .from(userGrants)
    .innerJoin(users, eq(users.id, userGrants.userId))
    .leftJoin(counterparties, eq(counterparties.id, users.counterpartyId))
    .leftJoin(grantors, eq(grantors.id, userGrants.grantedBy))
    .where(eq(userGrants.grantId, grantId))
    .orderBy(asc(userGrants.userId));
  return rows.map((row) => ({
    assignmentId: row.assignmentId,
    userId: row.userId,
    fullName: row.fullName,
    email: row.email,
    role: row.role,
    roleMismatch: row.role !== null && !allowed.has(row.role),
    isActive: row.isActive,
    isArchived: row.deletedAt !== null,
    grantedAt: row.grantedAt.toISOString(),
    grantedByName: row.grantedByName,
    origin: row.origin as GrantOrigin,
    counterpartyType: row.counterpartyType,
    authVersion: row.authVersion,
  }));
}

/** Держатель без служебных полей пересчёта — то, что уходит в ответ. */
export function holderDtoOf(row: HolderRow): GrantHolderDto {
  const { counterpartyType: _counterpartyType, authVersion: _authVersion, ...dto } = row;
  return dto;
}

/**
 * Строка набора под `FOR UPDATE` — **первый** шаг любой операции каталога (ADR 0106, решение 7,
 * шаг 1).
 *
 * Блокировки только учёток недостаточно: редактор набора берёт уже найденных держателей, а
 * параллельная выдача добавляет нового, которого в списке ещё нет, — транзакции не встречаются, и
 * новый держатель получает состав, который в этот момент перестал существовать. Поэтому сериализация
 * начинается со строки набора, и начинается ею у **всех** операций, включая будущую выдачу.
 */
export async function lockGrant(tx: Tx, grantId: string): Promise<GrantRow | undefined> {
  const [row] = await tx.select().from(grants).where(eq(grants.id, grantId)).for('update');
  return row;
}

/**
 * Строки затронутых учёток под `FOR UPDATE` — **второй** шаг, по возрастанию `user_id` (решение 7,
 * шаг 2).
 *
 * По одной строке в цикле, а не одним `WHERE id IN (…) ORDER BY id`: план запроса вправе брать
 * строки в своём порядке (Postgres не обещает, что блокировки лягут в порядке `ORDER BY`), и две
 * встречные операции с пересекающимися держателями получили бы дедлок — то, ради предотвращения
 * чего порядок и объявлен. Тем же приёмом берутся рейсы одного дня (`lockRouteIds`).
 *
 * Возвращается `authVersion` каждой учётки: он читается той же строкой, и второй запрос за ним
 * прочитал бы уже другое значение.
 */
export async function lockUsers(
  tx: Tx,
  userIds: readonly string[],
): Promise<Map<string, { role: Role | null; authVersion: number }>> {
  const locked = new Map<string, { role: Role | null; authVersion: number }>();
  for (const userId of [...new Set(userIds)].sort()) {
    const [row] = await tx
      .select({ role: users.role, authVersion: users.authVersion })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (row) locked.set(userId, row);
  }
  return locked;
}

/**
 * `authVersion + 1` затронутым учёткам — в той же транзакции, что правка состава (решение 7, шаг 5).
 *
 * Access-токен сверяется с `authVersion` на каждом запросе, и правка состава без поднятой версии
 * начала бы действовать не тогда, когда её сохранили, а когда истёк последний выданный токен:
 * снятое право ещё несколько минут работает, добавленное — ещё не работает. По возрастанию `user_id`
 * — тем же порядком, каким взяты блокировки.
 */
export async function bumpAuthVersions(tx: Tx, userIds: readonly string[]): Promise<void> {
  const ids = [...new Set(userIds)].sort();
  if (ids.length === 0) return;
  await tx
    .update(users)
    .set({ authVersion: sql`${users.authVersion} + 1`, updatedAt: new Date() })
    .where(inArray(users.id, ids));
}

/**
 * Права, которые дают держателям **остальные** их наборы, — половина будущего итога.
 *
 * Запрос повторяет `grantPermissionsByUserIds` с одним отличием — исключением правимого набора, — и
 * это отличие принципиально: вычесть состав набора из общего итога нельзя, потому что то же право
 * штатно лежит во втором наборе учётки, и вычитание отобрало бы его у итога, оставив в базе.
 *
 * Гейт совместимости с ролью (соединение с `grant_roles`) стоит здесь по той же причине, по которой
 * он стоит в выражении чтения: набор, выданный до смены роли, прав не даёт, и пересчёт обязан
 * отвечать ровно то, что ответит принципал следующему запросу.
 */
async function otherGrantPermissions(
  reader: Reader,
  grantId: string,
  userIds: readonly string[],
): Promise<Map<string, Permission[]>> {
  const map = new Map<string, Permission[]>();
  if (userIds.length === 0) return map;
  const rows = await reader
    .selectDistinct({ userId: userGrants.userId, permission: grantPermissions.permission })
    .from(userGrants)
    .innerJoin(grants, eq(grants.id, userGrants.grantId))
    .innerJoin(users, eq(users.id, userGrants.userId))
    .innerJoin(
      grantRoles,
      and(eq(grantRoles.grantId, userGrants.grantId), eq(grantRoles.role, users.role)),
    )
    .innerJoin(grantPermissions, eq(grantPermissions.grantId, userGrants.grantId))
    .where(
      and(
        inArray(userGrants.userId, [...userIds]),
        isNull(grants.deletedAt),
        ne(userGrants.grantId, grantId),
      ),
    );
  for (const row of rows) {
    if (!isPermission(row.permission)) continue;
    const list = map.get(row.userId) ?? [];
    list.push(row.permission);
    map.set(row.userId, list);
  }
  return map;
}

/** Итог операции у одного держателя — вход барьеров, считающихся по итогу. */
export interface HolderOutcome {
  userId: string;
  fullName: string;
  role: Role | null;
  /** Эффективные права **после** операции: роль ⊕ надстройки ⊕ все наборы ⊕ тип контрагента. */
  permissionsAfter: Permission[];
  /**
   * Что реально появится и реально уйдёт у этого держателя (`effectiveDelta`) — то, что показывает
   * предпросмотр. Считается по обоим субъектам целиком, а не разницей составов набора: право,
   * которое держателю и так даёт роль, из набора уходит, а из доступа — нет.
   */
  delta: PermissionDelta;
}

/**
 * Эффективные права держателей после операции — то, что требуют барьеры итога (ADR 0106,
 * решение 6, инварианты 3 и 4; план §13.1).
 *
 * **Считается итог субъекта, а не состав набора, и подменять одно другим нельзя.** Системный
 * «Оператор (оргтехника)» — прямое доказательство: `officeEquipment.write` даёт он, а
 * `officeEquipment.read` приходит от базовой роли; набор сам по себе инвариант «модуль закрывается
 * чтением» нарушает, субъект — нет. С разделением обязанностей то же самое с другой стороны:
 * составление сметы может лежать в одном полномочии, утверждение — в другом, и по отдельности оба
 * безупречны.
 *
 * Итог собирается подстановкой одного изменившегося слагаемого: права остальных наборов читаются из
 * базы, а вклад правимого берётся из **предлагаемого** состава — и только если роль держателя есть
 * в предлагаемом списке ролей. Убрали роль из списка — набор перестаёт давать ей права, и итог это
 * показывает; `can` спросит то же самое у выражения чтения.
 *
 * Зовётся уже **под блокировками**: между чтением состояния и записью не должно быть окна, в
 * котором посчитанный итог перестаёт быть правдой.
 */
export async function outcomesOfHolders(
  reader: Reader,
  params: {
    grantId: string;
    holders: readonly HolderRow[];
    /** Нынешний состав набора — левая сторона дельты («что у держателя есть сейчас»). */
    before: { permissions: readonly Permission[]; roles: readonly Role[] };
    /** Предлагаемый состав — правая сторона дельты и вход барьеров итога. */
    after: { permissions: readonly Permission[]; roles: readonly Role[] };
  },
): Promise<HolderOutcome[]> {
  const userIds = params.holders.map((holder) => holder.userId);
  const [others, codes] = await Promise.all([
    otherGrantPermissions(reader, params.grantId, userIds),
    // Пометки рядом с ролью (надстройки) — производное от кодов наборов учётки (шаг 1c), и `can`
    // спрашивает их наравне с правами: на переходных шагах одна выдача видна и надстройкой, и
    // набором. Правимый набор пользовательский, системных кодов в нём нет, поэтому его правка эту
    // половину итога не меняет — но собрать субъекта без неё значило бы посчитать держателю
    // системного набора меньше прав, чем у него есть.
    grantCodesByUserIds(reader, userIds),
  ]);
  const allowedBefore = new Set<Role>(params.before.roles);
  const allowedAfter = new Set<Role>(params.after.roles);
  return params.holders.map((holder) => {
    // Вклад правимого набора — только если роль держателя есть в **соответствующем** списке ролей:
    // до правки в нынешнем, после — в предлагаемом. Убрали роль из списка — набор перестаёт давать
    // ей права, и обе стороны дельты это показывают (гейт совместимости, `grantPermissionsExpr`).
    const contribution = (allowed: ReadonlySet<Role>, composition: readonly Permission[]) =>
      holder.role !== null && allowed.has(holder.role) ? composition : [];
    const subjectWith = (permissions: readonly Permission[]): AccessSubject => ({
      role: holder.role,
      counterpartyType: holder.counterpartyType,
      addons: systemAddonsOf(codes.get(holder.userId) ?? []),
      grantPermissions: [
        ...new Set<Permission>([...(others.get(holder.userId) ?? []), ...permissions]),
      ],
    });
    const before = subjectWith(contribution(allowedBefore, params.before.permissions));
    const after = subjectWith(contribution(allowedAfter, params.after.permissions));
    return {
      userId: holder.userId,
      fullName: holder.fullName,
      role: holder.role,
      permissionsAfter: [...permissionsFor(after)],
      delta: effectiveDelta(before, after),
    };
  });
}

// ── Выдача и отзыв назначения: состояние учётки, дельта и отпечаток (решение 7; план §13.1) ──

/**
 * Отпечаток последствий — sha256 канонической строки, объявленной контрактами (`grantImpactCanonical`).
 *
 * Хеш считает сервер, а не портал: портал получает отпечаток предпросмотром и возвращает как есть.
 * Считается он **дважды** — предпросмотром по свежему чтению и операцией уже под блокировками, из
 * присланного тела; несовпадение означает, что показанный расчёт больше не описывает то, что
 * применится (§13.1).
 */
export function grantImpactHash(input: GrantImpactInput): string {
  return createHash('sha256').update(grantImpactCanonical(input), 'utf8').digest('hex');
}

/**
 * Ответ предпросмотра. Собирается одной функцией на все операции затем, чтобы отпечаток считался из
 * **того же** входа, из которого взяты показанные `version` и `users`: разложенные по обработчикам,
 * эти два места разъезжаются первой же правкой — и отпечаток начинает подтверждать не то, что видно
 * на экране.
 */
export function grantImpactDtoOf(params: {
  input: GrantImpactInput;
  grantCode: string;
  grantName: string;
  users: GrantImpactUserDto[];
  violations: readonly GrantViolation[];
  holders: readonly GrantHolderViolationsDto[];
}): GrantImpactDto {
  return {
    operation: params.input.operation,
    grantId: params.input.grantId,
    grantCode: params.grantCode,
    grantName: params.grantName,
    userId: params.input.userId,
    version: params.input.version,
    users: params.users,
    violations: [...params.violations],
    holders: [...params.holders],
    expectedImpactHash: grantImpactHash(params.input),
  };
}

/**
 * Сверка присланного подтверждения со свежим отпечатком — **под блокировками** и из присланного тела
 * (решение 7). Одна функция на правку, выдачу и отзыв: сообщение про устаревший предпросмотр обязано
 * быть одним, иначе портал различал бы три исхода, у которых исход один — перечитать и посмотреть
 * предпросмотр заново.
 *
 * 409 со своим кодом, а не `version_conflict`: состав набора мог вообще не меняться — набор тем
 * временем выдали ещё одному человеку, и версия совпадает.
 */
export function assertImpactUnchanged(input: GrantImpactInput, expected: string): void {
  const actual = grantImpactHash(input);
  if (actual === expected) return;
  throw err.conflict(
    'Последствия операции изменились, пока вы подтверждали: состав набора, его держатели или их доступ уже не те, что показывал предпросмотр. Откройте карточку заново и посмотрите предпросмотр ещё раз.',
    { code: GRANT_CONFLICT_CODES.impactChanged },
  );
}

/**
 * Вклад одного набора в субъекта: код (пометки рядом с ролью) и права под гейтом совместимости.
 *
 * Собственного `id` здесь нет намеренно: у выдачи правая сторона расчёта содержит назначение, которого
 * ещё не существует, и выдуманный идентификатор пришлось бы отличать от настоящего при каждом чтении.
 */
export interface GrantContribution {
  code: string;
  /** Роль держателя есть в `grant_roles` этого набора: иначе прав он не даёт вовсе. */
  compatible: boolean;
  permissions: readonly Permission[];
}

/** Живое назначение учётки — вклад набора плюс то, чем назначение опознаётся. */
export interface UserAssignment extends GrantContribution {
  assignmentId: string;
  grantId: string;
  name: string;
  /**
   * Кем выдано: администратором или переводом ролей. В журнал отзыва идёт именно оно — «снято
   * выданное вручную» и «снято выданное переводом» это разные события, и различить их после удаления
   * строки будет уже нечем.
   */
  origin: GrantOrigin;
}

/** Учётка глазами операции над её полномочиями. */
export interface UserGrantState {
  userId: string;
  fullName: string;
  role: Role | null;
  counterpartyType: CounterpartyType | null;
  /** Слагаемое отпечатка: смену роли или другого набора у этой учётки ловит именно оно. */
  authVersion: number;
  /** Учётка в архиве (ADR 0070): полномочия ей не выдаются, но выданные остаются за ней. */
  isArchived: boolean;
  /** **Все** живые назначения по возрастанию `user_grants.id` — в том же порядке они входят в отпечаток. */
  assignments: UserAssignment[];
}

/**
 * Учётка вместе со всеми её назначениями — вход дельты, барьеров итога и отпечатка.
 *
 * Читаются **все** наборы учётки, а не один правимый, и это требование §13.1: конфликт обязанностей
 * возникает суммой двух наборов, и «модуль закрывается чтением» тоже считается по сумме. Мягко
 * удалённые наборы отсеиваются тем же правилом, что в `grantCodesExpr`: они не действуют ни у кого.
 *
 * Зовётся у операции **под блокировками** (строка набора, затем строка учётки), у предпросмотра —
 * без них: предпросмотр обязан показать нынешнее состояние и не имеет права держать чужие строки
 * между показом экрана и нажатием кнопки.
 */
export async function userGrantStateOf(
  reader: Reader,
  userId: string,
): Promise<UserGrantState | null> {
  const [account] = await reader
    .select({
      id: users.id,
      fullName: users.fullName,
      role: users.role,
      counterpartyType: counterparties.type,
      authVersion: users.authVersion,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .leftJoin(counterparties, eq(counterparties.id, users.counterpartyId))
    .where(eq(users.id, userId));
  if (!account) return null;
  const rows = await reader
    .select({
      assignmentId: userGrants.id,
      grantId: userGrants.grantId,
      code: grants.code,
      name: grants.name,
      origin: userGrants.origin,
    })
    .from(userGrants)
    .innerJoin(grants, eq(grants.id, userGrants.grantId))
    .where(and(eq(userGrants.userId, userId), isNull(grants.deletedAt)))
    .orderBy(asc(userGrants.id));
  const composition = await compositionByGrantIds(
    reader,
    rows.map((row) => row.grantId),
  );
  const role = account.role;
  return {
    userId: account.id,
    fullName: account.fullName,
    role,
    counterpartyType: account.counterpartyType,
    authVersion: account.authVersion,
    isArchived: account.deletedAt !== null,
    assignments: rows.map((row) => {
      const parts = composition.get(row.grantId) ?? emptyComposition();
      return {
        assignmentId: row.assignmentId,
        grantId: row.grantId,
        code: row.code,
        name: row.name,
        origin: row.origin as GrantOrigin,
        compatible: role !== null && parts.roles.includes(role),
        permissions: parts.permissions,
      };
    }),
  };
}

/**
 * Субъект `can` по набору вкладов: то же построение, что у принципала, но с подставленным составом.
 *
 * Роль приходит отдельным аргументом, а не берётся из состояния учётки, и это не обобщение впрок:
 * правка учётки считает итог по **будущей** роли (Р5 плана «полномочия в окне учётки»), которой в
 * состоянии нет вовсе. Собери мы субъекта из состояния — барьеры считались бы по роли «до», то есть
 * ровно по той дыре, которую фича и закрывает.
 *
 * Пометки рядом с ролью (`addons`) собираются из **всех** кодов, а права — только из совместимых
 * вкладов: гейт совместимости стоит в выражении прав (`grantPermissionsExpr`), а коды наборов
 * читаются без него (`grantCodesExpr`), и внутри `can` надстройку ещё раз сверяет с ролью
 * `canAttachAddon`. Второй гейт здесь означал бы третий ответ на один вопрос.
 */
function accessSubjectOf(
  role: Role | null,
  counterpartyType: CounterpartyType | null,
  parts: readonly GrantContribution[],
): AccessSubject {
  return {
    role,
    counterpartyType,
    // Пометки рядом с ролью — производное от кодов наборов (шаг 1c): выдача системного набора меняет
    // и их, и права, которые надстройка даёт внутри `can`.
    addons: systemAddonsOf(parts.map((part) => part.code)),
    grantPermissions: [
      ...new Set<Permission>(
        parts.filter((part) => part.compatible).flatMap((part) => [...part.permissions]),
      ),
    ],
  };
}

/** Субъект учётки в её нынешней роли — вход выдачи и отзыва одного набора. */
function subjectOf(state: UserGrantState, parts: readonly GrantContribution[]): AccessSubject {
  return accessSubjectOf(state.role, state.counterpartyType, parts);
}

/** Последствия выдачи или отзыва у одной учётки. */
export interface AssignmentImpact {
  /** Что реально появится и реально уйдёт: `effectiveDelta` по всем источникам. */
  delta: PermissionDelta;
  /** Эффективные права после операции — вход барьеров итога. */
  permissionsAfter: Permission[];
  /** Нынешнее назначение этого набора у учётки; `undefined` — набор ей не выдан. */
  held: UserAssignment | undefined;
}

/**
 * Дельта и итоговые права учётки после выдачи или отзыва — подстановкой **одного** изменившегося
 * слагаемого в субъекта.
 *
 * Считается по субъектам целиком, а не по составу набора, и подменять одно другим нельзя: отзыв
 * отбирает право только если его не даёт больше никто — ни роль, ни второй набор, ни тип контрагента.
 * Разница составов показала бы держателю роли «Менеджер» уход `officeEquipment.write`, который у него
 * ролевой, — то есть напугала бы отзывом, ничего не меняющим.
 *
 * Повторная выдача уже выданного набора даёт пустую дельту: вклад тот же, подставлять нечего. Это и
 * есть проверяемая идемпотентность — строка одна (`UNIQUE (user_id, grant_id)`), и вторая выдача
 * ничего не меняет.
 */
export function assignmentImpactOf(params: {
  state: UserGrantState;
  operation: GrantAssignmentOperation;
  grantId: string;
  grantCode: string;
  composition: GrantComposition;
}): AssignmentImpact {
  const { state, grantId, composition } = params;
  const held = state.assignments.find((assignment) => assignment.grantId === grantId);
  const others = state.assignments.filter((assignment) => assignment.grantId !== grantId);
  const proposed: GrantContribution = {
    code: params.grantCode,
    compatible: state.role !== null && composition.roles.includes(state.role),
    permissions: composition.permissions,
  };
  const after = params.operation === 'assign' ? [...others, proposed] : others;
  const afterSubject = subjectOf(state, after);
  return {
    delta: effectiveDelta(subjectOf(state, state.assignments), afterSubject),
    permissionsAfter: [...permissionsFor(afterSubject)],
    held,
  };
}

/** Каталожная строка в ответ. */
export function grantDtoOf(
  row: GrantRow,
  composition: GrantComposition,
  holderCount: number,
): GrantDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    version: row.version,
    permissions: composition.permissions,
    unknownPermissions: composition.unknownPermissions,
    roles: composition.roles,
    holderCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Состав одного набора — короткий путь для карточки и для правки: та же функция, что у списка, но
 * без разбора пачки на стороне вызывающего.
 */
export async function compositionOfGrant(
  reader: Reader,
  grantId: string,
): Promise<GrantComposition> {
  return (await compositionByGrantIds(reader, [grantId])).get(grantId) ?? emptyComposition();
}

/**
 * Карточка набора вместе с реестром его выдач (§12) — один ответ на каталог и на выдачу с отзывом.
 *
 * Общая функция, а не по копии в каждом файле маршрутов: реестр выдач обязан показывать актуальное
 * сразу после операции, и две сборки одной карточки разъехались бы первой же правкой её полей —
 * например той, что добавит в реестр происхождение назначения.
 *
 * Мягко удалённый набор отвечает `null`, а не карточкой: он не действует ни у кого (`grantCodesExpr`
 * отсекает его по `deleted_at`), и ни править, ни выдавать в нём нечего. Строка при этом остаётся
 * навсегда — реестр обязан объяснять прошлые назначения.
 */
export async function grantCardOf(reader: Reader, grantId: string): Promise<GrantCardDto | null> {
  const [row] = await reader.select().from(grants).where(eq(grants.id, grantId));
  if (!row || row.deletedAt) return null;
  const composition = await compositionOfGrant(reader, grantId);
  const holders = await holdersOfGrant(reader, grantId, composition.roles);
  return {
    ...grantDtoOf(row, composition, holders.length),
    holders: holders.map(holderDtoOf),
  };
}

// ── Полномочия в теле учётки: высказывание, разница, барьеры итога и раскладка дельты ──
//
// Окно учётки задаёт полномочия одной операцией вместе с ролью, областью и активацией (план
// «полномочия назначаются в окне учётки», §5), и всё, что этой операции нужно посчитать, лежит
// здесь по той же причине, по которой здесь лежит порядок блокировок: те же разницу, барьеры и
// раскладку дельты обязана считать точечная выдача (`routes/user-grants.ts`). Две реализации одного
// барьера разъедутся на первой же правке каталога — и тогда один и тот же запрос будет проходить
// формой и отклоняться реестром.
//
// Маршруту остаётся порядок шагов: блокировки, повтор транзакции при появлении нового набора,
// запись и журнал. Считать он ничего не считает.

/**
 * Набор глазами операции над учёткой: состав, версия и роли, которым он действует.
 *
 * Отличается от `GrantContribution` тем, что несёт **роли**, а не готовый признак совместимости, и
 * это не дубль: признак считается против роли, которая у учётки будет **после** правки, а её в
 * момент чтения набора ещё никто не знает. Посчитай мы совместимость при чтении — переход
 * `shtab → site` считался бы по роли «до», то есть по состоянию, которого операция как раз и не
 * оставляет.
 */
export interface PlannedGrant {
  id: string;
  code: string;
  name: string;
  /** Версия состава: с ней сверяется версия, показанная формой (Р7). */
  version: number;
  permissions: readonly Permission[];
  /** `grant_roles` набора. Пустой список законен — такой набор не действует ни у кого. */
  roles: readonly Role[];
}

/** Живое назначение учётки — набор плюс то, чем опознаётся сама выдача. */
export interface AssignedGrant extends PlannedGrant {
  assignmentId: string;
  /**
   * Кем выдано. Взведённое переводом ролей (`origin = 'migration'`, ADR 0113) из формы не снимается
   * вовсе: часть подготовленного перевода снимают в реестре выдач, где видно, что именно снимается.
   */
  origin: GrantOrigin;
}

/**
 * Строки наборов под `FOR UPDATE` — **первый** шаг операции над полномочиями учётки (ADR 0106,
 * решение 7; Р6 плана).
 *
 * **По одной строке в цикле и по возрастанию `id`, а не одним запросом с `ORDER BY … FOR UPDATE`.**
 * Обоснование то же, что записано у `lockUsers`, и оно не про стиль: план запроса вправе брать
 * строки в своём порядке, обещания `ORDER BY` на порядок блокировок не распространяются, — а две
 * встречные операции с пересекающимися наборами получили бы ровно тот дедлок, ради предотвращения
 * которого порядок и объявлен. Порядок захвата обязан объявляться одним местом, поэтому обе функции
 * живут рядом и написаны одинаково.
 *
 * Множество наборов операции известно не полностью: кандидаты — присланные в теле плюс уже выданные
 * учётке, а вторые читаются до блокировки строки учётки. Появившийся между чтением и захватом набор
 * ловится **перечитыванием под блокировкой** и лечится повтором транзакции с расширенным множеством
 * (Р6), а не второй блокировкой после строки учётки: это встречный порядок захвата.
 *
 * Возвращаются найденные строки: набор мог быть удалён между чтением тела и захватом, и отвечать за
 * это — маршруту (409 «полномочие удалили, откройте карточку заново»), а не блокировке.
 */
export async function lockGrants(
  tx: Tx,
  grantIds: readonly string[],
): Promise<Map<string, GrantRow>> {
  const locked = new Map<string, GrantRow>();
  for (const grantId of [...new Set(grantIds)].sort()) {
    const row = await lockGrant(tx, grantId);
    if (row) locked.set(grantId, row);
  }
  return locked;
}

/**
 * Живые назначения учётки с составом, версией и совместимыми ролями — вход планировщика (§5, шаги
 * 1 и 5).
 *
 * Отдельно от `userGrantStateOf` не по недосмотру: тот отдаёт вклад набора **готовым**, с
 * посчитанным признаком совместимости, — это ровно то, что нужно выдаче одного набора, где роль
 * держателя операция не меняет. Правка учётки меняет роль тем же запросом, и признак, посчитанный
 * при чтении, описывал бы состояние «до»; поэтому здесь отдаются роли набора, а гейт применяется
 * позже — по роли итоговой.
 *
 * Порядок — по возрастанию `grant_id`: тем же порядком берутся блокировки (Р6) и пишутся события
 * журнала (§5.2), и три порядка обязаны быть одним.
 *
 * Мягко удалённые наборы отсеиваются тем же правилом, что в `grantCodesExpr`: они не действуют ни у
 * кого, и высказываться о них форме нечем — она их не показывает.
 */
export async function assignmentsOfUser(reader: Reader, userId: string): Promise<AssignedGrant[]> {
  const rows = await reader
    .select({
      assignmentId: userGrants.id,
      id: grants.id,
      code: grants.code,
      name: grants.name,
      version: grants.version,
      origin: userGrants.origin,
    })
    .from(userGrants)
    .innerJoin(grants, eq(grants.id, userGrants.grantId))
    .where(and(eq(userGrants.userId, userId), isNull(grants.deletedAt)))
    .orderBy(asc(userGrants.grantId));
  const composition = await compositionByGrantIds(
    reader,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const parts = composition.get(row.id) ?? emptyComposition();
    return {
      assignmentId: row.assignmentId,
      id: row.id,
      code: row.code,
      name: row.name,
      version: row.version,
      origin: row.origin as GrantOrigin,
      permissions: parts.permissions,
      roles: parts.roles,
    };
  });
}

/** Набор действует этой роли: гейт совместимости (`grant_roles`) одним выражением на весь файл. */
function actsForRole(grant: Pick<PlannedGrant, 'roles'>, role: Role | null): boolean {
  return role !== null && grant.roles.includes(role);
}

/**
 * Почему высказывание отклонено. Код — для маршрута (он выбирает по нему ответ), текст — для
 * администратора.
 *
 * **Ответ у кодов разный, и выбирает его маршрут** (Р8): `incompatible`, `migration_locked`,
 * `incomplete`, `role_required` и `limit_exceeded` — это 400 с путём поля `grants`, потому что
 * виновата галочка или устаревший экран, и человеку нужно увидеть какая; `silence_forbidden` — 400
 * общей ошибкой формы, подсвечивать в ней нечего (поля `grants` в запросе нет вовсе); `unknown` —
 * 409, набор удалили или подменили между показом формы и сохранением, и исход у этого другой:
 * перечитать и открыть карточку заново.
 */
export type GrantStatementIssueCode =
  /** Полномочия названы, а роли нет: они выдаются поверх должности (§4.1). */
  | 'role_required'
  /** Отмечен набор, несовместимый с итоговой ролью: список формы устарел (Р8). */
  | 'incompatible'
  /** Названного набора нет вовсе — удалён или подменён (гонка, 409). */
  | 'unknown'
  /** Просят снять управляемое назначение, взведённое переводом ролей (Р4, §4.3). */
  | 'migration_locked'
  /** Не названо назначение, о котором операция что-то решает: полнота высказывания (§4.2). */
  | 'incomplete'
  /** Поля нет, а смена роли переключает действие назначений: границы молчания (§4.2). */
  | 'silence_forbidden'
  /** Назначений после операции больше `MAX_ASSIGNED_GRANTS` (§4.2). */
  | 'limit_exceeded';

/** Набор-виновник в отказе: `name` пуст только у `unknown` — имени у ненайденного набора нет. */
export interface GrantIssueRef {
  id: string;
  name: string | null;
}

/** Отказ по высказыванию: код для маршрута, текст для человека, виновники по отдельному полю. */
export interface GrantStatementIssue {
  code: GrantStatementIssueCode;
  message: string;
  grants: GrantIssueRef[];
}

/**
 * Версия набора, которую операция обязана сверить (Р7): показанная формой против той, что лежит под
 * блокировкой.
 */
export interface GrantVersionCheck {
  grantId: string;
  name: string;
  /** Версия, показанная формой, — из строки высказывания. */
  expected: number;
  /** Версия под блокировкой — состав, который применится. */
  actual: number;
}

/** Что операция сделает с полномочиями учётки. */
export interface GrantStatementPlan {
  /** Выдаваемые наборы по возрастанию `id` — тем же порядком пишутся события (§5.2). */
  toAssign: PlannedGrant[];
  /** Снимаемые назначения по возрастанию `id`. */
  toRevoke: AssignedGrant[];
  /** Итоговое множество назначений учётки — вход пересчёта прав и предела (Р5, §4.2). */
  grantsAfter: PlannedGrant[];
  /** Наборы, чьи версии сверяются под блокировками (Р7). */
  versionsToCheck: GrantVersionCheck[];
  /**
   * Непустой список означает отказ, и действий в плане тогда нет вовсе: `toAssign`, `toRevoke` и
   * `versionsToCheck` пусты, а `grantsAfter` равен нынешнему состоянию. Так сделано затем, что
   * применить план, не посмотрев в `violations`, не должно быть способом тихо сделать не то, о чём
   * просили, — Р4 требует отказа **до** расчёта разницы, а не вычитания из неё.
   */
  violations: GrantStatementIssue[];
}

function issueRefs(list: readonly PlannedGrant[]): GrantIssueRef[] {
  return list.map((grant) => ({ id: grant.id, name: grant.name }));
}

function grantNames(list: readonly GrantIssueRef[]): string {
  return list.map((grant) => `«${grant.name}»`).join(', ');
}

/**
 * Предел назначений по **итогу** операции — общая проверка обоих путей выдачи (§4.2).
 *
 * Общая, а не по копии в каждом маршруте, и это требование плана, а не вкус: точечная выдача,
 * считающая свой предел, набьёт учётке больше назначений, чем форма способна высказать, — правило
 * полноты станет невыполнимым, и карточка такого человека перестанет сохраняться вовсе, включая
 * правку телефона.
 *
 * Возвращает текст, а не бросает: форме он нужен нарушением на поле `grants` рядом с остальными
 * (одним отказом, а не по одному за раз), а точечной выдаче — исключением. Решает вызывающий.
 */
export function assignedGrantLimitIssue(assignedAfter: number): string | null {
  if (assignedAfter <= MAX_ASSIGNED_GRANTS) return null;
  return `У одной учётной записи не больше ${MAX_ASSIGNED_GRANTS} полномочий, а после сохранения их стало бы ${assignedAfter}. Снимите лишние в реестре выдач.`;
}

/**
 * Что операция делает с полномочиями учётки — чистой функцией по состоянию и телу (Р4, §4.2, §4.3).
 *
 * Чистой намеренно: правил здесь шесть, они переплетены, и каждое из них — отказ, который иначе
 * выясняется только в бою. Всё, что требует базы, вызывающий читает **под блокировками** и приносит
 * сюда готовым; здесь не читается ничего.
 *
 * **Диапазон разницы (Р4).** Управляемые назначения — это выданные ∩ совместимые с **итоговой**
 * ролью, и снятие считается только из них. За диапазоном остаются назначения, которых форма не
 * показывает чекбоксами: их не трогает никто, и это защищает назначения с несоответствием роли
 * (роль убрали из `grant_roles` уже после выдачи — по §13.1 они живут дальше и снимаются в реестре).
 *
 * **Отказ на снятие `origin = 'migration'` стоит до расчёта разницы, а не вычитается из неё**, и
 * порядок здесь — само решение. Вычесть неснимаемое из «снять» значило бы принять запрос, который
 * просит снять взведённое переводом назначение, и тихо сделать не то, о чём просили; §4.1 обещает
 * на это отказ, и обещание выполняется проверкой до, а не после.
 *
 * **Полнота высказывания (§4.2).** Строка обязана быть у каждого управляемого назначения и у
 * каждого, чьё действие переключает смена роли. Иначе «администратор снял галочку» неотличимо от
 * «экран этого набора не показал»: любая причина неполноты — каталог не поместился на страницу,
 * запрос оборвался, старая версия портала — превращалась бы в тихий отзыв полномочий, которых никто
 * не касался.
 *
 * **Границы молчания (§4.2).** Тела нет вовсе (`statements === undefined`) — законный ход, «наборов
 * не касаемся», но только пока роль не меняет их действия. Смена роли переключает гейт
 * совместимости: `shtab → site` зажигает состав, которого администратор не отмечал и не видел, а
 * обратный переход его гасит. Правило симметрично: зажигание — тихое расширение доступа, гашение —
 * тихая его потеря, и увидеть до сохранения нужно и то, и другое.
 *
 * **Два смысла `selected: false` (§4.3).** У управляемого назначения это команда снять, у
 * назначения вне диапазона итоговой роли — подтверждение того, что оно перестаёт действовать: права
 * гаснут, строка остаётся жить. Формула диапазона такое поведение даёт сама — снятие считается
 * только из управляемых, — и различие названо здесь потому, что одинаковый флаг с двумя исходами
 * обязан быть объяснён, а не выведен читателем из кода.
 *
 * **Множество версий (Р7).** Сверяются три вида наборов: выдаваемые (человек подписывает состав,
 * который ему показали), снимаемые (правка, добавившая в набор право, меняет то, чего человек
 * лишается) и переключаемые сменой роли — **в обе стороны**, и зажигаемые, и гасимые: прав по ним
 * не было (или было), а переход меняет состав, которого в форме не отмечали.
 */
export function planGrantStatements(params: {
  /** Живые назначения учётки, прочитанные под блокировками (`assignmentsOfUser`). */
  assignments: readonly AssignedGrant[];
  /** Роль учётки до правки. */
  roleBefore: Role | null;
  /** Роль после правки: по ней считается диапазон, гейт совместимости и барьеры итога. */
  roleAfter: Role | null;
  /** Высказывание из тела; `undefined` — поля `grants` в запросе нет вовсе (молчание, §4.2). */
  statements: readonly GrantStatement[] | undefined;
  /**
   * Наборы, названные в теле, — прочитанные под блокировками. Назначения искать здесь не нужно: их
   * сведения берутся из `assignments`, и набор, лежащий в обоих, читается оттуда.
   */
  catalog: ReadonlyMap<string, PlannedGrant>;
}): GrantStatementPlan {
  const { assignments, roleBefore, roleAfter, statements, catalog } = params;
  const violations: GrantStatementIssue[] = [];
  const unchanged = (): GrantStatementPlan => ({
    toAssign: [],
    toRevoke: [],
    grantsAfter: [...assignments],
    versionsToCheck: [],
    violations,
  });

  // Назначения, чьё действие переключает смена роли, — обе стороны перехода сразу (Р7, §4.2).
  const toggled = assignments.filter(
    (assignment) => actsForRole(assignment, roleBefore) !== actsForRole(assignment, roleAfter),
  );

  if (statements === undefined) {
    if (toggled.length > 0) {
      const refs = issueRefs(toggled);
      violations.push({
        code: 'silence_forbidden',
        grants: refs,
        message: `Смена роли меняет действие уже выданных полномочий (${grantNames(refs)}), а в запросе о них не сказано ничего. Откройте карточку заново и сохраните её вместе с полномочиями.`,
      });
    }
    return unchanged();
  }

  if (roleAfter === null && statements.length > 0) {
    violations.push({
      code: 'role_required',
      grants: [],
      message:
        'Полномочия выдаются поверх должности: сначала назначьте роль, потом отмечайте полномочия.',
    });
    return unchanged();
  }

  const said = new Map<string, GrantStatement>();
  const selected = new Set<string>();
  for (const statement of statements) {
    // Уникальность `id` внутри высказывания обещана схемой (`grantStatementListSchema`, §4.3):
    // два противоречащих слова об одном наборе — 400 контракта, а не «побеждает последнее» здесь.
    said.set(statement.id, statement);
    if (statement.selected) selected.add(statement.id);
  }
  const assigned = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const known = (id: string): PlannedGrant | undefined => assigned.get(id) ?? catalog.get(id);

  // Управляемые — выданные ∩ совместимые с итоговой ролью. Только из них считается снятие (Р4).
  const managed = assignments.filter((assignment) => actsForRole(assignment, roleAfter));

  // Отказ на снятие взведённого переводом — **до** разницы, а не вычитанием из неё (Р4).
  const locked = managed.filter(
    (assignment) => assignment.origin === 'migration' && !selected.has(assignment.id),
  );
  if (locked.length > 0) {
    const refs = issueRefs(locked);
    violations.push({
      code: 'migration_locked',
      grants: refs,
      message: `Полномочия ${grantNames(refs)} взведены переводом ролей: снять их можно только в реестре выдач, где видно, что снимается часть подготовленного перевода.`,
    });
  }

  // Полнота: строка обязана быть у каждого управляемого и у каждого переключаемого назначения.
  const required = new Map<string, AssignedGrant>();
  for (const assignment of [...managed, ...toggled]) required.set(assignment.id, assignment);
  const silent = [...required.values()].filter((assignment) => !said.has(assignment.id));
  if (silent.length > 0) {
    const refs = issueRefs(silent);
    violations.push({
      code: 'incomplete',
      grants: refs,
      message: `Форма показала не все полномочия учётной записи (${grantNames(refs)}) — откройте карточку заново.`,
    });
  }

  // Отмеченный набор обязан быть совместим с итоговой ролью: список формы отфильтрован по ней, и
  // несовместимая галочка означает устаревший экран (Р8). Назначение это или новая выдача — неважно.
  const incompatible: GrantIssueRef[] = [];
  const missing: GrantIssueRef[] = [];
  for (const id of selected) {
    const grant = known(id);
    if (!grant) {
      missing.push({ id, name: null });
      continue;
    }
    if (!actsForRole(grant, roleAfter)) incompatible.push({ id, name: grant.name });
  }
  if (incompatible.length > 0) {
    violations.push({
      code: 'incompatible',
      grants: incompatible,
      message: `Полномочия ${grantNames(incompatible)} роли «${roleAfter === null ? '—' : roleLabels[roleAfter]}» не выдаются: список полномочий устарел, откройте карточку заново.`,
    });
  }
  if (missing.length > 0) {
    violations.push({
      code: 'unknown',
      grants: missing,
      message:
        'Отмеченного полномочия больше нет — его удалили, пока карточка была открыта. Откройте её заново.',
    });
  }

  const byId = (first: PlannedGrant, second: PlannedGrant): number =>
    first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
  const toRevoke = managed.filter((assignment) => !selected.has(assignment.id)).sort(byId);
  const toAssign = [...selected]
    .filter((id) => !assigned.has(id))
    .map((id) => catalog.get(id))
    .filter((grant): grant is PlannedGrant => grant !== undefined && actsForRole(grant, roleAfter))
    .sort(byId);
  const revoked = new Set(toRevoke.map((assignment) => assignment.id));
  const grantsAfter = [
    ...assignments.filter((assignment) => !revoked.has(assignment.id)),
    ...toAssign,
  ].sort(byId);

  const limit = assignedGrantLimitIssue(grantsAfter.length);
  if (limit !== null) {
    violations.push({ code: 'limit_exceeded', grants: issueRefs(toAssign), message: limit });
  }

  // Версии сверяются у выдаваемых, снимаемых и переключаемых сменой роли — в обе стороны (Р7).
  // Строка высказывания у каждого из них есть по правилу полноты: без неё выше стоит отказ.
  const checked = new Map<string, PlannedGrant>();
  for (const grant of [...toAssign, ...toRevoke, ...toggled]) checked.set(grant.id, grant);
  const versionsToCheck = [...checked.values()].sort(byId).flatMap((grant) => {
    const statement = said.get(grant.id);
    return statement === undefined
      ? []
      : [
          {
            grantId: grant.id,
            name: grant.name,
            expected: statement.version,
            actual: grant.version,
          },
        ];
  });

  if (violations.length > 0) return unchanged();
  return { toAssign, toRevoke, grantsAfter, versionsToCheck, violations };
}

/**
 * Сверка версий участвующих наборов — **под блокировками** и до записи (Р7).
 *
 * 409 со своим кодом, а не 400 на поле: галочка не виновата, состав набора изменили между открытием
 * формы и сохранением, и человек получил бы (или потерял) права, которых в подсказке не видел.
 * Исход у этого другой, чем у отказа по полю: перечитать карточку, а не поправить галочку.
 *
 * Отпечатка последствий (`expectedImpactHash`) у этого пути нет вовсе, и версий достаточно: вход
 * операции — итог, названный явно, а не чужое состояние, которое подтверждают (Р7). Смену роли или
 * второго набора у **той же** учётки ловят барьеры по итогу, считающиеся уже под блокировками.
 */
export function assertGrantVersions(checks: readonly GrantVersionCheck[]): void {
  const stale = checks.find((check) => check.expected !== check.actual);
  if (!stale) return;
  throw err.conflict(
    `Состав полномочия «${stale.name}» изменили, пока карточка была открыта. Откройте её заново — состав, который вы подписываете, уже другой.`,
    { code: GRANT_CONFLICT_CODES.impactChanged },
  );
}

/** Субъект операции: роль, тип контрагента и **все** живые назначения — гейт применяется внутри. */
export interface GrantSubjectState {
  role: Role | null;
  counterpartyType: CounterpartyType | null;
  /**
   * Все назначения, включая несовместимые с ролью: отбирать их заранее нельзя, потому что коды
   * наборов (пометки рядом с ролью) читаются без гейта, а права — с ним.
   */
  grants: readonly PlannedGrant[];
}

/**
 * Субъект `can` по состоянию учётки — с **гейтом совместимости** (Р5).
 *
 * Гейт здесь тот же, по которому права гаснут при смене роли (`grantPermissionsExpr`): набор, чьи
 * `grant_roles` не содержат роль субъекта, прав не даёт. Итог обязан считаться по нему, а не по
 * составу набора, — иначе барьеры проверяли бы доступ, которого сервер не выдаёт, и правка
 * отклонялась бы конфликтом, которого в жизни учётки нет.
 */
export function grantSubjectOf(state: GrantSubjectState): AccessSubject {
  return accessSubjectOf(
    state.role,
    state.counterpartyType,
    state.grants.map((grant) => ({
      code: grant.code,
      compatible: actsForRole(grant, state.role),
      permissions: grant.permissions,
    })),
  );
}

/** Итог операции над учёткой: права после, дельта и нарушения барьеров. */
export interface GrantOperationOutcome {
  /** Эффективные права после операции по всем источникам — вход барьеров итога. */
  permissionsAfter: Permission[];
  /** Что реально появится и реально уйдёт: `effectiveDelta` по двум субъектам целиком. */
  delta: PermissionDelta;
  /** Пустой список — операция законна. */
  violations: GrantViolation[];
}

/**
 * Барьеры и дельта по **итоговому** субъекту: роль после правки, тип контрагента после правки и
 * наборы после правки (Р5).
 *
 * **Это чинит существующую дыру, а не только обслуживает форму.** Сегодня смена роли держателю
 * набора проверяется лишь двумя надстройками, а пара, собранная суммой роли и набора, не ловится
 * никем: держателю набора со «Сметой» назначают роль, дающую `serviceRequests.approveEstimate`, — и
 * один человек считает смету и утверждает её. Тем же способом ловится `requirement_missing`: набор
 * даёт ведение рассылок, а чтение их давала прежняя роль.
 *
 * **Барьеры набора (1–3) считаются только по выдаваемым наборам, и каждый — своим вызовом.** Вызов
 * на набор нужен ради текста отказа: `grantLabel` называет виновника, а слитый состав трёх наборов
 * назвал бы «набор с этими правами», которого администратор в форме не видел. Барьеры итога (4–5)
 * считаются один раз и **без** `grantLabel`: половину конфликтующей пары даёт роль или второй набор,
 * и приписывать конфликт одному из них значило бы соврать о причине.
 *
 * У наборов, которые операция не выдаёт (остающиеся, гасимые, зажигаемые сменой роли), барьеры
 * набора не считаются вовсе: `module_forbidden_for_axis` в исправном каталоге до сюда не доходит —
 * набор, чья роль запрещает модуль по оси, в `grant_roles` этой роли не попадает, — и превратился
 * бы в отказ на правку телефона у человека, которому набор выдали до правки каталога.
 */
export function grantOperationOutcome(params: {
  /** Состояние до правки — левая сторона дельты. */
  before: GrantSubjectState;
  /** Состояние после правки: роль, контрагент и наборы уже итоговые. */
  after: GrantSubjectState;
  /** Наборы, которые операция выдаёт: барьеры набора (1–3) считаются только по ним. */
  assigned: readonly PlannedGrant[];
}): GrantOperationOutcome {
  const beforeSubject = grantSubjectOf(params.before);
  const afterSubject = grantSubjectOf(params.after);
  const permissionsAfter = [...permissionsFor(afterSubject)];
  const violations: GrantViolation[] = [];
  for (const grant of params.assigned) {
    violations.push(
      ...validateGrantAssignment({
        // Роль **держателя**, а не список ролей набора: проверяется выдача конкретному человеку, и
        // матрица осей обязана сработать на его оси. Отсюда же отказ роли `driver`.
        roles: params.after.role === null ? [] : [params.after.role],
        permissions: grant.permissions,
        // Итог считается ниже одним вызовом: посчитай мы его здесь, держатель трёх наборов получил
        // бы три копии одного конфликта, приписанные трём разным виновникам.
        subjectPermissionsAfter: null,
        subjectRole: params.after.role,
        grantLabel: grant.name,
      }),
    );
  }
  violations.push(
    ...validateGrantAssignment({
      roles: [],
      permissions: [],
      subjectPermissionsAfter: permissionsAfter,
      subjectRole: params.after.role,
    }),
  );
  return {
    permissionsAfter,
    delta: effectiveDelta(beforeSubject, afterSubject),
    violations,
  };
}

/** Набор глазами раскладки дельты: чем выдали — то есть состав. */
export interface GrantDeltaSource {
  id: string;
  permissions: readonly Permission[];
}

/** Что приписано одному событию журнала. */
export interface GrantEventDelta {
  operation: GrantAssignmentOperation;
  grantId: string;
  added: Permission[];
  removed: Permission[];
}

/**
 * Раскладка **итоговой** дельты операции по событиям журнала (§5.2).
 *
 * **Итоговой, а не пошаговой, и отвергнут пошаговый пересчёт именно на замене.** Снимают набор A и
 * выдают B, оба дают одно право — пошаговый пересчёт написал бы «право снято», а следом «право
 * добавлено», хотя транзакционно доступ не прерывался ни на мгновение. Событие журнала отвечает на
 * «что человек получил и потерял», и промежуточных состояний внутри одной транзакции у этого
 * вопроса нет.
 *
 * Порядок объявлен и обязателен: сначала отзывы, затем выдачи, внутри каждой группы — по возрастанию
 * `grant_id`. По нему же приписывается право, которое дают два выдаваемых набора: оно попадает в
 * событие первого, второе показывает пустую добавку — «сверх уже имеющегося не дал». Сумма событий
 * равна итоговой дельте без взаимных погашений.
 *
 * Отзыв ничего не добавляет, а выдача ничего не отнимает — и обратные половины у событий пусты не
 * от лени: право, которое учётка получила, не может быть следствием снятия набора, и приписать его
 * отзыву значило бы соврать о причине. Право, ушедшее не из-за набора (его отобрала смена роли),
 * не приписывается никому — его показывает строка `changes` события правки учётки.
 */
export function attributeGrantDelta(params: {
  /** Итоговая дельта операции — `effectiveDelta` по двум субъектам целиком. */
  delta: PermissionDelta;
  revoked: readonly GrantDeltaSource[];
  assigned: readonly GrantDeltaSource[];
}): GrantEventDelta[] {
  const added = new Set<Permission>(params.delta.added);
  const removed = new Set<Permission>(params.delta.removed);
  const byId = (first: GrantDeltaSource, second: GrantDeltaSource): number =>
    first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
  // Перебором словаря, а не пересечением множеств: порядок прав в событии обязан быть тем же, в
  // каком их перечисляет дельта (`effectiveDelta`), иначе один и тот же журнал читался бы по-разному.
  const take = (pool: Set<Permission>, grant: GrantDeltaSource): Permission[] => {
    const mine = PERMISSIONS.filter(
      (permission) => pool.has(permission) && grant.permissions.includes(permission),
    );
    for (const permission of mine) pool.delete(permission);
    return mine;
  };
  return [
    ...[...params.revoked].sort(byId).map((grant) => ({
      operation: 'revoke' as GrantAssignmentOperation,
      grantId: grant.id,
      added: [],
      removed: take(removed, grant),
    })),
    ...[...params.assigned].sort(byId).map((grant) => ({
      operation: 'assign' as GrantAssignmentOperation,
      grantId: grant.id,
      added: take(added, grant),
      removed: [],
    })),
  ];
}
