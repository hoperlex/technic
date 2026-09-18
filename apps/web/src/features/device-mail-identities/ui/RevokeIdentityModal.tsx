import { useEffect } from 'react';
import { Alert, Form, Input } from 'antd';
import type { DeviceIdentityDto } from '@technic/contracts';
import { FormModal } from '@shared/ui';

/**
 * Снятие привязки — окно с обязательной причиной (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §5.1).
 *
 * ПРИЧИНА ОБЯЗАТЕЛЬНА, в отличие от заведения: снятая строка остаётся в реестре и объясняет
 * прошлое. Без причины она объясняет ровно ничего.
 *
 * ОКНО НАЗЫВАЕТ ПОСЛЕДСТВИЕ, А НЕ ПЕРЕСПРАШИВАЕТ. Записанные показания снятие НЕ откатывает — это
 * названная граница плана, — и человек, ожидавший отката, должен узнать об этом здесь.
 */
export function RevokeIdentityModal({
  item,
  pending,
  onCancel,
  onSubmit,
}: {
  item: DeviceIdentityDto | null;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}) {
  const [form] = Form.useForm<{ note: string }>();

  useEffect(() => {
    if (item) form.setFieldsValue({ note: '' });
  }, [item, form]);

  return (
    <FormModal
      open={item !== null}
      title="Снять привязку?"
      okText="Снять"
      okDanger
      confirmLoading={pending}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
    >
      <Alert
        type="warning"
        showIcon
        title={REVOKE_CONSEQUENCE}
        description={item ? `${item.value} → ${item.equipmentTitle}` : undefined}
        style={{ marginBottom: 12 }}
      />
      <Form form={form} layout="vertical" onFinish={(values) => onSubmit(values.note.trim())}>
        <Form.Item
          name="note"
          label="Почему снимаем"
          rules={[{ required: true, message: 'Назовите причину: она останется в реестре' }]}
        >
          <Input.TextArea rows={2} placeholder="Например: аппарат списан" />
        </Form.Item>
      </Form>
    </FormModal>
  );
}

/** Обещание окна, проверяемое дословно: снятие не откатывает записанное. */
export const REVOKE_CONSEQUENCE =
  'Новые письма по этому ключу опознаваться не будут. Уже записанные показания останутся в карточке';
