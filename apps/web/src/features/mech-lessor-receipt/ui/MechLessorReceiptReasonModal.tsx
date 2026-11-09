import { useEffect, useEffectEvent } from 'react';
import { Alert, App, Form, Input } from 'antd';
import type { MechRequestDto } from '@technic/contracts';
import { mechFailureText, MechRequestContext } from '@entities/mech-request';
import { FormModal, useFormBlockers } from '@shared/ui';
import { useDecideMechLessorReceipt, useWaiveMechLessorReceipt } from '../model/mutations';

/**
 * The three receipt decisions taken without looking at a file (P6, O15):
 *
 * - `waive` — «Без чека» when there is nothing to look at: no current version, or a rejected one;
 * - `revokeApproval` — «Отозвать утверждение»: the approved version goes back to «ждёт визы»;
 * - `revokeWaiver` — «Отменить „без чека“»: the rental needs a receipt again.
 */
export type MechLessorReceiptReasonKind = 'waive' | 'revokeApproval' | 'revokeWaiver';

const TEXTS: Record<
  MechLessorReceiptReasonKind,
  { title: string; label: string; ok: string; notice: string; required: string }
> = {
  waive: {
    title: 'Завершение без чека',
    label: 'Почему аренду завершают без чека',
    ok: 'Разрешить без чека',
    notice:
      'Аренду можно будет завершить без чека арендодателя. Чек, прикреплённый позже, заменит это решение и снова будет ждать визы.',
    required: 'Укажите, почему аренду завершают без чека',
  },
  revokeApproval: {
    title: 'Отозвать утверждение чека',
    label: 'Причина отзыва',
    ok: 'Отозвать',
    notice: 'Чек вернётся в «ждёт визы»: аренду не завершат, пока его не утвердят снова.',
    required: 'Укажите причину отзыва',
  },
  revokeWaiver: {
    title: 'Отменить «без чека»',
    label: 'Причина отмены',
    ok: 'Отменить «без чека»',
    notice: 'Аренде снова понадобится чек: завершить её можно будет после утверждённого чека.',
    required: 'Укажите причину отмены',
  },
};

interface Values {
  comment?: string;
}

/**
 * A reason and nothing else — the reason is the only record of why (the history keeps it; the
 * revocation's reason lives nowhere else). The window says what the decision does before the
 * reason is typed, not after.
 *
 * A revocation names the version it withdraws (`receiptId` of the current one at opening): if it was
 * replaced meanwhile, the server answers 409 instead of revoking something nobody looked at.
 */
export function MechLessorReceiptReasonModal({
  target,
  onClose,
}: {
  /** `null` — closed. */
  target: { request: MechRequestDto; kind: MechLessorReceiptReasonKind } | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const decide = useDecideMechLessorReceipt();
  const waive = useWaiveMechLessorReceipt();
  const kind = target?.kind ?? 'waive';
  const texts = TEXTS[kind];

  // Emptied once per opening: a reread of the card must not wipe a reason being typed.
  const requestId = target?.request.id ?? null;
  const reset = useEffectEvent((_requestId: string | null) => {
    if (target) form.resetFields();
  });
  useEffect(() => reset(requestId), [requestId]);

  const handlers = {
    onSuccess: () => {
      message.success(
        kind === 'waive'
          ? 'Завершение без чека разрешено'
          : kind === 'revokeApproval'
            ? 'Утверждение чека отозвано'
            : '«Без чека» отменено — аренде снова нужен чек',
      );
      onClose();
    },
    onError: (e: unknown) => {
      if (!blockers.fromApi(e, { comment: 'comment' })) message.error(mechFailureText(e));
    },
  };

  const submit = ({ comment }: Values) => {
    if (!target) return;
    const reason = comment?.trim() ?? '';
    const rental = target.request;
    if (kind === 'waive') {
      waive.mutate({ rental, comment: reason }, handlers);
      return;
    }
    const current = rental.lessorReceipt;
    if (!current) return;
    decide.mutate({ rental, receiptId: current.id, decision: 'revoke', comment: reason }, handlers);
  };

  return (
    <FormModal
      title={target ? `${texts.title} · ${target.request.displayNumber}` : texts.title}
      open={!!target}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={decide.isPending || waive.isPending}
      okText={texts.ok}
      okDanger={kind !== 'waive'}
      width={460}
    >
      {target && (
        <>
          <MechRequestContext request={target.request} />
          <Alert type="info" showIcon style={{ marginBottom: 16 }} title={texts.notice} />
          <Form form={form} layout="vertical" onFinish={submit} {...blockers.formProps}>
            <Form.Item
              name="comment"
              label={texts.label}
              rules={[
                { required: true, message: texts.required },
                { whitespace: true, message: texts.required },
                { max: 500, message: 'Слишком длинная причина' },
              ]}
            >
              <Input.TextArea rows={3} maxLength={500} showCount autoFocus />
            </Form.Item>
          </Form>
        </>
      )}
    </FormModal>
  );
}
