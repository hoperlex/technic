import { Form, Input } from 'antd';
import { formatDateOnly } from '@shared/lib';

/**
 * Standalone backdate reason (ADR 0101) for operations without request-term consequences: past
 * ESM-2 issue, relocation and past order-day planning. It becomes the durable audit explanation in
 * waybill_corrections.
 *
 * Kept apart from VehicleBackdateFields (request editor) because these operations need none of its
 * term, shift, ESM-2-week or route-mismatch queries.
 *
 * The field is named reason to match all three request bodies; request editing uses backdateReason
 * instead, to tell it apart from the request comment. Do not rename one to the other: the server
 * would receive the reason under the wrong key and reject the backdated operation.
 */
export function BackdateReasonField({
  effectiveDate,
  /** Concise operation-specific consequence shown below the reason. */
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
