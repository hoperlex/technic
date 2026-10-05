import { useState } from 'react';
import type { VehicleTypeDto } from '@technic/contracts';
import { useVehicleClassificationLifecycle } from '@features/vehicle-classification-lifecycle';
import { useVehicleTypeEditor } from '@features/vehicle-type-editor';
import { VehicleClassificationRegistry } from '@widgets/vehicle-classification-registry';
import { VehicleTypeCardDrawer } from '@widgets/vehicle-type-card';

/**
 * Compose classifier browsing with the independent type editor and type card use cases.
 *
 * The classification has two levels — type (ADR 0005) and category (ADR 0016) — but they are shown
 * as one list (ADR 0028): a type with categories is listed by its categories, without a row of its
 * own, while a type without specs stays itself. The spec set and category creation still live in
 * the type card (widgets/vehicle-type-card), because there they are one invariant.
 */
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
