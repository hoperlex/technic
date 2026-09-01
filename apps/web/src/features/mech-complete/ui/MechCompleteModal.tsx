import { useEffect } from 'react';
import { Alert, App, Button, DatePicker, Form, InputNumber, Space, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  calcMechCost,
  isAllowedMechFactDate,
  MECH_FUTURE_DATE_MESSAGE,
  mechRateUnitLabels,
  moscowDateKeyOf,
  type MechRequestDto,
} from '@technic/contracts';
import {
  mechFailureText,
  mechMoney,
  mechRateLabel,
  MechRequestContext,
  mechRequestKeys,
  mechRequestsApi,
  mechWorkedLabel,
} from '@entities/mech-request';
import { FormModal, useFormBlockers } from '@shared/ui';

const DATE = 'YYYY-MM-DD';

interface Values {
  actualFrom: Dayjs;
  actualTo: Dayjs;
  actualUnits: number;
  finalCost: number;
}

/**
 * «Завершить» (Р7): реальные даты, отработанные часы или смены и итоговая стоимость.
 *
 * Обе фактические даты, а не одна: выдачу могли отметить не тем днём, и завершение — последний
 * момент, когда это исправляют. Дата выдачи подставляется из заявки, дата возврата — сегодняшняя:
 * закрывают аренду в тот же день, когда технику забрали.
 *
 * **Стоимость вводит человек, а портал только считает рядом.** Это решение, а не недоделка: в
 * счёте арендодателя бывают подача, простой и округление, и сходиться сумма должна со счётом, а не
 * с формулой. Расчёт `отработано × ставка` стоит тут же и подсвечивает расхождение — но
 * подставляется только нажатием, и сохраняется всегда введённое.
 *
 * Повторное завершение (после отката «Выполнена» → «В работе») перезаписывает все четыре значения,
 * и прежние сохранит только история — ради этого у завершения и заведено своё событие (Р11).
 */
