import { useState } from 'react';
import type { VehicleTypeDto } from '@technic/contracts';
import { useVehicleClassificationLifecycle } from '@features/vehicle-classification-lifecycle';
import { useVehicleTypeEditor } from '@features/vehicle-type-editor';
import { VehicleClassificationRegistry } from '@widgets/vehicle-classification-registry';
import { VehicleTypeCardDrawer } from '@widgets/vehicle-type-card';

/** Compose classifier browsing with the independent type editor and type card use cases. */
export function VehicleTypesTab() {
  const editor = useVehicleTypeEditor();
  const lifecycle = useVehicleClassificationLifecycle();
  const [card, setCard] = useState<VehicleTypeDto | null>(null);

  return (
    <>
      <VehicleClassificationRegistry
        onCreate={editor.actions.create}
        onEdit={editor.actions.edit}
        onOpenCard={setCard}
        onToggle={lifecycle.toggle}
        togglePending={lifecycle.pending}
      />
      {editor.node}
      <VehicleTypeCardDrawer type={card} onClose={() => setCard(null)} />
    </>
  );
}
