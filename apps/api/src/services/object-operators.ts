import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { CounterpartyObjectRefDto, ObjectOperatorRefDto } from '@technic/contracts';
import { db } from '../db/client';
import { constructionObjectOperators, constructionObjects, counterparties } from '../db/schema';
import { err } from '../lib/errors';

// Связь «объект ↔ оператор вывоза» (ADR 0010, миграция 0027). Правится с обеих сторон —
// из карточки объекта и из карточки контрагента, — поэтому живёт отдельным сервисом, а не
// внутри одного из маршрутов: правила («только контрагент типа operator», «набор передаётся
// целиком») должны быть одни и те же с любой стороны.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Операторы объектов одним запросом: список объектов не должен порождать запрос на строку. */
export async function operatorsByObjectIds(
  objectIds: string[],
): Promise<Map<string, ObjectOperatorRefDto[]>> {
  const map = new Map<string, ObjectOperatorRefDto[]>();
  if (objectIds.length === 0) return map;
  const rows = await db
    .select({
      objectId: constructionObjectOperators.constructionObjectId,
      id: counterparties.id,
      name: counterparties.name,
    })
    .from(constructionObjectOperators)
    .innerJoin(counterparties, eq(constructionObjectOperators.counterpartyId, counterparties.id))
    .where(
      and(
        inArray(constructionObjectOperators.constructionObjectId, objectIds),
        // Удалённый контрагент из карточки объекта исчезает: привязка остаётся в БД и вернётся
        // вместе с восстановлением записи.
        isNull(counterparties.deletedAt),
      ),
    )
    .orderBy(counterparties.name);
  for (const row of rows) {
    const list = map.get(row.objectId) ?? [];
    list.push({ id: row.id, name: row.name });
    map.set(row.objectId, list);
  }
  return map;
}

/** Обратная сторона: объекты, которые обслуживает каждый из операторов. */
export async function objectsByCounterpartyIds(
  counterpartyIds: string[],
): Promise<Map<string, CounterpartyObjectRefDto[]>> {
  const map = new Map<string, CounterpartyObjectRefDto[]>();
  if (counterpartyIds.length === 0) return map;
  const rows = await db
    .select({
      counterpartyId: constructionObjectOperators.counterpartyId,
      id: constructionObjects.id,
      code: constructionObjects.code,
      name: constructionObjects.name,
    })
    .from(constructionObjectOperators)
    .innerJoin(
      constructionObjects,
      eq(constructionObjectOperators.constructionObjectId, constructionObjects.id),
    )
    .where(inArray(constructionObjectOperators.counterpartyId, counterpartyIds))
    .orderBy(constructionObjects.name);
  for (const row of rows) {
    const list = map.get(row.counterpartyId) ?? [];
    list.push({ id: row.id, code: row.code, name: row.name });
    map.set(row.counterpartyId, list);
  }
  return map;
}

/**
 * Проверяет, что все переданные контрагенты — живые операторы. Неактивных пропускаем:
 * привязка описывает сотрудничество, а не готовность взять заявку прямо сейчас (назначение
 * неактивного оператора отдельно запрещает assertOperatorAssignable).
 */
async function assertAllAreOperators(tx: Tx, counterpartyIds: string[]): Promise<void> {
  if (counterpartyIds.length === 0) return;
  const rows = await tx
    .select({ id: counterparties.id, type: counterparties.type, name: counterparties.name })
    .from(counterparties)
    .where(and(inArray(counterparties.id, counterpartyIds), isNull(counterparties.deletedAt)));
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of counterpartyIds) {
    const row = found.get(id);
    if (!row) throw err.badRequest('Контрагент не найден', { operatorIds: 'Контрагент не найден' });
    if (row.type !== 'operator') {
      throw err.badRequest(`«${row.name}» — не оператор вывоза`, {
        operatorIds: 'Привязать можно только контрагента типа «Оператор»',
      });
    }
  }
}

