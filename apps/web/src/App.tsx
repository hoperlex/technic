import { Route, Routes } from 'react-router';
import { AppLayout } from './components/AppLayout';
import { AppUpdateBanner } from './components/AppUpdateBanner';
import { HomeRedirect, ProtectedRoute, RequirePermission } from './auth/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { WasteRequestsPage } from './pages/WasteRequestsPage';
import { VehicleRequestsPage } from './pages/VehicleRequestsPage';
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
            <Route index element={<HomeRedirect />} />
            {/* Руководителю строительства «Вывоз мусора» недоступен (ADR 0025), оператору
                вывоза — наоборот, «Заказ ТС» (ADR 0010). */}
            <Route element={<RequirePermission permission="wasteRequests.read" />}>
              <Route path="/waste" element={<WasteRequestsPage />} />
            </Route>
            <Route element={<RequirePermission permission="vehicleRequests.read" />}>
              <Route path="/vehicle-requests" element={<VehicleRequestsPage />} />
            </Route>
            {/* Справочники открыты тем, кто их ведёт: смотреть их отдельной страницей
                остальным незачем — значения и так видны в карточках заявок. */}
            <Route element={<RequirePermission permission="directories.write" />}>
              <Route path="/directories" element={<DirectoriesPage />} />
            </Route>
            <Route element={<RequirePermission permission="users.manage" />}>
              <Route path="/admin" element={<AdministrationPage />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </>
  );
}
