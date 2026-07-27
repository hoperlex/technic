import { eq, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  canTransitionStatus,
  requestStatusLabels,
  type RequestStatus,
  type Role,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import { err } from './errors';

const NEVER_MATCH = '00000000-0000-0000-0000-000000000000';

/**
 * Ограничение видимости заявок по ролям: «Штаб» видит только заявки своего объекта;
 * остальные роли — все. Параметризовано колонкой объекта (переиспользуется модулями
 * «Вывоз мусора» и «Заказ ТС»).
 */
export function requestVisibilityWhere(p: Principal, objectIdColumn: AnyColumn): SQL | undefined {
  if (p.role === 'shtab') {
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

/** «Штаб» работает только со своим объектом (проверка конкретного objectId). */
export function assertShtabScope(p: Principal, objectId: string): void {
  if (p.role === 'shtab' && objectId !== p.constructionObjectId) {
    throw err.forbidden('Штаб работает только со своим объектом');
  }
}

/**
 * Оператор — исполнитель, а не заказчик: заявки он не заводит, не редактирует и не удаляет,
 * даже свои (ADR 0010). Роли «Штаб» такой запрет не подходит — она заявки как раз создаёт,
 * поэтому проверка отдельная, а не через canManageRequests.
 */
export function assertNotOperator(p: Principal, message: string): void {
  if (p.role === 'operator') throw err.forbidden(message);
}

/** «Оператор» работает только с заявками своего контрагента (проверка конкретной заявки). */
export function assertOperatorScope(p: Principal, operatorCounterpartyId: string | null): void {
  if (p.role === 'operator' && operatorCounterpartyId !== p.counterpartyId) {
    throw err.forbidden('Оператор работает только с заявками своего контрагента');
  }
}

export function canManageRequests(p: Principal): boolean {
  return p.role === 'admin' || p.role === 'manager' || p.role === 'dispatcher';
}

/**
 * Оператор заявки не ведёт, но статус меняет — в единственном разрешённом ему переходе
 * «В работе» → «Выполнена». Сам переход проверяет assertTransitionAllowed по роли.
 */
export function canChangeStatus(p: Principal): boolean {
  return canManageRequests(p) || p.role === 'operator';
}

/**
 * Переход статуса заявки с учётом роли (един для «Вывоза мусора» и «Заказа ТС»). Откат
 * закрытой заявки — право администратора, поэтому 403, а не 400: переход существует,
 * но не для этой роли.
 */
export function assertTransitionAllowed(
  from: RequestStatus,
  to: RequestStatus,
  // Учётка без роли статусы не меняет; до сюда её не пускает canChangeStatus.
  role: Role | null,
): void {
  if (role && canTransitionStatus(from, to, role)) return;
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
