import type { ReactElement } from 'react';
import { Button, Skeleton } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { ViewModal } from '@shared/ui';
import { RouteModalHost, type RequestCardRenderProps } from '@widgets/route-modal-host';
import { VehicleRouteWindows } from '@widgets/vehicle-route-windows';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';

function renderRequestCard(props: RequestCardRenderProps) {
  return <RequestViewById {...props} />;
}

/** Compose URL state, route windows and the page-specific read-only request card. */
export function RouteModalProvider(): ReactElement {
  return (
    <RouteModalHost renderRequestCard={renderRequestCard}>
      <VehicleRouteWindows />
    </RouteModalHost>
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
