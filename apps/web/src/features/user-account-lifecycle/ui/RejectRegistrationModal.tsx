import { useEffect } from 'react';
import { Checkbox, Form, Input } from 'antd';
import { FormModal } from '@shared/ui';
import type { RejectUserBody } from '@technic/contracts';

interface Props {
  open: boolean;
  /** Registration address, also the mail address — by it the administrator sees whom they reject. */
  email?: string;
  onCancel: () => void;
  onSubmit: (body: RejectUserBody) => void;
  confirmLoading?: boolean;
}

interface Values {
  reason: string;
  notifyApplicant: boolean;
  applicantMessage?: string;
}

/**
 * Rejecting a registration: an internal reason for later review, a send flag and the text the
 * applicant will read.
 *
 * A modal of its own rather than the shared `ReasonModal` (`@shared/ui`): that one has a single
 * `onSubmit(reason: string)` and five callers — request cancellation, return to "New", weekly
 * request rejection, service request rejection and this one. Threading a second text and a flag
 * through it would complicate the cancellation modal for a form one screen needs.
 *
 * The two reason fields are deliberate: wording for internal review ("duplicate, the person already
 * has an account under another address") is unfit for the outside, and one shared field would force
 * vague wording — and the audit entry would stop answering why access was not granted.
 */
export function RejectRegistrationModal({
  open,
  email,
  onCancel,
  onSubmit,
  confirmLoading,
}: Props) {
  const [form] = Form.useForm<Values>();
  // The flag is read from the form, not from separate state: it both shows the reply field and
  // builds the request body, so there are no two sources to diverge.
  const notify = Form.useWatch('notifyApplicant', form) ?? true;

  // The modal is reused for different registrations: the previous reason and reply must not leak.
  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  return (
    <FormModal
      title={email ? `Отклонение заявки: ${email}` : 'Отклонение заявки'}
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      okText="Отклонить"
      cancelText="Не отклонять"
      width={520}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ notifyApplicant: true }}
        onFinish={(v: Values) =>
          onSubmit({
            reason: v.reason.trim(),
            notifyApplicant: v.notifyApplicant,
            // With the flag off the text is not sent at all: antd keeps values of hidden fields,
            // and a reply typed and then abandoned would otherwise land in the audit as sent —
            // though nobody received it.
            ...(v.notifyApplicant ? { applicantMessage: v.applicantMessage?.trim() } : {}),
          })
        }
      >
        <Form.Item
          name="reason"
          label="Причина отказа"
          extra="Остаётся в портале и попадает в аудит: по ней потом видно, почему доступ не дали. Заявитель её не видит."
          rules={[
            { required: true, message: 'Укажите причину' },
            { whitespace: true, message: 'Укажите причину' },
          ]}
        >
          <Input.TextArea rows={3} maxLength={500} showCount autoFocus />
        </Form.Item>
        <Form.Item name="notifyApplicant" valuePropName="checked">
          <Checkbox>Сообщить заявителю по почте</Checkbox>
        </Form.Item>
        {/* With the flag off the reply field is absent, not disabled: writing text that goes nowhere
            is wasted work (ADR 0033 §6). */}
        {notify ? (
          <Form.Item
            name="applicantMessage"
            label="Ответ заявителю"
            extra="Уйдёт письмом на адрес заявки. Адрес мог быть не подтверждён — лишнего писать не нужно."
            rules={[
              { required: true, message: 'Напишите ответ или снимите отметку об отправке' },
              { whitespace: true, message: 'Напишите ответ или снимите отметку об отправке' },
            ]}
          >
            <Input.TextArea rows={4} maxLength={1000} showCount />
          </Form.Item>
        ) : null}
      </Form>
    </FormModal>
  );
}
