import { useEffect } from 'react';
import { Alert, App, Form, Input, Radio, Space, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SERVICE_ESTIMATE_DISPUTE_OUTCOMES,
  serviceEstimateDisputeOutcomeLabels,
  type ResolveServiceEstimateDisputeInput,
  type ServiceEstimateDisputeOutcome,
  type ServiceRequestDto,
} from '@technic/contracts';
import {
  ServiceRequestContext,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { FormModal, useFormBlockers } from '@shared/ui';
import { errorMessage } from '../../utils/format';

/** Поля окна: исход, обязательная при отмене причина и необязательное слово вдогонку. */
interface Values {
  outcome?: ServiceEstimateDisputeOutcome;
  reason?: string;
  comment?: string;
}

/**
 * Чем каждый исход кончается для заявки — словами, а не именем значения (Р9 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`).
 *
 * КУДА ИМЕННО УЙДЁТ ЗАЯВКА, ЗДЕСЬ НЕ НАЗЫВАЕТСЯ, и это не пропуск. Матрица «откуда спор открыт ×
 * исход» живёт на сервере: остановленная из «В работе» вернётся в «В работе», остановленная из
 * «Решена» — в «Решена», с фактом, суммами и гарантиями на месте. Портал целевой статус не считает
 * — посчитай он его сам, вторая матрица разошлась бы с первой молча и пообещала бы человеку не тот
 * исход. Поэтому здесь сказано ПОСЛЕДСТВИЕ, которое от исходного статуса не зависит.
 */
const OUTCOME_HINTS: Record<ServiceEstimateDisputeOutcome, string> = {
  keep: 'Освобождение остаётся, заявка возвращается туда, откуда её остановили. Окно приёмки начинается заново.',
  require_signature:
    'Автоподпись снимается, и по объёму работ снова ждут подписи — до неё заявку не примут и не закроют автоматически.',
  cancel:
    'Заявка уходит в «Отменена». Факт закрытия, суммы и подшитые документы остаются: отмена их не стирает.',
};

/**
 * Разрешение спора об освобождении от подписи (Р9).
 *
 * ОДНО ОКНО С ТРЕМЯ ИСХОДАМИ, А НЕ ТРИ ПУНКТА МЕНЮ. Решение здесь одно — «что делать с
 * освобождением», — и принимают его, сравнивая последствия: оставить, потребовать подпись или
 * отменить заявку. Разложенные по меню, исходы читались бы как три независимых действия, и цена
 * ошибки у крайнего (отмена) ничем не отличалась бы от цены первого.
 *
 * ПРИЧИНА ОБЯЗАТЕЛЬНА РОВНО У ОТМЕНЫ, и это правило сервера, а не бережливость окна: `keep` и
 * `require_signature` возвращают заявку в работу, и объяснение обоим уже лежит в самом споре —
 * спрашивать второе значило бы «почему вы передумали передумывать». Отмена же закрывает заявку, и
 * причина у неё обязательна по общему правилу модуля.
 *
 * Своим окном в `pages/service`, а не слайсом `features`: оно ничего не знает сверх заявки и двух
 * полей, а вход у него один — пункт набора действий этой же страницы (тот же приём, что у состава
 * расходников).
 */
export function ServiceEstimateDisputeModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  // Следим за исходом: поле причины появляется только у отмены, и у него своя подпись.
  const outcome = Form.useWatch('outcome', form);

  // Окно переоткрывают на соседней заявке: исход и причина прошлого разрешения не должны
  // подставляться — это решение по другому спору.
  useEffect(() => {
    if (request) form.resetFields();
  }, [request, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) => {
      const common = { comment: (values.comment ?? '').trim(), version: request!.version };
      /*
       * Тело собирается ПО ИСХОДУ, а не одним объектом с необязательной причиной: схема ручки —
       * союз по исходу (Р2), и «отменить заявку без причины» в ней не собирается вовсе. Пошли мы
       * лишнее поле у `keep`, строгая схема ответила бы 400 с именем поля.
       */
      const body: ResolveServiceEstimateDisputeInput =
        values.outcome === 'cancel'
          ? { outcome: 'cancel', reason: (values.reason ?? '').trim(), ...common }
          : {
              outcome: values.outcome === 'require_signature' ? 'require_signature' : 'keep',
              ...common,
            };
      return serviceRequestsApi.resolveEstimateDispute(request!.id, body);
    },
    onSuccess: (_res, values) => {
      message.success(
        values.outcome === 'cancel'
          ? 'Спор разрешён: заявка отменена'
          : values.outcome === 'require_signature'
            ? 'Спор разрешён: автоподпись снята, по объёму работ ждут подписи'
            : 'Спор разрешён: освобождение оставлено, заявка снова в работе',
      );
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  /*
   * Обязательность обоих полей выражена ПРАВИЛАМИ `Form.Item`, а не проверкой здесь, и причина в
   * поле причины: оно появляется вместе с выбором отмены, то есть монтируется по ходу
   * заполнения, — а правило перепроверяет такое поле само и снимает пометку с первым же вводом.
   * `useFormBlockers` при этом остаётся: он даёт единый вид отказа (прокрутка к первому блокеру и
   * вспышка) и раскладывает на поля ошибки сервера.
   */
  const submit = (values: Values) => mutation.mutate(values);

  return (
    <FormModal
      title={`Разрешить спор по заявке ${request?.displayNumber ?? ''}`}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText="Разрешить спор"
      okDanger={outcome === 'cancel'}
      width={560}
    >
      {request && (
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <ServiceRequestContext request={request} />
          {/* Причина остановки — здесь и только здесь: выход из заморозки её гасит вместе с
              исходным статусом, и после разрешения спрашивать «о чём спорили» будет нечего. */}
          {request.holdReason && (
            <Alert
              type="info"
              showIcon
              title="Спор открыт с причиной"
              description={request.holdReason}
            />
          )}

          <Form form={form} layout="vertical" onFinish={submit} {...blockers.formProps}>
            <Form.Item
              name="outcome"
              label="Чем спор кончается"
              rules={[{ required: true, message: 'Выберите, чем спор кончается' }]}
              style={{ marginBottom: 12 }}
            >
              <Radio.Group>
                <Space orientation="vertical" size={8}>
                  {SERVICE_ESTIMATE_DISPUTE_OUTCOMES.map((value) => (
                    <Radio key={value} value={value}>
                      {serviceEstimateDisputeOutcomeLabels[value]}
                      <Typography.Text
                        type="secondary"
                        style={{ display: 'block', fontSize: 12, lineHeight: 1.35 }}
                      >
                        {OUTCOME_HINTS[value]}
                      </Typography.Text>
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
            </Form.Item>

            {outcome === 'cancel' && (
              <Form.Item
                name="reason"
                label="Причина отмены"
                rules={[
                  { required: true, message: 'Укажите, почему заявка отменяется' },
                  { whitespace: true, message: 'Укажите, почему заявка отменяется' },
                ]}
                style={{ marginBottom: 12 }}
              >
                <Input.TextArea rows={2} maxLength={1000} />
              </Form.Item>
            )}

            <Form.Item
              name="comment"
              label="Комментарий"
              extra="Необязателен: решение уже названо исходом, а причина спора записана при его открытии."
              style={{ marginBottom: 0 }}
            >
              <Input.TextArea rows={2} maxLength={1000} />
            </Form.Item>
          </Form>
        </Space>
      )}
    </FormModal>
  );
}
