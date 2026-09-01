import { useEffect, type ReactNode } from 'react';
import { Alert, Form, Input } from 'antd';
import { FormModal } from '@shared/ui';

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
  notice,
  danger,
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

interface RollbackProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
  confirmLoading?: boolean;
  /** Пояснение над полем: какую именно заявку возвращаем. */
  subject?: string;
  /**
   * Что возврат сотрёт у этой самой заявки — строками, по её собственным данным. Перечень
   * собирает вызывающий экран: у заказа техники стирается одно (машина, рейс, виза), у вывоза
   * мусора другое (факт и талоны), а обещать снятие того, чего у заявки нет, нельзя — общий
   * список для обоих модулей врал бы половине заявок.
   */
  erases: string[];
  /**
   * Помеха, из-за которой сервер возврат не пропустит (выписанный путевой лист,
   * `ROLLBACK_WAYBILL_MESSAGE`). Показывается тут же: узнать о ней после набранной причины
   * и нажатия — значит проделать работу впустую.
   */
  blocker?: string | null;
}

/**
 * Возврат заявки из «В работе» в «Новую» (`transitionResetsWork`). От отмены отличается не
 * подписями, а тем, что стирает нажитое заявкой в работе, — поэтому перечень стираемого стоит
 * над полем причины, до нажатия: после него восстанавливать будет нечего.
 *
 * Окно то же самое, что у отмены: причина обязательна и там, и здесь, и уходит она тем же
 * запросом смены статуса. Второе окно с полем «Причина» отличалось бы от первого только
 * заголовком — и разъезжалось бы с ним при каждой правке.
 */
export function RollbackReasonModal({ subject, erases, blocker, ...rest }: RollbackProps) {
  return (
    <ReasonModal
      {...rest}
      title="Возврат заявки в «Новую»"
      label={subject ? `Причина возврата заявки ${subject}` : 'Причина возврата'}
      okText="Вернуть в «Новую»"
      cancelText="Не возвращать"
      danger
      notice={
        <>
          {blocker && (
            <Alert type="error" showIcon title={blocker} style={{ marginBottom: 12 }} />
          )}
          <Alert
            type="warning"
            showIcon
            title="Заявка вернётся в состояние только что заведённой"
            description={
              erases.length > 0 ? (
                <>
                  Будет стёрто:
                  <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                    {erases.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </>
              ) : (
                // Нечего стирать — так и сказано: пустой список «будет стёрто» человек читает
                // как недогрузившийся, а не как «работы по заявке не завелось».
                'Стирать у заявки нечего — сменится только статус.'
              )
            }
            style={{ marginBottom: 16 }}
          />
        </>
      }
    />
  );
}
