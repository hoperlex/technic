import { Typography } from 'antd';
import type { VehicleRequestDto } from '@technic/contracts';
import { formatDateTimeMaybe } from '@entities/request';
import { calendarDayCount, formatDateOnly } from '@shared/lib';

/** Work term: the period with the ordered day count for equipment, the delivery date for freight. */
export function historyTerm(request: VehicleRequestDto) {
  if (request.requestType !== 'special_equipment') {
    return <div>{formatDateTimeMaybe(request.scheduledAt, request.scheduledTimeUnspecified)}</div>;
  }
  const days = calendarDayCount(request.dateFrom, request.dateTo);
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>
        {request.dateTo
          ? `${formatDateOnly(request.dateFrom)} – ${formatDateOnly(request.dateTo)}`
          : formatDateOnly(request.dateFrom)}
      </div>
      {days != null && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          заказано {days} дн.
        </Typography.Text>
      )}
    </div>
  );
}
