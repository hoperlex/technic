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
    // Removing a document from the card is an administrator right (ADR 0021): maintaining documents
    // and erasing what was entered are different powers. The same right gates the replacement
    // checkbox that removes the previous document.
    canDelete: can('records.purge'),
  });
  const editor = useDriverEditor({ documentActions: documents.actions });
  const removal = useDriverRemoval();
  // Hard delete (docs/adr/0060-directory-record-purge.md) takes the person's documents and scans
  // along. Archive-only and administrator-only: waybills hold the driver by a foreign key.
  const purge = usePurgeAction({
    subject: 'водителя',
    purge: driversApi.purge,
    invalidate: [driverKeys.root],
  });

  return (
    <>
      <DriverRegistry
        canWrite={canWrite}
        // Directory archive (ADR 0021): removed drivers are visible with archive.read, so a removed
        // card can be checked and purged instead of vanishing from the portal entirely.
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
