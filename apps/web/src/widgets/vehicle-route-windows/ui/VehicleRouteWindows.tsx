import { useRouteModalWindows } from '@features/route-modal';
import { VehicleRouteEditModal } from './VehicleRouteEditModal';
import { VehicleRouteModal } from './VehicleRouteModal';
import { VehicleRoutesModal } from './VehicleRoutesModal';

/** Render the three route windows from URL state owned by the route-modal feature. */
export function VehicleRouteWindows() {
  const state = useRouteModalWindows();

  return (
    <>
      {state.listOpen && (
        <VehicleRoutesModal
          open
          focusDate={state.focus.date}
          focusToken={state.focus.token}
          onChanged={state.refresh}
          onClose={state.closeRoutesList}
        />
      )}
      {state.routeId && (
        <VehicleRouteModal
          routeId={state.routeId}
          onChanged={state.refresh}
          onClose={state.closeRoute}
          onEdit={state.editRoute}
        />
      )}
      {state.editing && (
        <VehicleRouteEditModal
          route={state.editing}
          onClose={state.closeEdit}
          onSaved={state.finishEdit}
        />
      )}
    </>
  );
}
