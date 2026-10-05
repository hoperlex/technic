import { Form, Input } from 'antd';
import { formatDateOnly } from '@shared/lib';

/** Collect the durable audit reason for an operation performed on an elapsed date. */
export function BackdateReasonField({
  effectiveDate,
  consequence,
  placeholder,
}: {
  effectiveDate: string;
  consequence: string;
  placeholder: string;
}) {
  return (
    <Form.Item
      name="reason"
      label="Причина заднего числа"
      // `backdateGuard` rejects an empty reason, so the form must not submit one.
      rules={[{ required: true, message: 'Укажите причину' }]}
      extra={`Дата ${formatDateOnly(effectiveDate)} уже прошла: ${consequence}`}
    >
      <Input.TextArea rows={2} maxLength={2000} showCount placeholder={placeholder} />
    </Form.Item>
  );
}
