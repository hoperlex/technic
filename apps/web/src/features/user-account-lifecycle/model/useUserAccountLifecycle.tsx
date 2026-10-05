import { useState, type ReactNode } from 'react';
import { App, Form } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RejectUserBody, UserAccountDto } from '@technic/contracts';
import { useAuth } from '@entities/session';
import {
  isPendingRegistration,
  PasswordField,
  type RestoreUserBody,
  userAccountErrorMessage as errorMessage,
  userAccountKeys,
  usersApi,
  withMailOutcome,
} from '@entities/user-account';
import { FormModal, type ActionSheetItem } from '@shared/ui';
import { RejectRegistrationModal } from '../ui/RejectRegistrationModal';
import { useChangeEmailAction } from '../ui/ChangeEmailModal';

interface RestoreModalPort {
  record: UserAccountDto | null;
  onCancel: () => void;
  onSubmit: (body: RestoreUserBody) => void;
  confirmLoading: boolean;
}

interface Options {
  edit: (record: UserAccountDto) => void;
  /**
   * Open the audit path of this account. Absent when the viewer has no permission for the log, and
   * then the item is absent too: the portal does not show unavailable actions even disabled (ADR
   * 0033 §6).
   */
  showHistory?: (record: UserAccountDto) => void;
  needsRestoreForm: (record: UserAccountDto) => boolean;
  renderRestoreModal: (port: RestoreModalPort) => ReactNode;
  purge: {
    allowed: boolean;
    pending: boolean;
    confirm: (id: string, name: string) => void;
  };
}

/**
 * Archived-row command. Loading is drawn only by the desktop row buttons: while it is set, the
 * button swallows clicks, so a double click on restore cannot send a second request.
 */
type ArchivedAccountAction = ActionSheetItem & { loading?: boolean };

export interface UserAccountLifecycleController {
  actionsFor: (record: UserAccountDto) => ActionSheetItem[];
  archivedActionsFor: (record: UserAccountDto) => ArchivedAccountAction[];
  node: ReactNode;
}

