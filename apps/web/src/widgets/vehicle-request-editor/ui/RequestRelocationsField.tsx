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
 * Relocations are maintained here because corrections are usually discovered while editing the
 * request, and the retired route tab should not be required to find an incorrectly created trip.
 *
 * `createRelocationRoute` permits at most one route per purpose. Zero remains valid because portal
 * data does not model whether the equipment arrived on a carrier.
 *
 * Actions apply immediately because a relocation is a separate route, not a draft request field.
 *
 * The display number opens the route modal (ADR 0120) so route details and forms can be handled
 * without abandoning the request edit.
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
        // Any issued waybill keeps the route in the strict-reporting journal permanently. Such a
        // route must be corrected through waybill cancellation and the route card.
        const documented = !!route.waybill;
        return (
          <Space key={route.id} size={8} wrap>
            <Tag color={route.purpose === 'delivery' ? 'blue' : 'gold'}>
              {routePurposeShortLabels[route.purpose]}
            </Tag>
            {/* Keep the route link and delete button as siblings so their independent click
                handling cannot trigger the other action. Without route access, the number remains text. */}
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
