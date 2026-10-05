import { Checkbox, Form, Input, Select, Switch, type FormInstance } from 'antd';
import {
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isPersonScopedRole,
  normalizeEmail,
  roleLabels,
  type Role,
  type UserAccountDto,
} from '@technic/contracts';
import {
  HALF_APPROVAL,
  PasswordField,
  PersonNameFields,
  PhoneField,
  roleNote,
} from '@entities/user-account';
import { AutoSelect, FormModal } from '@shared/ui';
import { roleIssue, type ActivationControl } from '../model/useActivationDefaults';
import type { UserFormValues } from '../model/types';
import { DriverPersonField, personFactsOf } from './DriverPersonField';
import { UserDepartmentsField } from './UserDepartmentsField';
import type { UserGrantsControl } from '../model/userGrantsFieldTypes';

interface Option {
  label: string;
  value: string;
}

interface OptionGroup {
  label: string;
  options: Option[];
}

interface Props {
  activation: ActivationControl;
  departmentOptions: Option[];
  departmentsLoading: boolean;
  executorCount: number;
  executorGroups: OptionGroup[];
  executorsLoading: boolean;
  form: FormInstance<UserFormValues>;
  formRoleOptions: Option[];
  grants: UserGrantsControl;
  notifyShown: boolean;
  objectOptions: Option[];
  objectsLoading: boolean;
  onCancel: () => void;
  onFinish: (values: UserFormValues) => void;
  open: boolean;
  pendingRecord: boolean;
  record: UserAccountDto | null;
  saving: boolean;
  watchRole?: Role;
}

