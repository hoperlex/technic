import { lazy } from 'react';
import { Button } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { activeManualsQuery } from '@entities/manual';
import { AsyncContent, ViewModal } from '@shared/ui';

const ManualsBody = lazy(() =>
  import('./ManualsBody').then((module) => ({ default: module.ManualsBody })),
);

/**
 * User manuals are administrator-maintained links, not documents bundled with the portal.
 * Unlike release news (ADR 0077), this menu item has no "new" dot: the list is only requested
 * on opening. Keep that query owner and its enabled condition while deferring presentation.
 * A stable shell can close immediately and retains focus when the body arrives.
 */
export function ManualsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isLoading, isError } = useQuery({ ...activeManualsQuery(), enabled: open });
  return (
    <ViewModal
      title="Руководства"
      open={open}
      onClose={onClose}
      width={480}
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <AsyncContent>
        <ManualsBody manuals={data?.items ?? []} isLoading={isLoading} isError={isError} />
      </AsyncContent>
    </ViewModal>
  );
}
