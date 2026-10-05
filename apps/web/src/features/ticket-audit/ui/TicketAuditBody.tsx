import { Segmented, Select, Space } from 'antd';
import type { TicketAuditPeriod } from '@technic/contracts';
import { useIsMobile } from '@shared/lib';
import type { useTicketAudit } from '../model/useTicketAudit';
import { TICKET_AUDIT_VIEWS, TICKET_AUDIT_VIEW_LABELS, type TicketAuditView } from '../model/view';
import { TicketAuditAccuracy } from './TicketAuditAccuracy';
import { TicketAuditCohorts } from './TicketAuditCohorts';
import { TicketAuditEvents } from './TicketAuditEvents';
import { TicketAuditOperations } from './TicketAuditOperations';
import { TicketAuditSummary } from './TicketAuditSummary';

type Props = Pick<
  ReturnType<typeof useTicketAudit>,
  'period' | 'view' | 'setPeriod' | 'setView'
> & {
  open: boolean;
};

/** Presentation loads only inside the opened shell; URL and permission ownership stays outside. */
export function TicketAuditBody({ view, period, setView, setPeriod, open }: Props) {
  const isMobile = useIsMobile();
  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {/* These are five views of one report, not separate documents, hence a segmented switch.
            A phone uses a select: five long captions would either be unreadable or force the
            entire window to scroll horizontally (plan section 5). */}
      {isMobile ? (
        <Select<TicketAuditView>
          value={view}
          onChange={setView}
          style={{ width: '100%' }}
          options={TICKET_AUDIT_VIEWS.map((value) => ({
            value,
            label: TICKET_AUDIT_VIEW_LABELS[value],
          }))}
        />
      ) : (
        <Segmented<TicketAuditView>
          value={view}
          onChange={setView}
          options={TICKET_AUDIT_VIEWS.map((value) => ({
            value,
            label: TICKET_AUDIT_VIEW_LABELS[value],
          }))}
        />
      )}
      {/*
       * The URL selects the view, but all views share one period. Switching must not change
       * dates: neighbouring numbers for different periods would describe different reports.
       * The same bounds mean events, re-check assignment or observations in different views
       * (section 1.3). Each view explains that in its label, not by owning different dates.
       * System status has no period and no period bar at all.
       */}
      <ViewBody view={view} period={period} onPeriodChange={setPeriod} enabled={open} />
    </Space>
  );
}

/**
 * A switch makes the five report views exhaustive: adding a sixth exposes the missing case to
 * TypeScript, whereas a trailing ternary would silently show another view.
 *
 * enabled stops requests for the closed view. Only the selected view mounts; hiding five mounted
 * screens with styles would keep querying their endpoints on every period change.
 */
function ViewBody({
  view,
  period,
  onPeriodChange,
  enabled,
}: {
  view: TicketAuditView;
  period: TicketAuditPeriod;
  onPeriodChange: (period: TicketAuditPeriod) => void;
  enabled: boolean;
}) {
  switch (view) {
    case 'summary':
      return (
        <TicketAuditSummary period={period} onPeriodChange={onPeriodChange} enabled={enabled} />
      );
    case 'cohorts':
      return (
        <TicketAuditCohorts period={period} onPeriodChange={onPeriodChange} enabled={enabled} />
      );
    case 'events':
      return (
        <TicketAuditEvents period={period} onPeriodChange={onPeriodChange} enabled={enabled} />
      );
    case 'operations':
      // No period prop: neither this endpoint nor this question has one (section 1.3).
      // An unused parameter would eventually invite an inappropriate calendar.
      return <TicketAuditOperations enabled={enabled} />;
    case 'blind':
      return (
        <TicketAuditAccuracy period={period} onPeriodChange={onPeriodChange} enabled={enabled} />
      );
  }
}
