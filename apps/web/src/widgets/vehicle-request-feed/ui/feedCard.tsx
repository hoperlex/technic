import type { ReactNode } from 'react';
import { Tag } from 'antd';
import {
  EditOutlined,
  EyeOutlined,
  FieldTimeOutlined,
  NodeIndexOutlined,
  ReloadOutlined,
  SwapOutlined,
  ToolOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import {
  assignmentRateLabel,
  assignmentTitle,
  vehicleClassificationLabel,
  vehicleRequestTypeLabels,
  type VehicleRequestDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { FilesCell } from '@entities/file';
import { requestCustomerLabel } from '@technic/contracts';
import { vehicleRequestTermLabel } from '@entities/vehicle-request';
import { WeeklyStatusTag, weeklyCountsText } from '@entities/weekly-request';
import { formatDateTime } from '@shared/lib';
import { EntityLink, type ActionSheetItem, type CardConfig } from '@shared/ui';
import type {
  VehicleRequestFeedActions,
  VehicleRequestFeedPending,
  VehicleRequestFeedRights,
  VehicleRequestFeedRow,
} from '../model/types';
import { ApprovalCell, StatusCell } from './orderStateCells';

/** Mobile cards expose the same information and commands as desktop rows without a wide table. */
export function vehicleRequestFeedCard({
  actions,
  pending,
  rights,
}: {
  actions: VehicleRequestFeedActions;
  pending: VehicleRequestFeedPending;
  rights: VehicleRequestFeedRights;
}): CardConfig<VehicleRequestFeedRow> {
  const orderLines: ((request: VehicleRequestDto) => ReactNode)[] = [
    (request) =>
      `${vehicleClassificationLabel({
        typeName: request.vehicleTypeName,
        categoryName: request.vehicleCategoryName,
      })} · ${vehicleRequestTypeLabels[request.requestType]}`,
    (request) => `Срок: ${vehicleRequestTermLabel(request)}`,
    (request) =>
      request.assignment
        ? `${assignmentTitle(request.assignment)} · ${assignmentRateLabel(request.assignment) || request.assignment.lessorName || 'без ставки'}`
        : null,
    // Route is both a real link (including Ctrl-click) and an action-sheet item with a larger
    // touch target. DataTable suppresses the card open gesture when the link itself is activated.
    (request) => {
      const route = request.route;
      if (route) {
        return (
          <>
            Маршрут{' '}
            <EntityLink
              to={actions.routeLink(route.id)}
              title="Открыть маршрут"
              onActivate={() => actions.openRoute(route.id)}
            >
              {route.displayNumber}
            </EntityLink>{' '}
            · строка {route.position}
          </>
        );
      }
      return request.status === 'confirmed' &&
        request.requestType === 'freight_transport' &&
        request.assignment?.ownership === 'own' ? (
        <Tag color="orange">Без маршрута</Tag>
      ) : null;
    },
    (request) => (request.cancelReason ? `Причина отмены: ${request.cancelReason}` : null),
    (request) => request.comment || null,
    (request) => (
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
    ),
    (request) => (request.files.length > 0 ? <FilesCell files={request.files} /> : null),
    (request) => (request.deletedAt ? <Tag>в архиве</Tag> : null),
  ];

  // A composition is summarized instead of listing ten vehicles in a single phone card.
  const weeklyLines: ((weekly: WeeklyVehicleRequestDto) => ReactNode)[] = [
    (weekly) => weekly.objectName,
    (weekly) => weeklyCountsText(weekly.counts),
    (weekly) => (weekly.status === 'pending' ? 'Ждёт визы' : null),
    (weekly) => (weekly.cancelReason ? `Причина снятия: ${weekly.cancelReason}` : null),
    (weekly) => `${weekly.createdByName} · ${formatDateTime(weekly.createdAt)}`,
  ];

  const orderActions = (request: VehicleRequestDto): ActionSheetItem[] => {
    const view: ActionSheetItem = {
      key: 'view',
      label: 'Открыть карточку',
      icon: <EyeOutlined />,
      onClick: () => actions.openOrder(request),
    };
    const route = request.route;
    const routeActions: ActionSheetItem[] =
      route && actions.routeLink(route.id)
        ? [
            {
              key: 'route',
              label: `Открыть маршрут ${route.displayNumber}`,
              icon: <NodeIndexOutlined />,
              onClick: () => actions.openRoute(route.id),
            },
          ]
        : [];
    if (request.deletedAt) {
      return rights.canRestore
        ? [
            view,
            ...routeActions,
            {
              key: 'restore',
              label: 'Восстановить',
              icon: <ReloadOutlined />,
              onClick: () => actions.restore(request),
            },
          ]
        : [view, ...routeActions];
    }

    const reassign: ActionSheetItem[] = actions.canReassign(request)
      ? [
          {
            key: 'reassign',
            label: 'Сменить технику',
            icon: <SwapOutlined />,
            onClick: () => actions.reassign(request),
          },
        ]
      : [];
    const machinist: ActionSheetItem[] = actions.canChangeMachinist(request)
      ? [
          {
            key: 'machinist',
            label: 'Сменить машиниста',
            icon: <UserSwitchOutlined />,
            onClick: () => actions.changeMachinist(request),
          },
        ]
      : [];
    const repair: ActionSheetItem[] = actions.canRepairHistory(request)
      ? [
          {
            key: 'history-repair',
            label: 'Починка истории',
            icon: <ToolOutlined />,
            onClick: () => actions.repairHistory(request),
          },
        ]
      : [];
    if (!rights.canEdit && !rights.canDelete) {
      return [view, ...routeActions, ...reassign, ...machinist, ...repair];
    }

    return [
      view,
      ...routeActions,
      ...reassign,
      ...machinist,
      ...repair,
      ...(actions.canDecideEarlyEnd(request)
        ? [
            {
              key: 'approve-early-end',
              label: 'Согласовать досрочное завершение',
              icon: <FieldTimeOutlined />,
              onClick: () => actions.approveEarlyEnd(request),
            },
            {
              key: 'reject-early-end',
              label: 'Отклонить досрочное завершение',
              danger: true,
              onClick: () => actions.rejectEarlyEnd(request),
            },
          ]
        : []),
      ...(actions.canRequestEarlyEnd(request)
        ? [
            {
              key: 'early-end',
              label: 'Завершить досрочно',
              icon: <FieldTimeOutlined />,
              onClick: () => actions.requestEarlyEnd(request),
            },
          ]
        : []),
      {
        key: 'edit',
        label: 'Редактировать',
        icon: <EditOutlined />,
        disabled: !actions.canModify(request),
        onClick: () => actions.edit(request),
      },
      {
        key: 'delete',
        label: request.status === 'new' ? 'Удалить' : 'Переместить в архив',
        danger: true,
        disabled: !actions.canModify(request),
        onClick: () => actions.remove(request),
      },
    ];
  };

  return {
    title: (row) => (row.kind === 'weekly' ? row.weekly.displayNumber : row.order.displayNumber),
    badge: (row) => {
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
    primary: (row) =>
      row.kind === 'weekly' ? row.weekly.weekLabel : requestCustomerLabel(row.order).text,
    lines: [
      ...weeklyLines.map(
        (line) => (row: VehicleRequestFeedRow) => (row.kind === 'weekly' ? line(row.weekly) : null),
      ),
      ...orderLines.map(
        (line) => (row: VehicleRequestFeedRow) => (row.kind === 'order' ? line(row.order) : null),
      ),
    ],
    onOpen: (row) =>
      row.kind === 'weekly' ? actions.openWeekly(row.weekly) : actions.openOrder(row.order),
    actions: (row) =>
      row.kind === 'weekly'
        ? [
            {
              key: 'open-weekly',
              label: 'Открыть неделю',
              icon: <EyeOutlined />,
              onClick: () => actions.openWeekly(row.weekly),
            },
          ]
        : orderActions(row.order),
  };
}
