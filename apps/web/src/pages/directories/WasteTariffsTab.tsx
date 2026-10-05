import { wasteTariffKeys, wasteTariffsApi } from '@entities/waste-tariff';
import { wasteTypeKeys, wasteTypesApi } from '@entities/waste-type';
import { usePurgeAction } from '@features/purge-record';
import { useWasteTariffEditor } from '@features/waste-tariff-editor';
import { useWasteTariffLifecycle } from '@features/waste-tariff-lifecycle';
import { useWasteTypeEditor } from '@features/waste-type-editor';
import { WasteTariffRegistry } from '@widgets/waste-tariff-registry';

/** Compose tariff-grid reading with independent price and waste-type actions. */
export function WasteTariffsTab() {
  // Permanent removal (ADR 0060) remains distinct from the ordinary isActive lifecycle because
  // historical request snapshots can still refer to a deactivated tariff or waste type.
  const purgeTariff = usePurgeAction({
    subject: 'цену',
    purge: wasteTariffsApi.purge,
    invalidate: [wasteTariffKeys.root],
  });
  const purgeType = usePurgeAction({
    subject: 'тип мусора',
    purge: wasteTypesApi.purge,
    // A waste type is both a grid row label and an editor option, so both families become stale.
    invalidate: [wasteTypeKeys.root, wasteTariffKeys.root],
  });
  const editor = useWasteTariffEditor(purgeTariff);
  const typeEditor = useWasteTypeEditor(purgeType);
  const lifecycle = useWasteTariffLifecycle();

  return (
    <>
      <WasteTariffRegistry
        onCreate={editor.actions.create}
        onCreateFor={editor.actions.createFor}
        onEdit={editor.actions.edit}
        onEditWasteType={typeEditor.actions.edit}
        onToggle={lifecycle.toggle}
        togglePending={lifecycle.pending}
      />
      {editor.node}
      {typeEditor.node}
    </>
  );
}
