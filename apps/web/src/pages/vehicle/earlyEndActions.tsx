import { useVehicleRequestEarlyEnd } from '@widgets/vehicle-request-lifecycle';
import { reassignStaleReason, recheckReasonOf } from '@features/vehicle-assignment';
import { VehicleEarlyEndApproveModal } from './VehicleEarlyEndApproveModal';

/**
 * Page-level adapter that binds the lifecycle widget's early-end host to this page's dialogs for
 * the "On site" view (`VehicleRequestsOnSiteTab`, typed by `onSiteCells`). It exists because the
 * widget cannot import page files: the approval dialog (`VehicleEarlyEndApproveModal`) and the
 * stale-preview readers are injected here, exactly as `useVehicleRequestOperations` does for the
 * request feed.
 *
 * Known debt, not a scheduled step: the two pages wire the same host twice, and the on-site view
 * also repeats the approve/reject/withdraw buttons that `useVehicleRequestLifecycle` renders as
 * `earlyEndActions`. The adapter can go once the early-end dialogs live in a slice the widget may
 * import and the on-site view consumes the widget's controller directly; until then any change to
 * the injected dialog or stale-reason readers must be made in both places.
 */
export function useEarlyEnd() {
  return useVehicleRequestEarlyEnd({
    staleReasonOf: (error) => reassignStaleReason(error) ?? recheckReasonOf(error),
    renderApproveModal: (props) => <VehicleEarlyEndApproveModal {...props} />,
  });
}
