import { Button, Space, Tag, Typography } from 'antd';
import {
  completionLabel,
  type Permission,
  type RequestWaybillDto,
  routePurposeLabels,
  routePurposeShortLabels,
  type VehicleRequestDto,
  type VehicleRouteDto,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { vehicleRouteLink } from '@entities/vehicle-route';
import { PrintWaybillButton, waybillLink } from '@entities/waybill';
import { formatDateOnly, formatDateTime, formatMoney } from '@shared/lib';
import { EntityLink, type ViewField, UserAvatar } from '@shared/ui';

interface ExecutionFieldOptions {
  request: VehicleRequestDto;
  asksRelocations: boolean;
  can: (permission: Permission) => boolean;
  onIssueEsm2?: (request: VehicleRequestDto) => void;
  onRelocate?: (request: VehicleRequestDto, purpose: 'delivery' | 'pickup') => void;
  openedRouteId: string | null;
  openRoute: (routeId: string) => void;
  relocations: VehicleRouteDto[] | undefined;
  waybills: RequestWaybillDto[] | undefined;
}

/** Fields describing issued documents, relocations, completion and audit metadata. */
export function requestExecutionFields({
  request,
  asksRelocations,
  can,
  onIssueEsm2,
  onRelocate,
  openedRouteId,
  openRoute,
  relocations,
  waybills,
}: ExecutionFieldOptions): ViewField[] {
  return [
    ...((waybills && waybills.length > 0) || onIssueEsm2
      ? [
          {
            key: 'waybills',
            label: (waybills?.length ?? 0) > 1 ? 'Путевые листы' : 'Путевой лист',
            full: true,
            children: (
              <Space orientation="vertical" size={4}>
                {(waybills ?? []).map((waybill) => (
                  <Space key={waybill.id} size={8} wrap>
                    {waybill.periodFrom && waybill.periodTo && (
                      <Tag>
                        {formatDateOnly(waybill.periodFrom)} — {formatDateOnly(waybill.periodTo)}
                      </Tag>
                    )}
                    <EntityLink
                      to={waybillLink(can, waybill.number)}
                      title="Открыть в журнале листов"
                    >
                      {waybill.number}
                    </EntityLink>
                    <Tag color={waybillStatusColors[waybill.status]}>
                      {waybillStatusLabels[waybill.status]}
                    </Tag>
                    <Typography.Text type="secondary">
                      {waybill.driverName}
                      {waybill.periodFrom ? '' : ` · строка ${waybill.slot}`}
                    </Typography.Text>
                    <PrintWaybillButton
                      waybillId={waybill.id}
                      number={waybill.number}
                      status={waybill.status}
                    >
                      Печать
                    </PrintWaybillButton>
                  </Space>
                ))}
                {onIssueEsm2 && (
                  <Space size={8} wrap>
                    {(waybills?.length ?? 0) === 0 && (
                      <Typography.Text type="secondary">
                        Листов нет — по этой заявке их выписывают по требованию
                      </Typography.Text>
                    )}
                    <Button size="small" onClick={() => onIssueEsm2(request)}>
                      Выписать ЭСМ-2
                    </Button>
                  </Space>
                )}
              </Space>
            ),
          },
        ]
      : []),
    ...(asksRelocations && (onRelocate || (relocations && relocations.length > 0))
      ? [
          {
            key: 'relocations',
            label: 'Перегон техники',
            full: true,
            children: (
              <Space orientation="vertical" size={4}>
                {(relocations ?? []).map((route) => (
                  <Space key={route.id} size={8} wrap>
                    <Tag color={route.purpose === 'delivery' ? 'blue' : 'gold'}>
                      {routePurposeShortLabels[route.purpose]}
                    </Tag>
                    <span>
                      {route.id === openedRouteId ? (
                        route.displayNumber
                      ) : (
                        <EntityLink
                          to={vehicleRouteLink(can, route.id)}
                          title="Открыть маршрут"
                          onActivate={() => openRoute(route.id)}
                        >
                          {route.displayNumber}
                        </EntityLink>
                      )}
                    </span>
                    <Typography.Text type="secondary">
                      {formatDateOnly(route.routeDate)} · {route.moveFrom} → {route.moveTo}
                    </Typography.Text>
                    {route.waybill ? (
                      <>
                        <Tag color={waybillStatusColors[route.waybill.status]}>
                          {route.waybill.number}
                        </Tag>
                        <PrintWaybillButton
                          waybillId={route.waybill.id}
                          number={route.waybill.number}
                          status={route.waybill.status}
                        >
                          Печать
                        </PrintWaybillButton>
                      </>
                    ) : (
                      <Typography.Text type="secondary">
                        лист не выписан — выпишите его в карточке маршрута
                      </Typography.Text>
                    )}
                  </Space>
                ))}
                {onRelocate && (
                  <Space size={8} wrap>
                    {(['delivery', 'pickup'] as const)
                      .filter((purpose) => !relocations?.some((route) => route.purpose === purpose))
                      .map((purpose) => (
                        <Button
                          key={purpose}
                          size="small"
                          onClick={() => onRelocate(request, purpose)}
                        >
                          {routePurposeLabels[purpose]}
                        </Button>
                      ))}
                  </Space>
                )}
              </Space>
            ),
          },
        ]
      : []),
    ...(request.completion
      ? [
          {
            key: 'completion',
            label: 'Выполнение',
            full: true,
            children: (
              <Space orientation="vertical" size={2}>
                <Space size={8} wrap>
                  <Typography.Text strong>
                    {formatMoney(request.completion.totalCost)}
                  </Typography.Text>
                  <Typography.Text>{completionLabel(request.completion)}</Typography.Text>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Закрыл {request.completion.completedByName || '—'} ·{' '}
                  {formatDateTime(request.completion.completedAt)}
                </Typography.Text>
              </Space>
            ),
          },
        ]
      : []),
    {
      key: 'author',
      label: 'Автор',
      children: (
        <Space size={8}>
          <UserAvatar name={request.createdByName} size="small" />
          <span>{request.createdByName}</span>
        </Space>
      ),
    },
    { key: 'createdAt', label: 'Создана', children: formatDateTime(request.createdAt) },
    ...(request.cancelReason
      ? [
          {
            key: 'cancelReason',
            label: 'Причина отмены',
            full: true,
            children: request.cancelReason,
          },
        ]
      : []),
    { key: 'comment', label: 'Комментарий', full: true, children: request.comment || '—' },
  ];
}
