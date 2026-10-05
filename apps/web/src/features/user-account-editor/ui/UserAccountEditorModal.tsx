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
      width={560}
    >
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
        <PhoneField />
        {activation.banner}
        <Form.Item
          name="role"
          label="Роль"
          required={!pendingRecord}
          extra={
            grants.blocked
              ? 'Роль не меняется, пока не загрузился список полномочий: смена роли переключает их действие'
              : roleNote(watchRole)
          }
          dependencies={pendingRecord ? ['isActive'] : undefined}
          rules={[
            {
              validator: (_rule, value: UserFormValues['role'] | undefined) => {
                const issue = roleIssue(record, value, form.getFieldValue('isActive'), grants);
                return issue ? Promise.reject(new Error(issue)) : Promise.resolve();
              },
            },
          ]}
        >
          <AutoSelect options={formRoleOptions} disabled={grants.blocked} />
        </Form.Item>
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
        {isDepartmentScopedRole(watchRole) ? (
          <UserDepartmentsField
            roleLabel={roleLabels[watchRole!]}
            departments={record?.departments ?? []}
            isNew={!record}
            options={departmentOptions}
            loading={departmentsLoading}
          />
        ) : null}
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
        {isPersonScopedRole(watchRole) ? (
          <DriverPersonField form={form} account={personFactsOf(record)} />
        ) : null}
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