/** Account create/edit form. Access axes appear only for the role that owns each axis. */
export function UserAccountEditorModal({
  activation,
  departmentOptions,
  departmentsLoading,
  executorCount,
  executorGroups,
  executorsLoading,
  form,
  formRoleOptions,
  grants,
  notifyShown,
  objectOptions,
  objectsLoading,
  onCancel,
  onFinish,
  open,
  pendingRecord,
  record,
  saving,
  watchRole,
}: Props) {
  return (
    <FormModal
      title={record ? 'Редактирование пользователя' : 'Новый пользователь'}
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={saving}
      // Wider than the standard 480: the field set is fixed and complete, and at 480 px labels like
      // "Objects (for role «Construction manager»)" and the applicant-wish hint wrapped by syllable.
      // The dense field rhythm has the same reason: a registration review is read as a whole, not
      // scrolled.
      width={560}
    >
      {/*
       * A role change silently removes nothing, and the form must say so rather than rely on the
       * absence of a message: an incompatible grant set stays issued but grants no permissions
       * (R4). The message therefore lives in the grants field itself: until the new role's catalog
       * arrives, it is unknown which sets stop working — compatibility is computed by the server,
       * not by the screen.
       */}
      <Form form={form} layout="vertical" className="form-dense" onFinish={onFinish}>
        <Form.Item
          name="email"
          label="Email"
          normalize={normalizeEmail}
          rules={[{ required: true, type: 'email', message: 'Введите email' }]}
        >
          <Input disabled={!!record} />
        </Form.Item>
        <PersonNameFields />
        {/* Employee contact (ADR 0043) is optional here too: accounts created by an administrator
            live without it and get it filled in through this form. There is no "the portal sends
            no mail" note any more: the mail circuit works (ADR 0093), and that promise of silence
            would be false. */}
        <PhoneField />
        {/* The applicant's wish (ADR 0034) and what was filled from it (§3.8). The banner's second
            line is in the past tense, so editing the role does not make it false. */}
        {activation.banner}
        {/* A role is not always required on a registration: a typo in its name or phone can be
            fixed without reviewing it, and it stays queued. But assigning a role without
            activating is forbidden: the record would stop being a registration, and the next edit
            would activate "an ordinary account with a role" bypassing the approval log (R8). */}
        <Form.Item
          name="role"
          label="Роль"
          // The required asterisk follows the same rule: on a registration the role awaits a
          // decision, not input, and marked as required it would promise that saving is impossible
          // without it.
          required={!pendingRecord}
          /*
           * An incomplete grants catalog locks the role too (§6): a role change switches the effect
           * of the assignments, and the form cannot make a statement about them in this state — the
           * server would answer with a refusal caused by the screen itself.
           */
          extra={
            grants.blocked
              ? 'Роль не меняется, пока не загрузился список полномочий: смена роли переключает их действие'
              : roleNote(watchRole)
          }
          dependencies={pendingRecord ? ['isActive'] : undefined}
          rules={[
            {
              // Both review rules come from roleIssue: a registration is reviewed as a whole and
              // not before the grants catalog has loaded (§3.6).
              validator: (_rule, value: UserFormValues['role'] | undefined) => {
                const issue = roleIssue(record, value, form.getFieldValue('isActive'), grants);
                return issue ? Promise.reject(new Error(issue)) : Promise.resolve();
              },
            },
          ]}
        >
          <AutoSelect options={formRoleOptions} disabled={grants.blocked} />
        </Form.Item>
        {/* Object-scoped roles ("HQ", "Construction manager") work within their objects and cannot
            be activated without them (ADR 0025, ADR 0039). A list rather than one object: HQ runs
            several sites, and a second account for the same person would be a second password and
            a second login for one directory row. */}
        {isObjectScopedRole(watchRole) ? (
          <Form.Item
            name="constructionObjectIds"
            label={`Объекты (для роли «${roleLabels[watchRole!]}»)`}
            extra={activation.hint('constructionObjectIds')}
            rules={[
              {
                validator: (_rule, value: string[] | undefined) =>
                  value && value.length > 0
                    ? Promise.resolve()
                    : Promise.reject(new Error('Выберите хотя бы один объект')),
              },
            ]}
          >
            <Select
              mode="multiple"
              options={objectOptions}
              loading={objectsLoading}
              showSearch
              optionFilterProp="label"
              placeholder="Выберите объекты"
            />
          </Form.Item>
        ) : null}
        {/* Departments are the second scope axis (ADR 0040): an office unit instead of a site.
            Shown instead of the objects field, not next to it: an account works on one axis. It is
            a separate component together with the answer to "does this person head them" (§11.1
            of the access restructuring plan): the head flag moved from the role into the link, is
            set from the department card, and keeping silent about it here would leave the
            administrator without an explanation. */}
        {isDepartmentScopedRole(watchRole) ? (
          <UserDepartmentsField
            roleLabel={roleLabels[watchRole!]}
            departments={record?.departments ?? []}
            isNew={!record}
            options={departmentOptions}
            loading={departmentsLoading}
          />
        ) : null}
        {/* Department candidates sit outside the field under the same condition: the field's own
            markup is owned by its component. */}
        {isDepartmentScopedRole(watchRole) ? activation.hint('departmentIds') : null}
        {isCounterpartyScopedRole(watchRole) ? (
          <Form.Item
            name="counterpartyId"
            label={`Контрагент (для роли «${roleLabels[watchRole!]}»)`}
            tooltip="Тип контрагента задаёт раздел: оператор вывоза ведёт заявки на вывоз мусора, арендодатель — заявки на технику, куда вышли его машины"
            rules={[{ required: true, message: 'Выберите контрагента' }]}
            extra={
              executorCount === 0
                ? 'Нет активных контрагентов-исполнителей — заведите оператора вывоза или арендодателя в справочнике'
                : activation.hint('counterpartyId')
            }
          >
            <AutoSelect
              options={executorGroups}
              loading={executorsLoading}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
        ) : null}
        {/* The directory person is the fourth scope axis (ADR 0102): a driver has a person instead of
            objects, departments and counterparty — the one whose assignment the driver cabinet
            shows. Same place and same rule as the other axes: shown only for its own role. */}
        {isPersonScopedRole(watchRole) ? (
          <DriverPersonField form={form} account={personFactsOf(record)} />
        ) : null}
        {/* Grants (ADR 0106, ADR 0119) are what a person can do beyond their position. They replace
            the former role add-ons (R1) and sit after the scope block, before password and
            activity: first "who and where", then "what else". The field is absent for a role
            without grants, for a driver and for one's own account. */}
        {grants.field}
        {!record ? (
          <PasswordField name="password" identityFields={['email', 'lastName', 'firstName']} />
        ) : null}
        <Form.Item
          name="isActive"
          label="Активен"
          valuePropName="checked"
          dependencies={pendingRecord ? ['role'] : undefined}
          rules={
            pendingRecord
              ? [
                  {
                    // Activation is demanded only by a role chosen by hand: a suggested role is the
                    // screen's proposal and without approval it does not enter the body at all
                    // (§3.6), so editing a queued registration does not become a half decision.
                    validator: (_rule, value: boolean | undefined) =>
                      !value && form.isFieldTouched('role') && form.getFieldValue('role')
                        ? Promise.reject(new Error(HALF_APPROVAL))
                        : Promise.resolve(),
                  },
                ]
              : undefined
          }
        >
          <Switch />
        </Form.Item>
        {/* The access email is sent by a checkbox that is on by default: the portal does not send
            mail on its own, a person sends it knowingly. The field is absent where no email
            happens at all (R7) — a disabled checkbox would promise a send that never comes. */}
        {notifyShown ? (
          <Form.Item
            name="notifyUser"
            valuePropName="checked"
            extra="Письмо с адресом портала и назначенной ролью. Пароль в письме не отправляется"
          >
            <Checkbox>Сообщить пользователю по почте</Checkbox>
          </Form.Item>
        ) : null}
      </Form>
    </FormModal>
  );
}
