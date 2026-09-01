import { useEffect } from 'react';
import { Alert, App, DatePicker, Form } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  isAllowedMechFactDate,
  MECH_FUTURE_DATE_MESSAGE,
  moscowDateKeyOf,
  type MechRequestDto,
} from '@technic/contracts';
import {
  mechFailureText,
  MechRequestContext,
  mechRequestKeys,
  mechRequestsApi,
} from '@entities/mech-request';
import { FormModal, useFormBlockers } from '@shared/ui';

const DATE = 'YYYY-MM-DD';

interface Values {
  actualFrom: Dayjs;
}

/**
 * «Отметить выдачу» (Р2): с этого дня техника стоит на площадке и стоит денег.
 *
 * Отметка ручная и остаётся ручной: портал не знает, когда арендодатель довёз виброплиту, и
 * догадка по плановой дате означала бы аренду, начавшуюся в портале раньше, чем в жизни. Цена
 * этого решения названа в плане (риск 4) и лечится видимостью — тегом «ждёт подачи» в списке и
 * числом таких заявок в сводке.
 *
 * Умолчание — сегодня: отмечают выдачу в тот же день, когда технику привезли, а вчерашнюю дату
 * ставят разве что задним числом. Будущие дни заперты и календарём, и правилом: выдача — запись о
 * случившемся, и «выдана послезавтра» означала бы, что портал знает то, чего ещё не было.
 */
export function MechIssueModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. Открывается у заявки в работе без отметки выдачи. */
  request: MechRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const today = moscowDateKeyOf(new Date());

  useEffect(() => {
    if (!request) return;
    form.resetFields();
    form.setFieldsValue({ actualFrom: dayjs(today) });
  }, [request, form, today]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      mechRequestsApi.issue(request!.id, {
        actualFrom: values.actualFrom.format(DATE),
        version: request!.version,
      }),
    onSuccess: () => {
      message.success('Выдача отмечена — аренда пошла');
      void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
      onClose();
    },
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(mechFailureText(e));
    },
  });

  return (
    <FormModal
      title={request ? `Выдача по заявке ${request.displayNumber}` : 'Отметить выдачу'}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText="Отметить выдачу"
      width={440}
    >
      {request && (
        <>
          <MechRequestContext request={request} />
          <Form
            form={form}
            layout="vertical"
            onFinish={(v) => mutation.mutate(v)}
            {...blockers.formProps}
          >
            <Form.Item
              name="actualFrom"
              label="Дата фактической выдачи"
              rules={[
                { required: true, message: 'Укажите дату выдачи' },
                {
                  validator: (_r, value: Dayjs | null | undefined) =>
                    !value || isAllowedMechFactDate(value.format(DATE))
                      ? Promise.resolve()
                      : Promise.reject(new Error(MECH_FUTURE_DATE_MESSAGE)),
                },
              ]}
            >
              <DatePicker
                style={{ width: '100%' }}
                format="DD.MM.YYYY"
                allowClear={false}
                disabledDate={(d) => d.format(DATE) > today}
              />
            </Form.Item>
            {/* Что изменится после нажатия — до нажатия: отмена заявки закрывается насовсем
                (Р2), и лечится ошибка уже другим действием — снятием отметки с причиной. */}
            <Alert
              type="warning"
              showIcon
              title="После отметки заявку нельзя отменить"
              description="За выданную технику выставят счёт: ошибочную отметку снимают действием «Снять отметку выдачи» с причиной, а состоявшуюся аренду закрывают завершением."
            />
          </Form>
        </>
      )}
    </FormModal>
  );
}
