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
    /*
     * Waybills (ADR 0037, printing ADR 0041). The row appears only once a waybill is issued:
     * rentals have none at all, and "Waybill: -" on such a request would read as a forgotten
     * document. The number next to the button is not decoration: the waybill is looked up by it in
     * the journal and on paper.
     *
     * An on-site equipment order has as many waybills as weeks in its term (ESM-2): each is
     * labelled with its week, otherwise identical-looking numbers could not be told apart when
     * choosing which to print. Cancelled ones stay in the list, so a burnt number is visible where
     * it was issued.
     *
     * A linear order shows the row even when empty: it may have no waybills at all (the portal does
     * not issue them), but the missing one has to be issued from somewhere (ADR 0100 decision 6).
     *
     * Printing stays available in the read-only overlay too (ADR 0120 item 7, decided explicitly):
     * printing paper is reading, the dispatcher who opened the route already has waybills.read, and
     * taking it away would send them to the journal for the same form.
     */
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
                    {/* A cancelled waybill cannot be printed from here or from the journal: the
                        number is written off and the paper is indistinguishable from a valid form.
                        The button stays disabled with an explanation; a vanished one would read as
                        a bug. */}
                    <PrintWaybillButton
                      waybillId={waybill.id}
                      number={waybill.number}
                      status={waybill.status}
                    >
                      Печать
                    </PrintWaybillButton>
                  </Space>
                ))}
                {/* On-demand issue (ADR 0100): for a linear order the waybill is born only by
                    this button. An empty list on such a request is not a gap, and that is said in
                    words, otherwise it would read as a forgotten document. */}
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
    /*
     * Relocations (migration 0082): how and when the equipment was brought to the site and taken
     * away. The row appears only once a relocation exists: there may be none (equipment travels on
     * a low-loader), and "Relocation: -" would read as a forgotten document.
     */
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
                    {/* A relocation is a route like a working one and opens in the same window over
                        the card: its waybill is issued from the route card, which is exactly where
                        the hint below sends the user. The route this card was opened over stays
                        plain text (openedRouteId). */}
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
                {/* A relocation is offered, not required: equipment may arrive on a low-loader,
                    and then there is no waybill at all. An already created one is not offered
                    again: delivery and pickup happen once per request. */}
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
    /*
     * Completion fact (ADR 0029): "how much was worked and what it cost". Only a request closed by
     * a fact has it: a cancelled one never does, and for older completed ones it cannot be
     * restored.
     */
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
