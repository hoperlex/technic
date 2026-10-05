import { useState } from 'react';
import { Tabs } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import type { UserAccountDto } from '@technic/contracts';
import {
  DriverRestoreModal,
  personFactsOf,
  restoreNeedsPerson,
  useUserAccountEditor,
} from '@features/user-account-editor';
import { useUserAccountLifecycle } from '@features/user-account-lifecycle';
import { usePurgeAction } from '@features/purge-record';
import { useAuth } from '@entities/session';
import { userAuditKeys } from '@entities/user-audit';
import { userAccountKeys, usersApi } from '@entities/user-account';
import { UserAccountRegistry } from '@widgets/user-account-registry';
import { UserAuditPathDrawer, UsersAuditTab, type AuditTarget } from '@widgets/user-audit';

/** Compose the account registry, account commands and the independently protected audit widget. */
export function UsersTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const editor = useUserAccountEditor();
  const canReadAudit = can('audit.read');
  const [tab, setTab] = useState('accounts');
  const [pathUser, setPathUser] = useState<AuditTarget | null>(null);
  const purge = usePurgeAction({
    subject: 'учётную запись',
    purge: usersApi.purge,
    invalidate: [userAccountKeys.root],
  });

  const showHistory = (record: UserAccountDto) =>
    setPathUser({ id: record.id, name: record.fullName });

  const lifecycle = useUserAccountLifecycle({
    edit: editor.actions.edit,
    showHistory: canReadAudit ? showHistory : undefined,
    needsRestoreForm: restoreNeedsPerson,
    purge,
    renderRestoreModal: ({ record, ...port }) => (
      <DriverRestoreModal account={record ? personFactsOf(record) : null} {...port} />
    ),
  });

  const openTab = (key: string) => {
    // A hidden audit tab stays mounted, while account commands can add events next to it.
    if (key === 'audit') void qc.invalidateQueries({ queryKey: userAuditKeys.root });
    setTab(key);
  };

  const items = [
    {
      key: 'accounts',
      label: 'Учётные записи',
      children: (
        <>
          <UserAccountRegistry
            create={editor.actions.create}
            edit={editor.actions.edit}
            actionsFor={lifecycle.actionsFor}
            archivedActionsFor={lifecycle.archivedActionsFor}
          />
          {editor.node}
          {lifecycle.node}
        </>
      ),
    },
    ...(canReadAudit
      ? [
          {
            key: 'audit',
            label: 'Аудит',
            children: <UsersAuditTab />,
          },
        ]
      : []),
  ];

  return (
    <div style={{ height: '100%' }}>
      <UserAuditPathDrawer target={pathUser} onClose={() => setPathUser(null)} />
      <Tabs
        className="full-height-tabs"
        size="small"
        activeKey={tab}
        onChange={openTab}
        items={items}
      />
    </div>
  );
}
