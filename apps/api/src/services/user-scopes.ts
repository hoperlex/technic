import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  DepartmentHeadRefDto,
  UserDepartmentRefDto,
  UserObjectRefDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  departments,
  userConstructionObjects,
  userDepartments,
  users,
} from '../db/schema';
import { err } from '../lib/errors';

// Область учётки: объекты (ADR 0039) или отделы (ADR 0040) — две связи «учётка ↔ подразделение»,
// многие-ко-многим. Отдельным сервисом, а не внутри routes/users.ts, по той же причине, что и
// связь «объект ↔ оператор»: набор правится не из одного места — отделы правятся ещё и из
// карточки справочника, — и правила синхронизации должны быть одни и те же с любой стороны.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Объекты учётки одним выражением — для запросов, которые и так отдают строку пользователя
 * целиком (принципал на каждом запросе, вход, смена пароля). Подзапросом, а не join'ом с
 * группировкой: размножать строку пользователя по числу его объектов ради одного массива незачем.
 *
 * Требует, чтобы в запросе участвовала таблица `users` — выражение ссылается на её `id`.
 */
export const constructionObjectIdsExpr = sql<string[]>`(
  SELECT coalesce(array_agg(uco.construction_object_id), '{}')
  FROM user_construction_objects uco
  WHERE uco.user_id = ${users.id}
)`;

/** Объекты учёток одним запросом: список пользователей не должен порождать запрос на строку. */
export async function objectsByUserIds(
  userIds: string[],
): Promise<Map<string, UserObjectRefDto[]>> {
  const map = new Map<string, UserObjectRefDto[]>();
  if (userIds.length === 0) return map;
  const rows = await db
    .select({
      userId: userConstructionObjects.userId,
      id: constructionObjects.id,
      code: constructionObjects.code,
      name: constructionObjects.name,
    })
    .from(userConstructionObjects)
    .innerJoin(
      constructionObjects,
      eq(userConstructionObjects.constructionObjectId, constructionObjects.id),
    )
    .where(inArray(userConstructionObjects.userId, userIds))
    .orderBy(constructionObjects.name);
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push({ id: row.id, code: row.code, name: row.name });
    map.set(row.userId, list);
  }
  return map;
}

/** Текущий набор объектов учётки — нужен, чтобы понять, менялась ли область (отзыв токенов). */
export async function objectIdsOfUser(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: userConstructionObjects.constructionObjectId })
    .from(userConstructionObjects)
    .where(eq(userConstructionObjects.userId, userId));
  return rows.map((r) => r.id);
}

/**
 * Неактивный объект пропускаем: привязка описывает зону ответственности, а не готовность
 * принимать заявки прямо сейчас — деактивация объекта не должна молча обрезать область учётки.
 */
async function assertAllObjectsExist(tx: Tx, objectIds: string[]): Promise<void> {
  if (objectIds.length === 0) return;
  const rows = await tx
    .select({ id: constructionObjects.id })
    .from(constructionObjects)
    .where(inArray(constructionObjects.id, objectIds));
  if (rows.length !== new Set(objectIds).size) {
    throw err.badRequest('Объект не найден', { constructionObjectIds: 'Объект не найден' });
  }
}

/**
 * Заменяет набор объектов учётки целиком (приём из replaceObjectOperators): клиент присылает то,
 * что должно остаться, сервер считает разницу. Возвращает `true`, если набор изменился, — по
 * этому ответу маршрут решает, гасить ли выданные токены: сменившаяся область меняет и то, какие
 * заявки учётке видны.
 */
export async function replaceUserObjects(
  tx: Tx,
  userId: string,
  objectIds: string[],
  actorUserId: string,
): Promise<boolean> {
  const ids = [...new Set(objectIds)];
  await assertAllObjectsExist(tx, ids);
  const before = new Set(await objectIdsOfUser(tx, userId));
  const changed = before.size !== ids.length || ids.some((id) => !before.has(id));
  if (!changed) return false;

  await tx.delete(userConstructionObjects).where(eq(userConstructionObjects.userId, userId));
  if (ids.length > 0) {
    await tx
      .insert(userConstructionObjects)
      .values(
        ids.map((constructionObjectId) => ({
          userId,
          constructionObjectId,
          createdBy: actorUserId,
        })),
      )
      .onConflictDoNothing();
  }
  return true;
}

/** Отделы учётки одним выражением — рядом с объектами и по той же причине (ADR 0040). */
export const departmentIdsExpr = sql<string[]>`(
  SELECT coalesce(array_agg(ud.department_id), '{}')
  FROM user_departments ud
  WHERE ud.user_id = ${users.id}
)`;

/** Отделы учёток одним запросом — то же, что objectsByUserIds, второй осью. */
export async function departmentsByUserIds(
  userIds: string[],
): Promise<Map<string, UserDepartmentRefDto[]>> {
  const map = new Map<string, UserDepartmentRefDto[]>();
  if (userIds.length === 0) return map;
  const rows = await db
    .select({
      userId: userDepartments.userId,
      id: departments.id,
      code: departments.code,
      name: departments.name,
    })
    .from(userDepartments)
    .innerJoin(departments, eq(userDepartments.departmentId, departments.id))
    .where(inArray(userDepartments.userId, userIds))
    .orderBy(departments.name);
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push({ id: row.id, code: row.code, name: row.name });
    map.set(row.userId, list);
  }
  return map;
}

/** Текущий набор отделов учётки — по нему видно, менялась ли область (отзыв токенов). */
export async function departmentIdsOfUser(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: userDepartments.departmentId })
    .from(userDepartments)
    .where(eq(userDepartments.userId, userId));
  return rows.map((r) => r.id);
}

