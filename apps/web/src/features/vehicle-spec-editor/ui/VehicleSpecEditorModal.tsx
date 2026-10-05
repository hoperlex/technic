import { Form, Input, InputNumber, Space, Switch, type FormInstance } from 'antd';
import {
  VEHICLE_SPEC_CODE_RE,
  VEHICLE_SPEC_MAX_DECIMALS,
  type VehicleSpecDto,
} from '@technic/contracts';
import { FormModal } from '@shared/ui';

export interface SpecFormValues {
  code?: string;
  name?: string;
  shortName?: string;
  unit?: string;
  decimals?: number;
  minValue?: number | null;
  maxValue?: number | null;
  description?: string;
  sortOrder?: number;
  isActive?: boolean;
}

interface Props {
  open: boolean;
  record: VehicleSpecDto | null;
  form: FormInstance<SpecFormValues>;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: SpecFormValues) => void;
}

/**
 * Spec fields. Unit and precision freeze once the spec is attached to a type: attached values are
 * already canonicalised with them, and changing either would change the meaning of existing
 * categories.
 */
export function VehicleSpecEditorModal({ open, record, form, pending, onCancel, onSubmit }: Props) {
  const isEdit = !!record;
  const isUsed = (record?.usedInTypes ?? 0) > 0;

  return (
    <FormModal
      title={isEdit ? 'Редактирование ТТХ' : 'Новый ТТХ'}
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={pending}
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item
          name="code"
          label="Код"
          rules={
            isEdit
              ? []
              : [
                  { required: true, message: 'Укажите код' },
                  {
                    pattern: VEHICLE_SPEC_CODE_RE,
                    message: 'Только строчные латинские, цифры и _, первый символ — буква',
                  },
                ]
          }
        >
          {/* The code is a stable system identifier and cannot change after creation. */}
          <Input disabled={isEdit} placeholder="например lift_capacity" />
        </Form.Item>
        <Form.Item
          name="name"
          label="Наименование"
          rules={[{ required: true, message: 'Укажите наименование' }]}
        >
          <Input placeholder="Грузоподъёмность" />
        </Form.Item>
        <Form.Item
          name="shortName"
          label="Короткое имя"
          extra="Используется в наименовании категории: «Автокраны, г/п 25 т»"
        >
          <Input placeholder="г/п" />
        </Form.Item>
        <Space size="middle" style={{ display: 'flex' }}>
          <Form.Item
            name="unit"
            label="Единица измерения"
            extra={isUsed ? 'Заморожена: ТТХ привязан к типам' : undefined}
            style={{ flex: 1 }}
          >
            <Input disabled={isUsed} placeholder="т" />
          </Form.Item>
          <Form.Item
            name="decimals"
            label="Знаков после запятой"
            extra={isUsed ? 'Заморожено: ТТХ привязан к типам' : undefined}
            style={{ flex: 1 }}
          >
            <InputNumber
              disabled={isUsed}
              min={0}
              max={VEHICLE_SPEC_MAX_DECIMALS}
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Space>
        <Space size="middle" style={{ display: 'flex' }}>
          <Form.Item name="minValue" label="Минимум" style={{ flex: 1 }}>
            <InputNumber style={{ width: '100%' }} placeholder="—" />
          </Form.Item>
          <Form.Item name="maxValue" label="Максимум" style={{ flex: 1 }}>
            <InputNumber style={{ width: '100%' }} placeholder="—" />
          </Form.Item>
        </Space>
        <Form.Item name="description" label="Описание">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name="sortOrder" label="Порядок сортировки">
          <InputNumber style={{ width: '100%' }} min={0} />
        </Form.Item>
        <Form.Item name="isActive" label="Активен" valuePropName="checked">
          <Switch disabled={isUsed} />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
