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

/** Mobile cards expose the same record and commands without reproducing the desktop table. */
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
    (request) => {
      const subject = [wasteSubjectLabel(request), request.wasteTypeName]
        .filter(Boolean)
        .join(' · ');
      return subject === '—' ? null : subject;
    },
    // The desktop foreign-owner tag has no room beside the subject on a phone card.
    (request) =>
      containerOwnerMismatch(request)
        ? `Контейнер установил «${request.containerOwnerName ?? '—'}»`
        : null,
    (request) => wasteAmountLine(request)?.text ?? wasteWeightFactLine(request),
    (request) =>
      `Доставка: ${formatDateTimeMaybe(request.deliveryAt, request.deliveryTimeUnspecified)}`,
    (request) =>
      rights.isOperator || !request.operatorName ? null : `Оператор: ${request.operatorName}`,
    // Desktop uses the status tooltip; touch devices need the cancellation reason as a real row.
    (request) => (request.cancelReason ? `Причина отмены: ${request.cancelReason}` : null),
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
