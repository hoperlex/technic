import type { ReactNode } from 'react';
import { Tag } from 'antd';
import {
  DeleteOutlined,
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

/**
 * Phone card of a feed row (ADR 0030). Orders and weeks render their own line sets rather than a
 * common one: the two documents share only the number and the site. Both sets are concatenated into
 * one list because a row belongs to exactly one document kind, so the other kind's lines return
 * null and are skipped.
 */
export function vehicleRequestFeedCard({
  actions,
  pending,
  rights,
}: {
  actions: VehicleRequestFeedActions;
  pending: VehicleRequestFeedPending;
  rights: VehicleRequestFeedRights;
}): CardConfig<VehicleRequestFeedRow> {
  // Order lines answer what was ordered and when, what took it and at what rate. Approval is a
  // button right in the card: for the construction manager it is the main action of this list, and
  // hiding it in the action sheet would add two taps to it.
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
    // The same route and the same "lost request" warning as the desktop "Маршрут" column. The
    // number is a real link, not text: the card takes the tap for itself only where no link is
    // under the finger (opensRow), so one gesture never means two different things. The route is
    // also duplicated as an action-sheet item because a full-width item is easier to hit than a
    // number inside a line; the link stays for Ctrl-click and a neighbouring browser tab.
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

  // The same lines the weekly request had in its own former list: site, composition in words,
  // pending approval, cancellation reason and author. The composition is counted, not listed: ten
  // vehicles on a phone would be a screen of scrolling for one list row.
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
    /*
     * The route is an action-sheet item, not only a link inside a card line: a full-width item is
     * easier to hit with a finger than a number inside text. The number in the label lets the user
     * check it is the expected route before tapping.
     *
     * The right is asked through the link address (routeLink returns null without it), not through
     * a separate condition: where the number stays plain text there must be no item either,
     * otherwise the route window would open where links are not shown. The item lives in every
     * branch, including the archived one: an archived request still had its route, and "what did it
     * travel in" is asked about archived requests more often than about live ones.
     */
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

    // Equipment change has its own right (ADR 0048), so it is offered in the short lessor branch
    // below as well: a lessor cannot edit the request but swaps its own vehicle.
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
    // Machinist change sits next to equipment change: the same decision about the request, only
    // about the person rather than the vehicle.
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
    // History repair sits next to machinist change: the same assignment history, but about its
    // gaps.
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
    // A role without the right to manage requests (an observer, a lessor) gets no edit/delete
    // items: a disabled item reads as "not now", while for this role it is "never".
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
        icon: <DeleteOutlined />,
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
    // The department is shown by the same code as in the desktop column: there is no hover hint on
    // a phone, but one customer must never get two different captions. For a week the primary line
    // is the week itself, since that is what the document is named by.
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
