import { useVehicleRequestEarlyEnd } from '@widgets/vehicle-request-lifecycle';
import { assignmentRecheckReason } from '@features/vehicle-assignment';
import { VehicleEarlyEndApproveModal } from './VehicleEarlyEndApproveModal';

/**
 * Page-level adapter that binds the lifecycle widget's early-end host to this page's dialogs for
 * the "On site" view (`VehicleRequestsOnSiteTab`, typed by `onSiteCells`). It exists because the
 * widget cannot import page files: the approval dialog (`VehicleEarlyEndApproveModal`) and the
 * stale-preview readers are injected here, exactly as `useVehicleRequestOperations` does for the
 * request feed.
 *
 * Stage 4 debt: remove this adapter together with the lifecycle renderer ports after the history
 * dialogs and their shared consequence helpers have owners below widgets. Moving only the dialog
 * would create a feature-to-feature dependency on assignment. Both pages already use the same
 * early-end action renderer and stale-reason reader; only dialog composition remains here.
 */
export function useEarlyEnd() {
  return useVehicleRequestEarlyEnd({
    staleReasonOf: assignmentRecheckReason,
    renderApproveModal: (props) => <VehicleEarlyEndApproveModal {...props} />,
  });
}
