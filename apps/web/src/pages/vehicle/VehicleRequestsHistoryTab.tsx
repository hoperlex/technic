import { lazy } from 'react';
import { useNavigate } from 'react-router';
import type { VehicleRequestDto } from '@technic/contracts';
import { useAuth } from '@entities/session';
import { vehicleRequestCopyLink } from '@entities/vehicle-request';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';

const VehicleRequestHistory = lazy(() =>
  import('@widgets/vehicle-request-history').then((module) => ({
    default: module.VehicleRequestHistory,
  })),
);

/**
 * Bind the history widget to the vehicle page's request-card adapter.
 *
 * No edit actions from the journal: a closed request is not edited. The only action the card
 * carries is the copy (ADR 0206), and that one it carries as a link. The section has a single
 * create form and it lives in the order list, so the card hands the reader over by address instead
 * of growing a second form here — the copy was wanted on closed orders precisely because "repeat
 * last year's order" is read off a closed one.
 */
export function VehicleRequestsHistoryTab() {
  const navigate = useNavigate();
  const { user, can } = useAuth();

  function renderRequest(request: VehicleRequestDto | null, onClose: () => void) {
    const copyHref = request ? vehicleRequestCopyLink(can, user, request) : null;
    return (
      <VehicleRequestViewModal
        request={request}
        onClose={onClose}
        onCopy={
          copyHref
            ? () => {
                // The card closes first: the address it leads to switches the tab, and a card left
                // open would stay on screen above the list it no longer belongs to.
                onClose();
                void navigate(copyHref);
              }
            : undefined
        }
      />
    );
  }

  return <VehicleRequestHistory renderRequest={renderRequest} />;
}
