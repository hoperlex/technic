import { Checkbox, Col, Form, InputNumber, Row, Typography } from 'antd';
import type { FormInstance } from 'antd';
import {
  HOURS_PER_SHIFT_WARNING,
  hoursPerShift,
  hoursPerShiftLabel,
  type VehicleWorkUnit,
  vehicleWorkUnitRateLabels,
  workedAmountLabel,
} from '@technic/contracts';
import { formatMoney } from '@shared/lib';
import type { CompletionFormValues } from './CompletionFields';

/**
 * The closing row of a rental (plan `docs/vehicle-rental-completion-documents-plan.md`, D1–D4):
 * shifts, actual hours and cost side by side, the delivery under them.
 *
 * Both counts are facts and both are asked; the unit switch above names the one the cost is
 * rate × of. Editing that one recalculates the cost until the cost is typed by hand (ADR 0029
 * decision 4) — the window owns that rule; the other count only moves the average per shift, shown
 * live under the hours (D2). The delivery is its own amount with its own paperwork (D3): it is
 * never added to the cost, and the hint says so where the number is typed.
 */
interface Props {
  form: FormInstance<CompletionFormValues>;
  unit: VehicleWorkUnit;
  rate: number | null;
  /** Rate × billed count, or `null` — nothing to compute from. */
  calculated: number | null;
  /** Under the shifts: what was ordered and what the site signed. */
  shiftsHint?: string;
  /** Under the hours, after the average: where the prefilled hours came from. */
  hoursHint?: string;
  onCountChange: (field: 'workedShifts' | 'workedHours', value: number | null) => void;
  onCostTouched: () => void;
}

export function RentalCompletionFields({
  form,
  unit,
  rate,
  calculated,
  shiftsHint,
  hoursHint,
  onCountChange,
  onCostTouched,
}: Props) {
  const hours = Form.useWatch('workedHours', form);
  const shifts = Form.useWatch('workedShifts', form);
  const delivery = Form.useWatch('delivery', form);
  const average = hoursPerShift(hours, shifts);
  const billed = unit === 'hours' ? hours : shifts;

  return (
    <>
      <Row gutter={12}>
        <Col xs={24} md={8}>
          <Form.Item
            name="workedShifts"
            label="Отработано смен"
            rules={[{ required: true, message: 'Укажите смены' }]}
            extra={shiftsHint}
          >
            <InputNumber
              style={{ width: '100%' }}
              min={0}
              step={0.5}
              precision={2}
              onChange={(value) => onCountChange('workedShifts', value)}
            />
          </Form.Item>
        </Col>
        <Col xs={24} md={8}>
          <Form.Item
            name="workedHours"
            label="Фактически часов"
            rules={[{ required: true, message: 'Укажите часы' }]}
            extra={
              [hoursPerShiftLabel(hours, shifts), hoursHint].filter(Boolean).join(' · ') ||
              'Сумма по сменам'
            }
          >
            <InputNumber
              style={{ width: '100%' }}
              min={0}
              step={1}
              precision={2}
              onChange={(value) => onCountChange('workedHours', value)}
            />
          </Form.Item>
        </Col>
        <Col xs={24} md={8}>
          <Form.Item
            name="totalCost"
            label="Стоимость, ₽"
            extra={
              calculated != null
                ? `Расчёт: ${workedAmountLabel(unit, billed ?? 0)} × ${formatMoney(rate)}`
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
              onChange={onCostTouched}
            />
          </Form.Item>
        </Col>
      </Row>

      {/* A warning, not a refusal (P1): half shifts make odd averages legal, but a day longer than
          a day is usually a typo in the hours. */}
      {average != null && average > HOURS_PER_SHIFT_WARNING && (
        <Typography.Paragraph type="warning">
          Больше {HOURS_PER_SHIFT_WARNING} ч на смену — проверьте часы и смены
        </Typography.Paragraph>
      )}

      <Form.Item name="delivery" valuePropName="checked" style={{ marginBottom: 8 }}>
        <Checkbox>Доставка на объект</Checkbox>
      </Form.Item>
      {delivery && (
        <Form.Item
          name="deliveryCost"
          label="Стоимость привоза/увоза, ₽"
          rules={[{ required: true, message: 'Укажите стоимость доставки' }]}
          extra="Отдельно от стоимости заказа: у доставки свои документы"
        >
          <InputNumber style={{ width: '100%' }} min={0} step={1000} precision={2} />
        </Form.Item>
      )}
    </>
  );
}
