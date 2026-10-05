import { Button, Form, Input, Switch, type FormInstance } from 'antd';
import { DeleteFilled } from '@ant-design/icons';
import {
  findWasteTypeByName,
  wasteTypeDuplicateMessage,
  type WasteTypeDto,
} from '@technic/contracts';
import { FormModal, type FormBlockersApi } from '@shared/ui';

export interface WasteTypeFormValues {
  name: string;
  isActive: boolean;
}

export interface WasteTypePurgeControl {
  allowed: boolean;
  pending: boolean;
  confirm: (id: string, name: string) => void;
}

interface Props {
  open: boolean;
  record: WasteTypeDto | null;
  wasteTypes: WasteTypeDto[];
  form: FormInstance<WasteTypeFormValues>;
  formProps: FormBlockersApi['formProps'];
  pending: boolean;
  purge: WasteTypePurgeControl;
  onCancel: () => void;
  onSubmit: (values: WasteTypeFormValues) => void;
}

/** Waste-type fields embedded in the tariff directory row (ADR 0017). */
export function WasteTypeEditorModal({
  open,
  record,
  wasteTypes,
  form,
  formProps,
  pending,
  purge,
  onCancel,
  onSubmit,
}: Props) {
  return (
    <FormModal
      title="Тип мусора"
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={pending}
      width={480}
      footerExtra={
        record && !record.isActive && purge.allowed ? (
          <Button
            danger
            icon={<DeleteFilled />}
            loading={purge.pending}
            onClick={() => {
              onCancel();
              purge.confirm(record.id, record.name);
            }}
          >
            Удалить окончательно
          </Button>
        ) : undefined
      }
    >
      <Form form={form} layout="vertical" onFinish={onSubmit} {...formProps}>
        <Form.Item
          name="name"
          label="Название"
          rules={[
            { required: true, message: 'Укажите название' },
            {
              validator: (_rule, value: string) => {
                const others = wasteTypes.filter((type) => type.id !== record?.id);
                const clash = value ? findWasteTypeByName(value, others) : undefined;
                return clash
                  ? Promise.reject(new Error(wasteTypeDuplicateMessage(clash.name)))
                  : Promise.resolve();
              },
            },
          ]}
        >
          <Input maxLength={255} />
        </Form.Item>
        <Form.Item
          name="isActive"
          label="Активен"
          valuePropName="checked"
          extra="Неактивный тип исчезает из выбора в заявках; заведённые заявки и тарифы остаются как есть"
        >
          <Switch />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
