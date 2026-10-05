import { lazy, useEffect } from 'react';
import { App } from 'antd';
import { ActiveWindowContent, AsyncContent, ViewModal, WindowActivityScope } from '@shared/ui';
import { useTicketAudit } from '../model/useTicketAudit';

const TicketAuditBody = lazy(() =>
  import('./TicketAuditBody').then((module) => ({ default: module.TicketAuditBody })),
);

/**
 * Ticket-recognition audit is a large window over the waste registry (ADR 0137, plan section 5).
 *
 * Its temporary placement must be replaceable by changing the entry point, not the report.
 * Like ADR 0120, the URL (?ticketAudit=1&view=cohorts&from=&to=) carries the period and view so
 * a shared link opens the same numbers and perspective that were being discussed.
 *
 * Mount beside the registry, above its tabs: links can arrive on any tab. The URL owner remains
 * synchronous so a cold chunk cannot delay closing or leave a revoked permission armed.
 */
export function TicketAuditModal({ allowed }: { allowed: boolean }) {
  const { opened, period, view, close, setPeriod, setView } = useTicketAudit();
  const { message } = App.useApp();

  /*
   * A URL parameter without permission is removed with an explanation: silent disappearance
   * would look broken. The same effect handles a live session update revoking the permission,
   * so a previously opened window closes as soon as its authority disappears.
   */
  useEffect(() => {
    if (allowed || !opened) return;
    message.error('Аудит распознавания вам недоступен');
    close();
  }, [allowed, opened, message, close]);

  const open = allowed && opened;
  return (
    <WindowActivityScope open={open}>
      <ViewModal
        title="Аудит распознавания талонов"
        open={open}
        onClose={close}
        width={960}
        // Reopening asks today's question rather than continuing yesterday's report interaction.
        destroyOnHidden
        footer={null}
      >
        <ActiveWindowContent>
          <AsyncContent>
            <TicketAuditBody
              view={view}
              period={period}
              setView={setView}
              setPeriod={setPeriod}
              open={open}
            />
          </AsyncContent>
        </ActiveWindowContent>
      </ViewModal>
    </WindowActivityScope>
  );
}
