import { CheckCircleOutlined, EyeOutlined } from '@ant-design/icons';
import { Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import {
  requestCustomerLabel,
  requestStatusColors,
  requestStatusLabels,
  type VehicleRequestDto,
  vehicleClassificationLabel,
  vehicleRequestTypeColors,
  vehicleRequestTypeLabels,
  workedAmountLabel,
} from '@technic/contracts';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '@entities/object';
import { VehicleRequestAssignmentCell } from '@entities/vehicle-request';
import { actionsColumn, RowActionButton, textColumn, UserAvatar } from '@shared/ui';
import { formatDate, formatMoney } from '@shared/lib';
import { historyTerm } from './historyTerm';

const dash = <Typography.Text type="secondary">—</Typography.Text>;

/** Desktop columns for the closed-request journal. */
export function historyColumns(
  onOpen: (request: VehicleRequestDto) => void,
): TableColumnType<VehicleRequestDto>[] {
  return [
    {
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      width: 170,
      sorter: true,
      render: (_value, request) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{request.displayNumber}</div>
          <Space size={6}>
            <UserAvatar name={request.createdByName} size={18} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {request.createdByName}
            </Typography.Text>
          </Space>
        </div>
      ),
    },
    {
      key: 'term',
      title: 'Когда',
      width: 175,
      sorter: true,
      defaultSortOrder: 'descend',
      render: (_value, request) => historyTerm(request),
    },
    textColumn({
      key: 'objectName',
      title: 'Заказчик',
      dataIndex: 'objectName',
      searchable: false,
      width: OBJECT_COLUMN_WIDTH,
      render: (_value, request) => {
        const customer = requestCustomerLabel(request);
        return (
          <ObjectCell name={customer.text} hint={customer.hint} address={request.objectAddress} />
        );
      },
    }),
    {
      key: 'vehicleTypeName',
      title: 'Заказано',
      dataIndex: 'vehicleTypeName',
      width: 190,
      sorter: true,
      render: (_value, request) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>
            {vehicleClassificationLabel({
              typeName: request.vehicleTypeName,
              categoryName: request.vehicleCategoryName,
            })}
          </div>
          <Tag
            color={vehicleRequestTypeColors[request.requestType]}
            style={{
              whiteSpace: 'normal',
              lineHeight: 1.25,
              maxWidth: '100%',
              wordBreak: 'break-word',
              marginTop: 2,
            }}
          >
            {vehicleRequestTypeLabels[request.requestType]}
          </Tag>
        </div>
      ),
    },
    {
      key: 'lessorName',
      title: 'Техника',
      width: 210,
      sorter: true,
      render: (_value, request) => (
        <VehicleRequestAssignmentCell
          assignment={request.assignment}
          detail={(assignment) => assignment.lessorName ?? 'Своя техника'}
        />
      ),
    },
    {
      key: 'worked',
      title: 'Отработано',
      width: 130,
      render: (_value, request) =>
        request.completion ? (
          <div style={{ lineHeight: 1.35 }}>
            <div>
              {workedAmountLabel(request.completion.workedUnit, request.completion.workedAmount)}
            </div>
            {request.completion.rate != null && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                по {formatMoney(request.completion.rate)}
              </Typography.Text>
            )}
          </div>
        ) : (
          dash
        ),
    },
    {
      key: 'totalCost',
      title: 'Стоимость',
      width: 150,
      sorter: true,
      align: 'right',
      render: (_value, request) =>
        request.completion?.totalCost != null ? (
          <Typography.Text strong>{formatMoney(request.completion.totalCost)}</Typography.Text>
        ) : (
          dash
        ),
    },
    {
      key: 'approval',
      title: 'Подтвердили',
      width: 220,
      sorter: true,
      render: (_value, request) => (
        <div style={{ lineHeight: 1.35 }}>
          {request.approvedAt ? (
            <Tooltip
              title={`Завизировал ${request.approvedByName ?? '—'} · ${formatDate(request.approvedAt)}`}
            >
              <Space size={4}>
                <CheckCircleOutlined style={{ color: '#52c41a' }} />
                <span>{request.approvedByName ?? '—'}</span>
              </Space>
            </Tooltip>
          ) : (
            <Typography.Text type="secondary">без визы</Typography.Text>
          )}
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {request.assignment
                ? `назначил ${request.assignment.assignedByName || '—'}`
                : 'не назначалась'}
            </Typography.Text>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      title: 'Чем закончилась',
      dataIndex: 'status',
      width: 165,
      sorter: true,
      render: (_value, request) => (
        <div style={{ lineHeight: 1.35 }}>
          <Tooltip
            title={request.cancelReason ? `Причина отмены: ${request.cancelReason}` : undefined}
          >
            <Tag color={requestStatusColors[request.status]} style={{ marginInlineEnd: 0 }}>
              {requestStatusLabels[request.status]}
            </Tag>
          </Tooltip>
          {request.completion && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatDate(request.completion.completedAt)} ·{' '}
                {request.completion.completedByName || '—'}
              </Typography.Text>
            </div>
          )}
        </div>
      ),
    },
    actionsColumn<VehicleRequestDto>(
      (request) => (
        <RowActionButton
          title="Открыть карточку"
          icon={<EyeOutlined />}
          onClick={() => onOpen(request)}
        />
      ),
      70,
    ),
  ];
}
