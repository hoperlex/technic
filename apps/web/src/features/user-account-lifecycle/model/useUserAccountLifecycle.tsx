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
  showHistory?: (record: UserAccountDto) => void;
  needsRestoreForm: (record: UserAccountDto) => boolean;
  renderRestoreModal: (port: RestoreModalPort) => ReactNode;
  purge: {
    allowed: boolean;
    confirm: (id: string, name: string) => void;
  };
}

export interface UserAccountLifecycleController {
  actionsFor: (record: UserAccountDto) => ActionSheetItem[];
  archivedActionsFor: (record: UserAccountDto) => ActionSheetItem[];
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

  // Restoring a rejected registration also changes the pending counter under the same root key.
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

  // cache-invalidation: none — password changes revoke sessions but do not alter any field
  // rendered by the registry. Audit is refreshed when its tab opens.
  const password = useMutation({
    mutationFn: ({ id, newPassword }: { id: string; newPassword: string }) =>
      usersApi.setPassword(id, newPassword),
    onSuccess: () => {
      message.success('Пароль изменён. Пользователь должен сменить его при входе.');
      setPasswordUser(null);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

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
      ...(!pendingRegistration && (isSelf || record.role !== 'admin')
        ? [{ key: 'email', label: 'Сменить email', onClick: () => changeEmail.openFor(record) }]
        : []),
      {
        key: 'toggle',
        label: record.isActive ? 'Деактивировать' : 'Активировать',
        disabled: isSelf && record.isActive,
        onClick: () => {
          if (!record.isActive && !record.role) {
            message.info('Назначьте роль — без неё учётку активировать нельзя');
            edit(record);
            return;
          }
          toggleActive.mutate(record);
        },
      },
      ...(showHistory
        ? [{ key: 'history', label: 'История', onClick: () => showHistory(record) }]
        : []),
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

  const archivedActionsFor = (record: UserAccountDto): ActionSheetItem[] => [
    ...(showHistory
      ? [{ key: 'history', label: 'История', onClick: () => showHistory(record) }]
      : []),
    ...(can('archive.restore')
      ? [{ key: 'restore', label: 'Восстановить', onClick: () => requestRestore(record) }]
      : []),
    ...(purge.allowed
      ? [
          {
            key: 'purge',
            label: 'Удалить окончательно',
            danger: true,
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
