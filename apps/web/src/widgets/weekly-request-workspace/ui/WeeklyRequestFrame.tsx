import { Button, Result, Space, Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import type { WeeklyVehicleRequestDto } from '@technic/contracts';
import { weeklyRequestErrorMessage as errorMessage } from '@entities/weekly-request';
import { WeeklyStatusTag } from '@entities/weekly-request';
import { hasApiStatus } from '../model/apiError';

/*
 * Framing of the weekly request page: the header with number and status, and the screen of a
 * request that did not open. Both know nothing about composition assembly; they need only the
 * request and "where to go".
 *
 * Both speak about one thing: how a document NOT being edited looks. The header answers "which week
 * is this and in what state", the refusal screen "why it is not visible and what to do next". There
 * is no dead end in either case: a vanished request names its reason (deleted together with its
 * site), and the button returns to the list instead of leaving an empty page.
 */

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

/**
 * The request did not open. A vanished one differs from a connection failure and is labelled with
 * the reason: unapplied weekly requests of a retired site are deleted with it, and "the request did
 * not open" on such a link would send people looking for a bug where there is none.
 */
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
