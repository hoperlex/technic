import { counterpartiesApi, counterpartyKeys } from '@entities/counterparty';
import { objectKeys } from '@entities/object';
import { useAuth } from '@entities/session';
import { vehicleKeys } from '@entities/vehicle';
import { useCounterpartyEditor } from '@features/counterparty-editor';
import { useCounterpartyLifecycle } from '@features/counterparty-lifecycle';
import { usePurgeAction } from '@features/purge-record';
import { CounterpartyRegistry } from '@widgets/counterparty-registry';

export function CounterpartiesTab() {
  // Archive visibility and restoration are separate grants (ADR 0021). Keep both action sets
  // behind their own grant so a reader never receives a restore button that only returns 403.
  const { can } = useAuth();
  const editor = useCounterpartyEditor();
  const lifecycle = useCounterpartyLifecycle();
  // Permanent deletion (ADR 0060) is archive-only; ordinary removal remains recoverable.
  const purge = usePurgeAction({
    subject: 'контрагента',
    purge: counterpartiesApi.purge,
    invalidate: [counterpartyKeys.root, vehicleKeys.root, objectKeys.root],
  });

  return (
    <>
      <CounterpartyRegistry
        canSeeArchive={can('archive.read')}
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
