import { useEffect } from 'react';
import { Alert, App, Form, Input } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MechRequestDto } from '@technic/contracts';
import {
  mechDayLabel,
  mechFailureText,
  MechRequestContext,
  mechRequestKeys,
  mechRequestsApi,
} from '@entities/mech-request';
import { FormModal, useFormBlockers } from '@shared/ui';

interface Values {
  reason: string;
}

/**
 * «Снять отметку выдачи» (Р2) — единственное лечение опечатки в дате подачи.
 *
 * Своё окно, а не общий `ReasonModal`: причина здесь не про отказ и не про отмену, а про то, чего
 * не было, — и над полем обязано стоять, какую именно дату снимают. Без этой строки человек снимал
 * бы отметку вслепую, а снятие необратимо в том смысле, что аренда перестаёт считаться идущей.
 *
 * Причина обязательна и уходит в историю своим событием (`mech_request.issue_revoke`): без неё в
 * ленте осталась бы пара «выдана — не выдана», по которой не понять, отменили ошибочную отметку
 * или техника уезжала и вернулась. В комментарий заявки её положить нельзя — она перезаписала бы
 * его.
 *
 * Доступно ровно при действующей аренде (весь предикат Р2), и решает это меню действий по барьерам
 * контрактов: у заявки без выдачи снимать нечего, у завершённой — поздно, а второе нажатие подряд
 * сервер отклонит.
 */
export function MechRevokeIssueModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. Открывается только у действующей аренды. */
  request: MechRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);

  useEffect(() => {
    if (request) form.resetFields();
  }, [request, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      mechRequestsApi.revokeIssue(request!.id, {
        reason: values.reason.trim(),
        version: request!.version,
      }),
    onSuccess: () => {
      message.success('Отметка выдачи снята');
      void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
      onClose();
    },
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(mechFailureText(e));
    },
  });

  return (
    <FormModal
      title={request ? `Снять отметку выдачи ${request.displayNumber}` : 'Снять отметку выдачи'}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText="Снять отметку"
      cancelText="Не снимать"
      okDanger
      width={460}
    >
      {request && (
        <>
          <MechRequestContext request={request} />
          <Alert
            type="warning"
            showIcon
            title={`Будет снята выдача от ${mechDayLabel(request.actualFrom)}`}
            description="Аренда перестанет считаться действующей: заявка вернётся в состояние «ждёт подачи», её снова можно будет отменить."
            style={{ marginBottom: 16 }}
          />
          <Form
            form={form}
            layout="vertical"
            onFinish={(v) => mutation.mutate(v)}
            {...blockers.formProps}
          >
            <Form.Item
              name="reason"
              label="Причина снятия"
              extra="Причина уходит в историю заявки отдельным событием — по ней потом отличают ошибку ввода от возврата техники."
              rules={[
                { required: true, message: 'Укажите причину' },
                { whitespace: true, message: 'Укажите причину' },
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
