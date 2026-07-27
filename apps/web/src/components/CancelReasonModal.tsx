import { useEffect } from 'react';
import { Form, Input } from 'antd';
import { FormModal } from './FormModal';

interface Props {
  open: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
  confirmLoading?: boolean;
  /** Пояснение над полем: какую именно заявку отменяем. */
  subject?: string;
}

interface Values {
  reason: string;
}

/**
 * Отмена заявки: причина обязательна (её требует и сервер) и уходит в историю статусов.
 * Поэтому отдельное окно с полем, а не confirm — подтверждать здесь нечего, нужно объяснение.
 */
export function CancelReasonModal({ open, onCancel, onSubmit, confirmLoading, subject }: Props) {
  const [form] = Form.useForm<Values>();

  // Окно переиспользуется для разных заявок: причина предыдущей отмены не должна подставляться.
  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  return (
    <FormModal
      title="Отмена заявки"
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      okText="Отменить заявку"
      cancelText="Не отменять"
      width={440}
    >
      <Form form={form} layout="vertical" onFinish={(v) => onSubmit(v.reason.trim())}>
        <Form.Item
          name="reason"
          label={subject ? `Причина отмены заявки ${subject}` : 'Причина отмены'}
          rules={[
            { required: true, message: 'Укажите причину отмены' },
            { whitespace: true, message: 'Укажите причину отмены' },
          ]}
        >
          <Input.TextArea rows={3} maxLength={2000} showCount autoFocus />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
