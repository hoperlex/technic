import type { ReactElement } from 'react';
import { Button, Skeleton } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { ViewModal } from '@shared/ui';
import {
  RouteModalHost,
  type RequestCardRenderProps,
  type RouteCardRenderProps,
  type RouteEditRenderProps,
  type RouteListRenderProps,
} from '@widgets/route-modal-host';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';
import { VehicleRouteEditModal } from './VehicleRouteEditModal';
import { VehicleRouteModal } from './VehicleRouteModal';
import { VehicleRoutesModal } from './VehicleRoutesModal';

function renderRouteList(props: RouteListRenderProps) {
  return <VehicleRoutesModal open {...props} />;
}

function renderRouteCard(props: RouteCardRenderProps) {
  return <VehicleRouteModal {...props} />;
}

function renderRouteEdit(props: RouteEditRenderProps) {
  return <VehicleRouteEditModal {...props} />;
}

function renderRequestCard(props: RequestCardRenderProps) {
  return <RequestViewById {...props} />;
}

/** Connect the page-owned route windows to the URL-backed host shared by portal pages. */
export function RouteModalProvider(): ReactElement {
  return (
    <RouteModalHost
      renderRouteList={renderRouteList}
      renderRouteCard={renderRouteCard}
      renderRouteEdit={renderRouteEdit}
      renderRequestCard={renderRequestCard}
    />
  );
}

/** Load the request named by the URL while the host owns errors and parameter cleanup. */
function RequestViewById({ requestId, onClose }: RequestCardRenderProps): ReactElement {
  const { data } = useQuery({
    queryKey: vehicleRequestKeys.detail(requestId),
    queryFn: () => vehicleRequestsApi.get(requestId),
  });

  if (!data) {
    return (
      <ViewModal
        title="Заявка"
        open
        onClose={onClose}
        width={1000}
        footer={<Button onClick={onClose}>Закрыть</Button>}
      >
        <Skeleton active paragraph={{ rows: 6 }} />
      </ViewModal>
    );
  }

  return <VehicleRequestViewModal request={data} onClose={onClose} readOnly />;
}
