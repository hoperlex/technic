import { DatePicker, Form, Input, Select, Typography, type FormInstance } from 'antd';
import {
  CREDENTIAL_TYPE_CODES,
  EMAIL_FORMAT_MESSAGE,
  type DriverDto,
  isValidSnils,
  normalizeEmail,
  normalizeSnils,
  optionalEmailSchema,
  SNILS_CHECKSUM_MESSAGE,
  SNILS_MESSAGE,
} from '@technic/contracts';
import { PhoneField } from '@entities/user-account';
import { documentsBlock, type DriverDocumentActions } from '@entities/driver';
import { FormModal } from '@shared/ui';
import type { DriverFormValues } from '../model/types';

interface Option {
  value: string;
  label: string;
}

interface Props {
  open: boolean;
  record: DriverDto | null;
  form: FormInstance<DriverFormValues>;
  documentActions: DriverDocumentActions;
  driverLicenseOptions: Option[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: DriverFormValues) => void;
}

const snilsRules = [
  { required: true, message: 'Обязательное поле' },
  {
    validator: (_: unknown, value: string) => {
      if (!value) return Promise.resolve();
      const digits = normalizeSnils(value);
      if (!/^\d{11}$/u.test(digits)) return Promise.reject(new Error(SNILS_MESSAGE));
      if (!isValidSnils(digits)) return Promise.reject(new Error(SNILS_CHECKSUM_MESSAGE));
      return Promise.resolve();
    },
  },
];

/** Person editor; document commands remain ports owned by the document-management feature. */
export function DriverEditorModal({
  open,
  record,
  form,
  documentActions,
  driverLicenseOptions,
  pending,
  onCancel,
  onSubmit,
}: Props) {
  return (
    <FormModal
      title={record ? 'Карточка водителя' : 'Новый водитель'}
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={pending}
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item name="lastName" label="Фамилия" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="firstName" label="Имя" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="middleName" label="Отчество">
          <Input />
        </Form.Item>
        <Form.Item
          name="snils"
          label="СНИЛС"
          rules={snilsRules}
          extra="Обязательный реквизит путевого листа"
        >
          <Input placeholder="112-233-445 95" />
        </Form.Item>
        <Form.Item name="personnelNo" label="Табельный номер">
          <Input />
        </Form.Item>
        <PhoneField />
        <Form.Item
          name="email"
          label="Email"
          normalize={normalizeEmail}
          // Validate on blur because a partially typed address is almost always invalid.
          validateTrigger="onBlur"
          rules={[
            () => ({
              validator: (_: unknown, value: unknown) =>
                optionalEmailSchema.safeParse(typeof value === 'string' ? value : '').success
                  ? Promise.resolve()
                  : Promise.reject(new Error(EMAIL_FORMAT_MESSAGE)),
            }),
          ]}
          extra="На него уходит задание на рейс; пусто — письма водителю не отправляются"
        >
          <Input placeholder="ivanov@example.ru" autoComplete="off" />
        </Form.Item>
        <Form.Item name="comment" label="Комментарий">
          <Input.TextArea rows={2} />
        </Form.Item>

        {record &&
          CREDENTIAL_TYPE_CODES.map((type) => documentsBlock(record, type, documentActions))}

        {!record && (
          <>
            {/* New records start as drivers; tractor credentials are added after staff import. */}
            <Typography.Title level={5}>Водительское удостоверение</Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
              Без документа водитель не попадёт в выбор при переводе заявки в работу.
            </Typography.Paragraph>
            <Form.Item name={['license', 'series']} label="Серия">
              <Input placeholder="99 39" />
            </Form.Item>
            <Form.Item name={['license', 'number']} label="Номер">
              <Input placeholder="482645" />
            </Form.Item>
            <Form.Item name={['license', 'issuedOn']} label="Дата выдачи">
              <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
            </Form.Item>
            <Form.Item name={['license', 'expiresOn']} label="Действительно до">
              <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
            </Form.Item>
            <Form.Item name={['license', 'categoryIds']} label="Категории">
              <Select mode="multiple" options={driverLicenseOptions} placeholder="B, C, CE" />
            </Form.Item>
          </>
        )}
      </Form>
    </FormModal>
  );
}
