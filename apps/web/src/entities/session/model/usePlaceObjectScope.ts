import { placeObjectScopeIds } from '@technic/contracts';
import { objectScopeAnswers } from '@shared/lib';
import { useAuth } from './authContext';

/**
 * Place scope follows the shared contracts axis: direct objects for object roles and department
 * sites for department roles (ADRs 0062, 0144 and 0201). Request-customer selection uses this hook;
 * candidate reporting has its separate location choice under ADR 0249.
 *
 * Session owns the hook because it reads the authenticated subject, and features cannot import
 * another feature. Keeping it separate from direct object scope also prevents a department's
 * derived sites from being added beside its department in freight filters, where two customer
 * axes would produce an empty list. Server guards still enforce access independently.
 */
export function usePlaceObjectScope() {
  const { user } = useAuth();
  const scopeIds = placeObjectScopeIds(user);
  return {
    /** Есть ли у учётки площадочная ось вовсе: у диспетчера, менеджера, наблюдателя и админа её нет. */
    isScoped: scopeIds !== null,
    ...objectScopeAnswers(scopeIds),
  };
}
