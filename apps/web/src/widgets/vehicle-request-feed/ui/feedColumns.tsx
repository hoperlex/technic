import { Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import {
  assignmentRateLabel,
  requestCustomerLabel,
  vehicleClassificationLabel,
  vehicleRequestTypeColors,
  vehicleRequestTypeLabels,
} from '@technic/contracts';
import { FilesCell } from '@entities/file';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '@entities/object';
import {
  VehicleRequestAssignmentCell,
  VehicleRequestEarlyEndTag,
  vehicleRequestTermLabel,
} from '@entities/vehicle-request';
import { WeeklyStatusTag } from '@entities/weekly-request';
import { formatDate } from '@shared/lib';
import { EntityLink, ExpandableCell, textColumn, UserAvatar } from '@shared/ui';
import type {
  VehicleRequestFeedActions,
  VehicleRequestFeedPending,
  VehicleRequestFeedRights,
  VehicleRequestFeedRow,
} from '../model/types';
import { ApprovalCell, StatusCell } from './orderStateCells';
import { RequestContactsCell } from './requestContactsCell';
import { vehicleRequestFeedActionsColumn } from './feedActionsColumn';
import {
  WeeklyApprovalCell,
  WeeklyCommentCell,
  WeeklyCompositionCell,
  WeeklyContactsCell,
} from './weeklyFeedRow';

const dash = <Typography.Text type="secondary">—</Typography.Text>;

/**
 * One table represents orders and weekly documents. Columns branch on the discriminant because
 * empty weekly fields are meaningful: a weekly document has no classification, route or files.
 */
export function vehicleRequestFeedColumns({
  actions,
  pending,
  rights,
}: {
  actions: VehicleRequestFeedActions;
  pending: VehicleRequestFeedPending;
  rights: VehicleRequestFeedRights;
}): TableColumnType<VehicleRequestFeedRow>[] {
  return [
    {
      key: 'num',
      title: '№',
      width: 190,
      sorter: true,
      // The TС/НЗ prefix already names the document kind, so a second kind badge would duplicate
      // the first thing the user reads.
      render: (_value, row) => {
        const record = row.kind === 'order' ? row.order : row.weekly;
        return (
          <div style={{ lineHeight: 1.35 }}>
            <div>{record.displayNumber}</div>
            <Space size={6}>
              <UserAvatar name={record.createdByName} size={18} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {record.createdByName}
              </Typography.Text>
            </Space>
          </div>
        );
      },
    },
    // Every column has a width: with max-content a single long comment must not stretch the whole
    // table. Object and department share one customer column because every request has one payer.
    textColumn<VehicleRequestFeedRow>({
      key: 'objectName',
      title: 'Заказчик',
      dataIndex: 'objectName',
      searchable: false,
      width: OBJECT_COLUMN_WIDTH,
      render: (_value, row) => {
        if (row.kind === 'weekly') {
          return <ObjectCell name={row.weekly.objectName} address={row.weekly.objectCode} />;
        }
        const customer = requestCustomerLabel(row.order);
        return (
          <ObjectCell name={customer.text} hint={customer.hint} address={row.order.objectAddress} />
        );
      },
    }),
    {
      key: 'vehicleTypeName',
      title: 'Тип/категория',
      width: 200,
      sorter: true,
      render: (_value, row) => {
        if (row.kind === 'weekly') return dash;
        const request = row.order;
        return (
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
            {/* A frozen mode explains why two orders of the same current type behave differently. */}
            {request.requestType === 'special_equipment' && request.linearFrozen ? (
              <Tooltip
                title={`Тип «${request.vehicleTypeName}» переключили после того, как заявку взяли в работу: до закрытия она ведётся так, как заведена`}
              >
                <Tag color="gold" style={{ marginInlineEnd: 0, marginTop: 2 }}>
                  прежний режим: {request.linearFrozen.isLinear ? 'по дням' : 'по неделям'}, с{' '}
                  {formatDate(request.linearFrozen.at)}
                </Tag>
              </Tooltip>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'term',
      title: 'Срок',
      width: 170,
      sorter: true,
      render: (_value, row) => {
        // weekLabel is server-owned; rebuilding a week in the client could promise different days.
        if (row.kind === 'weekly') return row.weekly.weekLabel;
        const request = row.order;
        return (
          <div style={{ lineHeight: 1.35 }}>
            <div>{vehicleRequestTermLabel(request)}</div>
            {request.requestType === 'special_equipment' && (
              <VehicleRequestEarlyEndTag earlyEnd={request.earlyEnd} />
            )}
          </div>
        );
      },
    },
    {
      key: 'assignment',
      title: 'Техника',
      width: 200,
      render: (_value, row) =>
        row.kind === 'weekly' ? (
          <WeeklyCompositionCell weekly={row.weekly} />
        ) : (
          <VehicleRequestAssignmentCell
            assignment={row.order.assignment}
            detail={(assignment) => assignmentRateLabel(assignment) || assignment.lessorName || '—'}
          />
        ),
    },
    {
      key: 'route',
      title: 'Маршрут',
      width: 150,
      render: (_value, row) => {
        if (row.kind === 'weekly') return dash;
        const request = row.order;
        const route = request.route;
        if (route) {
          return (
            <div style={{ lineHeight: 1.35 }}>
              <div>
                <EntityLink
                  to={actions.routeLink(route.id)}
                  title="Открыть маршрут"
                  onActivate={() => actions.openRoute(route.id)}
                >
                  {route.displayNumber}
                </EntityLink>
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                строка {route.position}
                {route.hasWaybill ? ' · лист выписан' : ''}
              </Typography.Text>
            </div>
          );
        }
        // A confirmed own-fleet freight order without a route is operationally lost: no route can
        // issue its waybill, so the empty value must be a warning rather than a neutral dash.
        const lost =
          request.status === 'confirmed' &&
          request.requestType === 'freight_transport' &&
          request.assignment?.ownership === 'own';
        return lost ? <Tag color="orange">Без маршрута</Tag> : dash;
      },
    },
    {
      key: 'status',
      title: 'Статус',
      width: 150,
      sorter: true,
      render: (_value, row) => {
        if (row.kind === 'weekly') return <WeeklyStatusTag status={row.weekly.status} />;
        const request = row.order;
        return (
          <StatusCell
            status={request.status}
            deleted={!!request.deletedAt}
            approved={!!request.approvedAt}
            cancelReason={request.cancelReason}
            pending={pending.statusRequestId === request.id}
            onChange={(status) => actions.changeStatus(request, status)}
          />
        );
      },
    },
    {
      key: 'approval',
      title: 'Согласование',
      width: 160,
      sorter: true,
      render: (_value, row) => {
        if (row.kind === 'weekly') return <WeeklyApprovalCell weekly={row.weekly} />;
        const request = row.order;
        return (
          <ApprovalCell
            status={request.status}
            deleted={!!request.deletedAt}
            approved={!!request.approvedAt}
            approvedByName={request.approvedByName}
            approvedAt={request.approvedAt}
            canApprove={rights.canApprove}
            pending={pending.approvalRequestId === request.id}
            onChange={(approved) => actions.changeApproval(request, approved)}
          />
        );
      },
    },
    {
      key: 'contacts',
      title: 'Контактные данные',
      width: 260,
      render: (_value, row) =>
        row.kind === 'weekly' ? (
          <WeeklyContactsCell weekly={row.weekly} />
        ) : (
          <RequestContactsCell request={row.order} />
        ),
    },
    textColumn<VehicleRequestFeedRow>({
      key: 'comment',
      title: 'Комментарий',
      dataIndex: 'comment',
      width: 260,
      render: (_value, row) => {
        if (row.kind === 'weekly') return <WeeklyCommentCell weekly={row.weekly} />;
        const text = row.order.comment;
        return text.trim() ? (
          <ExpandableCell>
            <span style={{ whiteSpace: 'pre-line' }}>{text}</span>
          </ExpandableCell>
        ) : (
          dash
        );
      },
    }),
    {
      key: 'files',
      title: 'Файлы',
      width: 110,
      render: (_value, row) =>
        row.kind === 'weekly' ? dash : <FilesCell files={row.order.files} />,
    },
    vehicleRequestFeedActionsColumn({ actions, rights }),
  ];
}
