import type { ReactElement } from 'react';
import { Button, Skeleton } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { AsyncContent, ViewModal } from '@shared/ui';
import { RouteModalHost, type RequestCardRenderProps } from '@widgets/route-modal-host';
import { VehicleRouteWindows } from '@widgets/vehicle-route-windows';
import { VehicleRequestViewModal } from '@pages/vehicle';

function renderRequestCard(props: RequestCardRenderProps) {
  return <RequestViewById {...props} />;
}

/*
 * Composition root of the URL-backed windows (ADR 0120), mounted above every portal page by
 * App.tsx. URL state lives in @features/route-modal, the route windows in
 * @widgets/vehicle-route-windows. The request card comes through the vehicle page's public entry:
 * it is bound to page-owned VehicleRequestDays, and widgets may not import pages (the boundary
 * matrix in docs/frontend-fsd-stage-2.md). Keeping this composition in app lets all three caller
 * sections share the URL host without making the vehicle section part of the initial bundle.
 */
export function RouteModalProvider(): ReactElement {
  return (
    <RouteModalHost renderRequestCard={renderRequestCard}>
      <VehicleRouteWindows />
    </RouteModalHost>
  );
}

/**
 * A request as a window. The list card receives a ready DTO from its row; here there is no row,
 * only an id from the URL.
 *
 * The query key is the one the URL host and the tabs use, so there is still a single network
 * request. The split of duties is honest: the host (useRouteModalState) owns the error and URL
 * cleanup, including the "not found or unavailable" message, and this wrapper owns display; an
 * error drops the parameter and the window leaves with it.
 *
 * Read-only means "no actions": edit, vehicle change, transfer to a route, relocation, ESM-2 and
 * the early-end decision reach the card as optional props, and not passing them hides them. One
 * explicit readOnly is still needed: the card mounts the "Work days" tab of a linear order by
 * itself, and that tab's own planning buttons are not closed by props (ADR 0120 item 7).
 */
function RequestViewById({ requestId, onClose }: RequestCardRenderProps): ReactElement {
  const { data } = useQuery({
    queryKey: vehicleRequestKeys.detail(requestId),
    queryFn: () => vehicleRequestsApi.get(requestId),
  });

  /*
   * The window is already open while the request loads: the id is known before the record, and
   * waiting inside the window is more honest than delaying it. Otherwise a click on a request
   * number looks for half a second like a click that led nowhere.
   */
  const pending = (
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
  if (!data) return pending;

  // Code and data can arrive in either order. Both waits keep a closeable window over the page;
  // putting Suspense around the provider instead would hide the entire portal on a cold link.
  return (
    <AsyncContent fallback={pending}>
      <VehicleRequestViewModal request={data} onClose={onClose} readOnly />
    </AsyncContent>
  );
}
