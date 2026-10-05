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

/**
 * "Users" tab: the account registry and the audit log of actions on accounts (ADR 0088).
 *
 * The sub-tabs live here rather than as a second level in AdministrationPage: the log is read while
 * working through one particular account, and sending the administrator to a sibling section tab
 * would lose that context (and would also force a sub-level onto "Mailings" and "Directory
 * exchange", which have nothing to split).
 *
 * The tab strip is always compact, not only on phones: a second navigation level must not compete
 * in weight with the first, otherwise two identical strips in a row read as one.
 */
export function UsersTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const editor = useUserAccountEditor();
  // The log is gated by its own permission, not by role (ADR 0021): the whole tab opens with
  // users.manage, and nothing keeps these two permissions together — "Mailings" is split the same
  // way. Checking users.manage here would show the log to someone the server refuses.
  const canReadAudit = can('audit.read');
  const [tab, setTab] = useState('accounts');
  // Whose path is open in the drawer. History is asked straight from the registry row without
  // leaving it (ADR 0109): the "History" item used to switch to the audit sub-tab, and the person
  // reviewing an account lost both its row and the filter that led to it.
  const [pathUser, setPathUser] = useState<AuditTarget | null>(null);
  // Purge forever (ADR 0063) uses the shared directory hook so that the confirmation of an
  // irreversible action sounds the same everywhere.
  const purge = usePurgeAction({
    subject: 'учётную запись',
    purge: usersApi.purge,
    invalidate: [userAccountKeys.root],
  });

  const showHistory = (record: UserAccountDto) =>
    setPathUser({ id: record.id, name: record.fullName });

  const lifecycle = useUserAccountLifecycle({
    edit: editor.actions.edit,
    // Without audit.read there is no "History" item at all: the portal does not show unavailable
    // actions even disabled (ADR 0033 §6).
    showHistory: canReadAudit ? showHistory : undefined,
    needsRestoreForm: restoreNeedsPerson,
    purge,
    // Restoring a driver asks for the directory person (R8) in a modal rather than via a server
    // refusal: a live driver account cannot exist without one, and an archived account may have
    // lost the link together with a deleted person. Other accounts restore with one click.
    renderRestoreModal: ({ record, ...port }) => (
      <DriverRestoreModal account={record ? personFactsOf(record) : null} {...port} />
    ),
  });

  const openTab = (key: string) => {
    // A hidden sub-tab is not unmounted and would show its cache on return, while the log grows
    // with every portal action, including the one just made on the accounts sub-tab. Opening the
    // log means "show it as it is now", so the query is refreshed and the filters are kept — the
    // same technique section tabs use (PageTabs).
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
