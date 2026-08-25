import { Alert, DatePicker, Form, Typography } from 'antd';
import type { DriverDto, RequiredAnchor, SpecialEquipmentRequestDto } from '@technic/contracts';
import { AutoSelect } from '@shared/ui';
import { machinistOption } from './assignDriverHints';
import { formatDateOnly } from './shared';

/**
 * Поля окна «Сменить машиниста» (этап 6 плана `docs/assignment-periods-plan.md`, §9): кого сажают
 * за технику, с какого числа — и кто работал в дни, за которые история никого не знает.
 *
 * Отдельным файлом от окна, потому что окно про порядок разговора: предпросмотр, пересчёт, отказы
 * и подтверждения. Здесь только ввод — и одно правило, общее обоим полям: **портал не подставляет
 * ни дату, ни человека** (ADR 0083). Подставленная фамилия уезжает в бланк строгой отчётности
 * настоящей, а подставленная дата назначает человека на дни, о которых его не спрашивали.
 */

interface PickProps {
  request: SpecialEquipmentRequestDto;
  machinists: DriverDto[];
  loading: boolean;
}

/** Кого назначают и с какого числа. */
export function MachinistPickFields({ request, machinists, loading }: PickProps) {
  return (
    <>
      <Form.Item
        name="driverPersonId"
        label="Машинист"
        rules={[{ required: true, message: 'Выберите машиниста' }]}
        extra="За технику портал никого не сажает сам: даже когда в справочнике один водитель, его выбирает диспетчер."
      >
        <AutoSelect
          autoSelectSole={false}
          options={machinists.map(machinistOption)}
          loading={loading}
          placeholder="Кто сядет за технику"
          notFoundContent="В справочнике нет действующих водителей"
        />
      </Form.Item>
      <Form.Item
        name="effectiveDate"
        label="Работает с"
        rules={[{ required: true, message: 'Выберите дату' }]}
        extra={
          <>
            Прежний машинист работает по этот день включительно. День позже конца срока завести
            можно — такое решение подождёт продления ({formatDateOnly(request.dateFrom)} —{' '}
            {request.dateTo ? formatDateOnly(request.dateTo) : 'без даты окончания'}).
          </>
        }
      >
        <DatePicker
          style={{ width: '100%' }}
          format="DD.MM.YYYY"
          allowClear={false}
          // До начала работ машиниста нет — сервер отвечает тем же 422 (Р13), и предлагать такую
          // дату окно не должно.
          disabledDate={(d) => d.format('YYYY-MM-DD') < request.dateFrom}
        />
      </Form.Item>
      <Typography.Text type="secondary">
        Дата и человек не подставлены нарочно: подставленная фамилия уезжает в бланк строгой
        отчётности настоящей.
      </Typography.Text>
    </>
  );
}

/**
 * Пробелы машиниста (Р16) — первая фаза предпросмотра.
 *
 * Пока за эти дни не назван человек, команда не пройдёт: сверка не выпишет за них лист, а в
 * истории остался бы отрезок, за которым никого нет. Второго экрана здесь ещё нет и быть не может
 * — набор последствий станет известен только после ответа на этот вопрос.
 */
export function MachinistAnchorFields({
  anchors,
  machinists,
  loading,
}: {
  anchors: readonly RequiredAnchor[];
  machinists: DriverDto[];
  loading: boolean;
}) {
  return (
    <>
      <Alert
        type="warning"
        showIcon
        message="Назовите машиниста на днях, где он неизвестен"
        description="На этих отрезках история не знает, кто работал, — а смена, которую вы задумали, обязана оставить историю полной. Назовите людей, и портал покажет, что произойдёт."
      />
      {anchors.map((gap) => (
        <Form.Item
          key={gap.effectiveDate}
          name={['anchors', gap.effectiveDate]}
          label={`Кто работал ${formatDateOnly(gap.from)} — ${formatDateOnly(gap.to)}`}
          rules={[{ required: true, message: 'Назовите машиниста' }]}
          style={{ marginBottom: 0 }}
        >
          <AutoSelect
            autoSelectSole={false}
            options={machinists.map(machinistOption)}
            loading={loading}
            placeholder="Кто работал в эти дни"
            notFoundContent="В справочнике нет действующих водителей"
          />
        </Form.Item>
      ))}
    </>
  );
}
