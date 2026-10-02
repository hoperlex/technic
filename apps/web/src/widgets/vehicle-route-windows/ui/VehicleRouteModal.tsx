import type { VehicleRouteDto } from '@technic/contracts';
import { useVehicleRouteWindow } from '../model/useVehicleRouteWindow';
import { VehicleRouteWindowView } from './VehicleRouteWindowView';

interface Props {
  routeId: string | null;
  onClose: () => void;
  /** Invalidate every screen whose route-derived data can be visible below this window. */
  onChanged: () => void;
  onEdit?: (route: VehicleRouteDto) => void;
}

/**
 * Route record window. The controller owns server state and commands; the view keeps the route
 * composition, document actions and nested correction windows visible as one coherent record.
 */
export function VehicleRouteModal({ routeId, onClose, onChanged, onEdit }: Props) {
  const state = useVehicleRouteWindow({ routeId, onChanged });
  return (
    <VehicleRouteWindowView routeId={routeId} onClose={onClose} onEdit={onEdit} state={state} />
  );
}
