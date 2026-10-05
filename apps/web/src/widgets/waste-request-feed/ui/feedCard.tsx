import type { ReactNode } from 'react';
import { Tag } from 'antd';
import { DeleteOutlined, EditOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  containerOwnerMismatch,
  requestTypeLabels,
  wasteRequestCommentLines,
  wasteSubjectLabel,
  type WasteRequestDto,
} from '@technic/contracts';
import { FilesCell } from '@entities/file';
import { formatDateTimeMaybe } from '@entities/request';
import { wasteAmountLine, wasteWeightFactLine } from '@entities/waste-request';
import type { ActionSheetItem, CardConfig } from '@shared/ui';
import type {
  WasteRequestFeedActions,
  WasteRequestFeedPending,
  WasteRequestFeedRights,
} from '../model/types';
import { WasteCommentCell, WasteStatusCell } from './feedCells';

/**
 * Phone card of a waste request (ADR 0030). It is read top to bottom: what request and in what
 * status, on which object, what is hauled and at what price, when and by whom. Actions are a list
 * with captions, because icon tooltips stay silent on touch.
 */
export function wasteRequestFeedCard({
  actions,
  pending,
  rights,
}: {
  actions: WasteRequestFeedActions;
  pending: WasteRequestFeedPending;
  rights: WasteRequestFeedRights;
}): CardConfig<WasteRequestDto> {
  const lines: ((request: WasteRequestDto) => ReactNode)[] = [
    (request) => requestTypeLabels[request.requestType],
    // The subject as a line; scrap removal has none (ADR 0067), and the dash there is not a card
    // line but its absence: the card drops null lines itself.
    (request) => {
      const subject = [wasteSubjectLabel(request), request.wasteTypeName]
        .filter(Boolean)
        .join(' · ');
      return subject === '—' ? null : subject;
    },
    // A foreign container is its own line: the desktop tag beside the subject is not visible on a
    // phone, and whoever looks at the request from the site needs this mismatch most (ADR 0054).
    (request) =>
      containerOwnerMismatch(request)
        ? `Контейнер установил «${request.containerOwnerName ?? '—'}»`
        : null,
    // A missing tariff is named by the same text as in the table (ADR 0046): the card has no line
    // colour, but it must not stay silent about an uncalculated amount.
    (request) => wasteAmountLine(request)?.text ?? wasteWeightFactLine(request),
    (request) =>
      `Доставка: ${formatDateTimeMaybe(request.deliveryAt, request.deliveryTimeUnspecified)}`,
    // The operator is not shown to an operator: every request in its list is its own (ADR 0010).
    (request) =>
      rights.isOperator || !request.operatorName ? null : `Оператор: ${request.operatorName}`,
    // Desktop uses the status tooltip; touch devices need the cancellation reason as a real row.
    (request) => (request.cancelReason ? `Причина отмены: ${request.cancelReason}` : null),
    // Both comment sides (ADR 0053), uncollapsed: the card has room. An empty comment returns null
    // rather than an empty component, so the card drops the line itself.
    (request) =>
      wasteRequestCommentLines(request).length > 0 ? <WasteCommentCell request={request} /> : null,
    (request) => (request.files.length > 0 ? <FilesCell files={request.files} /> : null),
    (request) => (request.deletedAt ? <Tag>в архиве</Tag> : null),
  ];

  const rowActions = (request: WasteRequestDto): ActionSheetItem[] => {
    const view: ActionSheetItem = {
      key: 'view',
      label: 'Открыть карточку',
      icon: <EyeOutlined />,
      onClick: () => actions.open(request),
    };
    if (request.deletedAt) {
      return rights.canRestore
        ? [
            view,
            {
              key: 'restore',
              label: 'Восстановить',
              icon: <ReloadOutlined />,
              onClick: () => actions.restore(request),
            },
          ]
        : [view];
    }
    // A role that does not manage requests at all (observer, operator) gets no edit/delete items:
    // a disabled item reads as "not now", while for this role it is "never".
    if (!rights.canEdit && !rights.canDelete) return [view];
    const allowed = actions.canModify(request);
    return [
      view,
      {
        key: 'edit',
        label: 'Редактировать',
        icon: <EditOutlined />,
        disabled: !allowed,
        onClick: () => actions.edit(request),
      },
      {
        key: 'delete',
        label: request.status === 'new' ? 'Удалить' : 'Переместить в архив',
        icon: <DeleteOutlined />,
        danger: true,
        disabled: !allowed,
        onClick: () => actions.remove(request),
      },
    ];
  };

  return {
    title: (request) => `№ ${request.displayNumber}`,
    badge: (request) => (
      <WasteStatusCell
        request={request}
        pending={pending.statusRequestId === request.id}
        onChange={actions.changeStatus}
      />
    ),
    primary: (request) => request.objectName,
    lines,
    onOpen: actions.open,
    actions: rowActions,
  };
}
