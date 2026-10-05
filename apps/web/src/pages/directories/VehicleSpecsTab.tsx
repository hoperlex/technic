import { vehicleSpecKeys, vehicleSpecsApi } from '@entities/vehicle-type';
import { usePurgeAction } from '@features/purge-record';
import { useVehicleSpecEditor } from '@features/vehicle-spec-editor';
import { VehicleSpecRegistry } from '@widgets/vehicle-spec-registry';

/** Directory-route composition for the vehicle specification registry. */
export function VehicleSpecsTab() {
  const editor = useVehicleSpecEditor();
  // Hard delete (docs/adr/0060-directory-record-purge.md): a detached and deactivated spec would
  // otherwise stay in the directory forever. Only a spec attached to no type reaches deletion.
  const purge = usePurgeAction({
    subject: 'ТТХ',
    purge: vehicleSpecsApi.purge,
    invalidate: [vehicleSpecKeys.root],
  });

  return (
    <>
      <VehicleSpecRegistry {...editor.actions} purge={purge} />
      {editor.node}
    </>
  );
}
