import { Button, Result, Space, Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import type { WeeklyVehicleRequestDto } from '@technic/contracts';
import { weeklyRequestErrorMessage as errorMessage } from '@entities/weekly-request';
import { WeeklyStatusTag } from '@entities/weekly-request';
import { hasApiStatus } from '../model/apiError';

/** Static document framing shared by loaded and unavailable weekly-request states. */

/** Identify the document by number, week, status, site and author. */
export function WeeklyRequestHeader({
  request,
  onBack,
}: {
  request: WeeklyVehicleRequestDto;
  onBack: () => void;
}) {
  return (
    <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 12 }}>
      <Button icon={<ArrowLeftOutlined />} onClick={onBack} aria-label="К списку" />
      <div style={{ lineHeight: 1.3 }}>
        <Space size={8} wrap>
          <Typography.Title level={5} style={{ margin: 0 }}>
            {request.displayNumber} · {request.weekLabel}
          </Typography.Title>
          <WeeklyStatusTag status={request.status} />
        </Space>
        <div>
          <Typography.Text type="secondary">
            {request.objectName}
            {request.objectCode ? ` · ${request.objectCode}` : ''} · автор {request.createdByName}
          </Typography.Text>
        </div>
      </div>
    </div>
  );
}

/** Distinguish a deleted site draft from a transport failure and always offer a way back. */
export function WeeklyRequestNotOpened({
  error,
  onLeave,
}: {
  error: unknown;
  onLeave: () => void;
}) {
  const gone = hasApiStatus(error, 404);
  return (
    <Result
      status={gone ? '404' : 'error'}
      title={gone ? 'Заявка удалена вместе с площадкой' : 'Заявка не открылась'}
      subTitle={
        gone
          ? 'Неприменённые недельные заявки погашенной площадки удаляются вместе с ней: документа больше нет.'
          : errorMessage(error)
      }
      extra={
        <Button type="primary" onClick={onLeave}>
          К списку недельных заявок
        </Button>
      }
    />
  );
}
