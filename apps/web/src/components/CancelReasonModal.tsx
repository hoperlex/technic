import { useEffect } from 'react';
import { Form, Input } from 'antd';
import { FormModal } from './FormModal';

interface ReasonProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
  confirmLoading?: boolean;
  title?: string;
  label?: string;
  okText?: string;
  cancelText?: string;
  /** Пояснение под полем: зачем эта причина нужна и куда попадёт. */
  placeholderHint?: string;
}

interface Values {
  reason: string;
}

/**
 * Действие, которое нельзя подтвердить одной кнопкой: нужно объяснение. Отмена заявки пишет
 * причину в историю статусов, отказ по заявке на регистрацию — в аудит; и там, и там окно с
 * обязательным полем, а не confirm.
 */
export function ReasonModal({
  open,
  onCancel,
  onSubmit,
  confirmLoading,
  title = 'Причина',
  label = 'Причина',
  okText,
  cancelText,
  placeholderHint,
}: ReasonProps) {
  const [form] = Form.useForm<Values>();

  // Окно переиспользуется для разных записей: причина предыдущего отказа не должна подставляться.
  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  return (
    <FormModal
      title={title}
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      okText={okText}
      cancelText={cancelText}
      width={440}
    >
      <Form form={form} layout="vertical" onFinish={(v) => onSubmit(v.reason.trim())}>
        <Form.Item
          name="reason"
          label={label}
          extra={placeholderHint}
          rules={[
            { required: true, message: 'Укажите причину' },
            { whitespace: true, message: 'Укажите причину' },
          ]}
        >
          <Input.TextArea rows={3} maxLength={2000} showCount autoFocus />
        </Form.Item>
      </Form>
    </FormModal>
  );
}

interface CancelProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
  confirmLoading?: boolean;
  /** Пояснение над полем: какую именно заявку отменяем. */
  subject?: string;
}

/** Отмена заявки: причина обязательна (её требует и сервер) и уходит в историю статусов. */
export function CancelReasonModal({ subject, ...rest }: CancelProps) {
  return (
    <ReasonModal
      {...rest}
      title="Отмена заявки"
      label={subject ? `Причина отмены заявки ${subject}` : 'Причина отмены'}
      okText="Отменить заявку"
      cancelText="Не отменять"
    />
  );
}
