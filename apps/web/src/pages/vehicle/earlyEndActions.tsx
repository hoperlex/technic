import { useVehicleRequestEarlyEnd } from '@widgets/vehicle-request-lifecycle';
import { reassignStaleReason, recheckReasonOf } from '@features/vehicle-assignment';
import { VehicleEarlyEndApproveModal } from './VehicleEarlyEndApproveModal';

/** Compatibility adapter for the on-site page until its own widget extraction wave. */
export function useEarlyEnd() {
  return useVehicleRequestEarlyEnd({
    staleReasonOf: (error) => reassignStaleReason(error) ?? recheckReasonOf(error),
    renderApproveModal: (props) => <VehicleEarlyEndApproveModal {...props} />,
  });
}
