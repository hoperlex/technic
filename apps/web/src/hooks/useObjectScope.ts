import { isObjectScopedRole } from '@technic/contracts';
import { useAuth } from '../auth/AuthContext';

/**
 * Область объектной роли на портале (ADR 0039): объектов у учётки набор, а не один.
 *
 * Роль здесь не перечисляется, спрашивается предикат `isObjectScopedRole` — заказчиков со стороны
 * объекта двое (ADR 0031), и оставленный список ролей разошёлся бы с `OBJECT_SCOPED_ROLES` молча,
 * фильтром объекта, открытым для чужих площадок.
 *
 * Портал сужает выбор, но не решает доступ: чужой объект сервер всё равно отдаёт как 403
 * (`assertObjectScope`), а список — как пустую выборку (`requestVisibilityWhere`).
 */
export function useObjectScope() {
  const { user } = useAuth();
  const isObjectRole = isObjectScopedRole(user?.role);
  const ownObjectIds = isObjectRole ? (user?.constructionObjectIds ?? []) : [];

  return {
    isObjectRole,
    ownObjectIds,
    /**
     * Единственный объект учётки: им заполняются фильтр списка и поле формы. `null`, когда
     * объектов несколько — тогда выбирает человек, и подставлять за него первый попавшийся
     * значило бы заводить заявку не на ту площадку.
     */
    soleObjectId: ownObjectIds.length === 1 ? ownObjectIds[0]! : null,
    /**
     * Поле объекта заперто, когда выбирать не из чего: у роли ровно один объект. Не `isObjectRole`:
     * с несколькими объектами запертое поле показывало бы один из них как единственно возможный.
     */
    objectFieldDisabled: isObjectRole && ownObjectIds.length <= 1,
    /** Оставляет в списке только свои объекты: чужие объектной роли и выбирать незачем. */
    limitObjectOptions<T extends { value: string }>(options: T[]): T[] {
      return isObjectRole ? options.filter((o) => ownObjectIds.includes(o.value)) : options;
    },
  };
}
