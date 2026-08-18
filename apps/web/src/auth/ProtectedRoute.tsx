import { Navigate, Outlet, useLocation } from 'react-router';
import { Spin } from 'antd';
import {
  ADMIN_PAGE_PERMISSIONS,
  isPersonScopedRole,
  type AuthUser,
  type Permission,
} from '@technic/contracts';
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
 * Открыт ли кабинет водителя (ADR 0102) — **роль и право**, а не одно право.
 *
 * Право здесь недостаточно, и это не перестраховка: `driverCabinet.read` есть у администратора,
 * потому что у него есть все права словаря (`ROLE_PERMISSIONS.admin` — `[...PERMISSIONS]`), и по
 * одному праву кабинет открывался и стартовой страницей, и по прямой ссылке. Выход из него портал
 * не предусматривает: кабинет живёт вне `AppLayout` — ни меню, ни разделов, — а корень и любой
 * неизвестный адрес ведут в `HomeRedirect`, то есть обратно в кабинет. Раздел портала, из которого
 * нельзя выйти, для держателя всех прав — не «лишний пункт», а потеря портала целиком.
 *
 * Спрашивается роль, а не список прав, потому что вопрос кабинета — про роль: он показывает
 * задание конкретного работника и принимает показания от его имени, и субъект у него один —
 * `PERSON_SCOPED_ROLES` (ADR 0102). Модель доступа при этом не меняется: право у администратора
 * остаётся, API кабинета по-прежнему открыто им, и `NON_GRANTABLE_PERMISSIONS` эта проверка не
 * дублирует — она отвечает на другой вопрос, «чей это контур», а не «выдаваемо ли право».
 */
function canOpenDriverCabinet(
  user: AuthUser | null,
  canUse: (permission: Permission) => boolean,
): boolean {
  return isPersonScopedRole(user?.role) && canUse('driverCabinet.read');
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
function homePath(user: AuthUser | null, canUse: (permission: Permission) => boolean): string {
  // Кабинет водителя (ADR 0102) — первой строкой, и порядок здесь важнее обычного: у роли
  // `driver` нет ни одного права основного портала, и без этой строки водитель попадал бы на
  // смену пароля — единственное, что осталось бы ему доступным. Условие — роль вместе с правом
  // (`canOpenDriverCabinet`): по одному праву сюда попадал администратор и оставался в кабинете,
  // потому что возвращаться в портал из второго контура нечем.
  if (canOpenDriverCabinet(user, canUse)) return '/driver';
  if (canUse('wasteRequests.read')) return '/waste';
  if (canUse('vehicleRequests.read')) return '/vehicle-requests';
  // Служба главного механика: заявок у неё нет вовсе, и первый её раздел — парк на дату. Без этих
  // двух строк механик попадал бы на смену пароля — как водитель до ADR 0102.
  if (canUse('garage.read')) return '/garage';
  if (canUse('waybills.read')) return '/waybills';
  if (canUse('directories.write')) return '/directories';
  // Администрирование — последним и по всему списку прав его вкладок (`ADMIN_PAGE_PERMISSIONS`,
  // `docs/manuals-plan.md` §3.6): держателю одних «Руководств» или одних «Рассылок» это
  // единственный доступный раздел, и без списка он попадал бы на смену пароля. Порядок при этом
  // не меняется — у менеджера с `directories.export` стартовой остаётся его рабочая страница,
  // потому что `homePath` отдаёт первый доступный раздел, а не самый широкий.
  if (ADMIN_PAGE_PERMISSIONS.some((permission) => canUse(permission))) return '/admin';
  // Роли без единого раздела быть не должно; смена пароля доступна любому вошедшему.
  return '/change-password';
}

export function HomeRedirect() {
  const { user, canUse } = useAuth();
  return <Navigate to={homePath(user, canUse)} replace />;
}

/**
 * Маршрут кабинета водителя. Своим компонентом, а не `RequirePermission` с `driverCabinet.read`:
 * условие входа здесь другое — роль вместе с правом (`canOpenDriverCabinet`), и держатель одного
 * права в кабинет не попадает ни по стартовой странице, ни по прямой ссылке.
 *
 * Уводит туда же, куда `RequirePermission`, — в первый доступный раздел. Зацикливания это не даёт
 * по построению: `/driver` возвращается стартовой страницей ровно при том же условии, по которому
 * пускает сюда, и не-водителю `homePath` его уже не вернёт.
 */
export function RequireDriverCabinet() {
  const { user, canUse } = useAuth();
  if (!canOpenDriverCabinet(user, canUse)) return <Navigate to={homePath(user, canUse)} replace />;
  return <Outlet />;
}

/**
 * Раздел портала закрывается правом вместе с областью, а не списком ролей: список пришлось бы
 * держать в согласии с проверками API вручную, а право одно и то же по обе стороны (ADR 0021).
 * Область добавлена к нему тем же правилом, что и в меню (ADR 0062): раздел, в котором роли не
 * над чем работать, не должен открываться и по прямой ссылке.
 */
export function RequirePermission({ permission }: { permission: Permission | Permission[] }) {
  const { user, canUse } = useAuth();
  // Список прав — для страницы из нескольких вкладок: администрирование открывается и тому, кто
  // ведёт учётки, и тому, кто настраивает рассылки. Права разные, страница одна, и требовать оба
  // значило бы закрыть её каждому, у кого есть только одно.
  const required = Array.isArray(permission) ? permission : [permission];
  if (!required.some((p) => canUse(p))) return <Navigate to={homePath(user, canUse)} replace />;
  return <Outlet />;
}
