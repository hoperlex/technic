import { useState } from 'react';
import { App, Button, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  routePurposeLabels,
  routePurposeShortLabels,
  type VehicleRequestDto,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { vehicleRouteKeys, vehicleRoutesApi } from '@entities/vehicle-route';
import { garageKeys } from '@entities/garage';
import { EntityLink } from '@shared/ui';
import { useAuth } from '@entities/session';
import { vehicleRouteErrorMessage as errorMessage } from '@entities/vehicle-route';
import { vehicleRouteLink } from '@entities/vehicle-route';
import { useRouteModal } from '@features/route-modal';
import { formatDateOnly } from '@shared/lib';
import { VehicleRelocationModal } from './VehicleRelocationModal';

/**
 * Request relocations shown inside the editor: delivery to and pickup from the site (migration 0082).
 *
 * Relocations are maintained here because they are corrected exactly when the request itself is
 * opened: the equipment went on a carrier, the date moved, the pickup was created on the wrong
 * request. Previously a wrong relocation could only be removed from the route tab, by number.
 *
 * At most one route per purpose — the server enforces it (`createRelocationRoute`) — so only the
 * missing purposes are offered. Zero is a normal state: the portal does not track the delivery
 * method, and the equipment may arrive on a carrier without any waybill.
 *
 * Actions apply immediately, not on "Save": a relocation is a separate route, not a request field.
 * The block says so, otherwise the person would expect closing the dialog unsaved to undo it.
 *
 * The display number opens the route modal (ADR 0120, `docs/vehicle-routes-modal-plan.md` §1,
 * stage 3) so the route and its 4-P waybill are handled on top of the form, without abandoning the
 * request edit.
 */

const PURPOSES = ['delivery', 'pickup'] as const;

interface Props {
  /** Confirmed request with assigned company equipment; callers hide the block otherwise. */
  request: VehicleRequestDto;
}

export function RequestRelocationsField({ request }: Props) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const { openRoute } = useRouteModal();
  const qc = useQueryClient();
  const [adding, setAdding] = useState<(typeof PURPOSES)[number] | null>(null);

  // Share the request-card query key so an already loaded relocation list is reused.
  const { data: relocations, isFetching } = useQuery({
    queryKey: vehicleRequestKeys.relocations(request.id),
    queryFn: () => vehicleRequestsApi.relocations(request.id),
  });

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: vehicleRequestKeys.relocations(request.id) }),
      qc.invalidateQueries({ queryKey: vehicleRouteKeys.root }),
      qc.invalidateQueries({ queryKey: vehicleRequestKeys.root }),
      qc.invalidateQueries({ queryKey: garageKeys.root }),
    ]);
  };

  const remove = useMutation({
    mutationFn: (routeId: string) => vehicleRoutesApi.remove(routeId),
    onSuccess: async () => {
      message.success('Перегон убран');
      await refresh();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmRemove = (routeId: string, displayNumber: string) =>
    modal.confirm({
      title: `Убрать перегон ${displayNumber}?`,
      content: 'Рейс удалится целиком. Завести его заново можно тут же — датой и водителем.',
      okText: 'Убрать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => remove.mutateAsync(routeId),
    });

  const existing = relocations ?? [];
  const missing = PURPOSES.filter((purpose) => !existing.some((r) => r.purpose === purpose));

  return (
    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        Перегон — отдельный рейс с путевым листом 4-П, и правки здесь применяются сразу, не
        дожидаясь «Сохранить». Технику везут тралом — перегона не заводят вовсе.
      </Typography.Text>

      {existing.length === 0 && !isFetching && (
        <Typography.Text type="secondary">Перегонов нет</Typography.Text>
      )}

      {existing.map((route) => {
        // Any issued waybill keeps the route in the strict-reporting journal permanently, even a
        // cancelled one (the server refuses with the same answer). Such a route is corrected by
        // cancelling the waybill and editing the route in its card.
        const documented = !!route.waybill;
        return (
          <Space key={route.id} size={8} wrap>
            <Tag color={route.purpose === 'delivery' ? 'blue' : 'gold'}>
              {routePurposeShortLabels[route.purpose]}
            </Tag>
            {/* The link and the delete button are siblings, not nested: `EntityLink` suppresses only
                its own navigation (`preventDefault` on a plain left click) and lets the event
                bubble, so nesting would let one click reach `confirmRemove` or vice versa. Without
                route access the number stays plain text. */}
            <EntityLink
              to={vehicleRouteLink(can, route.id)}
              title="Открыть маршрут"
              onActivate={() => openRoute(route.id)}
            >
              {route.displayNumber}
            </EntityLink>
            <Typography.Text type="secondary">
              {formatDateOnly(route.routeDate)} · {route.moveFrom} → {route.moveTo}
              {route.driverName ? ` · ${route.driverName}` : ' · водитель не назначен'}
            </Typography.Text>
            {route.waybill && (
              <Tag color={waybillStatusColors[route.waybill.status]}>
                {route.waybill.number} · {waybillStatusLabels[route.waybill.status]}
              </Tag>
            )}
            <span
              title={
                documented
                  ? 'По перегону выписывался путевой лист — рейс остаётся в журнале бланков'
                  : undefined
              }
            >
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={documented || remove.isPending}
                aria-label={`Убрать перегон ${route.displayNumber}`}
                onClick={() => confirmRemove(route.id, route.displayNumber)}
              />
            </span>
          </Space>
        );
      })}

      {missing.length > 0 && (
        <Space size={8} wrap>
          {missing.map((purpose) => (
            <Button
              key={purpose}
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setAdding(purpose)}
            >
              {routePurposeLabels[purpose]}
            </Button>
          ))}
        </Space>
      )}

      <VehicleRelocationModal
        request={adding ? request : null}
        purpose={adding ?? 'delivery'}
        onClose={() => setAdding(null)}
        onDone={() => {
          setAdding(null);
          void refresh();
        }}
      />
    </Space>
  );
}
