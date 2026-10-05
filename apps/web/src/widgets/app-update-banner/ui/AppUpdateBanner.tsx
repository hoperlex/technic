import { useState, useSyncExternalStore } from 'react';
import { Alert, Button, Space, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useLocation } from 'react-router';
import { isClientUpgradeRequired, onClientUpgradeRequired } from '@shared/api';
import { reloadPage, useIsMobile, useVersionCheck } from '@shared/lib';

// Reload is initiated by the user so filled forms are not lost. The optional banner stays below
// AntD modals (1000), behind their mask, to avoid distracting someone filling a form.
//
// The driver cabinet has no "Later" (driver-readings-first, R13 item 3). A stale cabinet writes
// local reading drafts without a network request, in its old format: postponing an update can
// create incompatible data that someone must reconcile manually. There is no unsaved form to
// protect here; readings survive a reload in the draft, and no second person in the cab will
// come back to accept the dismissed update.
//
// A 426 client_upgrade_required is mandatory (ADR 0146 decision 7): the document is below
// MIN_CLIENT_CONTRACT, so neither this nor later requests can work. "Later" would outlive both
// releases, and the screen is blocked: nothing the user types can be saved anyway.
//
// A failed chunk also requires a reload — React caches the rejected import, and retrying it cannot
// recover that screen — but it does NOT block the document (user decision 06.10.2026). The API
// still answers, and the failure is as often a network blip as a deployment that removed an old
// asset; a full-screen mask would cost the person an open, unsaved form. So the banner cannot be
// dismissed, stays above modals, and leaves forms usable: the person saves and reloads themselves.
// It is not labelled as a server refusal.
//
// One component owns all update modes: an optional offer beneath a mandatory reload would imply
// a choice that no longer exists.
export function AppUpdateBanner() {
  const { latestBuildId, chunkLoadFailed } = useVersionCheck();
  const [dismissedBuildId, setDismissedBuildId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  // Transport can signal a refusal outside React, while answering another component's request.
  // Subscribe to the store instead of copying its state; SSR observes the same module snapshot.
  const upgradeRequired = useSyncExternalStore(
    onClientUpgradeRequired,
    isClientUpgradeRequired,
    isClientUpgradeRequired,
  );
  // Match the cabinet branch, not a prefix like /drivers, where an open form may justify deferral.
  const driverCabinet = pathname === '/driver' || pathname.startsWith('/driver/');

  // Mandatory recovery takes precedence over both a release offer and its previous dismissal.
  if (upgradeRequired) {
    const title = 'Портал обновился';
    return (
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'fixed',
          inset: 0,
          // Cover existing modals (1000) and the optional banner (900): the current document
          // cannot continue safely, including an already-open form.
          zIndex: 2000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: 'rgba(0, 0, 0, 0.45)',
        }}
      >
        <Alert
          type="warning"
          showIcon
          style={{ maxWidth: 520, boxShadow: '0 8px 32px rgba(0, 0, 0, 0.25)' }}
          title={title}
          description={
            <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
              <Typography.Text>
                Эта вкладка работает на устаревшей версии, и продолжать на ней нельзя: сервер
                отвечает на её запросы отказом. Обновите страницу — портал откроется заново.
              </Typography.Text>
              {/* A broken document cannot defer recovery; no automatic reload discards a form. */}
              <Button type="primary" icon={<ReloadOutlined />} onClick={reloadPage}>
                Обновить страницу
              </Button>
            </Space>
          }
        />
      </div>
    );
  }

  if (chunkLoadFailed) {
    const title = 'Не удалось загрузить часть портала';
    return (
      <div
        role="alert"
        aria-label={title}
        style={{
          position: 'fixed',
          insetInline: 0,
          top: 8,
          display: 'flex',
          justifyContent: 'center',
          // Above modals (1000) so an open form still shows the reason, but without a mask and with
          // pointer events only on the banner itself: the form below stays usable.
          zIndex: 1100,
          pointerEvents: 'none',
          paddingInline: 12,
        }}
      >
        <Alert
          type="warning"
          showIcon
          style={{
            maxWidth: 640,
            pointerEvents: 'auto',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)',
          }}
          title={title}
          description="Портал обновился или ненадолго пропала сеть. Сохраните то, что заполняете, и обновите страницу."
          action={
            <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={reloadPage}>
              Обновить страницу
            </Button>
          }
        />
      </div>
    );
  }

  // A dismissal belongs to one release, never to all future updates.
  if (!latestBuildId || latestBuildId === dismissedBuildId) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        insetInline: 0,
        // Stay above mobile navigation (ADR 0030), otherwise it would cover the update actions.
        bottom: isMobile ? 'calc(56px + var(--safe-bottom) + 8px)' : 16,
        display: 'flex',
        justifyContent: 'center',
        zIndex: 900,
        pointerEvents: 'none',
        // Narrow screens need margins so the banner does not touch both viewport edges.
        ...(isMobile ? { paddingInline: 12 } : {}),
      }}
    >
      <Alert
        type="info"
        showIcon
        title="Доступна новая версия приложения"
        style={{ pointerEvents: 'auto', boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)' }}
        action={
          <Space>
            <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={reloadPage}>
              Обновить
            </Button>
            {!driverCabinet && (
              <Button size="small" type="text" onClick={() => setDismissedBuildId(latestBuildId)}>
                Позже
              </Button>
            )}
          </Space>
        }
      />
    </div>
  );
}
