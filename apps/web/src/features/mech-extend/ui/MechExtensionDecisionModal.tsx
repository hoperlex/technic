import { useEffect, useEffectEvent } from 'react';
import { Alert, App, Form, Input, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type MechRequestDto } from '@technic/contracts';
import {
  mechDayLabel,
  mechFailureText,
  MechRequestContext,
  mechRequestKeys,
  mechRequestsApi,
} from '@entities/mech-request';
import { formatDateTime } from '@shared/lib';
import { FormModal, useFormBlockers } from '@shared/ui';

interface Values {
  comment?: string;
}

export type MechExtensionDecision = 'approve' | 'reject';

/**
 * The visa holder's decision on an extension (ADR 0171, stage 3): one window in two modes, because
 * both are one body and one door (`PATCH /:id/extension`) — split into two windows, the context they
 * show would drift. The window shows what is signed: from which date to which, why and who asked.
 *
 * A refusal requires its reason: the rental stays on its term, and the dispatcher needs to know why
 * before he calls the lessor back. An approval may carry a remark; it stays in the history next to
 * the moved term.
 */
export function MechExtensionDecisionModal({
  request,
  mode,
  onClose,
}: {
  /** `null` — closed. Opens only on a request with a pending extension the subject may decide. */
  request: MechRequestDto | null;
  mode: MechExtensionDecision;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const extension = request?.extension ?? null;
  const approve = mode === 'approve';

  // Filled once per opening (stage 5 plan §4.5): a reread of the card must not wipe the reason.
  const requestId = request?.id ?? null;
  const fill = useEffectEvent((_requestId: string | null) => {
    if (request) form.resetFields();
  });
  useEffect(() => fill(requestId), [requestId]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      mechRequestsApi.decideExtension(request!.id, {
        approved: approve,
        comment: values.comment?.trim() ?? '',
        version: request!.version,
      }),
    onSuccess: (updated) => {
      message.success(
        approve
          ? `Продление согласовано: возврат ${mechDayLabel(updated.plannedTo)}`
          : 'Продление отклонено',
      );
      void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
      onClose();
    },
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(mechFailureText(e));
    },
  });

  return (
    <FormModal
      title={
        request
          ? `${approve ? 'Согласовать' : 'Отклонить'} продление ${request.displayNumber}`
          : 'Продление аренды'
      }
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText={approve ? 'Согласовать' : 'Отклонить'}
      okDanger={!approve}
      width={460}
    >
      {request && extension && (
        <>
          <MechRequestContext request={request} />
          <Alert
            type={approve ? 'info' : 'warning'}
            showIcon
            title={`Возврат ${mechDayLabel(extension.previousPlannedTo)} → ${mechDayLabel(extension.newPlannedTo)}`}
            description={
              <>
                <div>Причина: {extension.reason}</div>
                <Typography.Text type="secondary">
                  Запросил {extension.requestedByName} · {formatDateTime(extension.requestedAt)}
                </Typography.Text>
              </>
            }
            style={{ marginBottom: 16 }}
          />
          <Form
            form={form}
            layout="vertical"
            onFinish={(v) => mutation.mutate(v)}
            {...blockers.formProps}
          >
            <Form.Item
              name="comment"
              label={approve ? 'Комментарий (необязательно)' : 'Причина отказа'}
              rules={[
                ...(approve
                  ? []
                  : [
                      { required: true, message: 'Укажите причину отказа' },
                      { whitespace: true, message: 'Укажите причину отказа' },
                    ]),
                { max: 500, message: 'Слишком длинный комментарий' },
              ]}
            >
              <Input.TextArea rows={3} maxLength={500} showCount />
            </Form.Item>
          </Form>
        </>
      )}
    </FormModal>
  );
}
