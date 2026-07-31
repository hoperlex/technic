import { isDepartmentScopedRole } from '@technic/contracts';
import { useAuth } from '../auth/AuthContext';

/**
 * Область роли отдела на портале (ADR 0040) — вторая ось рядом с объектной (`useObjectScope`).
 * Устроена так же: отделов у учётки набор, поле заперто только когда отдел один.
 *
 * Двумя хуками, а не одним «заказчиком»: оси взаимоисключающие, и место, спрашивающее сразу обе,
 * должно делать это явно — иначе выбор поля в форме заявки свёлся бы к «что не пусто».
 */
export function useDepartmentScope() {
  const { user } = useAuth();
  const isDepartmentRole = isDepartmentScopedRole(user?.role);
  const ownDepartmentIds = isDepartmentRole ? (user?.departmentIds ?? []) : [];

  return {
    isDepartmentRole,
    ownDepartmentIds,
    /** Единственный отдел учётки; `null`, когда их несколько — тогда выбирает человек. */
    soleDepartmentId: ownDepartmentIds.length === 1 ? ownDepartmentIds[0]! : null,
    departmentFieldDisabled: isDepartmentRole && ownDepartmentIds.length <= 1,
    limitDepartmentOptions<T extends { value: string }>(options: T[]): T[] {
      return isDepartmentRole ? options.filter((o) => ownDepartmentIds.includes(o.value)) : options;
    },
  };
}
