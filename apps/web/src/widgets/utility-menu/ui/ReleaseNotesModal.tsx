import { lazy } from 'react';
import { Button } from 'antd';
import { useReleases } from '@entities/release';
import { AsyncContent, ViewModal } from '@shared/ui';

const ReleaseNotesBody = lazy(() =>
  import('./ReleaseNotesBody').then((module) => ({ default: module.ReleaseNotesBody })),
);

/**
 * Release news (ADR 0077) explains what changed, unlike AppUpdateBanner's "this page is old".
 * Without it users learn of changes only by noticing them or asking support.
 *
 * destroyOnHidden rebuilds the contents on every opening: a newer release can arrive during
 * the session and must be expanded instead of the one that was newest at the first opening.
 *
 * Keep the release query here and in the menu: the news dot needs it before opening. The
 * entity's module-level unseenSince snapshot must not be retaken after the menu calls markSeen.
 */
export function ReleaseNotesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { releases, isLoading, isError, unseenSince } = useReleases();
  return (
    <ViewModal
      title="Что нового"
      open={open}
      onClose={onClose}
      width={640}
      destroyOnHidden
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <AsyncContent>
        <ReleaseNotesBody
          releases={releases}
          isLoading={isLoading}
          isError={isError}
          unseenSince={unseenSince}
        />
      </AsyncContent>
    </ViewModal>
  );
}
