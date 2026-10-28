import {
  Alert,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Segmented,
  Space,
  Tag,
  Typography,
} from 'antd';
import type { Dayjs } from 'dayjs';
import type { FormInstance } from 'antd';
import {
  approvedMachineHours,
  durationLabel,
  requestCustomerName,
  assignmentRateLabel,
  assignmentTitle,
  calcVehicleRequestCost,
  rateForWorkUnit,
  type RouteTimePrefill,
  shiftsCompletionWarning,
  unapprovedPastShiftDays,
  VEHICLE_WORK_UNITS,
  vehicleOwnershipColors,
  vehicleOwnershipLabels,
  type VehicleRequestDto,
  type VehicleRequestShiftsDto,
  type VehicleWorkUnit,
  vehicleWorkUnitLabels,
  vehicleWorkUnitRateLabels,
  workedAmountLabel,
} from '@technic/contracts';
import { FormGrid } from '@shared/ui';
import { calendarDayCount, formatDateOnly, formatMoney } from '@shared/lib';
import { billedCount } from './rentalCompletion';
import { RentalCompletionFields } from './RentalCompletionFields';

/**
 * Поля факта закрытия: фактическая дата, отработанное, стоимость и комментарий (ADR 0029, ADR 0178).
 *
 * Отдельным файлом от `VehicleCompleteModal` по той же границе, что `MachinistFields` отделены от
 * своего окна: здесь ввод — поля, подсказки и подстановки, — а там шаги, предпросмотр, отпечатки и
 * отправка. Разъехавшись, они перестали бы читаться оба: окно тонуло бы в разметке, а поля — в
 * рукопожатиях, к которым не имеют отношения.
 *
 * Состояние формы живёт у окна и приходит сюда `form`: значения нужны и полям (подстановки), и окну
 * (тело команды), а две формы на одно окно означали бы два разных ответа на «что мы закрываем».
 */

/** Значения формы закрытия — одни на оба шага окна: второй шаг дописывает к ним подтверждения. */
export interface CompletionFormValues {
  /** Фактический конец работ; поля нет у грузоперевозки и у арендодателя (Р2, Р16). */
  endedOn?: Dayjs;
  workedAmount?: number | null;
  /** Both counts of a rental closing (D1); the unit switch names the billed one. */
  workedShifts?: number | null;
  workedHours?: number | null;
  /** «Доставка на объект» ticked (D3); its amount is apart from `totalCost`. */
  delivery?: boolean;
  deliveryCost?: number | null;
  totalCost?: number | null;
  comment?: string;
  /** Подтверждение перечня гасимых решений о технике (Д2 плана периодов) — второй шаг. */
  cancelAck?: boolean;
  /** Причина операции журнала — второй шаг, и только когда её спросил предпросмотр. */
  reason?: string;
}

/** Максимум дат в перечне: заказ бывает на месяц, и весь список в предупреждение не влезет. */
const MAX_LISTED_DAYS = 5;

/** Дни без подписи перечнем: «Без подписи: 12.08.2026, 13.08.2026 и ещё 7». */
function listDays(days: string[]): string {
  const head = days.slice(0, MAX_LISTED_DAYS).map(formatDateOnly).join(', ');
  const rest = days.length - MAX_LISTED_DAYS;
  return `Без подписи: ${head}${rest > 0 ? ` и ещё ${rest}` : ''}`;
}

/**
 * The basis of a freight request's hours (D7, D12): the exact recorded share and the whole hours it
 * was rounded up to, or why nothing was proposed — the dispatcher sees where the number came from,
 * or that it has to come from the invoice.
 */
function routeTimeHint(prefill: RouteTimePrefill | null): string | undefined {
  if (!prefill) return undefined;
  if (!prefill.ok) return `Время по точкам не подставлено: ${prefill.reason}`;
  return `По точкам: ${durationLabel(prefill.seconds)} → ${workedAmountLabel('hours', prefill.hours)}, округлено вверх до часа`;
}

interface Props {
  request: VehicleRequestDto;
  form: FormInstance<CompletionFormValues>;
  /**
   * Границы фактической даты, посчитанные контрактами (`completionEndBounds`); `null` — даты не
   * спрашивают вовсе: грузоперевозка, арендодатель или ещё не начавшийся срок.
   */
  bounds: { min: string; max: string } | null;
  unit: VehicleWorkUnit;
  /** Таблица смен заявки: из неё считаются принятые часы и дни без подписи объекта. */
  shifts: VehicleRequestShiftsDto | undefined;
  /**
   * A freight request's recorded route time as the window proposes it (D7, D12), or the reason it
   * proposes none; `null` — not freight, or not loaded yet.
   */
  routePrefill?: RouteTimePrefill | null;
  /** Сумму уже правили руками — подсказка о расхождении с расчётом показывается только тогда. */
  costTouched: boolean;
  /** A rented vehicle: both counts and the delivery are asked (`completionAsksRentalFacts`). */
  rental: boolean;
  onUnitChange: (unit: VehicleWorkUnit) => void;
  onAmountChange: (value: number | null) => void;
  onCountChange: (field: 'workedShifts' | 'workedHours', value: number | null) => void;
  onCostTouched: () => void;
  onEndedOnChange: (value: Dayjs | null) => void;
}

