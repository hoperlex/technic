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
  // What the replacement checkbox removes: every document of the selected kind, not only the
  // current one.
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
        {/* The kind comes first: it drives both the category dictionary below and which paper the
            person will hold. It is preset from the job title but not locked — a truck-crane
            operator holds a driver license in the HR data (ADR 0095). */}
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
        {/* Categories are required only for a driver license: without them it permits nothing.
            Tractor credentials never carry categories in the staff import, and requiring a letter
            that has nowhere to come from would make the document impossible to create. */}
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
        {/* Administrator-only (records.purge) and only when there is something to remove: on a
            card without a document of this kind it would promise an action that never happens.
            It exists where history gets in the way — a reissued credential often keeps the same
            series and number, which the previous record still holds, so without removal the
            replacement fails on a taken number. */}
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
