import { useEffect, useState } from 'react';
import { App, Form, Input, InputNumber, Segmented, Space, Tag, Typography } from 'antd';
import {
  requestCustomerName,
  assignmentRateLabel,
  assignmentTitle,
  calcVehicleRequestCost,
  type CompleteVehicleRequestInput,
  rateForWorkUnit,
  VEHICLE_WORK_UNITS,
  vehicleOwnershipColors,
  vehicleOwnershipLabels,
  type VehicleRequestDto,
  type VehicleWorkUnit,
  vehicleWorkUnitLabels,
  vehicleWorkUnitRateLabels,
  workedAmountLabel,
} from '@technic/contracts';
import { FormGrid } from '../../components/FormGrid';
import { FormModal } from '../../components/FormModal';
import { calendarDayCount } from '../../utils/date';
import { formatMoney } from '../../utils/format';

/**
 * Закрытие заявки фактом (ADR 0029): сколько техника отработала и во сколько это обошлось.
 *
 * Заявку оформляли планом — «автокран на три дня», — а платят за то, что было: машина вышла на
 * день позже, работала полторы смены, простояла в ожидании фронта работ. Поэтому факт
 * предъявляется при переводе в «Выполнена», тем же запросом, что и статус: заявка не бывает
 * выполненной без ответа на «сколько стоило».
 *
 * Единицу выбирают ту, в которой договорились о ставке (ADR 0027): часами или сменами. Сумма
 * подставляется расчётом «ставка × количество» и правится свободно — счёт арендодателя включает
 * и перегон, и простой, и сходиться она должна со счётом, а не с формулой. Ручная правка видна
 * подсказкой: расхождение с расчётом должно быть замечено, а не проскочить молча.
 */
interface Props {
  /** null — окно закрыто; заявка берётся из строки списка. */
  request: VehicleRequestDto | null;
  confirmLoading: boolean;
  onCancel: () => void;
  onSubmit: (v: { completion: CompleteVehicleRequestInput; comment: string }) => void;
}

interface FormValues {
  workedAmount?: number | null;
  totalCost?: number | null;
  comment?: string;
}

/**
 * Единица по умолчанию: та, за которую есть ставка. Смена — первая, потому что технику на объект
 * так и берут; часами закрывают то, что не доработало до смены.
 */
function defaultUnit(request: VehicleRequestDto): VehicleWorkUnit {
  const previous = request.completion?.workedUnit;
  if (previous) return previous;
  const a = request.assignment;
  if (a?.pricePerShift != null) return 'shifts';
  if (a?.pricePerHour != null) return 'hours';
  return 'shifts';
}

/**
 * Сколько отработано «по плану» — им и открывается поле: у спецтехники это длина заказанного
 * периода в сменах (день работы = смена), у грузоперевозки одна подача. Подставленное значение
 * подтверждают или правят; угадывать часы по периоду портал не берётся — их считают по табелю.
 */
function plannedAmount(request: VehicleRequestDto, unit: VehicleWorkUnit): number | null {
  if (unit !== 'shifts') return null;
  if (request.requestType !== 'special_equipment') return 1;
  return calendarDayCount(request.dateFrom, request.dateTo);
}

