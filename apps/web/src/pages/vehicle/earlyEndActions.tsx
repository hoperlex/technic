import { useVehicleRequestEarlyEnd } from '@widgets/vehicle-request-lifecycle';
import { VehicleEarlyEndApproveModal } from './VehicleEarlyEndApproveModal';
import { recheckReasonOf } from './assignmentWarnings';
import { reassignStaleReason } from './ReassignPreview';

/** Compatibility adapter for the on-site page until its own widget extraction wave. */
export function useEarlyEnd() {
  return useVehicleRequestEarlyEnd({
    staleReasonOf: (error) => reassignStaleReason(error) ?? recheckReasonOf(error),
    renderApproveModal: (props) => <VehicleEarlyEndApproveModal {...props} />,
  });
}
