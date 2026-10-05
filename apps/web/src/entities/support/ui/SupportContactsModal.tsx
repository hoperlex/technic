import { lazy } from 'react';
import { AsyncContent, ViewModal } from '@shared/ui';

const SupportContactsBody = lazy(() =>
  import('./SupportContactsBody').then((module) => ({ default: module.SupportContactsBody })),
);

/**
 * Until the portal has its own support conversation, this is a person in a messenger: three
 * contact methods and a rule for choosing one (docs/support-plan.md), not a ticket form.
 * Keep the window shell available before its content so closing and focus do not wait on a chunk.
 */
export function SupportContactsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <ViewModal title="Техподдержка" open={open} onClose={onClose} width={420} footer={null}>
      <AsyncContent>
        <SupportContactsBody />
      </AsyncContent>
    </ViewModal>
  );
}