export function MechCompleteModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. Открывается у действующей аренды и у коррекции завершения. */
  request: MechRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const today = moscowDateKeyOf(new Date());

  const units = Form.useWatch('actualUnits', form);
  const cost = Form.useWatch('finalCost', form);
  const rate = request?.rate ?? null;
  /** Расчёт есть всегда, когда есть ставка и отработанное: договорённость к этому моменту стоит. */
  const calculated = typeof units === 'number' ? calcMechCost(rate, units) : null;
  /** Копейка разницы — уже расхождение: суммы сравнивают со счётом, а не «примерно». */
  const mismatch =
    calculated !== null && typeof cost === 'number' && Math.abs(cost - calculated) >= 0.01
      ? cost - calculated
      : null;

  useEffect(() => {
    if (!request) return;
    form.resetFields();
    form.setFieldsValue({
      // Выдача — из самой заявки: у действующей аренды она есть всегда, и переспрашивать её
      // значило бы предлагать человеку ввести заново то, что портал уже знает.
      actualFrom: request.actualFrom ? dayjs(request.actualFrom) : dayjs(today),
      // Повторное завершение начинается с прежних чисел: их и пришли исправлять.
      actualTo: dayjs(request.actualTo ?? today),
      actualUnits: request.actualUnits ?? undefined,
      finalCost: request.finalCost ?? undefined,
    });
  }, [request, form, today]);

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      mechRequestsApi.changeStatus(request!.id, {
        status: 'done',
        comment: '',
        completion: {
          actualFrom: values.actualFrom.format(DATE),
          actualTo: values.actualTo.format(DATE),
          actualUnits: values.actualUnits,
          finalCost: values.finalCost,
        },
        version: request!.version,
      }),
    onSuccess: () => {
      message.success('Аренда завершена');
      void qc.invalidateQueries({ queryKey: mechRequestKeys.root });
      onClose();
    },
    /*
     * Факт уходит вложенным объектом вместе с переходом, поэтому пути сервера начинаются с
     * `completion.`: без карты псевдонимов пометка не легла бы ни на одно поле формы и человек
     * увидел бы только тост, не понимая, какую из четырёх цифр править.
     */
    onError: (e) => {
      const landed = blockers.fromApi(e, {
        'completion.actualFrom': 'actualFrom',
        'completion.actualTo': 'actualTo',
        'completion.actualUnits': 'actualUnits',
        'completion.finalCost': 'finalCost',
      });
      if (!landed) message.error(mechFailureText(e));
    },
  });

  const unitWord = request?.rateUnit ? mechRateUnitLabels[request.rateUnit] : 'единиц';

  return (
    <FormModal
      title={request ? `Завершение аренды ${request.displayNumber}` : 'Завершение аренды'}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText="Завершить"
      width={560}
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
            <Space size={12} wrap style={{ width: '100%' }}>
              <Form.Item
                name="actualFrom"
                label="Фактическая выдача"
                rules={[
                  { required: true, message: 'Укажите дату выдачи' },
                  { validator: notInFuture },
                ]}
              >
                <DatePicker
                  style={{ width: 200 }}
                  format="DD.MM.YYYY"
                  allowClear={false}
                  disabledDate={(d) => d.format(DATE) > today}
                />
              </Form.Item>
              <Form.Item
                name="actualTo"
                label="Фактический возврат"
                dependencies={['actualFrom']}
                rules={[
                  { required: true, message: 'Укажите дату возврата' },
                  { validator: notInFuture },
                  /*
                   * Порядок дат проверяется и здесь, и на сервере, и в схеме контрактов. Здесь —
                   * потому что это единственное место, где человек видит обе даты сразу: отказ
                   * сервера пришёл бы после нажатия и без указания, какую из них править.
                   */
                  ({ getFieldValue }) => ({
                    validator: (_r, value: Dayjs | null | undefined) => {
                      const from = getFieldValue('actualFrom') as Dayjs | undefined;
                      return !value || !from || !value.isBefore(from, 'day')
                        ? Promise.resolve()
                        : Promise.reject(
                            new Error('Дата возврата не может быть раньше даты выдачи'),
                          );
                    },
                  }),
                ]}
              >
                <DatePicker
                  style={{ width: 200 }}
                  format="DD.MM.YYYY"
                  allowClear={false}
                  disabledDate={(d) => d.format(DATE) > today}
                />
              </Form.Item>
            </Space>

            <Form.Item
              name="actualUnits"
              label={`Отработано (${unitWord})`}
              extra={`Ставка по договорённости: ${mechRateLabel(request.rate, request.rateUnit)}`}
              rules={[{ required: true, message: 'Укажите отработанное количество' }]}
            >
              {/* Границы повторяют `mechUnitsSchema`: ноль означал бы аренду, которой не было, —
                  такую заявку отменяют, а не завершают. */}
              <InputNumber
                style={{ width: 220 }}
                min={0.01}
                max={99_999_999.99}
                precision={2}
                placeholder="26"
              />
            </Form.Item>

            <Form.Item
              name="finalCost"
              label="Итоговая стоимость, ₽"
              extra="Сумма из счёта арендодателя: подача, простой и округление в расчёт не входят."
              rules={[{ required: true, message: 'Укажите итоговую стоимость' }]}
            >
              {/* Ноль допустим: аренда бывает и в счёт другой работы (`mechCostSchema`). */}
              <InputNumber
                style={{ width: 220 }}
                min={0}
                max={999_999_999}
                precision={2}
                placeholder="31200"
              />
            </Form.Item>

            {calculated !== null && (
              <Space size={8} wrap style={{ marginBottom: 12 }}>
                <Typography.Text type="secondary">
                  Расчёт: {mechWorkedLabel(units ?? null, request.rateUnit)} ×{' '}
                  {mechMoney(request.rate)} = <strong>{mechMoney(calculated)}</strong>
                </Typography.Text>
                {/* Подстановка — нажатием, а не сама собой: посчитанное портала не должно
                    незаметно становиться тем, что человек «подтвердил». */}
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0 }}
                  onClick={() => form.setFieldsValue({ finalCost: calculated })}
                >
                  Подставить расчёт
                </Button>
              </Space>
            )}

            {mismatch !== null && (
              // Расхождение — предупреждение, а не запрет: оно бывает законным, и решает человек.
              <Alert
                type="warning"
                showIcon
                title={`Сумма расходится с расчётом на ${mechMoney(Math.abs(mismatch))}`}
                description={
                  mismatch > 0
                    ? 'Введено больше расчёта — так бывает при подаче и простое. Сохранится введённое.'
                    : 'Введено меньше расчёта — так бывает при скидке по акту. Сохранится введённое.'
                }
              />
            )}
          </Form>
        </>
      )}
    </FormModal>
  );
}

/**
 * Фактические даты не бывают в будущем (Р2) — тем же предикатом, каким отвечает сервер. Обе даты
 * проверяются им одинаково, поэтому правило одно на два поля.
 */
function notInFuture(_rule: unknown, value: Dayjs | null | undefined): Promise<void> {
  return !value || isAllowedMechFactDate(value.format(DATE))
    ? Promise.resolve()
    : Promise.reject(new Error(MECH_FUTURE_DATE_MESSAGE));
}
