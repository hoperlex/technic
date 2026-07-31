import { eq, inArray, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  actsForCounterparty,
  can,
  canTransitionStatus,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isPlaceScopedRole,
  requestStatusLabels,
  roleLabels,
  type CounterpartyType,
  type Permission,
  type RequestStatus,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import { err } from './errors';

const NEVER_MATCH = '00000000-0000-0000-0000-000000000000';

/**
 * Доступ проверяется в два слоя (ADR 0021):
 *  - право — «что учётка может делать» (матрица в @technic/contracts: роль плюс тип контрагента,
 *    ADR 0038), проверяется до запроса в БД: `app.requirePermission(...)` на маршруте либо
 *    `assertCan(...)` в обработчике, если право зависит от содержимого запроса;
 *  - область — «над какими строками», проверяется по конкретной записи: штаб работает со своим
 *    объектом, внешний исполнитель — с заявками своего контрагента.
 * Здесь живёт второй слой и те проверки прав, которые нельзя сделать на маршруте.
 */

/** Право, проверяемое внутри обработчика (когда оно зависит от тела запроса или от записи). */
export function assertCan(p: Principal, permission: Permission, message?: string): void {
  if (!can(p, permission)) throw err.forbidden(message);
}

/**
 * Ограничение видимости для внешнего исполнителя (ADR 0010, 0038): в своём модуле он видит
 * строки своего контрагента, в чужом — не видит ничего.
 *
 * Ветка «чужой модуль» существует не ради отказа в правах (их и так нет — маршрут закрыт правом
 * модуля), а ради того, чтобы ограничение видимости нельзя было обойти новым правом: право и
 * область выдаются по отдельности, и «право есть, а область не написана» означает доступ ко
 * всем строкам сразу.
 */
function counterpartyVisibilityWhere(
  p: Principal,
  type: CounterpartyType,
  counterpartyColumn: AnyColumn,
): SQL | undefined {
  if (!isCounterpartyScopedRole(p.role)) return undefined;
  const own = actsForCounterparty(p, type) ? (p.counterpartyId ?? NEVER_MATCH) : NEVER_MATCH;
  return eq(counterpartyColumn, own);
}

/** Своя запись контрагента или отказ — общий разбор для проверок по конкретной строке. */
function assertCounterpartyScope(
  p: Principal,
  type: CounterpartyType,
  counterpartyId: string | null,
  message: string,
): void {
  if (!isCounterpartyScopedRole(p.role)) return;
  if (!actsForCounterparty(p, type) || counterpartyId !== p.counterpartyId)
    throw err.forbidden(message);
}

/**
 * Ограничение видимости заявок по ролям: роли, работающие в пределах объекта («Штаб»,
 * «Руководитель строительства», ADR 0025), видят только заявки своих объектов; остальные — все.
 * Параметризовано колонкой объекта (переиспользуется модулями «Вывоз мусора» и «Заказ ТС»).
 *
 * Объектов у учётки набор (ADR 0039). Пустой набор означает «не видит ничего», а не «видит всё»:
 * активировать объектную роль без объектов API не даёт, но выборка не должна зависеть от того,
 * удержалась ли эта проверка.
 */
export function requestVisibilityWhere(p: Principal, objectIdColumn: AnyColumn): SQL | undefined {
  if (isObjectScopedRole(p.role)) {
    const ids = p.constructionObjectIds;
    return ids.length > 0 ? inArray(objectIdColumn, ids) : eq(objectIdColumn, NEVER_MATCH);
  }
  // Роль отдела объектных заявок не видит вовсе (ADR 0040): отдел — офис, и заявка площадки не
  // его. Ветка написана явно, а не оставлена на «нет прав»: право и область выдаются порознь, и
  // «право есть, а область не написана» означает доступ ко всем строкам сразу — тем же приёмом,
  // что и у внешнего исполнителя в чужом модуле.
  if (isDepartmentScopedRole(p.role)) return eq(objectIdColumn, NEVER_MATCH);
  return undefined;
}

/**
 * Видимость заявок вывоза для оператора (ADR 0010): только заявки, назначенные его контрагенту.
 * Отдельно от requestVisibilityWhere — колонка оператора есть только у «Вывоза мусора».
 */
export function operatorVisibilityWhere(p: Principal, operatorColumn: AnyColumn): SQL | undefined {
  return counterpartyVisibilityWhere(p, 'operator', operatorColumn);
}

/**
 * Видимость заявок на технику для арендодателя (ADR 0038): только заявки, на которые вышла его
 * техника. Колонка — `vehicles.lessor_id` назначенной машины, поэтому запрос обязан быть
 * соединён с назначением: своего поля исполнителя у заявки ТС нет, и роль арендодателя в заявке
 * появляется вместе с назначением машины (ADR 0027).
 *
 * Следствие, принятое сознательно: «Новую» заявку арендодатель не видит — до назначения она
 * ничья. Это и есть разница с вывозом мусора, где исполнителя можно проставить заранее.
 */
export function lessorVisibilityWhere(p: Principal, lessorColumn: AnyColumn): SQL | undefined {
  return counterpartyVisibilityWhere(p, 'vehicle_lessor', lessorColumn);
}

/**
 * Удалённая запись видна только тем, кому открыт архив; остальным её как бы нет — 404, а не
 * 403: сам факт существования удалённой заявки под известным id тоже не их дело. Проверять
 * это обязан каждый маршрут, отдающий запись по id: список удалённые скрывает, а карточка,
 * история и карточка справочника получают строку напрямую и без этой проверки отдают архив
 * любому, кто знает id.
 */
export function assertArchiveVisible(
  p: Principal,
  deletedAt: Date | string | null,
  notFoundMessage: string,
): void {
  if (deletedAt && !can(p, 'archive.read')) throw err.notFound(notFoundMessage);
}

/**
 * Может ли учётка визировать заявку ТС этого объекта (ADR 0025): право визы плюс область —
 * руководитель строительства отвечает за свой объект и чужие заявки не согласовывает.
 * Предикат, а не проверка с отказом: им же решается, снимать ли визу при правке заявки.
 */
export function canApproveForObject(p: Principal, objectId: string): boolean {
  if (!can(p, 'vehicleRequests.approve')) return false;
  // Руководитель отдела визирует заявки своего отдела, а не площадки: право визы у него есть,
  // но объектная заявка вне его области (ADR 0040).
  if (isDepartmentScopedRole(p.role)) return false;
  return !isObjectScopedRole(p.role) || p.constructionObjectIds.includes(objectId);
}

/**
 * Визируется ли заявка сразу, самим фактом заведения её автором (ADR 0025 п. 5, ADR 0032).
 *
 * Это не то же, что право визировать. Виза — ответ объекта «техника нужна и по средствам», и
 * сама собой она случается только у того, кто за объект отвечает: у руководителя строительства
 * на своём объекте. Администратор право визы сохраняет, но заводит заявку не за себя — за того,
 * кто до портала не добрался; согласование этим не состоялось, и его заявка ждёт визы наравне с
 * остальными. Иначе на вопрос «кто согласовал» портал отвечал бы именем того, кто решения не
 * принимал, — и обойти визу можно было бы просьбой завести заявку.
 */
export function approvesOwnRequestOnCreate(p: Principal, objectId: string): boolean {
  return isPlaceScopedRole(p.role) && canApproveForObject(p, objectId);
}

/**
 * Объектная роль работает только со своими объектами (проверка конкретного objectId).
 *
 * Роль отдела не работает ни с одним: у неё нет объектов, и заявка площадки — не её (ADR 0040).
 * Отказ здесь, а не в отсутствии прав: права на модуль у отдела как раз есть, и без этой ветки
 * сотрудник отдела заводил бы заявки на любой объект компании.
 */
export function assertObjectScope(p: Principal, objectId: string): void {
  if (isDepartmentScopedRole(p.role)) {
    throw err.forbidden(`${roleLabels[p.role!]} работает только со своим отделом`);
  }
  if (isObjectScopedRole(p.role) && !p.constructionObjectIds.includes(objectId)) {
    throw err.forbidden(`${roleLabels[p.role!]} работает только со своими объектами`);
  }
}

/**
 * Со стороны заказчика — объекта или отдела — правят и удаляют только заявку, которую ещё не
 * взяли в работу: после «В работе» за заявкой стоят договорённости с исполнителем, и менять её
 * задним числом нельзя. Ограничение по состоянию записи, а не по действию, поэтому это область,
 * а не право. Правило одно на обе оси, отсюда `isPlaceScopedRole` (ADR 0040).
 */
export function assertObjectRoleEditable(
  p: Principal,
  status: RequestStatus,
  action: string,
): void {
  if (isPlaceScopedRole(p.role) && status !== 'new') {
    throw err.forbidden(`${roleLabels[p.role!]} может ${action} заявку только в статусе «Новая»`);
  }
}

/** Оператор вывоза работает только с заявками своего контрагента (проверка конкретной заявки). */
export function assertOperatorScope(p: Principal, operatorCounterpartyId: string | null): void {
  assertCounterpartyScope(
    p,
    'operator',
    operatorCounterpartyId,
    'Оператор работает только с заявками своего контрагента',
  );
}

/**
 * Арендодатель работает только с заявками, на которые вышла его техника (ADR 0038). Проверяется
 * арендодатель назначенной машины: у заявки без назначения его нет вовсе — такая заявка ничья, и
 * доступ к ней исполнителю закрыт.
 */
export function assertLessorScope(p: Principal, assignedLessorId: string | null): void {
  assertCounterpartyScope(
    p,
    'vehicle_lessor',
    assignedLessorId,
    'Арендодатель работает только с заявками, на которые назначена его техника',
  );
}

/**
 * Переход статуса заявки с учётом прав (един для «Вывоза мусора» и «Заказа ТС»). Откат
 * закрытой заявки — право администратора, поэтому 403, а не 400: переход существует,
 * но не для этой учётки.
 */
export function assertTransitionAllowed(
  p: Principal,
  from: RequestStatus,
  to: RequestStatus,
): void {
  if (canTransitionStatus(from, to, p)) return;
  // Учётка без роли до сюда не доходит — её отсекает право на маршруте. Но объяснять отказ
  // разбором переходов ей нечем: у неё нет ни одного, и «только администратор» было бы ложью.
  if (!p.role) throw err.forbidden('Недостаточно прав для смены статуса');
  // У внешнего исполнителя коридор один, поэтому «недопустимый переход» ему ничего не объясняет.
  if (isCounterpartyScopedRole(p.role)) {
    throw err.forbidden(
      `${roleLabels[p.role]} может только отметить заявку «${requestStatusLabels.confirmed}» выполненной`,
    );
  }
  if (canTransitionStatus(from, to, { role: 'admin' })) {
    throw err.forbidden('Вернуть заявку в предыдущий статус может только администратор');
  }
  throw err.badRequest(
    `Недопустимый переход статуса: «${requestStatusLabels[from]}» → «${requestStatusLabels[to]}»`,
  );
}
