import { Navigate, Outlet, useLocation } from 'react-router';
import { Spin } from 'antd';
import type { Role } from '@technic/contracts';
import { useAuth } from './AuthContext';

function FullScreenSpin() {
  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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

export function RequireRole({ roles }: { roles: Role[] }) {
  const { user } = useAuth();
  if (!user?.role || !roles.includes(user.role)) {
    return <Navigate to="/waste" replace />;
  }
  return <Outlet />;
}