export function CompletionFields({
  request,
  form,
  bounds,
  unit,
  shifts,
  routePrefill = null,
  costTouched,
  rental,
  onUnitChange,
  onAmountChange,
  onCountChange,
  onCostTouched,
  onEndedOnChange,
}: Props) {
  const assignment = request.assignment ?? null;
  const rate = rateForWorkUnit(assignment, unit);
  const workedAmount = Form.useWatch('workedAmount', form);
  const workedHours = Form.useWatch('workedHours', form);
  const workedShifts = Form.useWatch('workedShifts', form);
  const totalCost = Form.useWatch('totalCost', form);
  // The count the cost is rate × of: the unit's own field for a rental, the single one otherwise.
  const billed = rental ? billedCount({ workedHours, workedShifts }, unit) : workedAmount;

  // Принятые объектом машиночасы: подписанные дни и есть основание факта.
  const approvedHours = shifts ? approvedMachineHours(shifts.items) : 0;
  // Дни, за которые объект не расписался. Закрытие они не запирают, но проходить незамеченными не
  // должны: часы таких дней попадают в факт со слов закрывающего, а не с подписи площадки.
  // Предупреждение считается по сводке из строки списка — она уже здесь, тогда как таблица смен
  // приходит вторым запросом и до её ответа перечислять было бы нечего.
  const pendingShifts = shiftsCompletionWarning(request);
  const pendingDays = shifts ? unapprovedPastShiftDays(shifts.items, shifts.onDate) : [];

  /** Расчёт по ставке — им подставляется сумма и с ним же сравнивается введённая вручную. */
  const calculated = billed != null && billed > 0 ? calcVehicleRequestCost(rate, billed) : null;
  // What was ordered and what the site signed: the basis the worked count is checked against.
  const orderedHint =
    request.requestType === 'special_equipment'
      ? [
          `Заказано: ${calendarDayCount(request.dateFrom, request.dateTo) ?? '—'} дн.`,
          approvedHours > 0
            ? `согласовано смен: ${workedAmountLabel('hours', approvedHours)}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : undefined;
  const costDiffers = costTouched && calculated != null && (totalCost ?? null) !== calculated;

  return (
    <>
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

        {/* Незакрытые дни — не отказ, а предупреждение: заявку закрывают и без подписей, но
          закрывающий должен видеть, что принимает работу за площадку. Даты приходят таблицей
          смен, поэтому появляются на мгновение позже самого предупреждения. */}
        {pendingShifts && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title={pendingShifts}
            description={pendingDays.length > 0 ? listDays(pendingDays) : undefined}
          />
        )}
      </FormGrid.Full>

      <FormGrid>
        {/* Фактическая дата — первой: от неё считается и отработанное, и всё, что случится с
          бумагой. Поля нет там, где даты не спрашивают: у грузоперевозки, у арендодателя и у
          заказа, срок которого ещё не начался, — у последнего фактического конца не
          существует вовсе, и дверь такое закрытие отклоняет. */}
        {bounds && (
          <FormGrid.Full>
            <Form.Item
              name="endedOn"
              label="Фактическое окончание работ"
              rules={[{ required: true, message: 'Выберите дату' }]}
              extra={`Когда работы кончились на самом деле. Срок сократится до этого дня; позже ${formatDateOnly(bounds.max)} закрыть нельзя`}
            >
              <DatePicker
                style={{ width: '100%' }}
                format="DD.MM.YYYY"
                allowClear={false}
                onChange={onEndedOnChange}
                // Те же границы проверяет сервер: портал не должен предлагать дату, которую
                // он отклонит, — ни до начала срока, ни завтрашнюю, ни позже разрешённого.
                disabledDate={(d) => {
                  const key = d.format('YYYY-MM-DD');
                  return key < bounds.min || key > bounds.max;
                }}
              />
            </Form.Item>
          </FormGrid.Full>
        )}

        {/* Единица — та, в которой договорились о ставке. Ветка без ставки не запрещена:
          стоимость можно проставить и руками, а отработанное — это факт, а не расчёт. */}
        <FormGrid.Full>
          <Form.Item label="Считаем работу">
            <Segmented<VehicleWorkUnit>
              block
              value={unit}
              onChange={onUnitChange}
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

        {/* Отработанное и стоимость — соседними ячейками: их сверяют друг с другом. У аренды
          ячеек три — смены, часы и стоимость — и доставка под ними (D1–D3). */}
        {rental ? (
          <FormGrid.Full>
            <RentalCompletionFields
              form={form}
              unit={unit}
              rate={rate}
              calculated={calculated}
              shiftsHint={orderedHint}
              hoursHint={routeTimeHint(routePrefill)}
              onCountChange={onCountChange}
              onCostTouched={onCostTouched}
            />
          </FormGrid.Full>
        ) : (
          <>
            <Form.Item
              name="workedAmount"
              label={unit === 'hours' ? 'Отработано часов' : 'Отработано смен'}
              rules={[{ required: true, message: 'Укажите отработанное' }]}
              // Что приняла площадка — основание факта: расхождение с ним должно быть замечено, а
              // не проскочить молча.
              extra={
                request.requestType === 'special_equipment'
                  ? orderedHint
                  : routeTimeHint(routePrefill)
              }
            >
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                step={unit === 'hours' ? 1 : 0.5}
                precision={2}
                onChange={onAmountChange}
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
                onChange={onCostTouched}
              />
            </Form.Item>
          </>
        )}

        <FormGrid.Full>
          {costDiffers && (
            <Typography.Text type="warning">
              Сумма отличается от расчёта ({formatMoney(calculated)}) — в заявке сохранится
              введённая
            </Typography.Text>
          )}

          {/* Комментарий описывает конкретное закрытие («простой 2 ч по вине объекта»),
            поэтому уходит в историю заявки, а не в её поле комментария. */}
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
    </>
  );
}
