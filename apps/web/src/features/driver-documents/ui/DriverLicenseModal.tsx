import { Checkbox, DatePicker, Form, Input, Select, Typography, type FormInstance } from 'antd';
import {
  CREDENTIAL_TYPE_CODES,
  type CredentialTypeCode,
  credentialTypeLabels,
  credentialTypeShortLabels,
  type DriverDto,
  licenseNumberLabel,
} from '@technic/contracts';
import { FormModal, type FormBlockersApi } from '@shared/ui';
import type { DriverLicenseFormValues } from '../model/types';

interface Option {
  value: string;
  label: string;
}

interface Props {
  record: DriverDto | null;
  form: FormInstance<DriverLicenseFormValues>;
  blockers: FormBlockersApi;
  credentialType: CredentialTypeCode;
  categoryOptions: Option[];
  canDelete: boolean;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: DriverLicenseFormValues) => void;
  onCredentialTypeChange: (type: CredentialTypeCode) => void;
}

/** Form for adding a new current credential while retaining or explicitly removing its history. */
export function DriverLicenseModal({
  record,
  form,
  blockers,
  credentialType,
  categoryOptions,
  canDelete,
  pending,
  onCancel,
  onSubmit,
  onCredentialTypeChange,
}: Props) {
  const previous = (record?.licenses ?? []).filter(
    (license) => license.credentialTypeCode === credentialType,
  );

  return (
    <FormModal
      title="Новое удостоверение"
      open={record !== null}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={pending}
      width={480}
    >
      <Form form={form} layout="vertical" onFinish={onSubmit} {...blockers.formProps}>
        <Typography.Paragraph type="secondary">
          {canDelete
            ? 'Прежнее удостоверение останется в карточке — по нему объясняются листы прошлых лет. Убрать его нужно, только если его там быть не должно.'
            : 'Прежнее удостоверение останется в карточке: по нему объясняются листы прошлых лет.'}
        </Typography.Paragraph>
        {/* The type drives both the category dictionary and the document created by this form. */}
        <Form.Item label="Вид документа">
          <Select
            value={credentialType}
            onChange={onCredentialTypeChange}
            options={CREDENTIAL_TYPE_CODES.map((code) => ({
              value: code,
              label: credentialTypeLabels[code],
            }))}
          />
        </Form.Item>
        <Form.Item name="series" label="Серия">
          <Input placeholder="99 39" />
        </Form.Item>
        <Form.Item name="number" label="Номер" rules={[{ required: true }]}>
          <Input placeholder="482645" />
        </Form.Item>
        <Form.Item name="issuedOn" label="Дата выдачи">
          <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
        </Form.Item>
        <Form.Item name="expiresOn" label="Действительно до">
          <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
        </Form.Item>
        {/* A driver license without categories grants nothing; staff imports may omit tractor ones. */}
        <Form.Item
          name="categoryIds"
          label={`Категории ${credentialTypeShortLabels[credentialType]}`}
          rules={[{ required: credentialType === 'driver_license' }]}
        >
          <Select
            mode="multiple"
            options={categoryOptions}
            placeholder={credentialType === 'driver_license' ? 'B, C, CE' : 'B, C, D, E'}
          />
        </Form.Item>
        {/* Only administrators may destroy history, and the control is useless without history. */}
        {canDelete && previous.length > 0 && (
          <Form.Item name="deletePrevious" valuePropName="checked">
            <Checkbox>
              Убрать прежнее {credentialTypeShortLabels[credentialType]} (
              {previous.map((license) => licenseNumberLabel(license)).join(', ')}) из карточки
            </Checkbox>
          </Form.Item>
        )}
      </Form>
    </FormModal>
  );
}
