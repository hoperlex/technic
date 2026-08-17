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
  type AccessSubject,
  type CounterpartyType,
  GRANT_CONFLICT_CODES,
  type GrantAssignmentOperation,
  type GrantCardDto,
  type GrantDto,
  type GrantHolderDto,
  type GrantHolderViolationsDto,
  type GrantImpactDto,
  type GrantImpactInput,
  type GrantImpactUserDto,
  type GrantOrigin,
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

/** Субъект `can` по набору вкладов: то же построение, что у принципала, но с подставленным составом. */
function subjectOf(state: UserGrantState, parts: readonly GrantContribution[]): AccessSubject {
  return {
    role: state.role,
    counterpartyType: state.counterpartyType,
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
