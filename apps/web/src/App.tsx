import { lazy, Suspense } from 'react';
import { Spin } from 'antd';
import { Route, Routes } from 'react-router';
import { EMAIL_VERIFICATION_ENABLED } from '@technic/contracts';
import { AppLayout } from './components/AppLayout';
import { AppUpdateBanner } from './components/AppUpdateBanner';
import {
  HomeRedirect,
  ProtectedRoute,
  RequireDriverCabinet,
  RequirePermission,
} from './auth/ProtectedRoute';
import { WaybillsPage } from './pages/WaybillsPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { WasteRequestsPage } from './pages/WasteRequestsPage';
import { VehicleRequestsPage } from './pages/VehicleRequestsPage';
import { WeeklyRequestPage } from './pages/vehicle/WeeklyRequestPage';
import { GaragePage } from './pages/GaragePage';
import { ServiceRequestsPage } from './pages/service/ServiceRequestsPage';
import { DirectoriesPage } from './pages/DirectoriesPage';
import { AdministrationPage } from './pages/AdministrationPage';

/**
 * Кабинет водителя (ADR 0102) грузится отдельным чанком: у него свой каркас, свои экраны и своя
 * форма, а открывает его роль, которой основной портал недоступен вовсе. Тянуть этот код в первый
 * бандл диспетчера — платить весом за экран, который он никогда не увидит; и наоборот, водитель с
 * телефона не должен скачивать заявки, справочники и журнал листов ради четырёх полей.
 */
const DriverLayout = lazy(() =>
  import('./pages/driver/DriverLayout').then((m) => ({ default: m.DriverLayout })),
);
const DriverPage = lazy(() =>
  import('./pages/driver/DriverPage').then((m) => ({ default: m.DriverPage })),
);

export default function App() {
  return (
    <>
      <AppUpdateBanner />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        {/* Публичные: по ссылкам из писем ходят те, кто ещё не вошёл — и войти как раз не может. */}
        {/* Подтверждение адреса выключено (EMAIL_VERIFICATION_ENABLED): страницы нет, старые
            ссылки уводит на вход общий `*`. Сервер такую ссылку по-прежнему принимает. */}
        {EMAIL_VERIFICATION_ENABLED ? (
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        ) : null}
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/change-password" element={<ChangePasswordPage />} />
          {/* Кабинет водителя — ВНЕ `AppLayout`: у него нет ни боковой панели, ни разделов, ни
              нижней навигации. Это второй контур портала, а не ещё одна его страница.
              Отсюда и гейт своим компонентом (`RequireDriverCabinet`, роль вместе с правом): у
              администратора `driverCabinet.read` есть по построению — права у него все, — и по
              одному праву он попадал сюда стартовой страницей, а выйти обратно в портал из контура
              без навигации ему было нечем. */}
          <Route element={<RequireDriverCabinet />}>
            <Route
              path="/driver"
              element={
                <Suspense fallback={<Spin style={{ margin: '40vh auto', display: 'block' }} />}>
                  <DriverLayout />
                </Suspense>
              }
            >
              <Route index element={<DriverPage />} />
            </Route>
          </Route>
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
            {/* Недельная заявка (ADR 0085) — своя страница с адресом, а не окно поверх списка:
                три блока состава, история и документы в модалку не помещаются, а ссылку на
                неделю нужно уметь послать. Право своё: `vehicleRequests.read` есть у
                наблюдателя и арендодателя, которым планы площадок не показывают (Р12). */}
            <Route element={<RequirePermission permission="weeklyRequests.read" />}>
              <Route path="/vehicle-requests/weekly/:id" element={<WeeklyRequestPage />} />
            </Route>
            {/* Орг.техника (ADR 0085) — третий модуль заявок: обслуживание оргтехники ведут
                три стороны (заказчик, оператор оргтехники, сервисная компания). Раздел
                открывают два права: заявки — `serviceRequests.read`, парк техники —
                `officeEquipment.read` (Р72). Второе есть у менеджера и диспетчера, у которых
                модуля заявок нет вовсе, и до вкладки «Техника» они иначе не дошли бы. Что
                доступно внутри, решают коридор переходов и право самой вкладки. */}
            <Route
              element={
                <RequirePermission permission={['serviceRequests.read', 'officeEquipment.read']} />
              }
            >
              <Route path="/office-equipment" element={<ServiceRequestsPage />} />
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
            {/* Справочники — тоже страница из вкладок под разными правами (Р7): весь набор
                ведёт `directories.write`, одну вкладку «Оргтехника» — `officeEquipment.write`
                (ADR 0085). Требовать оба значило бы закрыть раздел ответственному за
                оргтехнику, а выдать ему `directories.write` — отдать заодно объекты,
                контрагентов и прайс вывоза. */}
            <Route
              element={
                <RequirePermission permission={['directories.write', 'officeEquipment.write']} />
              }
            >
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