async function assertAllObjectsExist(tx: Tx, objectIds: string[]): Promise<void> {
  if (objectIds.length === 0) return;
  const rows = await tx
    .select({ id: constructionObjects.id })
    .from(constructionObjects)
    .where(inArray(constructionObjects.id, objectIds));
  if (rows.length !== new Set(objectIds).size) {
    throw err.badRequest('Объект не найден', { objectIds: 'Объект не найден' });
  }
}

/**
 * Заменяет набор операторов объекта целиком (приём из replaceSynonyms): клиент присылает то,
 * что должно остаться, сервер вычисляет разницу. Удаляем и вставляем, а не пересчитываем дельту:
 * записей единицы, а `created_by`/`created_at` у привязки — служебные, не пользовательские данные.
 */
export async function replaceObjectOperators(
  tx: Tx,
  objectId: string,
  counterpartyIds: string[],
  actorUserId: string,
): Promise<void> {
  const ids = [...new Set(counterpartyIds)];
  await assertAllAreOperators(tx, ids);
  await tx.delete(constructionObjectOperators).where(
    and(
      eq(constructionObjectOperators.constructionObjectId, objectId),
      // Привязки к удалённым контрагентам не трогаем: в карточке объекта их не видно, а
      // «замена набора» снимала бы то, чего пользователь не выбирал и не мог выбрать.
      inArray(
        constructionObjectOperators.counterpartyId,
        tx
          .select({ id: counterparties.id })
          .from(counterparties)
          .where(isNull(counterparties.deletedAt)),
      ),
    ),
  );
  if (ids.length > 0) {
    await tx
      .insert(constructionObjectOperators)
      .values(
        ids.map((counterpartyId) => ({
          constructionObjectId: objectId,
          counterpartyId,
          createdBy: actorUserId,
        })),
      )
      .onConflictDoNothing();
  }
}

/** То же с обратной стороны: набор объектов оператора. */
export async function replaceOperatorObjects(
  tx: Tx,
  counterpartyId: string,
  objectIds: string[],
  actorUserId: string,
): Promise<void> {
  const ids = [...new Set(objectIds)];
  await assertAllObjectsExist(tx, ids);
  await tx
    .delete(constructionObjectOperators)
    .where(eq(constructionObjectOperators.counterpartyId, counterpartyId));
  if (ids.length > 0) {
    await tx
      .insert(constructionObjectOperators)
      .values(
        ids.map((constructionObjectId) => ({
          constructionObjectId,
          counterpartyId,
          createdBy: actorUserId,
        })),
      )
      .onConflictDoNothing();
  }
}

/** Есть ли у контрагента привязки к объектам (проверка перед сменой типа с «Оператора»). */
export async function hasObjectLinks(tx: Tx, counterpartyId: string): Promise<boolean> {
  const rows = await tx
    .select({ objectId: constructionObjectOperators.constructionObjectId })
    .from(constructionObjectOperators)
    .where(eq(constructionObjectOperators.counterpartyId, counterpartyId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Оператор заявки должен обслуживать объект заявки (ADR 0010). Объект без единой привязки
 * назначению не мешает: справочник заполняется постепенно, и первая заявка на новом объекте
 * иначе встала бы до его заполнения — это запрет там, где нет данных, а не там, где есть ошибка.
 */
export async function assertOperatorServesObject(
  tx: Tx,
  objectId: string,
  counterpartyId: string,
): Promise<void> {
  const links = await tx
    .select({ counterpartyId: constructionObjectOperators.counterpartyId })
    .from(constructionObjectOperators)
    .where(eq(constructionObjectOperators.constructionObjectId, objectId));
  if (links.length === 0) return;
  if (links.some((l) => l.counterpartyId === counterpartyId)) return;
  throw err.badRequest('Этот оператор не обслуживает объект заявки', {
    operatorCounterpartyId: 'Оператор не привязан к объекту — привяжите его в справочнике объектов',
  });
}
