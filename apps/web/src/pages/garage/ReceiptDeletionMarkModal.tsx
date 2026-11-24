import { Alert, App, Form, Input } from 'antd';
import dayjs from 'dayjs';
import { useMutation } from '@tanstack/react-query';
import { isApiError } from '@shared/api';
import type { AutoPartReceiptDto } from '@technic/contracts';
import { autoPartReceiptApi } from '@entities/auto-part-receipt';
import { FormModal, StaleRecordNotice, useFormRecordSession } from '@shared/ui';
import { receiptErrorText, useReceiptInvalidation } from './receiptMutations';

/**
 * Marking a receipt for deletion (plan `docs/auto-part-receipts-plan.md`, R12).
 *
 * Deletion is split into two actions and two permissions because they are two different jobs: the
 * holder of the maintenance permission (`autoParts.manage`) **asks** for the deletion and says why;
 * only the administrator (`autoParts.delete`, not grantable) deletes the receipt. Clearing the mark
 * needs only `autoParts.manage` (the «Снять пометку» button of the receipt card), so it is not
 * reserved to the administrator. There is no soft delete: a hidden receipt would either keep
 * taking part in the totals or drop out of them silently, and both halves of the answer to "how
 * much went into the vehicle" would depend on an invisible state.
 *
 * Hence two promises of the window:
 *
 *   1. **The reason is required.** The mark is a request to the administrator, and "I suggest
 *      deleting it, but I will not say why" is a riddle, not a request. The pair of `CHECK`s in the
 *      database demands the same.
 *   2. **The mark changes nothing.** A marked receipt stays in the list, counts in the per-vehicle
 *      totals and is edited as before. This must be said before the button is pressed: otherwise
 *      the orange tag would read as "the record is switched off".
 *
 * The version is as in the other three mutations (R12): the person marks the document they read,
 * not a row in a table, and a receipt rewritten in the meantime must answer 409.
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

  /*
   * The reason starts empty once per opening, and the mark carries the version of the receipt as
   * it was when the window opened (stage 5 plan §4.5): the card rereads the receipt after any
   * neighbouring action, and that must neither erase the typed reason nor silently retarget the
   * mark to a receipt the person has not read.
   */
  const session = useFormRecordSession(form, {
    open: !!receipt,
    id: receipt?.id ?? null,
    data: receipt ?? undefined,
    version: (r: AutoPartReceiptDto) => r.version,
    values: () => ({ reason: '' }),
  });

  const mark = useMutation({
    mutationFn: (v: Values) =>
      autoPartReceiptApi.markDeletion(receipt!.id, {
        reason: v.reason.trim(),
        version: session.version!,
      }),
    onSuccess: () => {
      message.success('Чек помечен к удалению');
      // The mark moves no numbers (R12), so the list, the summary and the card are invalidated — and only they.
      invalidate({ kind: 'mark', id: receipt!.id });
      onClose();
    },
    onError: (e) => {
      message.error(receiptErrorText(e));
      /*
       * 409 — the version moved or the mark was set from another window. Both are cured by a
       * reread, not by pressing the same button again: the card on screen is stale. The window stays
       * open with the typed reason — the reread brings the newer receipt and the notice, and
       * "Reload" is the person's choice (stage 5 plan §4.5, decision R6-a). Other refusals (network,
       * server) keep it open too: a typed reason would survive closing only in the writer's head.
       */
      if (isApiError(e) && e.status === 409) {
        invalidate({ kind: 'mark', id: receipt!.id });
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
        <StaleRecordNotice session={session} />
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="Пометка ничего не удаляет и ничего не пересчитывает"
          description="Чек останется в списке и в суммах по машинам. Удаляет его только администратор; снять пометку можно в карточке чека."
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
