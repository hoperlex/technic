import { isObjectScopedRole } from '@technic/contracts';
import { objectScopeAnswers } from '@shared/lib';
import { useAuth } from '../auth/AuthContext';

/**
 * Область объектной роли на портале (ADR 0039): объектов у учётки набор, а не один.
 *
 * Роль здесь не перечисляется, спрашивается предикат `isObjectScopedRole` — заказчиков со стороны
 * объекта двое (ADR 0031), и оставленный список ролей разошёлся бы с `OBJECT_SCOPED_ROLES` молча,
 * фильтром объекта, открытым для чужих площадок.
 *
 * Хук считает ось, а ответы формы по ней собирает общий `objectScopeAnswers`: они у обеих осей
 * портала одни и те же, и второе их написание разошлось бы с первым на первой же правке. Роль без
 * этой оси передаёт туда `null` — «областью не ограничен», а не «объектов ноль»: пустой набор
 * оставил бы человека без единой строки в списке.
 *
 * Портал сужает выбор, но не решает доступ: чужой объект сервер всё равно отдаёт как 403
 * (`assertPlaceObjectScope`), а список — как пустую выборку (`placeObjectVisibilityWhere`).
 */
export function useObjectScope() {
  const { user } = useAuth();
  const isObjectRole = isObjectScopedRole(user?.role);
  return {
    isObjectRole,
    ...objectScopeAnswers(isObjectRole ? (user?.constructionObjectIds ?? []) : null),
  };
}
