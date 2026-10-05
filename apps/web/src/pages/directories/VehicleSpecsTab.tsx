import { vehicleSpecKeys, vehicleSpecsApi } from '@entities/vehicle-type';
import { usePurgeAction } from '@features/purge-record';
import { useVehicleSpecEditor } from '@features/vehicle-spec-editor';
import { VehicleSpecRegistry } from '@widgets/vehicle-spec-registry';

/** Directory-route composition for the vehicle specification registry. */
export function VehicleSpecsTab() {
  const editor = useVehicleSpecEditor();
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
