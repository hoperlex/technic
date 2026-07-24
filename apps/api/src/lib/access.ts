import { eq, type AnyColumn, type SQL } from 'drizzle-orm';
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

/** «Штаб» работает только со своим объектом (проверка конкретного objectId). */
export function assertShtabScope(p: Principal, objectId: string): void {
  if (p.role === 'shtab' && objectId !== p.constructionObjectId) {
    throw err.forbidden('Штаб работает только со своим объектом');
  }
}

export function canManageRequests(p: Principal): boolean {
  return p.role === 'admin' || p.role === 'manager' || p.role === 'dispatcher';
}

export function canChangeStatus(p: Principal): boolean {
  return canManageRequests(p);
}
