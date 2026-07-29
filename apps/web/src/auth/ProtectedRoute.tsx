import { Navigate, Outlet, useLocation } from 'react-router';
import { Spin } from 'antd';
import type { Permission } from '@technic/contracts';
import { useAuth } from './AuthContext';

function FullScreenSpin() {
  return (
    <div
      style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <Spin size="large" />
    </div>
  );
}

export function ProtectedRoute() {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <FullScreenSpin />;
  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (user?.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return <Outlet />;
}

/**
 * Стартовый раздел роли — первый доступный ей по правам. Фиксированной страницы «по умолчанию»
 * у портала больше нет: «Вывоз мусора» закрыт руководителю строительства (ADR 0025), а «Заказ
 * ТС» — оператору вывоза (ADR 0010), и любая жёсткая ссылка отправляла бы половину ролей туда,
 * откуда их тут же выкидывает обратно.
 */
function homePath(can: (permission: Permission) => boolean): string {
  if (can('wasteRequests.read')) return '/waste';
  if (can('vehicleRequests.read')) return '/vehicle-requests';
  if (can('directories.write')) return '/directories';
  if (can('users.manage')) return '/admin';
  // Роли без единого раздела быть не должно; смена пароля доступна любому вошедшему.
  return '/change-password';
}

export function HomeRedirect() {
  const { can } = useAuth();
  return <Navigate to={homePath(can)} replace />;
}

/**
 * Раздел портала закрывается правом, а не списком ролей: список пришлось бы держать в
 * согласии с проверками API вручную, а право одно и то же по обе стороны (ADR 0021).
 */
export function RequirePermission({ permission }: { permission: Permission }) {
  const { can } = useAuth();
  if (!can(permission)) return <Navigate to={homePath(can)} replace />;
  return <Outlet />;
}