export function VehicleCompleteModal({ request, confirmLoading, onCancel, onSubmit }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [unit, setUnit] = useState<VehicleWorkUnit>('shifts');
  /** Сумму правили руками — расчёт её больше не переписывает. */
  const [costTouched, setCostTouched] = useState(false);

  const assignment = request?.assignment ?? null;
  const rate = rateForWorkUnit(assignment, unit);

  // Окно переиспользуется под разные заявки, поэтому поля сбрасываются при смене цели, а не при
  // размонтировании. Повторное закрытие (после отката администратором) открывается на прежнем
  // факте: обычно правят одну цифру, а не набирают всё заново.
  const targetId = request?.id ?? null;
  useEffect(() => {
    if (!request) return;
    const start = defaultUnit(request);
    const previous = request.completion;
    setUnit(start);
    setCostTouched(!!previous);
    form.setFieldsValue({
      workedAmount: previous?.workedAmount ?? plannedAmount(request, start),
      totalCost:
        previous?.totalCost ??
        calcVehicleRequestCost(
          rateForWorkUnit(request.assignment, start),
          previous?.workedAmount ?? plannedAmount(request, start) ?? 0,
        ),
      comment: '',
    });
    // Зависимость — идентификатор заявки: перерисовка той же заявки (инвалидация списка после
    // соседнего действия) приходит новым объектом и стёрла бы уже набранное.
  }, [targetId]);

  const workedAmount = Form.useWatch('workedAmount', form);
  const totalCost = Form.useWatch('totalCost', form);

  /** Расчёт по ставке — им подставляется сумма и с ним же сравнивается введённая вручную. */
  const calculated =
    workedAmount != null && workedAmount > 0 ? calcVehicleRequestCost(rate, workedAmount) : null;
  const costDiffers = costTouched && calculated != null && (totalCost ?? null) !== calculated;

  /** Смена единицы меняет и ставку: пересчитываем, пока сумму не правили руками. */
  const changeUnit = (next: VehicleWorkUnit) => {
    setUnit(next);
    if (costTouched) return;
    const amount = form.getFieldValue('workedAmount') as number | null | undefined;
    const nextAmount = amount ?? (request ? plannedAmount(request, next) : null);
    form.setFieldsValue({
      workedAmount: nextAmount,
      totalCost: calcVehicleRequestCost(rateForWorkUnit(assignment, next), nextAmount ?? 0),
    });
  };

  const changeAmount = (value: number | null) => {
    if (costTouched) return;
    form.setFieldsValue({ totalCost: calcVehicleRequestCost(rate, value ?? 0) });
  };

  const submit = (v: FormValues) => {
    if (v.workedAmount == null || v.workedAmount <= 0) {
      message.warning('Укажите, сколько отработала техника');
      return;
    }
    // Аренда — счёт от контрагента (ADR 0027): закрытие без суммы означало бы «сколько заплатили,
    // выясним потом». Тем же правилом отвечает сервер.
    if (assignment?.ownership === 'rental' && v.totalCost == null) {
      message.warning('Укажите стоимость — по арендованной технике заявка закрывается со счётом');
      return;
    }
    onSubmit({
      completion: {
        workedUnit: unit,
        workedAmount: v.workedAmount,
        totalCost: v.totalCost ?? null,
      },
      comment: (v.comment ?? '').trim(),
    });
  };

  return (
    <FormModal
      title={request ? `Выполнение заявки ${request.displayNumber}` : 'Выполнение заявки'}
      open={!!request}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      okText="Выполнена"
      width={880}
    >
      {request && (
        // Основание (машина и ставка) и факт стоят рядом: сумму сверяют с тем, о чём
        // договаривались, а не листают к нему прокруткой. На телефоне колонка одна.
        <Form form={form} layout="vertical" onFinish={submit}>
          <FormGrid.Full>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
              {requestCustomerName(request)}
            </Typography.Paragraph>

            {/* Чем работали и по какой ставке договаривались: сумму считают именно от этого, и
              видеть основание нужно там же, где вводят факт. */}
            {assignment ? (
              <div style={{ marginBottom: 16, lineHeight: 1.5 }}>
                <Space size={8} wrap>
                  <Typography.Text strong>{assignmentTitle(assignment)}</Typography.Text>
                  <Tag color={vehicleOwnershipColors[assignment.ownership]}>
                    {vehicleOwnershipLabels[assignment.ownership]}
                  </Tag>
                  {assignment.lessorName && <Tag>{assignment.lessorName}</Tag>}
                </Space>
                <div>
                  <Typography.Text type="secondary">
                    {assignmentRateLabel(assignment) || 'Ставка не указана'}
                  </Typography.Text>
                </div>
              </div>
            ) : (
              <Typography.Paragraph type="warning">
                Техника у заявки не назначена — стоимость считать не по чему, укажите её вручную
              </Typography.Paragraph>
            )}
          </FormGrid.Full>

          <FormGrid>
            {/* Единица — та, в которой договорились о ставке. Ветка без ставки не запрещена:
              стоимость можно проставить и руками, а отработанное — это факт, а не расчёт. */}
            <FormGrid.Full>
              <Form.Item label="Считаем работу">
                <Segmented<VehicleWorkUnit>
                  block
                  value={unit}
                  onChange={changeUnit}
                  options={VEHICLE_WORK_UNITS.map((u) => {
                    const unitRate = rateForWorkUnit(assignment, u);
                    return {
                      value: u,
                      label: `${vehicleWorkUnitLabels[u]}${unitRate != null ? ` · ${formatMoney(unitRate)}` : ''}`,
                    };
                  })}
                />
              </Form.Item>
            </FormGrid.Full>

            {/* Отработанное и стоимость — соседними ячейками: их сверяют друг с другом. */}
            <>
              <Form.Item
                name="workedAmount"
                label={unit === 'hours' ? 'Отработано часов' : 'Отработано смен'}
                rules={[{ required: true, message: 'Укажите отработанное' }]}
                extra={
                  request.requestType === 'special_equipment'
                    ? `Заказано: ${calendarDayCount(request.dateFrom, request.dateTo) ?? '—'} дн.`
                    : undefined
                }
              >
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  step={unit === 'hours' ? 1 : 0.5}
                  precision={2}
                  onChange={changeAmount}
                />
              </Form.Item>
              <Form.Item
                name="totalCost"
                label="Стоимость, ₽"
                extra={
                  calculated != null
                    ? `Расчёт: ${workedAmountLabel(unit, workedAmount ?? 0)} × ${formatMoney(rate)}`
                    : rate == null
                      ? `Ставки ${vehicleWorkUnitRateLabels[unit]} нет — укажите сумму`
                      : undefined
                }
              >
                <InputNumber
                  style={{ width: '100%' }}
                  min={0}
                  step={1000}
                  precision={2}
                  onChange={() => setCostTouched(true)}
                />
              </Form.Item>
            </>

            <FormGrid.Full>
              {costDiffers && (
                <Typography.Text type="warning">
                  Сумма отличается от расчёта ({formatMoney(calculated)}) — в заявке сохранится
                  введённая
                </Typography.Text>
              )}

              {/* Комментарий описывает конкретное закрытие («простой 2 ч по вине объекта»), поэтому
              уходит в историю заявки, а не в её поле комментария. */}
              <Form.Item name="comment" label="Комментарий" style={{ marginTop: 16 }}>
                <Input.TextArea
                  rows={2}
                  maxLength={2000}
                  showCount
                  placeholder="Необязательно: что важно знать об этом выполнении"
                />
              </Form.Item>
            </FormGrid.Full>
          </FormGrid>
        </Form>
      )}
    </FormModal>
  );
}
