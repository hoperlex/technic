import { useEffect } from 'react';
import { Alert, App, Form, Input } from 'antd';
import dayjs from 'dayjs';
import { useMutation } from '@tanstack/react-query';
import { isApiError } from '@shared/api';
import type { AutoPartReceiptDto } from '@technic/contracts';
import { autoPartReceiptApi } from '@entities/auto-part-receipt';
import { FormModal } from '@shared/ui';
import { receiptErrorText, useReceiptInvalidation } from './receiptMutations';

/**
 * Пометка чека к удалению (план `docs/auto-part-receipts-plan.md`, Р12).
 *
 * Удаление разведено на два действия и два права, потому что это две разные работы: держатель
 * ведения (`autoParts.manage`) **просит** удалить и объясняет зачем, администратор
 * (`autoParts.delete`) удаляет или отказывает, сняв пометку. Мягкого удаления у чека нет вовсе:
 * скрытый чек либо продолжал бы участвовать в суммах, либо выпадал бы из них молча — и обе
 * половины ответа «сколько вложено в машину» зависели бы от невидимого состояния.
 *
 * Отсюда два обещания окна:
 *
 *   1. **Причина обязательна.** Пометка — просьба к администратору, а «предлагаю удалить, а зачем
 *      не скажу» это не просьба, а загадка. Того же требует пара `CHECK` в базе.
 *   2. **Пометка ничего не меняет.** Чек с ней виден в списке, входит в суммы по машинам и
 *      правится как прежде. Сказать это надо до нажатия: иначе оранжевый тег читался бы как
 *      «запись выключена».
 *
 * Версия — как у остальных трёх мутаций (Р12): помечают прочитанный документ, а не строку в
 * таблице, и чек, переписанный тем временем, обязан ответить 409.
 */

interface Values {
  reason: string;
}

export function ReceiptDeletionMarkModal({
  receipt,
  onClose,
}: {
  /** `null` — окно закрыто. Открывается только у непомеченного чека: у помеченного кнопка другая. */
  receipt: AutoPartReceiptDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const invalidate = useReceiptInvalidation();
  const [form] = Form.useForm<Values>();

  useEffect(() => {
    if (receipt) form.resetFields();
  }, [receipt, form]);

  const mark = useMutation({
    mutationFn: (v: Values) =>
      autoPartReceiptApi.markDeletion(receipt!.id, {
        reason: v.reason.trim(),
        version: receipt!.version,
      }),
    onSuccess: () => {
      message.success('Чек помечен к удалению');
      // Цифры пометка не двигает (Р12), поэтому гасится список, сводка и карточка — и только они.
      invalidate({ kind: 'mark', id: receipt!.id });
      onClose();
    },
    onError: (e) => {
      message.error(receiptErrorText(e));
      /*
       * 409 — либо версия уехала, либо пометку уже поставили из другого окна. И то, и другое
       * лечится перечиткой, а не повторным нажатием той же кнопки: карточка на экране устарела.
       * Прочие отказы (сеть, отказ сервера) окно не закрывают — набранная причина пережила бы
       * закрытие только в голове у пишущего.
       */
      if (isApiError(e) && e.status === 409) {
        invalidate({ kind: 'mark', id: receipt!.id });
        onClose();
      }
    },
  });

  if (!receipt) return null;

  return (
    <FormModal
      title={`Пометить к удалению чек № ${receipt.documentNumber} от ${dayjs(receipt.purchasedOn).format('DD.MM.YYYY')}`}
      open
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mark.isPending}
      okText="Пометить"
      okDanger
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={(v) => mark.mutate(v)}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="Пометка ничего не удаляет и ничего не пересчитывает"
          description="Чек останется в списке и в суммах по машинам. Удалить его или снять пометку может только администратор — причину прочитает он."
        />
        <Form.Item
          name="reason"
          label="Причина"
          rules={[
            { required: true, message: 'Укажите причину' },
            { min: 3, message: 'Причина слишком короткая — её будут читать через неделю' },
          ]}
        >
          <Input.TextArea
            rows={3}
            maxLength={1000}
            showCount
            placeholder="Задвоили с чеком № 214"
          />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
