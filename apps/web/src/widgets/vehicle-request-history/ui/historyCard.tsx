import { EyeOutlined } from '@ant-design/icons';
import { Tag } from 'antd';
import {
  assignmentTitle,
  requestCustomerLabel,
  requestStatusColors,
  requestStatusLabels,
  type VehicleRequestDto,
  vehicleClassificationLabel,
  vehicleRequestTypeLabels,
  workedAmountLabel,
} from '@technic/contracts';
import { formatDate, formatMoney } from '@shared/lib';
import type { CardConfig } from '@shared/ui';
import { historyTerm } from './historyTerm';

/**
 * Journal row on a phone (ADR 0030): how the request ended and what it cost come first, since those
 * two numbers are why the journal is opened. Term, customer, vehicle and both signatures follow.
 */
export function historyCard(
  onOpen: (request: VehicleRequestDto) => void,
): CardConfig<VehicleRequestDto> {
  return {
    title: (request) => request.displayNumber,
    badge: (request) => (
      <Tag color={requestStatusColors[request.status]} style={{ marginInlineEnd: 0 }}>
        {requestStatusLabels[request.status]}
      </Tag>
    ),
    primary: (request) =>
      request.completion?.totalCost != null
        ? formatMoney(request.completion.totalCost)
        : 'Без суммы',
    lines: [
      (request) => requestCustomerLabel(request).text,
      (request) =>
        `${vehicleClassificationLabel({
          typeName: request.vehicleTypeName,
          categoryName: request.vehicleCategoryName,
        })} · ${vehicleRequestTypeLabels[request.requestType]}`,
      historyTerm,
      (request) =>
        request.assignment
          ? `${assignmentTitle(request.assignment)} · ${request.assignment.lessorName ?? 'Своя техника'}`
          : null,
      (request) =>
        request.completion
          ? `Отработано: ${workedAmountLabel(
              request.completion.workedUnit,
              request.completion.workedAmount,
            )}${
              request.completion.rate != null ? ` по ${formatMoney(request.completion.rate)}` : ''
            }`
          : null,
      (request) => (request.cancelReason ? `Причина отмены: ${request.cancelReason}` : null),
      (request) =>
        request.approvedAt
          ? `Завизировал ${request.approvedByName ?? '—'} · ${formatDate(request.approvedAt)}`
          : 'Без визы',
      (request) =>
        request.completion
          ? `Закрыл ${request.completion.completedByName || '—'} · ${formatDate(
              request.completion.completedAt,
            )}`
          : null,
    ],
    onOpen,
    actions: (request) => [
      {
        key: 'view',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => onOpen(request),
      },
    ],
  };
}
