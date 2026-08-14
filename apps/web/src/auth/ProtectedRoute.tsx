import { Navigate, Outlet, useLocation } from 'react-router';
import { Spin } from 'antd';
import type { Permission } from '@technic/contracts';
import { useAuth } from './AuthContext';

function FullScreenSpin() {
  return (
    <div
      style={{ height: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
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
 * Стартовый раздел роли — первый доступный ей. Фиксированной страницы «по умолчанию» у портала
 * больше нет: «Вывоз мусора» закрыт руководителю строительства (ADR 0025), а «Заказ ТС» —
 * оператору вывоза (ADR 0010), и любая жёсткая ссылка отправляла бы половину ролей туда, откуда
 * их тут же выкидывает обратно.
 *
 * Спрашивается `canUse`, а не `can`: у роли отдела без площадки право на вывоз есть, а работать
 * им не над чем (ADR 0062), и стартовой страницей ей досталось бы пустое место.
 */
function homePath(canUse: (permission: Permission) => boolean): string {
  // Кабинет водителя (ADR 0102) — первой строкой, и порядок здесь важнее обычного: у роли
  // `driver` нет ни одного права основного портала, и без этой строки водитель попадал бы на
  // смену пароля — единственное, что осталось бы ему доступным.
  if (canUse('driverCabinet.read')) return '/driver';
  if (canUse('wasteRequests.read')) return '/waste';
  if (canUse('vehicleRequests.read')) return '/vehicle-requests';
  // Служба главного механика: заявок у неё нет вовсе, и первый её раздел — парк на дату. Без этих
  // двух строк механик попадал бы на смену пароля — как водитель до ADR 0102.
  if (canUse('garage.read')) return '/garage';
  if (canUse('waybills.read')) return '/waybills';
  if (canUse('directories.write')) return '/directories';
  if (canUse('users.manage')) return '/admin';
  // Роли без единого раздела быть не должно; смена пароля доступна любому вошедшему.
  return '/change-password';
}

export function HomeRedirect() {
  const { canUse } = useAuth();
  return <Navigate to={homePath(canUse)} replace />;
}

/**
 * Раздел портала закрывается правом вместе с областью, а не списком ролей: список пришлось бы
 * держать в согласии с проверками API вручную, а право одно и то же по обе стороны (ADR 0021).
 * Область добавлена к нему тем же правилом, что и в меню (ADR 0062): раздел, в котором роли не
 * над чем работать, не должен открываться и по прямой ссылке.
 */
export function RequirePermission({ permission }: { permission: Permission | Permission[] }) {
  const { canUse } = useAuth();
  // Список прав — для страницы из нескольких вкладок: администрирование открывается и тому, кто
  // ведёт учётки, и тому, кто настраивает рассылки. Права разные, страница одна, и требовать оба
  // значило бы закрыть её каждому, у кого есть только одно.
  const required = Array.isArray(permission) ? permission : [permission];
  if (!required.some((p) => canUse(p))) return <Navigate to={homePath(canUse)} replace />;
  return <Outlet />;
}
