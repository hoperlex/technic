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
 * Pages are the only section detail owned by routing. SHELL_SECTIONS owns paths, permissions and
 * order; public page entries own their lazy factories, so importing this map loads no section UI.
 *
 * Record<PortalShellSectionId, ReactNode> makes a registry entry without a page a compile error.
 * The old three independent section lists let new sections appear in only two of the three.
 */
const SECTION_PAGES: Record<PortalShellSectionId, ReactNode> = {
  waste: <WasteRequestsPage />,
  'vehicle-requests': <VehicleRequestsPage />,
  waybills: <WaybillsPage />,
  garage: <GaragePage />,
  // "Механизация" opens with the rental request list; presence ("В аренде"), the closed-request
  // journal and the archive are tabs inside that page, not sections of their own.
  mechanization: <MechRequestsPage />,
  // Office equipment (ADR 0085) opens with service requests; its equipment registry is an inner tab.
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
        {/* Mail links must work before authentication: their recipients may be unable to log in. */}
        {/* With EMAIL_VERIFICATION_ENABLED off, old links fall through to login via `*`.
            The server still accepts verification links; only this page is disabled. */}
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
              {/* Readings are the cabinet's first screen (driver-readings-first, R1): they are
                  the only data drivers enter, so a read-only assignment must not add a click on
                  that path. The complete assignment remains linked from the header, with the
                  same date in its URL. */}
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
              {/* The index must stay outside section gates: every denial redirects here. A gate
                  on `/` would redirect to itself and leave a blank screen without explaining why. */}
              <Route index element={<HomeRedirect />} />
              {/* RequireSection, the menu and the landing page ask the same registry. Named
                  routes here would reintroduce the third section list. Suspense is below
                  AppLayout and the gate: the shell stays visible, and a denied section's lazy
                  factory is never rendered or requested. */}
              {SHELL_SECTIONS.map((section) => (
                <Route key={section.id} element={<RequireSection id={section.id} />}>
                  <Route
                    path={section.path}
                    element={<AsyncContent>{SECTION_PAGES[section.id]}</AsyncContent>}
                  />
                </Route>
              ))}
              {/* A weekly request (ADR 0085) needs its own shareable URL: three composition
                  blocks, history and documents do not fit a modal. It is not a shell section,
                  hence RequirePermission rather than a registry entry. Its own permission is
                  essential: observers and lessors have vehicleRequests.read but must not see
                  site plans (R12). */}
              <Route element={<RequirePermission permission="weeklyRequests.read" />}>
                <Route
                  path="/vehicle-requests/weekly/:id"
                  element={
                    <AsyncContent>
                      <WeeklyRequestPage />
                    </AsyncContent>
                  }
                />
              </Route>
            </Route>
          </Route>
        </Route>
        {/* Unknown URLs redirect to the index instead of drawing HomeRedirect here: its
            no-sections screen still needs the shell's account menu and logout control. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
