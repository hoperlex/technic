import { eq, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  can,
  canTransitionStatus,
  isObjectScopedRole,
  requestStatusLabels,
  roleLabels,
  type Permission,
  type RequestStatus,
  type Role,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import { err } from './errors';

const NEVER_MATCH = '00000000-0000-0000-0000-000000000000';

/**
 * Доступ проверяется в два слоя (ADR 0021):
 *  - право — «что роль может делать» (матрица в @technic/contracts), проверяется до запроса
 *    в БД: `app.requirePermission(...)` на маршруте либо `assertCan(...)` в обработчике, если
 *    право зависит от содержимого запроса;
 *  - область — «над какими строками», проверяется по конкретной записи: штаб работает со своим
 *    объектом, оператор — с заявками своего контрагента.
 * Здесь живёт второй слой и те проверки прав, которые нельзя сделать на маршруте.
 */

/** Право, проверяемое внутри обработчика (когда оно зависит от тела запроса или от записи). */
export function assertCan(p: Principal, permission: Permission, message?: string): void {
  if (!can(p.role, permission)) throw err.forbidden(message);
}

/**
 * Ограничение видимости заявок по ролям: роли, работающие в пределах объекта («Штаб»,
 * «Руководитель строительства», ADR 0025), видят только заявки своего объекта; остальные — все.
 * Параметризовано колонкой объекта (переиспользуется модулями «Вывоз мусора» и «Заказ ТС»).
 */
export function requestVisibilityWhere(p: Principal, objectIdColumn: AnyColumn): SQL | undefined {
  if (isObjectScopedRole(p.role)) {
    return eq(objectIdColumn, p.constructionObjectId ?? NEVER_MATCH);
  }
  return undefined;
}

/**
 * Видимость заявок вывоза для «Оператора» (ADR 0010): только заявки, назначенные его контрагенту.
 * Отдельно от requestVisibilityWhere — колонка оператора есть только у «Вывоза мусора».
 */
export function operatorVisibilityWhere(p: Principal, operatorColumn: AnyColumn): SQL | undefined {
  if (p.role !== 'operator') return undefined;
  return eq(operatorColumn, p.counterpartyId ?? NEVER_MATCH);
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
  if (deletedAt && !can(p.role, 'archive.read')) throw err.notFound(notFoundMessage);
}

/**
 * Может ли учётка визировать заявку ТС этого объекта (ADR 0025): право визы плюс область —
 * руководитель строительства отвечает за свой объект и чужие заявки не согласовывает.
 * Предикат, а не проверка с отказом: им же решается, снимать ли визу при правке заявки.
 */
export function canApproveForObject(p: Principal, objectId: string): boolean {
  if (!can(p.role, 'vehicleRequests.approve')) return false;
  return !isObjectScopedRole(p.role) || p.constructionObjectId === objectId;
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
  return isObjectScopedRole(p.role) && canApproveForObject(p, objectId);
}

/** Объектная роль работает только со своим объектом (проверка конкретного objectId). */
export function assertObjectScope(p: Principal, objectId: string): void {
  if (isObjectScopedRole(p.role) && objectId !== p.constructionObjectId) {
    throw err.forbidden(`${roleLabels[p.role!]} работает только со своим объектом`);
  }
}

/**
 * Со стороны объекта правят и удаляют только заявку, которую ещё не взяли в работу: после
 * «В работе» за заявкой стоят договорённости с исполнителем, и менять её задним числом нельзя.
 * Ограничение по состоянию записи, а не по действию, поэтому это область, а не право.
 */
export function assertObjectRoleEditable(
  p: Principal,
  status: RequestStatus,
  action: string,
): void {
  if (isObjectScopedRole(p.role) && status !== 'new') {
    throw err.forbidden(`${roleLabels[p.role!]} может ${action} заявку только в статусе «Новая»`);
  }
}

/** «Оператор» работает только с заявками своего контрагента (проверка конкретной заявки). */
export function assertOperatorScope(p: Principal, operatorCounterpartyId: string | null): void {
  if (p.role === 'operator' && operatorCounterpartyId !== p.counterpartyId) {
    throw err.forbidden('Оператор работает только с заявками своего контрагента');
  }
}

/**
 * Переход статуса заявки с учётом роли (един для «Вывоза мусора» и «Заказа ТС»). Откат
 * закрытой заявки — право администратора, поэтому 403, а не 400: переход существует,
 * но не для этой роли.
 */
export function assertTransitionAllowed(
  from: RequestStatus,
  to: RequestStatus,
  role: Role | null,
): void {
  if (role && canTransitionStatus(from, to, role)) return;
  // Учётка без роли до сюда не доходит — её отсекает право на маршруте. Но объяснять отказ
  // разбором переходов ей нечем: у неё нет ни одного, и «только администратор» было бы ложью.
  if (!role) throw err.forbidden('Недостаточно прав для смены статуса');
  // У оператора коридор один, поэтому «недопустимый переход» ему ничего не объясняет.
  if (role === 'operator') {
    throw err.forbidden(
      `Оператор может только отметить заявку «${requestStatusLabels.confirmed}» выполненной`,
    );
  }
  if (canTransitionStatus(from, to, 'admin')) {
    throw err.forbidden('Вернуть заявку в предыдущий статус может только администратор');
  }
  throw err.badRequest(
    `Недопустимый переход статуса: «${requestStatusLabels[from]}» → «${requestStatusLabels[to]}»`,
  );
}
