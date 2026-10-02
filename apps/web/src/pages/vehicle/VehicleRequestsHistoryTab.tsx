import type { VehicleRequestDto } from '@technic/contracts';
import { VehicleRequestHistory } from '@widgets/vehicle-request-history';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';

function renderRequest(request: VehicleRequestDto | null, onClose: () => void) {
  return <VehicleRequestViewModal request={request} onClose={onClose} />;
}

/** Bind the history widget to the vehicle page's request-card adapter. */
export function VehicleRequestsHistoryTab() {
  return <VehicleRequestHistory renderRequest={renderRequest} />;
}
