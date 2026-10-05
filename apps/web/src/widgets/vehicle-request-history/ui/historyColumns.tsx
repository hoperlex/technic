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

/**
 * Desktop columns for the closed-request journal. A column key doubles as the server sort field
 * (VEHICLE_REQUEST_SORT_FIELDS), so renaming one silently breaks sorting.
 */
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
      // The journal is ordered by work term, not by closing date: "when was the equipment on site"
      // is what it is reconciled against timesheets and invoices by.
      key: 'term',
      title: 'Когда',
      width: 175,
      sorter: true,
      defaultSortOrder: 'descend',
      render: (_value, request) => historyTerm(request),
    },
    // The request customer: object or department (ADR 0040). One column for both axes because a
    // request has one customer and a second column would be empty in every row. Sorting stays on
    // objectName because the column key is the server sort field.
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
          {/* Ordered classifier position (ADR 0028): the category, or the type without one. */}
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
      // What worked and who it was rented from. The lessor goes on the second line: rental costs
      // are grouped by it, and an own vehicle says so in the same place. Rates are not needed here:
      // the journal has "Worked" and "Cost", the closing fact rather than the assignment.
      //
      // The cell is the request list's VehicleRequestAssignmentCell: the "Vehicle" column is one
      // across all tabs and must keep the same row height.
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
      // "For how long" by fact, not by order: three days ordered, one and a half shifts worked.
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
      // "Who confirmed" is two different signatures: the construction manager approved the order
      // itself (ADR 0025), the dispatcher took it into work with a concrete vehicle and price
      // (ADR 0027). The journal needs both: one tells whom to ask about the order, the other about
      // the price.
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
          {/* The cancel reason is a tooltip on the tag: there is no column for it, and without it a
              cancelled journal row does not answer "why didn't they go". */}
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
        // The card is the only place with addresses, files and the full chronology (ADR 0015). The
        // row answers "what happened", the card "how it came to that".
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
