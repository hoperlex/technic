import { useEffect } from 'react';
import { Checkbox, Form, Input } from 'antd';
import { FormModal } from '@shared/ui';
import type { RejectUserBody } from '@technic/contracts';

interface Props {
  open: boolean;
  /** Адрес заявки: он же адрес письма — по нему администратор и узнаёт, кому отказывает. */
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
 * Отказ по заявке на регистрацию: причина для разбора внутри, отметка об отправке и текст, который
 * прочитает сам заявитель.
 *
 * Своё окно, а не общий `ReasonModal` (`components/CancelReasonModal`): у того один
 * `onSubmit(reason: string)` и пять вызывающих — отмена заявки, возврат в «Новую», отказ по
 * недельной заявке, отказ по заявке на обслуживание и этот. Продеть через него второй текст и флаг
 * значит усложнить окно отмены заявки ради формы, нужной одному экрану.
 *
 * Полей причины два намеренно: формулировка для разбора («дубль, человек уже заведён под другим
 * адресом») наружу не годится, а одно общее поле заставило бы писать обтекаемо — и запись в аудите
 * перестала бы отвечать на вопрос, почему доступ не дали.
 */
export function RejectRegistrationModal({
  open,
  email,
  onCancel,
  onSubmit,
  confirmLoading,
}: Props) {
  const [form] = Form.useForm<Values>();
  // Отметка читается из формы, а не из состояния рядом: по ней и показывается поле ответа, и
  // собирается тело запроса — двум источникам тут разойтись негде.
  const notify = Form.useWatch('notifyApplicant', form) ?? true;

  // Окно переиспользуется для разных заявок: причина и ответ предыдущей не должны подставляться.
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
            // Со снятой отметкой текст не уходит вовсе: antd хранит значения скрытых полей, и
            // набранный, а потом передуманный ответ иначе лёг бы в аудит как отправленный —
            // хотя его никто не получил.
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
        {/* Поля ответа со снятой отметкой нет вовсе, а не выключенное: писать текст, который никуда
            не уйдёт, — работа впустую (ADR 0033 §6). */}
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
