import { useEffect } from 'react';
import { Alert, App, DatePicker, Form, Input } from 'antd';
import type { Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
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
 * «Продлить» (Р9, Р11): техника нужна дольше, чем договаривались, — новая дата возврата и причина.
 *
 * Право своё (`mechRequests.extend`, у диспетчера), а не общее со статусом: продление стоит денег
 * ровно так же, как сама аренда, и решает его тот, кто говорит с арендодателем. Меню строки этот
 * барьер и считает — окно открывается только там, где пункт показан.
 *
 * **Дата строго позже прежней, и проверяется это здесь, а не только на сервере.** Та же дата — не
 * продление, а меньшая — сокращение срока, которое оформляется завершением с фактической датой:
 * иначе аренда «сократилась» бы в плане, а техника осталась бы на площадке. Текст отказа общий с
 * сервером (`MECH_EXTEND_NOT_LATER_MESSAGE`) — двух разных объяснений одного правила у портала
 * быть не должно. Календарь запирает прошлое той же границей: выбрать неверный день нельзя вовсе,
 * а сообщение остаётся для набранного руками.
 *
 * Причина обязательна и уходит в историю своим событием (`mech_request.extend`). В комментарий
 * заявки её положить нельзя — она перезаписала бы его, — а без неё в ленте осталась бы одна
 * переехавшая дата, по которой не понять, чья это была просьба и почему.
 *
 * Умолчания у новой даты нет намеренно: «прежняя плюс неделя» выглядела бы как согласованный с
 * арендодателем срок, а согласовывает его человек. Продлевают действующую аренду в том числе
 * просроченную — тогда новая дата закрывает уже прошедшие дни, и остаток срока в шапке показывает,
 * сколько их накопилось.
 */
export function MechExtendModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. Открывается только у действующей аренды (весь предикат Р2). */
  request: MechRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const today = moscowDateKeyOf(new Date());

  useEffect(() => {
    if (request) form.resetFields();
  }, [request, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      mechRequestsApi.extend(request!.id, {
        plannedTo: values.plannedTo.format(DATE),
        reason: values.reason.trim(),
        version: request!.version,
      }),
    onSuccess: (updated) => {
      message.success(`Аренда продлена до ${mechDayLabel(updated.plannedTo)}`);
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
      title={request ? `Продление аренды ${request.displayNumber}` : 'Продление аренды'}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText="Продлить"
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
              left
                ? `Выдана ${mechDayLabel(request.actualFrom)}, ${left.text}. Новая дата должна быть позже прежней.`
                : 'Новая дата должна быть позже прежней.'
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
              extra="Причина уходит в историю заявки отдельным событием: по ней потом видно, чья это была просьба и за чей счёт лишние дни."
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
