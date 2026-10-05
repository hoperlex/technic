import { lazy } from 'react';
import type { VehicleRequestDto } from '@technic/contracts';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';

const VehicleRequestHistory = lazy(() =>
  import('@widgets/vehicle-request-history').then((module) => ({
    default: module.VehicleRequestHistory,
  })),
);

// No edit actions from the journal: a closed request is not edited.
function renderRequest(request: VehicleRequestDto | null, onClose: () => void) {
  return <VehicleRequestViewModal request={request} onClose={onClose} />;
}

/** Bind the history widget to the vehicle page's request-card adapter. */
export function VehicleRequestsHistoryTab() {
  return <VehicleRequestHistory renderRequest={renderRequest} />;
}
