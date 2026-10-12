import { useEffect, useEffectEvent } from 'react';
import { Alert, App, DatePicker, Form, Input } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  isMechExtensionPending,
  MECH_EXTEND_NOT_LATER_MESSAGE,
  moscowDateKeyOf,
  type MechRequestDto,
} from '@technic/contracts';
import {
  mechDayLabel,
  mechDaysLeftLabel,
  mechFailureText,
  MechRequestContext,
  mechRequestKeys,
  mechRequestsApi,
} from '@entities/mech-request';
import { FormModal, useFormBlockers } from '@shared/ui';

const DATE = 'YYYY-MM-DD';

interface Values {
  plannedTo: Dayjs;
  reason: string;
}

/**
 * «Запросить продление» (ADR 0171, stage 3): the equipment is needed longer — the new return date
 * and the reason go to the site's visa holder, and the term moves when he signs. The window no
 * longer moves the term itself, and its words say so: «Продлено» after a request would be untrue.
 *
 * The permission is the dispatcher's own (`mechRequests.extend`): an extension costs money just as
 * the rental does, and the one who talks to the lessor asks for it. The menu computes the barrier —
 * the window opens only where the item is shown.
 *
 * A pending request is CHANGED here, not added to: a repeated request overwrites it, and the window
 * opens filled with it. The chain stays in the history.
 *
 * The date is strictly later than the current return, checked here and not only on the server: the
 * same date is no extension and an earlier one is a completion with the actual date. The text is
 * shared with the server (`MECH_EXTEND_NOT_LATER_MESSAGE`). There is no default for a new request:
 * "current plus a week" would look agreed with the lessor, and a person agrees it.
 */
export function MechExtensionRequestModal({
  request,
  onClose,
}: {
  /** `null` — closed. Opens only on a running rental (the whole predicate of R2). */
  request: MechRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const today = moscowDateKeyOf(new Date());
  const pending = request && isMechExtensionPending(request.extension) ? request.extension : null;

  /*
   * Filled once per opening of a request, not per request object (stage 5 plan §4.5): the card
   * rereads the request while the window is open, and a reread must not wipe what is being typed.
   */
  const requestId = request?.id ?? null;
  const fill = useEffectEvent((_requestId: string | null) => {
    if (!request) return;
    form.resetFields();
    if (pending) {
      form.setFieldsValue({ plannedTo: dayjs(pending.newPlannedTo), reason: pending.reason });
    }
  });
  useEffect(() => fill(requestId), [requestId]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      mechRequestsApi.requestExtension(request!.id, {
        plannedTo: values.plannedTo.format(DATE),
        reason: values.reason.trim(),
        version: request!.version,
      }),
    onSuccess: (updated) => {
      const asked = updated.extension?.newPlannedTo ?? updated.plannedTo;
      message.success(`Продление до ${mechDayLabel(asked)} отправлено на визу площадки`);
      void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
      onClose();
    },
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(mechFailureText(e));
    },
  });

  const left = request ? mechDaysLeftLabel(request, today) : null;

  return (
    <FormModal
      title={
        request
          ? `${pending ? 'Изменить запрос продления' : 'Запрос продления'} ${request.displayNumber}`
          : 'Запрос продления'
      }
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText={pending ? 'Изменить запрос' : 'Запросить продление'}
      width={460}
    >
      {request && (
        <>
          <MechRequestContext request={request} />
          <Alert
            type={left?.overdue ? 'warning' : 'info'}
            showIcon
            title={`Сейчас возврат ${mechDayLabel(request.plannedTo)}`}
            description={
              <>
                {left ? `Выдана ${mechDayLabel(request.actualFrom)}, ${left.text}. ` : ''}
                Срок сдвинется, когда ответственное лицо площадки согласует продление.
                {pending &&
                  ` Сейчас ждёт визы запрос до ${mechDayLabel(pending.newPlannedTo)} — новый запрос заменит его.`}
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
              name="plannedTo"
              label="Новая дата возврата"
              rules={[
                { required: true, message: 'Укажите новую дату возврата' },
                {
                  validator: (_r, value: Dayjs | null | undefined) =>
                    !value || value.format(DATE) > request.plannedTo
                      ? Promise.resolve()
                      : Promise.reject(new Error(MECH_EXTEND_NOT_LATER_MESSAGE)),
                },
              ]}
            >
              <DatePicker
                style={{ width: '100%' }}
                format="DD.MM.YYYY"
                allowClear={false}
                disabledDate={(d) => d.format(DATE) <= request.plannedTo}
              />
            </Form.Item>

            <Form.Item
              name="reason"
              label="Причина продления"
              extra="Причину видит тот, кто визирует, и она остаётся в истории заявки: по ней потом видно, чья это была просьба и за чей счёт лишние дни."
              rules={[
                { required: true, message: 'Укажите причину продления' },
                { whitespace: true, message: 'Укажите причину продления' },
                { max: 500, message: 'Слишком длинная причина' },
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
