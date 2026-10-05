import { type ReactNode } from 'react';
import { Spin } from 'antd';
import { Navigate, Route, Routes } from 'react-router';
import {
  EMAIL_VERIFICATION_ENABLED,
  SHELL_SECTIONS,
  type PortalShellSectionId,
} from '@technic/contracts';
import { AppLayout } from './app/layout';
import { AppUpdateBanner } from '@widgets/app-update-banner';
import { AsyncContent } from '@shared/ui';
import { HomeRedirect, ProtectedRoute, RequirePermission, RequireSection } from '@app/routing';
import { RouteModalProvider } from '@app/route-windows';
import { AdministrationPage } from '@pages/admin';
import {
  ChangePasswordPage,
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from '@pages/auth';
import { DirectoriesPage } from '@pages/directories';
import { DriverLayout, DriverPage, DriverReadingsPage } from '@pages/driver';
import { GaragePage } from '@pages/garage';
import { MechRequestsPage } from '@pages/mech';
import { ServiceRequestsPage } from '@pages/service';
import { VehicleRequestsPage, WeeklyRequestPage } from '@pages/vehicle';
import { WasteRequestsPage } from '@pages/waste';
import { WaybillsPage } from '@pages/waybills';

/**
 * Чем открывается каждый раздел каркаса — и всё, что маршруты знают о разделах сами. Адреса, права
 * и порядок держит реестр (`SHELL_SECTIONS`), здесь остаётся страница.
 *
 * `Record` по `PortalShellSectionId` — не оформление, а сама гарантия: раздел, заведённый в реестре
 * без страницы, не собирается. Раньше состав разделов жил тремя независимыми списками, и новый
 * заводили в двух копиях из трёх.
 */
const SECTION_PAGES: Record<PortalShellSectionId, ReactNode> = {
  waste: <WasteRequestsPage />,
  'vehicle-requests': <VehicleRequestsPage />,
  waybills: <WaybillsPage />,
  garage: <GaragePage />,
  // "Механизация" opens with the rental request list; presence ("В аренде"), the closed-request
  // journal and the archive are tabs inside that page, not sections of their own.
  mechanization: <MechRequestsPage />,
  // «Орг.техника» (ADR 0085) открывается заявками на обслуживание; парк техники — вкладка внутри.
  'office-equipment': <ServiceRequestsPage />,
  directories: <DirectoriesPage />,
  admin: <AdministrationPage />,
};

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
          {/* The driver cabinet is outside AppLayout: no sidebar, sections or bottom navigation.
              It is a second portal shell with its own layout and index, so its branch is composed
              explicitly. Only the entry condition is shared: RequireSection reads the role and
              permission from the registry instead of duplicating them in another guard. */}
          <Route element={<RequireSection id="driver-cabinet" />}>
            <Route
              path="/driver"
              element={
                <AsyncContent fallback={<Spin style={{ margin: '40vh auto', display: 'block' }} />}>
                  <DriverLayout />
                </AsyncContent>
              }
            >
              {/* Кабинет открывается формой показаний, а не заданием (план driver-readings-first,
                  Р1): показания — единственное, что водитель в портал вводит, и добираться до них
                  нажатием поверх читающего экрана он больше не должен. Задание осталось целиком —
                  страницей по ссылке из шапки, с той же датой в адресе. */}
              <Route index element={<DriverReadingsPage />} />
              <Route path="assignment" element={<DriverPage />} />
            </Route>
          </Route>
          {/* Route, route-list and request windows (ADR 0120) are above the whole portal branch:
              requests, the garage and the waybill journal all open them, so their URL owner must
              outlive navigation between these three sections. App composes public widget/feature
              entries and the page-owned request card; importing a page-owned provider here would
              pull the vehicle section into the initial bundle. The driver cabinet keeps its own
              shell outside this branch and must not receive these portal windows. */}
          <Route element={<RouteModalProvider />}>
            <Route element={<AppLayout />}>
              {/* Стартовая страница гейтом НЕ накрывается, и это условие устройства, а не
                  случайность: отказ любого гейта ведёт сюда, и страж на самом `/` отбивал бы
                  входящего в себя же — React Router отдал бы пустой экран без единого следа
                  причины. */}
              <Route index element={<HomeRedirect />} />
              {/* Разделы каркаса — циклом по реестру: кому какой открыт, знает `RequireSection`,
                  и тот же ответ получают меню и стартовая страница. Поимённых маршрутов здесь
                  больше нет — они и были третьей копией состава разделов. */}
              {SHELL_SECTIONS.map((section) => (
                <Route key={section.id} element={<RequireSection id={section.id} />}>
                  <Route path={section.path} element={SECTION_PAGES[section.id]} />
                </Route>
              ))}
              {/* Недельная заявка (ADR 0085) — своя страница с адресом, а не окно поверх списка:
                  три блока состава, история и документы в модалку не помещаются, а ссылку на
                  неделю нужно уметь послать. Разделом она не является — отсюда `RequirePermission`
                  и своё право: `vehicleRequests.read` есть у наблюдателя и арендодателя, которым
                  планы площадок не показывают (Р12). */}
              <Route element={<RequirePermission permission="weeklyRequests.read" />}>
                <Route path="/vehicle-requests/weekly/:id" element={<WeeklyRequestPage />} />
              </Route>
            </Route>
          </Route>
        </Route>
        {/* Неизвестный адрес — на корень, а не сразу стартовой страницей: та умеет отвечать
            экраном «разделов нет», и вне ветки каркаса он отрисовался бы голым — без меню учётной
            записи и без выхода. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
