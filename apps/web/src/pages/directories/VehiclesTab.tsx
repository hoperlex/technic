import { useAuth } from '@entities/session';
import { vehicleKeys, vehiclesApi } from '@entities/vehicle';
import { usePurgeAction } from '@features/purge-record';
import { useVehicleEditor } from '@features/vehicle-editor';
import { useVehicleLifecycle } from '@features/vehicle-lifecycle';
import { VehicleRegistry } from '@widgets/vehicle-registry';

export function VehiclesTab() {
  // Directory maintainers can inspect archived vehicles; restoration has its own administrator
  // grant (ADR 0021), so the action must follow that grant rather than archive visibility.
  const { can } = useAuth();
  const editor = useVehicleEditor();
  const lifecycle = useVehicleLifecycle();
  // Permanent deletion (ADR 0060) is administrator-only and available only for archived rows.
  const purge = usePurgeAction({
    subject: 'технику',
    purge: vehiclesApi.purge,
    invalidate: [vehicleKeys.root],
  });

  return (
    <>
      <VehicleRegistry
        canRestore={can('archive.restore')}
        create={editor.actions.create}
        edit={editor.actions.edit}
        remove={lifecycle.remove}
        restore={lifecycle.restore}
        purge={purge}
      />
      {editor.node}
    </>
  );
}
