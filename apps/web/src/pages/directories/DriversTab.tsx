import { driverKeys, driversApi } from '@entities/driver';
import { useAuth } from '@entities/session';
import { useDriverDocuments } from '@features/driver-documents';
import { useDriverEditor } from '@features/driver-editor';
import { useDriverRemoval } from '@features/driver-removal';
import { usePurgeAction } from '@features/purge-record';
import { DriverRegistry } from '@widgets/driver-registry';

/** Compose the driver registry with independent editor, document and removal commands. */
export function DriversTab() {
  const { can } = useAuth();
  const canWrite = can('drivers.write');
  const documents = useDriverDocuments({
    canWrite,
    canDelete: can('records.purge'),
  });
  const editor = useDriverEditor({ documentActions: documents.actions });
  const removal = useDriverRemoval();
  const purge = usePurgeAction({
    subject: 'водителя',
    purge: driversApi.purge,
    invalidate: [driverKeys.root],
  });

  return (
    <>
      <DriverRegistry
        canWrite={canWrite}
        canSeeArchive={can('archive.read')}
        create={editor.actions.create}
        edit={editor.actions.edit}
        replaceDocument={documents.open}
        remove={removal.remove}
        purge={purge}
      />
      {editor.node}
      {documents.node}
    </>
  );
}
