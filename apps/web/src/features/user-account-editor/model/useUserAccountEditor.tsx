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
  // An executor account is bound to the counterparty it works for in the portal: a waste operator
  // or a vehicle lessor (ADR 0038). A contractor has no requests in any module.
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
  // Grouped by type: the type decides what the account will be able to do, so the choice reads
  // "first as whom, then who" instead of one flat list mixing two kinds of executors.
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

  // Role and activity are read live from the form, not from the record: the mail checkbox and the
  // intent to review a registration follow what the administrator has typed right now, while the
  // record shows the state before the edit.
  const watchRole = Form.useWatch('role', form);
  const watchIsActive = Form.useWatch('isActive', form);
  // The counterparty type is read live as well: the grants field computes its "Will be added" line
  // for the resulting subject of the edit, while the record describes the previous one (§6).
  const watchCounterpartyId = Form.useWatch('counterpartyId', form);
  const watchCounterpartyType = isCounterpartyScopedRole(watchRole)
    ? (executors?.items.find((item) => item.id === watchCounterpartyId)?.type ?? null)
    : null;
  // A registration opened for review: its role and activation travel as a pair (R8).
  const pendingRecord = !!record && isPendingRegistration(record);
  const notifyShown = asksAboutMail(record, watchRole, watchIsActive);
  // Filling the form from the applicant's wish (ADR 0143, §3.5–§3.8): role, scope, grant codes and
  // the banner about what was filled. It edits form fields, never the request body, and never
  // touches "Active".
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
    // Suggested grants enter as the third hydration set (§3.6), not as an assignment to the field.
    suggestedCodes: activation.grantCodes,
    onReload: () => void qc.invalidateQueries({ queryKey: userAccountKeys.root }),
  });
  /*
   * Roles offered for selection in the form exclude retiring ones (plan §13.2, ADR 0113).
   *
   * This is not a duplicate of the registry's role filter options: the filter must still find
   * accounts on old roles while anyone holds them, whereas the form must not offer them — the
   * server rejects such a change (retiringRoleIssue). The edited account's own role stays in the
   * list even when retiring: otherwise its form would open with an empty select, and every save
   * would demand a migration this release does not perform yet.
   */
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
      // Default is "notify": an account is created for the person to use it, and they should not
      // learn about it only from the administrator's words.
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
      // The record's role, not the applicant's wish: the wish is filled by useActivationDefaults
      // once and only into an empty field (§3.5), and the decision stays with the administrator.
      role: account.role ?? undefined,
      constructionObjectIds: account.constructionObjects.map((object) => object.id),
      departmentIds: account.departments.map((department) => department.id),
      counterpartyId: account.counterpartyId,
      // Directory person (ADR 0102): a driver already has the link and the field opens with it, so
      // the full-name check repeats only when another person is chosen.
      personId: account.person?.id,
      confirmNameMismatch: false,
      isActive: account.isActive,
      notifyUser: true,
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (values: UserFormValues) => {
      // personId is taken out of the common set: for a non-driver role it must be absent from the
      // body altogether, not empty — an empty value would be a request to unlink (R6).
      const { notifyUser, personId, confirmNameMismatch, ...fields } = values;
      // Both flags are computed from the submitted values, not from what the form showed: the
      // request body and the displayed checkbox must express the same decision.
      const approving = approvesRegistration(record, values.role, values.isActive);
      const notifying = asksAboutMail(record, values.role, values.isActive);
      /*
       * A suggested role goes to the server only together with approval (§3.6): the server answers
       * 400 to a registration carrying a role without a declared review, so fixing a typo in the
       * name of a queued registration would hit a refusal created by the screen itself. The
       * suggestion is the screen's proposal, not the registration's value; if unsaved, it is
       * rebuilt on the next opening.
       */
      const role = pendingRecord && !approving ? undefined : values.role;
      // Grants stay silent together with the role for a reason: the planner rejects a grant set
      // without a role separately (role_required) — grants are issued on top of a position.
      const grantStatements = role ? grants.statements() : undefined;
      const payload = {
        ...fields,
        role,
        // An empty field is sent as an empty string, not undefined: for an update these differ —
        // "the phone was erased" versus "the phone was not touched" (ADR 0043).
        phone: values.phone ?? '',
        // Scope of the other axis is reset right here: after switching from an object role to a
        // department role the form must not send the set left from the previous role — the server
        // would reject it anyway as an incompatible pair (ADR 0040).
        constructionObjectIds: isObjectScopedRole(role) ? (values.constructionObjectIds ?? []) : [],
        departmentIds: isDepartmentScopedRole(role) ? (values.departmentIds ?? []) : [],
        counterpartyId: isCounterpartyScopedRole(role) ? (values.counterpartyId ?? null) : null,
        /*
         * Grants go as a statement about every displayed set (R3), not as a list of the remaining
         * ones: a removed set is absent from such a list by construction, and neither its
         * composition version nor the fact that it was shown could be conveyed. The statement is
         * built by a separate step, not taken from the checkbox group value: a line about a set
         * deactivated by a role change cannot come from the group — that set is not shown (§6).
         * undefined means the field is absent from the body (§4.1); such silence is legal only
         * while the role does not switch the effect of the grants, and the role field is locked
         * then (§4.2). addons is never sent: both fields edit the same set, and a body with both
         * is a 400.
         */
        ...(grantStatements ? { grants: grantStatements } : {}),
        // personId goes only with its own role (ADR 0102). It cannot be sent with another role
        // even empty: null means "unlink", and unlinking a live driver account is forbidden (R6);
        // for other roles the link is informational and is edited elsewhere.
        ...(isPersonScopedRole(role)
          ? { personId, confirmNameMismatch: confirmNameMismatch ?? false }
          : {}),
      };
      if (record) {
        const { password: _password, email: _email, ...body } = payload;
        return usersApi.update(record.id, {
          ...body,
          // The mail request and the declared review intent go only with their own case: an
          // ordinary edit needs neither, and the schema defaults ("notify", "not an approval")
          // describe it more precisely than fields sent blindly.
          ...(notifying ? { notifyUser } : {}),
          ...(approving ? { approveRegistration: true } : {}),
        });
      }
      return usersApi.create({
        ...(payload as Required<Omit<UserFormValues, 'notifyUser'>>),
        // The statement does not survive the cast: UserFormValues knows nothing about it — grants
        // are collected outside the form (§6) — and without the repeat the field would drop out
        // of the body type.
        ...(grantStatements ? { grants: grantStatements } : {}),
        ...(notifying ? { notifyUser } : {}),
      });
    },
    onSuccess: ({ notified }) => {
      message.success(withMailOutcome('Сохранено', notified, 'пользователю отправлено письмо'));
      void qc.invalidateQueries({ queryKey: userAccountKeys.root });
      // Departments are the same link that carries the head flag (migration 0149): a department
      // removed from the set takes its headship with it. The department directory shows the same
      // data — in the department card and as a hint in this form — so it is refreshed too. The
      // reverse invalidation lives in the department card.
      void qc.invalidateQueries({ queryKey: departmentKeys.root });
      setOpen(false);
    },
    onError: (error) => {
      /*
       * A grants refusal is handled by the field itself (R8): a 400 with details lands on "Grants",
       * where the offending checkbox is visible, and a 409 on a set version sends the user to
       * reload the account. The generic messages below cover everything else: a refusal caused by
       * silence is the fault of a stale screen, not of a checkbox, and there is nothing to mark.
       */
      if (grants.handleError(error)) return;
      // Any other 409 means one thing: another administrator has already reviewed the
      // registration, and the server refused to overwrite that decision. There is nothing to
      // retry until the other decision is seen, so the list is refetched right away.
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
