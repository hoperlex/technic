import { useState, type ReactNode } from 'react';
import { App, Form } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  counterpartyTypeLabels,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isPersonScopedRole,
  isRetiringRole,
  ROLES,
  roleLabels,
  type UserAccountDto,
} from '@technic/contracts';
import { counterpartiesApi, counterpartyKeys } from '@entities/counterparty';
import { departmentKeys, departmentOptionsQuery } from '@entities/department';
import { objectKeys, objectsApi } from '@entities/object';
import { useAuth } from '@entities/session';
import {
  approvesRegistration,
  asksAboutMail,
  isPendingRegistration,
  userAccountErrorMessage as errorMessage,
  userAccountKeys,
  usersApi,
  withMailOutcome,
} from '@entities/user-account';
import { isApiError } from '@shared/api';
import { UserAccountEditorModal } from '../ui/UserAccountEditorModal';
import { useUserGrantsField } from '../ui/UserGrantsField';
import type { UserFormValues } from './types';
import { useActivationDefaults } from './useActivationDefaults';

export interface UserAccountEditorController {
  actions: {
    create: () => void;
    edit: (record: UserAccountDto) => void;
  };
  node: ReactNode;
}

/** Own account create/edit state, source dictionaries and the versioned grant statement. */
export function useUserAccountEditor(): UserAccountEditorController {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { user: currentUser } = useAuth();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<UserAccountDto | null>(null);
  const [form] = Form.useForm<UserFormValues>();

  const { data: objects, isLoading: objectsLoading } = useQuery({
    queryKey: objectKeys.options({ activeOnly: true }),
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  const { data: departmentOptions, isLoading: departmentsLoading } =
    useQuery(departmentOptionsQuery());
  const { data: executors, isLoading: executorsLoading } = useQuery({
    queryKey: counterpartyKeys.activeOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });

  const objectOptions = (objects?.items ?? []).map((object) => ({
    value: object.id,
    label: `${object.code} — ${object.name}`,
  }));
  const executorGroups = COUNTERPARTY_TYPES_WITH_ACCOUNTS.map((type) => ({
    label: counterpartyTypeLabels[type],
    options: (executors?.items ?? [])
      .filter((counterparty) => counterparty.type === type)
      .map((counterparty) => ({
        value: counterparty.id,
        label: `${counterparty.name} (ИНН ${counterparty.inn})`,
      })),
  })).filter((group) => group.options.length > 0);
  const executorCount = executorGroups.reduce((count, group) => count + group.options.length, 0);

  const watchRole = Form.useWatch('role', form);
  const watchIsActive = Form.useWatch('isActive', form);
  const watchCounterpartyId = Form.useWatch('counterpartyId', form);
  const watchCounterpartyType = isCounterpartyScopedRole(watchRole)
    ? (executors?.items.find((item) => item.id === watchCounterpartyId)?.type ?? null)
    : null;
  const pendingRecord = !!record && isPendingRegistration(record);
  const notifyShown = asksAboutMail(record, watchRole, watchIsActive);
  const activation = useActivationDefaults({
    open,
    record,
    form,
    objects: objects?.items,
    counterparties: executors?.items,
  });
  const grants = useUserGrantsField({
    open,
    isSelf: !!record && record.id === currentUser?.id,
    role: watchRole ?? null,
    counterpartyType: watchCounterpartyType,
    record,
    suggestedCodes: activation.grantCodes,
    onReload: () => void qc.invalidateQueries({ queryKey: userAccountKeys.root }),
  });
  const formRoleOptions = ROLES.filter(
    (role) => !isRetiringRole(role) || role === record?.role,
  ).map((role) => ({
    value: role,
    label: isRetiringRole(role) ? `${roleLabels[role]} (упраздняется)` : roleLabels[role],
  }));

  const create = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      isActive: true,
      constructionObjectIds: [],
      departmentIds: [],
      notifyUser: true,
    });
    setOpen(true);
  };
  const edit = (account: UserAccountDto) => {
    setRecord(account);
    form.resetFields();
    form.setFieldsValue({
      email: account.email,
      lastName: account.lastName,
      firstName: account.firstName,
      middleName: account.middleName,
      phone: account.phone,
      role: account.role ?? undefined,
      constructionObjectIds: account.constructionObjects.map((object) => object.id),
      departmentIds: account.departments.map((department) => department.id),
      counterpartyId: account.counterpartyId,
      personId: account.person?.id,
      confirmNameMismatch: false,
      isActive: account.isActive,
      notifyUser: true,
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (values: UserFormValues) => {
      const { notifyUser, personId, confirmNameMismatch, ...fields } = values;
      const approving = approvesRegistration(record, values.role, values.isActive);
      const notifying = asksAboutMail(record, values.role, values.isActive);
      // Suggested registration values stay local until the administrator approves the request.
      const role = pendingRecord && !approving ? undefined : values.role;
      const grantStatements = role ? grants.statements() : undefined;
      const payload = {
        ...fields,
        role,
        phone: values.phone ?? '',
        constructionObjectIds: isObjectScopedRole(role) ? (values.constructionObjectIds ?? []) : [],
        departmentIds: isDepartmentScopedRole(role) ? (values.departmentIds ?? []) : [],
        counterpartyId: isCounterpartyScopedRole(role) ? (values.counterpartyId ?? null) : null,
        ...(grantStatements ? { grants: grantStatements } : {}),
        ...(isPersonScopedRole(role)
          ? { personId, confirmNameMismatch: confirmNameMismatch ?? false }
          : {}),
      };
      if (record) {
        const { password: _password, email: _email, ...body } = payload;
        return usersApi.update(record.id, {
          ...body,
          ...(notifying ? { notifyUser } : {}),
          ...(approving ? { approveRegistration: true } : {}),
        });
      }
      return usersApi.create({
        ...(payload as Required<Omit<UserFormValues, 'notifyUser'>>),
        ...(grantStatements ? { grants: grantStatements } : {}),
        ...(notifying ? { notifyUser } : {}),
      });
    },
    onSuccess: ({ notified }) => {
      message.success(withMailOutcome('Сохранено', notified, 'пользователю отправлено письмо'));
      void qc.invalidateQueries({ queryKey: userAccountKeys.root });
      void qc.invalidateQueries({ queryKey: departmentKeys.root });
      setOpen(false);
    },
    onError: (error) => {
      if (grants.handleError(error)) return;
      if (isApiError(error) && error.status === 409) {
        message.error('Заявку уже рассмотрел другой администратор — обновите список');
        void qc.invalidateQueries({ queryKey: userAccountKeys.root });
        return;
      }
      message.error(errorMessage(error));
    },
  });

  return {
    actions: { create, edit },
    node: (
      <UserAccountEditorModal
        activation={activation}
        departmentOptions={departmentOptions ?? []}
        departmentsLoading={departmentsLoading}
        executorCount={executorCount}
        executorGroups={executorGroups}
        executorsLoading={executorsLoading}
        form={form}
        formRoleOptions={formRoleOptions}
        grants={grants}
        notifyShown={notifyShown}
        objectOptions={objectOptions}
        objectsLoading={objectsLoading}
        onCancel={() => setOpen(false)}
        onFinish={(values) => save.mutate(values)}
        open={open}
        pendingRecord={pendingRecord}
        record={record}
        saving={save.isPending}
        watchRole={watchRole}
      />
    ),
  };
}
