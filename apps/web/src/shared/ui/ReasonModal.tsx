import { useEffect, type ReactNode } from 'react';
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
  /** Что произойдёт по нажатию — блоком над полем: читают до ввода причины, а не после. */
  notice?: ReactNode;
  /** Действие необратимо — кнопка подтверждения красная. */
  danger?: boolean;
  /**
   * The confirmation cannot go out yet, while the dialog can still be left. Distinct from
   * `confirmLoading`: a loading dialog also refuses "Cancel", Esc and the close icon, and a wait
   * for something the dialog only reads must not lock the person inside it. The reason for the
   * disabled button is the caller's to show in `notice`.
   */
  okDisabled?: boolean;
}

interface Values {
  reason: string;
}

/**
 * Действие, которое нельзя подтвердить одной кнопкой: нужно объяснение. Отмена заявки пишет
 * причину в историю статусов, отказ по заявке на регистрацию — в аудит; и там, и там окно с
 * обязательным полем, а не confirm.
 *
 * IN THE FOUNDATION BECAUSE IT KNOWS NO DOMAIN: every word on it arrives as a prop, and what the
 * reason is then written into is the caller's business. Its request-flavoured wrappers live in
 * `@entities/request` — moving a single title in here would give `shared` a say about request
 * cycles, which is exactly what the layer is forbidden to have.
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
  notice,
  danger,
  okDisabled,
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
      okDanger={danger}
      okDisabled={okDisabled}
      width={440}
    >
      {notice}
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
