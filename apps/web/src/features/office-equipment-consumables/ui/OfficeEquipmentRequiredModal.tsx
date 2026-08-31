import { useEffect } from 'react';
import { App, Form, InputNumber, Space, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { OfficeEquipmentConsumableDto } from '@technic/contracts';
import { FormModal, useFormBlockers } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentConsumablesApi,
  officeEquipmentPurchaseKeys,
} from '@entities/office-equipment';

/**
 * Быстрая правка потребности прямо из перечня (план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р13).
 *
 * ВТОРАЯ ДВЕРЬ К ОДНОМУ ЧИСЛУ, НО НЕ ВТОРАЯ РУЧКА. Потребность правят из двух мест — из формы
 * карточки в справочнике и отсюда, со вкладки, где на неё смотрят вместе с дефицитом, — и обе
 * ведут в одну и ту же ручку правки карточки (`PATCH /:id`). Своей ручки ради одного числа у
 * потребности нет вовсе: она разошлась бы с первой на первой же проверке — на праве, на записи в
 * аудит, на отказе по погашенной позиции.
 *
 * ПОЧЕМУ ЭТО НЕ ПОХОЖЕ НА ОКНО ОСТАТКА, хотя окна соседние. Остаток — предмет учёта: у каждого его
 * изменения есть причина, автор и строка журнала, а сохранение сверяет «то число, которое человек
 * видел» и отвечает 409 на расхождение. Потребность — намерение: её правят по обстоятельствам,
 * журнала у неё нет, и стеречь одновременную правку двоих здесь нечем и незачем — последнее
 * сказанное слово и есть план. Отсюда ни причины, ни `expectedQuantity` в этой форме.
 *
 * Тело правки — ОДНО ПОЛЕ, а не вся карточка: `PATCH` разбирает присланное по одному полю, и
 * отсутствующее означает «не трогать». Пришли форма всю карточку, она везла бы сюда код,
 * наименование и набор моделей — то есть могла бы затереть чужую правку, которой не видела.
 */

interface Props {
  /** Позиция, которой правят потребность; `null` — окно закрыто. */
  consumable: OfficeEquipmentConsumableDto | null;
  onClose: () => void;
}

interface Values {
  requiredQuantity: number;
}

export function OfficeEquipmentRequiredModal({ consumable, onClose }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);

  const openedId = consumable?.id;
  useEffect(() => {
    if (!openedId) return;
    // Окно открывают и на соседней строке: набранное в прошлый раз к ней отношения не имеет.
    form.resetFields();
    form.setFieldsValue({ requiredQuantity: consumable?.requiredQuantity ?? 0 });
    // Значение берётся из строки перечня, а не перечитывается: список под окном обновляется сам,
    // а потребность — не то число, ради которого стоит держать второй запрос.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedId, form]);

  const saveMut = useMutation({
    mutationFn: (values: Values) =>
      officeEquipmentConsumablesApi.update(consumable!.id, {
        requiredQuantity: values.requiredQuantity,
      }),
    onSuccess: () => {
      message.success('Потребность сохранена');
      void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
      /*
       * И закупки: предзаполнение считается по потребности (Р15), и открытая рядом форма закупки,
       * собранная до правки, предложила бы старые количества. Карточку аппарата гасить незачем —
       * потребности в её ответе нет вовсе, там только остаток.
       */
      void qc.invalidateQueries({ queryKey: officeEquipmentPurchaseKeys.root });
      onClose();
    },
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title={`Потребность: ${consumable?.name ?? ''}`}
      open={!!consumable}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={saveMut.isPending}
      width={460}
    >
      {/* Три числа рядом с полем — те же, из которых сложен дефицит (Р15): потребность правят,
          глядя на них, и заставлять человека держать их в голове или возвращаться в таблицу
          значило бы звать на ошибку в плане закупки. */}
      <Space size={16} wrap style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary">
          На складе: <Typography.Text strong>{consumable?.quantity ?? 0}</Typography.Text>
        </Typography.Text>
        <Typography.Text type="secondary">
          Уже заказано: <Typography.Text strong>{consumable?.alreadyOrdered ?? 0}</Typography.Text>
        </Typography.Text>
        <Typography.Text type="secondary">
          К закупке: <Typography.Text strong>{consumable?.deficit ?? 0}</Typography.Text>
        </Typography.Text>
      </Space>
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => saveMut.mutate(v)}
        {...blockers.formProps}
      >
        <Form.Item
          name="requiredQuantity"
          label="Сколько держать на полке"
          rules={[{ required: true, message: 'Укажите потребность' }]}
          // Ноль назван словами, потому что он значим и не равен «нет данных»: за позицией с нулём
          // не следят, и в плановую закупку она не попадает вовсе (Р13).
          extra="Ноль означает «не следим»: такую позицию плановая закупка не предложит, даже если полка пуста"
        >
          <InputNumber min={0} max={1_000_000} precision={0} style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
