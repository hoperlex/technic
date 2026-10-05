import { lazy } from 'react';
import { Button, Skeleton } from 'antd';
import { useRouteModalWindows } from '@features/route-modal';
import { AsyncContent, ViewModal } from '@shared/ui';

const VehicleRouteEditModal = lazy(() =>
  import('./VehicleRouteEditModal').then((module) => ({ default: module.VehicleRouteEditModal })),
);
const VehicleRouteModal = lazy(() =>
  import('./VehicleRouteModal').then((module) => ({ default: module.VehicleRouteModal })),
);
const VehicleRoutesModal = lazy(() =>
  import('./VehicleRoutesModal').then((module) => ({ default: module.VehicleRoutesModal })),
);

function pending(title: string, onClose: () => void, width: number) {
  // The URL opens the window immediately, even before its code arrives. Closing it removes the
  // conditional mount below, so a late import cannot reopen a window the user already dismissed.
  return (
    <ViewModal
      title={title}
      open
      onClose={onClose}
      width={width}
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <Skeleton active paragraph={{ rows: 6 }} />
    </ViewModal>
  );
}

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
        <AsyncContent fallback={pending('Маршруты', state.closeRoutesList, 1080)}>
          <VehicleRoutesModal
            open
            focusDate={state.focus.date}
            focusToken={state.focus.token}
            onChanged={state.refresh}
            onClose={state.closeRoutesList}
          />
        </AsyncContent>
      )}
      {state.routeId && (
        <AsyncContent fallback={pending('Маршрут', state.closeRoute, 720)}>
          <VehicleRouteModal
            routeId={state.routeId}
            onChanged={state.refresh}
            onClose={state.closeRoute}
            onEdit={state.editRoute}
          />
        </AsyncContent>
      )}
      {state.editing && (
        <AsyncContent
          fallback={pending(
            `Маршрут ${state.editing.displayNumber} · правка`,
            state.closeEdit,
            640,
          )}
        >
          <VehicleRouteEditModal
            route={state.editing}
            onClose={state.closeEdit}
            onSaved={state.finishEdit}
          />
        </AsyncContent>
      )}
    </>
  );
}
