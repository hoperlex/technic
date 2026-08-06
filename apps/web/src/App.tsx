import { Route, Routes } from 'react-router';
import { AppLayout } from './components/AppLayout';
import { AppUpdateBanner } from './components/AppUpdateBanner';
import { HomeRedirect, ProtectedRoute, RequirePermission } from './auth/ProtectedRoute';
import { WaybillsPage } from './pages/WaybillsPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { WasteRequestsPage } from './pages/WasteRequestsPage';
import { VehicleRequestsPage } from './pages/VehicleRequestsPage';
import { GaragePage } from './pages/GaragePage';
import { DirectoriesPage } from './pages/DirectoriesPage';
import { AdministrationPage } from './pages/AdministrationPage';

export default function App() {
  return (
    <>
      <AppUpdateBanner />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        {/* Публичные: по ссылкам из писем ходят те, кто ещё не вошёл — и войти как раз не может. */}
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
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
            <Route element={<RequirePermission permission="waybills.read" />}>
              <Route path="/waybills" element={<WaybillsPage />} />
            </Route>
            {/* Гараж (ADR 0076) — срез дня по парку и водителям: своё право, потому что в нём
                видно, кто за рулём, — те же персональные данные, что в карточке водителя. */}
            <Route element={<RequirePermission permission="garage.read" />}>
              <Route path="/garage" element={<GaragePage />} />
            </Route>
            <Route element={<RequirePermission permission="directories.write" />}>
              <Route path="/directories" element={<DirectoriesPage />} />
            </Route>
            {/* Администрирование — страница из вкладок под разными правами: учётки ведёт один
                человек, рассылки может настраивать другой. */}
            <Route element={<RequirePermission permission={['users.manage', 'mailings.read']} />}>
              <Route path="/admin" element={<AdministrationPage />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </>
  );
}
