import { lazy, Suspense, type ReactNode } from 'react';
import { Spin } from 'antd';
import { Navigate, Route, Routes } from 'react-router';
import {
  EMAIL_VERIFICATION_ENABLED,
  SHELL_SECTIONS,
  type PortalShellSectionId,
} from '@technic/contracts';
import { AppLayout } from './components/AppLayout';
import { AppUpdateBanner } from './components/AppUpdateBanner';
import {
  HomeRedirect,
  ProtectedRoute,
  RequirePermission,
  RequireSection,
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
import { RouteModalProvider } from './pages/vehicle/routeModal';
import { WeeklyRequestPage } from './pages/vehicle/WeeklyRequestPage';
import { GaragePage } from './pages/GaragePage';
import { ServiceRequestsPage } from './pages/service/ServiceRequestsPage';
import { MechRequestsPage } from './pages/mech/MechRequestsPage';
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
const DriverReadingsPage = lazy(() =>
  import('./pages/driver/DriverReadingsPage').then((m) => ({ default: m.DriverReadingsPage })),
);

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
  // «Механизация» открывается списком заявок на аренду: вкладка присутствия «В аренде» (Р13
  // плана `docs/mechanization-module-plan.md`) приходит следующим этапом и живёт внутри раздела.
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
          {/* Кабинет водителя — ВНЕ `AppLayout`: у него нет ни боковой панели, ни разделов, ни
              нижней навигации. Это второй контур портала, а не ещё одна его страница, поэтому
              ветку ему собирают руками — свой каркас и своя index-страница. Общее с разделами
              каркаса у него ровно одно, условие входа, и потому гейт тот же `RequireSection`:
              роль вместе с правом описана строкой реестра, а не отдельным компонентом. */}
          <Route element={<RequireSection id="driver-cabinet" />}>
            <Route
              path="/driver"
              element={
                <Suspense fallback={<Spin style={{ margin: '40vh auto', display: 'block' }} />}>
                  <DriverLayout />
                </Suspense>
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
          {/* Окна рейса, списка рейсов и заявки (ADR 0120) — отдельным элементом маршрутизации над
              всей веткой портала: рейс открывают из заявок, из гаража и из журнала листов, то есть
              со страниц трёх разных разделов, и держатель его адреса обязан стоять выше их всех.
              Здесь, а не в `AppLayout`: тот лежит в легаси-`components`, которым импорт `pages`
              запрещён матрицей границ, — а окна живут в `pages/vehicle`. Заодно провайдер не
              попадает в кабинет водителя: у того свой контур, вне этой ветки. */}
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
