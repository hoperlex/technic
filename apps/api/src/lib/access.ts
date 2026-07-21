import { eq, type SQL } from 'drizzle-orm';
import { wasteRequests } from '../db/schema';
import type { Principal } from '../auth/principal';

const NEVER_MATCH = '00000000-0000-0000-0000-000000000000';

/**
 * Ограничение видимости заявок по ролям:
 * «Штаб» видит только заявки своего объекта; остальные роли — все.
 */
export function requestVisibilityWhere(p: Principal): SQL | undefined {
  if (p.role === 'shtab') {
    return eq(wasteRequests.objectId, p.constructionObjectId ?? NEVER_MATCH);
  }
  return undefined;
}

export function canManageRequests(p: Principal): boolean {
  return p.role === 'admin' || p.role === 'manager' || p.role === 'dispatcher';
}

export function canChangeStatus(p: Principal): boolean {
  return canManageRequests(p);
}