/** Own every command that changes an existing account outside the editor form. */
export function useUserAccountLifecycle({
  edit,
  showHistory,
  needsRestoreForm,
  renderRestoreModal,
  purge,
}: Options): UserAccountLifecycleController {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { user: currentUser, can } = useAuth();
  const [passwordUser, setPasswordUser] = useState<UserAccountDto | null>(null);
  const [rejecting, setRejecting] = useState<UserAccountDto | null>(null);
  const [restoring, setRestoring] = useState<UserAccountDto | null>(null);
  const [passwordForm] = Form.useForm<{ newPassword: string }>();

  const invalidateAccounts = () => void qc.invalidateQueries({ queryKey: userAccountKeys.root });

  const toggleActive = useMutation({
    mutationFn: (record: UserAccountDto) =>
      usersApi.update(record.id, { isActive: !record.isActive }),
    onSuccess: () => {
      message.success('Готово');
      invalidateAccounts();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => usersApi.remove(id),
    onSuccess: () => {
      message.success('Пользователь удалён');
      invalidateAccounts();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  // Return from the archive (ADR 0063). It invalidates the same account root as the other
  // commands: the pending-registrations counter lives under it too — a restored rejection goes back
  // to the queue, and the badge must show that.
  const restore = useMutation({
    mutationFn: ({ id, body }: { id: string; body?: RestoreUserBody }) =>
      usersApi.restore(id, body),
    onSuccess: () => {
      message.success('Учётная запись восстановлена — она осталась неактивной');
      setRestoring(null);
      invalidateAccounts();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const reject = useMutation({
    mutationFn: ({ id, body }: { id: string; body: RejectUserBody }) => usersApi.reject(id, body),
    onSuccess: ({ notified }) => {
      message.success(withMailOutcome('Заявка отклонена', notified, 'заявителю отправлено письмо'));
      setRejecting(null);
      invalidateAccounts();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  /*
   * cache-invalidation: none — a password change alters nothing the registry shows.
   *
   * The server rewrites the hash, sets mustChangePassword, bumps authVersion and revokes issued
   * sessions. None of these is visible in the list: the password is never shown, the flag is read
   * only for one's OWN account (from the session response, ProtectedRoute), and the table does not
   * render updatedAt. The new audit entry is picked up when the "Audit" sub-tab opens — that is
   * decided there, next to the log itself.
   */
  const password = useMutation({
    mutationFn: ({ id, newPassword }: { id: string; newPassword: string }) =>
      usersApi.setPassword(id, newPassword),
    onSuccess: () => {
      message.success('Пароль изменён. Пользователь должен сменить его при входе.');
      setPasswordUser(null);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  // Email change (ADR 0092) has its own hook: it sends two emails, archives a shadow record and logs
  // the administrator out when changing their own address; mixing that into the role and scope
  // commands would tangle two conversations.
  const changeEmail = useChangeEmailAction({
    currentUserId: currentUser?.id,
    onChanged: invalidateAccounts,
  });

  const requestRemove = (record: UserAccountDto) =>
    modal.confirm({
      title: `Удалить пользователя ${record.email}?`,
      content: 'Аккаунт будет деактивирован (soft-delete).',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => remove.mutateAsync(record.id),
    });

  const requestRestore = (record: UserAccountDto) =>
    needsRestoreForm(record) ? setRestoring(record) : restore.mutate({ id: record.id });

  /**
   * What can be done with a row. One list serves both modes: a dropdown menu on desktop and a
   * labelled sheet on the phone (ADR 0030 item 6, ADR 0042). They must not diverge — otherwise
   * "Reject registration" would exist only with a mouse.
   */
  const actionsFor = (record: UserAccountDto): ActionSheetItem[] => {
    const isSelf = record.id === currentUser?.id;
    const pendingRegistration = isPendingRegistration(record);

    return [
      {
        key: 'edit',
        label: pendingRegistration ? 'Рассмотреть заявку' : 'Редактировать',
        onClick: () => edit(record),
      },
      {
        key: 'password',
        label: 'Сменить пароль',
        onClick: () => {
          passwordForm.resetFields();
          setPasswordUser(record);
        },
      },
      // Changing the address, which is also the login (ADR 0092). The item is absent where the
      // server would refuse: on a pending registration (it is reviewed as a whole, the applicant's
      // address is not edited) and on another administrator's account — only its owner can move
      // it. The portal does not show unavailable actions even disabled (ADR 0033 §6): a disabled
      // item would promise an action that never happens.
      ...(!pendingRegistration && (isSelf || record.role !== 'admin')
        ? [{ key: 'email', label: 'Сменить email', onClick: () => changeEmail.openFor(record) }]
        : []),
      {
        key: 'toggle',
        label: record.isActive ? 'Деактивировать' : 'Активировать',
        disabled: isSelf && record.isActive,
        onClick: () => {
          // Activation without a role is forbidden (the server rejects it): a self-registered user
          // has no role, so activation goes through the form.
          if (!record.isActive && !record.role) {
            message.info('Назначьте роль — без неё учётку активировать нельзя');
            edit(record);
            return;
          }
          toggleActive.mutate(record);
        },
      },
      // Account history (ADR 0088, ADR 0109) is opened from here rather than by searching the
      // shared log: finding a person there by hand is exactly the work this screen saves.
      ...(showHistory
        ? [{ key: 'history', label: 'История', onClick: () => showHistory(record) }]
        : []),
      // Rejecting a pending registration and deleting an employee are different events: the audit
      // keeps the rejection reason, and neither the administrator nor a later review should mix
      // them up.
      ...(pendingRegistration
        ? [
            {
              key: 'reject',
              label: 'Отклонить заявку',
              danger: true,
              onClick: () => setRejecting(record),
            },
          ]
        : [
            {
              key: 'delete',
              label: 'Удалить',
              danger: true,
              disabled: isSelf,
              onClick: () => requestRemove(record),
            },
          ]),
    ];
  };

  /**
   * What can be done with an archived row (ADR 0063): return it from the archive or purge it
   * forever. The same list feeds the table buttons and the phone sheet, and each command keeps its
   * own permission: seeing the archive (archive.read) and managing it (archive.restore,
   * records.purge) are different permissions (ADR 0021). Restoring does not activate — a rejected
   * registration goes back to the queue and is reviewed again.
   */
  const archivedActionsFor = (record: UserAccountDto): ArchivedAccountAction[] => [
    // History is asked about an archived account more often than about a live one: only one row of
    // it is left in the list, and only the log tells how it all ended.
    ...(showHistory
      ? [{ key: 'history', label: 'История', onClick: () => showHistory(record) }]
      : []),
    ...(can('archive.restore')
      ? [
          {
            key: 'restore',
            label: 'Восстановить',
            loading: restore.isPending,
            onClick: () => requestRestore(record),
          },
        ]
      : []),
    ...(purge.allowed
      ? [
          {
            key: 'purge',
            label: 'Удалить окончательно',
            danger: true,
            loading: purge.pending,
            onClick: () => purge.confirm(record.id, record.email),
          },
        ]
      : []),
  ];

  return {
    actionsFor,
    archivedActionsFor,
    node: (
      <>
        <FormModal
          title={`Смена пароля: ${passwordUser?.email ?? ''}`}
          open={!!passwordUser}
          onCancel={() => setPasswordUser(null)}
          onSubmit={() => passwordForm.submit()}
          confirmLoading={password.isPending}
          width={520}
        >
          <Form
            form={passwordForm}
            layout="vertical"
            onFinish={({ newPassword }) =>
              passwordUser && password.mutate({ id: passwordUser.id, newPassword })
            }
          >
            <PasswordField name="newPassword" label="Новый пароль" />
          </Form>
        </FormModal>

        <RejectRegistrationModal
          open={!!rejecting}
          email={rejecting?.email}
          onCancel={() => setRejecting(null)}
          onSubmit={(body) => rejecting && reject.mutate({ id: rejecting.id, body })}
          confirmLoading={reject.isPending}
        />

        {renderRestoreModal({
          record: restoring,
          onCancel: () => setRestoring(null),
          onSubmit: (body) => restoring && restore.mutate({ id: restoring.id, body }),
          confirmLoading: restore.isPending,
        })}

        {changeEmail.modal}
      </>
    ),
  };
}
