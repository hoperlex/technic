import { Spin, Tabs, Typography } from 'antd';
import { FileLinkList } from '@entities/file';
import { RequestHistoryTable } from '@entities/request-history';
import { vehicleRequestChangeLabels } from '@technic/contracts';
import { ViewFields, ViewModal } from '@shared/ui';
import type { VehicleRequestViewModalProps } from '../model/types';
import { useVehicleRequestViewData } from '../model/useVehicleRequestViewData';
import { RequestTripsTable } from './RequestTripsTable';
import { requestAssignmentFields } from './requestAssignmentFields';
import { requestExecutionFields } from './requestExecutionFields';
import { requestOverviewFields } from './requestOverviewFields';
import { vehicleRequestCardFooter } from './vehicleRequestCardFooter';
import { VehicleShiftsView } from './VehicleShiftsView';

/**
 * Vehicle request card: read-only fields and the event history (ADR 0015). It opens from the row
 * actions because the table has no room for everything, and the author, addresses and who edited
 * the request when are needed while examining one request, not in the list. Editing is a separate
 * window with the same form. Built like the waste removal card (ADR 0012), minus the closing
 * evidence: vehicle requests have no trucks and tickets to present.
 *
 * The same card serves the editable lists and the URL-backed read-only overlay (ADR 0120 item 7);
 * see readOnly in VehicleRequestViewModalProps for what that mode hides and what it keeps.
 */
export function VehicleRequestViewModal({
  request,
  onClose,
  onEdit,
  onCopy,
  onReassign,
  onChangeMachinist,
  onTransfer,
  onRelocate,
  onIssueEsm2,
  earlyEndActions,
  readOnly,
  renderDays,
  weeklyRequestPath,
}: VehicleRequestViewModalProps) {
  const view = useVehicleRequestViewData(request, readOnly, !!onTransfer);
  const fields = request
    ? [
        ...requestOverviewFields({
          request,
          amountText: view.amountText,
          earlyEndActions,
          singleTrip: view.singleTrip,
          trips: view.trips,
          weekly: view.weekly,
          weeklyRequestPath,
        }),
        ...requestAssignmentFields({
          request,
          asksDriver: view.asksDriver,
          assignmentHint: view.assignmentHint,
          can: view.can,
          canTransfer: view.canTransfer,
          driver: view.driver,
          isDriverPending: view.isDriverPending,
          onChangeMachinist,
          onReassign,
          onTransfer,
          openedRouteId: view.openedRouteId,
          openRoute: view.openRoute,
          openRoutesList: view.openRoutesList,
          showAllRoutes: view.showAllRoutes,
        }),
        ...requestExecutionFields({
          request,
          asksRelocations: view.asksRelocations,
          can: view.can,
          onIssueEsm2,
          onRelocate,
          openedRouteId: view.openedRouteId,
          openRoute: view.openRoute,
          relocations: view.relocations,
          waybills: view.waybills,
        }),
      ]
    : [];

  // The request itself: fields, files and history, i.e. what the card showed before it had tabs.
  const main = request && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Layout belongs to ViewFields: a field only says whether it needs a full row (full). Column
          count and widths are computed there, and a phone gets one column. */}
      <ViewFields items={fields} />

      {/* Trips are their own section rather than a field: the table is wider than a row share even
          with full, and next to "Files" and "History" it reads as what it is, the list of order
          lines. A one-trip request never gets here: the field pair above shows it (R24). */}
      {view.trips && !view.singleTrip && (
        <div>
          <Typography.Text strong>Ездки</Typography.Text>
          <div style={{ marginTop: 12 }}>
            <RequestTripsTable trips={view.trips} />
          </div>
        </div>
      )}

      {request.files.length > 0 && (
        <div>
          <Typography.Text strong>Файлы</Typography.Text>
          <FileLinkList files={request.files} maxNameWidth={420} />
        </div>
      )}

      <div>
        <Typography.Text strong>История</Typography.Text>
        <div style={{ marginTop: 12 }}>
          {view.isPending ? (
            <Spin size="small" />
          ) : view.rows.length > 0 ? (
            // One event per row: status bubbles on the left, then the gist and changed values.
            <RequestHistoryTable rows={view.rows} labels={vehicleRequestChangeLabels} />
          ) : (
            <Typography.Text type="secondary">История недоступна</Typography.Text>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <ViewModal
      title={request ? `Заявка ${request.displayNumber}` : 'Заявка'}
      open={!!request}
      onClose={onClose}
      width={1000}
      // The window is reopened on a neighbouring request; expanded rows of the previous history
      // must not carry over.
      destroyOnHidden
      footer={vehicleRequestCardFooter({
        request,
        onClose,
        onEdit,
        onCopy,
        requestListHref: view.requestListHref,
        isMobile: view.isMobile,
      })}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Tabs appear only for special equipment, where there is something for a second tab:
              shifts are kept by work day, while freight has a delivery moment, not a period. A
              card with a single page needs no tab bar. */}
          {request.requestType === 'special_equipment' ? (
            <Tabs
              items={[
                { key: 'request', label: 'Заявка', children: main },
                /*
                 * Work days (ADR 0100 decision 8) are where days are run, one by one or as a batch
                 * for the whole period. The tab is open to ANY on-site equipment order, not only a
                 * linear one (ADR 0207 decision 1): a daily 4-P is asked for a vehicle that stands
                 * on site all week too, and hiding the door by the type flag would answer "no such
                 * paper" where it is issued. An order that is not entitled to days (a rental, one
                 * not taken into work) gets the server's explanation (blocker) instead of emptiness.
                 *
                 * The tab has no permission of its own (ADR 0122): "who comes to me on Thursday and
                 * with what" is the customer's question; day planning is gated by canPlan inside.
                 *
                 * readOnly is passed through on purpose: in the overlay opened from a route the
                 * planning right (vehicleRequests.status + waybills.read) equals the right that
                 * opened the route, so without it a dispatcher would get a working day planner over
                 * that very route (ADR 0120 item 7). The tab itself stays: it answers "which route
                 * carries which day", the question the overlay is opened for.
                 */
                {
                  key: 'days',
                  label: 'Дни работ',
                  children: renderDays(request, readOnly),
                },
                {
                  key: 'shifts',
                  label: 'Смены',
                  // Read-only: shifts are confirmed on the "On site" tab, which shows what stands on
                  // the site today. People come here for them without a link to the site: to check
                  // an invoice or settle a dispute about hours.
                  children: <VehicleShiftsView requestId={request.id} />,
                },
              ]}
            />
          ) : (
            main
          )}
        </div>
      )}
    </ViewModal>
  );
}