async function assertAllDepartmentsExist(tx: Tx, departmentIds: string[]): Promise<void> {
  if (departmentIds.length === 0) return;
  const rows = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(inArray(departments.id, departmentIds));
  if (rows.length !== new Set(departmentIds).size) {
    throw err.badRequest('Отдел не найден', { departmentIds: 'Отдел не найден' });
  }
}

/** Заменяет набор отделов учётки целиком; возвращает `true`, если он изменился. */
export async function replaceUserDepartments(
  tx: Tx,
  userId: string,
  departmentIds: string[],
  actorUserId: string,
): Promise<boolean> {
  const ids = [...new Set(departmentIds)];
  await assertAllDepartmentsExist(tx, ids);
  const before = new Set(await departmentIdsOfUser(tx, userId));
  const changed = before.size !== ids.length || ids.some((id) => !before.has(id));
  if (!changed) return false;

  await tx.delete(userDepartments).where(eq(userDepartments.userId, userId));
  if (ids.length > 0) {
    await tx
      .insert(userDepartments)
      .values(ids.map((departmentId) => ({ userId, departmentId, createdBy: actorUserId })))
      .onConflictDoNothing();
  }
  return true;
}

/**
 * Руководители отделов (ADR 0040) — учётки с ролью «Руководитель отдела», привязанные к отделу.
 * Своего хранилища у связи нет: это та же `user_departments`, прочитанная со стороны справочника.
 * Отсюда и правило показа — роль спрашивается в запросе, а не подразумевается: в отделе сидят и
 * сотрудники, и руководитель, а карточка отдела отвечает только про вторых.
 */
export async function headsByDepartmentIds(
  departmentIds: string[],
): Promise<Map<string, DepartmentHeadRefDto[]>> {
  const map = new Map<string, DepartmentHeadRefDto[]>();
  if (departmentIds.length === 0) return map;
  const rows = await db
    .select({
      departmentId: userDepartments.departmentId,
      id: users.id,
      fullName: users.fullName,
    })
    .from(userDepartments)
    .innerJoin(users, eq(userDepartments.userId, users.id))
    .where(
      and(
        inArray(userDepartments.departmentId, departmentIds),
        eq(users.role, 'department_head'),
        // Удалённая учётка из карточки отдела исчезает: привязка остаётся в БД и вернётся вместе
        // с восстановлением записи — тем же правилом, что и операторы у объекта.
        sql`${users.deletedAt} IS NULL`,
      ),
    )
    .orderBy(users.fullName);
  for (const row of rows) {
    const list = map.get(row.departmentId) ?? [];
    list.push({ id: row.id, fullName: row.fullName });
    map.set(row.departmentId, list);
  }
  return map;
}

/**
 * Заменяет набор руководителей отдела со стороны справочника. Трогает только учётки с ролью
 * «Руководитель отдела»: в той же таблице лежат привязки сотрудников отдела, и «замена набора»
 * из карточки отдела снимала бы то, чего человек не выбирал и не мог выбрать.
 *
 * Возвращает учётки, у которых область сменилась: правка карточки справочника меняет то, какие
 * заявки человек видит, и его выданные токены обязаны погаснуть так же, как при правке из
 * карточки учётки. Гасит их маршрут — сервис не ходит в сессии.
 */
export async function replaceDepartmentHeads(
  tx: Tx,
  departmentId: string,
  userIds: string[],
  actorUserId: string,
): Promise<string[]> {
  const ids = [...new Set(userIds)];
  if (ids.length > 0) {
    const rows = await tx
      .select({ id: users.id, role: users.role, fullName: users.fullName })
      .from(users)
      .where(and(inArray(users.id, ids), sql`${users.deletedAt} IS NULL`));
    const found = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = found.get(id);
      if (!row) {
        throw err.badRequest('Учётная запись не найдена', {
          headUserIds: 'Учётная запись не найдена',
        });
      }
      if (row.role !== 'department_head') {
        throw err.badRequest(`«${row.fullName}» — не руководитель отдела`, {
          headUserIds: 'Привязать можно только учётку с ролью «Руководитель отдела»',
        });
      }
    }
  }

  const before = await tx
    .select({ userId: userDepartments.userId })
    .from(userDepartments)
    .innerJoin(users, eq(userDepartments.userId, users.id))
    .where(and(eq(userDepartments.departmentId, departmentId), eq(users.role, 'department_head')));
  const beforeIds = new Set(before.map((r) => r.userId));
  const affected = [...new Set([...beforeIds, ...ids])].filter(
    (id) => beforeIds.has(id) !== ids.includes(id),
  );
  if (affected.length === 0) return [];

  await tx.delete(userDepartments).where(
    and(
      eq(userDepartments.departmentId, departmentId),
      // Сотрудников отдела не трогаем: карточка отдела про них не спрашивала.
      inArray(
        userDepartments.userId,
        tx.select({ id: users.id }).from(users).where(eq(users.role, 'department_head')),
      ),
    ),
  );
  if (ids.length > 0) {
    await tx
      .insert(userDepartments)
      .values(ids.map((userId) => ({ userId, departmentId, createdBy: actorUserId })))
      .onConflictDoNothing();
  }
  // Область сменилась — выданные токены обязаны погаснуть. `authVersion` поднимается здесь, в той
  // же транзакции, что и привязка: access-токен сверяется с ним на каждом запросе, и отзыва одних
  // refresh-сессий не хватило бы — прежний токен жил бы до своего истечения.
  await tx
    .update(users)
    .set({ authVersion: sql`${users.authVersion} + 1`, updatedAt: new Date() })
    .where(inArray(users.id, affected));
  return affected;
}
