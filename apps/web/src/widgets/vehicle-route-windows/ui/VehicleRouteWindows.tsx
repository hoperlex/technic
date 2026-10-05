import { useRouteModalWindows } from '@features/route-modal';
import { VehicleRouteEditModal } from './VehicleRouteEditModal';
import { VehicleRouteModal } from './VehicleRouteModal';
import { VehicleRoutesModal } from './VehicleRoutesModal';

/** Render the three route windows from URL state owned by the route-modal feature. */
export function VehicleRouteWindows() {
  const state = useRouteModalWindows();

  /*
   * Conditional mount instead of an open flag: destroyOnHidden only clears the ViewModal body,
   * while the state of child windows (correction, ticket transfer, adding a request, the edit)
   * lives outside it. A hidden window would keep them armed, and the next route would open with a
   * foreign correction window on top.
   */
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
