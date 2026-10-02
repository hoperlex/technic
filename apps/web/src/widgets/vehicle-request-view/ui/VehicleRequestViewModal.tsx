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

/** Read-only request card shared by list pages and URL-backed route overlays. */
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

  const main = request && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ViewFields items={fields} />

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
          {request.requestType === 'special_equipment' ? (
            <Tabs
              items={[
                { key: 'request', label: 'Заявка', children: main },
                {
                  key: 'days',
                  label: 'Дни работ',
                  children: renderDays(request, readOnly),
                },
                {
                  key: 'shifts',
                  label: 'Смены',
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
