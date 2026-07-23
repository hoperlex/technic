import { Navigate, Route, Routes } from 'react-router';
import { AppLayout } from './components/AppLayout';
import { AppUpdateBanner } from './components/AppUpdateBanner';
import { ProtectedRoute, RequireRole } from './auth/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { WasteRequestsPage } from './pages/WasteRequestsPage';
import { DirectoriesPage } from './pages/DirectoriesPage';
import { AdministrationPage } from './pages/AdministrationPage';

export default function App() {
  return (
    <>
      <AppUpdateBanner />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to="/waste" replace />} />
            <Route path="/waste" element={<WasteRequestsPage />} />
            <Route element={<RequireRole roles={['admin', 'manager']} />}>
              <Route path="/directories" element={<DirectoriesPage />} />
            </Route>
            <Route element={<RequireRole roles={['admin']} />}>
              <Route path="/admin" element={<AdministrationPage />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/waste" replace />} />
      </Routes>
    </>
  );
}
