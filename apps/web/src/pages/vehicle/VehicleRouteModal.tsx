import { useState } from 'react';
import { Alert, App, Button, Descriptions, Space, Tag, Typography } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canIssueWaybill,
  isRouteEditable,
  isWaybillEditable,
  MAX_ROUTE_REQUESTS,
  moscowDateKeyOf,
  requestStatusColors,
  requestStatusLabels,
  ROUTE_FROZEN_MESSAGE,
  type VehicleRequestDto,
  type VehicleRouteDto,
  type VehicleRouteRequestDto,
  WAYBILL_LOCKED_MESSAGE,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { vehicleRequestsApi, vehicleRoutesApi, waybillsApi } from '../../api/resources';
import { AutoSelect } from '../../components/AutoSelect';
import { ViewModal } from '../../components/ViewModal';
import { PrintWaybillButton } from '../../components/WaybillPrint';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Карточка рейса: кто едет, с кем и в каком порядке.
 *
 * Порядок заявок — это талоны бланка 4-П, поэтому переставляются они стрелками, а не
 * перетаскиванием: позиций максимум четыре, а стрелки одинаково работают и на телефоне.
 *
 * Выписанный лист карточку замораживает: состав, порядок и водитель правятся только до него —
 * бланк уже у водителя, и запись, разошедшаяся с бумагой на руках, хуже отсутствия записи
 * (ADR 0037 п. 9). Чтобы пересобрать рейс, лист аннулируют — тем же правом и с той же причиной,
 * что в журнале.
 */

interface Props {
  /** null — окно закрыто. */
  routeId: string | null;
  onClose: () => void;
  /** Список рейсов и список заявок после правки устарели — их обновляет вкладка. */
  onChanged: () => void;
}

export function VehicleRouteModal({ routeId, onClose, onChanged }: Props) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [adding, setAdding] = useState<string | undefined>();

  const { data: route, isFetching } = useQuery({
    queryKey: ['vehicle-routes', routeId],
    queryFn: () => vehicleRoutesApi.get(routeId!),
    enabled: !!routeId,
  });

  const frozen = !!route && !isRouteEditable(route.waybill?.status ?? null);

  /**
   * Что можно положить в этот рейс: грузоперевозки в работе на собственной технике, поданные в
   * тот же день и ещё не стоящие ни в одном рейсе. Отбор тот же, что проверит сервер, — иначе
   * список предлагал бы заявки, которые он отклонит.
   */
  const { data: candidates } = useQuery({
    queryKey: ['vehicle-requests', 'for-route', route?.routeDate],
    queryFn: () =>
      vehicleRequestsApi.list({
        status: 'confirmed',
        requestType: 'freight_transport',
        dateFrom: route!.routeDate,
        dateTo: route!.routeDate,
        page: 1,
        pageSize: 500,
      }),
    enabled: !!route && !frozen,
  });
  const free = (candidates?.items ?? []).filter(
    (r: VehicleRequestDto) => !r.route && r.assignment?.ownership === 'own',
  );

  const afterChange = (updated: VehicleRouteDto) => {
    qc.setQueryData(['vehicle-routes', updated.id], updated);
    onChanged();
  };

  const fail = (e: unknown) => message.error(errorMessage(e));

  const attach = useMutation({
    mutationFn: (requestId: string) =>
      vehicleRoutesApi.attach(route!.id, { requestId, version: route!.version }),
    onSuccess: (updated) => {
      setAdding(undefined);
      afterChange(updated);
    },
    onError: fail,
  });

  const detach = useMutation({
    mutationFn: (requestId: string) =>
      vehicleRoutesApi.detach(route!.id, requestId, route!.version),
    onSuccess: afterChange,
    onError: fail,
  });

  const reorder = useMutation({
    mutationFn: (requestIds: string[]) =>
      vehicleRoutesApi.order(route!.id, { requestIds, version: route!.version }),
    onSuccess: afterChange,
    onError: fail,
  });

  const issue = useMutation({
    mutationFn: () => vehicleRoutesApi.issueWaybill(route!.id, route!.version),
    onSuccess: (updated) => {
      message.success(`Путевой лист ${updated.waybill?.number ?? ''} выписан`);
      afterChange(updated);
    },
    onError: fail,
  });

  const cancelWaybill = useMutation({
    mutationFn: (reason: string) => waybillsApi.cancel(route!.waybill!.id, { reason }),
    onSuccess: async () => {
      message.success('Лист аннулирован — маршрут снова можно править');
      await qc.invalidateQueries({ queryKey: ['vehicle-routes'] });
      onChanged();
    },
    onError: fail,
  });

  /** Сдвиг талона: порядок уходит на сервер целиком — он переписывает его одним заходом. */
  const move = (index: number, delta: number) => {
    if (!route) return;
    const ids = route.requests.map((r) => r.requestId);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorder.mutate(ids);
  };

  const confirmCancelWaybill = () => {
    let reason = '';
    modal.confirm({
      title: `Аннулировать лист ${route?.waybill?.number}?`,
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Номер бланка сгорит: после правки рейса выпишется новый.
          </Typography.Text>
          <textarea
            className="ant-input"
            rows={2}
            placeholder="Причина: испорчен при печати, сменился водитель…"
            onChange={(e) => {
              reason = e.target.value;
            }}
          />
        </Space>
      ),
      okText: 'Аннулировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        if (!reason.trim()) {
          message.error('Укажите причину');
          throw new Error('reason required');
        }
        await cancelWaybill.mutateAsync(reason);
      },
    });
  };

  const readiness = route
    ? canIssueWaybill({
        driverPersonId: route.driverPersonId,
        requests: route.requests,
        waybillStatus: route.waybill?.status ?? null,
      })
    : null;

  const waybillEditable =
    !!route?.waybill &&
    route.waybill.status === 'issued' &&
    isWaybillEditable(route.waybill.issuedForDate, moscowDateKeyOf(new Date()));

  return (
    <ViewModal
      title={
        route ? `Маршрут ${route.displayNumber} · ${formatDateOnly(route.routeDate)}` : 'Маршрут'
      }
      open={!!routeId}
      onClose={onClose}
      width={720}
      destroyOnHidden
      footer={
        route && (
          <Space wrap>
            {route.waybill && route.waybill.status !== 'cancelled' && (
              <PrintWaybillButton waybillId={route.waybill.id} number={route.waybill.number} />
            )}
            {route.waybill && can('waybills.cancel') && (
              <Button
                danger
                disabled={!waybillEditable}
                // Выключенная кнопка объясняет себя: иначе она читается как поломка.
                title={
                  route.waybill.status === 'cancelled'
                    ? 'Лист уже аннулирован'
                    : waybillEditable
                      ? 'Аннулировать лист'
                      : WAYBILL_LOCKED_MESSAGE
                }
                onClick={confirmCancelWaybill}
              >
                Аннулировать лист
              </Button>
            )}
            <Button
              type="primary"
              loading={issue.isPending}
              disabled={!readiness?.ok}
              title={readiness?.ok ? 'Выписать путевой лист' : readiness?.reason}
              onClick={() => issue.mutate()}
            >
              Выписать лист
            </Button>
          </Space>
        )
      }
    >
      {route && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions column={1} size="small">
            <Descriptions.Item label="Техника">
              {route.vehicleLabel}
              {route.withTrailer && ` · с прицепом ${route.trailerLabel}`}
            </Descriptions.Item>
            <Descriptions.Item label="Водитель">
              {route.driverName || <Tag color="orange">не назначен</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="Путевой лист">
              {route.waybill ? (
                <Space>
                  {route.waybill.number}
                  <Tag color={waybillStatusColors[route.waybill.status]}>
                    {waybillStatusLabels[route.waybill.status]}
                  </Tag>
                </Space>
              ) : (
                <Typography.Text type="secondary">не выписан</Typography.Text>
              )}
            </Descriptions.Item>
          </Descriptions>

          {frozen && <Alert type="info" showIcon message={ROUTE_FROZEN_MESSAGE} />}
          {!frozen && readiness && !readiness.ok && route.requests.length > 0 && (
            <Alert type="warning" showIcon message={readiness.reason} />
          )}

          <div>
            <Typography.Title level={5}>
              Заявки рейса ({route.requests.length} из {MAX_ROUTE_REQUESTS})
            </Typography.Title>
            {route.requests.length === 0 && (
              <Typography.Paragraph type="secondary">
                Рейс пуст: положите в него заявку, взятую в работу на эту машину и дату.
              </Typography.Paragraph>
            )}
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {route.requests.map((item, index) => (
                <RouteRequestRow
                  key={item.requestId}
                  item={item}
                  index={index}
                  total={route.requests.length}
                  frozen={frozen}
                  busy={reorder.isPending || detach.isPending}
                  onMove={move}
                  onDetach={() => detach.mutate(item.requestId)}
                />
              ))}
            </Space>
          </div>

          {!frozen && route.requests.length < MAX_ROUTE_REQUESTS && (
            <Space.Compact style={{ width: '100%' }}>
              <AutoSelect
                style={{ width: '100%' }}
                value={adding}
                onChange={(v) => setAdding(v as string)}
                options={free.map((r) => ({
                  value: r.id,
                  label:
                    r.requestType === 'freight_transport'
                      ? `${r.displayNumber} · ${r.loadingLocation} → ${r.unloadingLocation}`
                      : r.displayNumber,
                }))}
                showSearch
                optionFilterProp="label"
                placeholder={
                  free.length > 0
                    ? 'Заявка в работе без маршрута'
                    : 'Свободных заявок на эту дату нет'
                }
                disabled={free.length === 0}
              />
              <Button
                type="primary"
                icon={<PlusOutlined />}
                loading={attach.isPending}
                disabled={!adding}
                onClick={() => adding && attach.mutate(adding)}
              >
                Добавить
              </Button>
            </Space.Compact>
          )}
        </Space>
      )}
      {!route && isFetching && <Typography.Text type="secondary">Загружаем рейс…</Typography.Text>}
    </ViewModal>
  );
}

/**
 * Строка талона: номер по порядку, заказчик и маршрут груза. Отменённая или закрытая заявка
 * остаётся в рейсе историей (лист по ней уже выписан) — её помечает тег, и она же не даёт
 * выписать новый лист, пока её не убрали.
 */
function RouteRequestRow({
  item,
  index,
  total,
  frozen,
  busy,
  onMove,
  onDetach,
}: {
  item: VehicleRouteRequestDto;
  index: number;
  total: number;
  frozen: boolean;
  busy: boolean;
  onMove: (index: number, delta: number) => void;
  onDetach: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        border: '1px solid var(--ant-color-border)',
        borderRadius: 8,
        padding: 8,
      }}
    >
      <Tag style={{ marginTop: 2 }}>{item.position}</Tag>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space size={8} wrap>
          <strong>{item.displayNumber}</strong>
          <span>{item.customerName}</span>
          {item.status !== 'confirmed' && (
            <Tag color={requestStatusColors[item.status]}>{requestStatusLabels[item.status]}</Tag>
          )}
        </Space>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {item.loadingLocation} → {item.unloadingLocation}
            {item.cargoLabel && ` · ${item.cargoLabel}`}
          </Typography.Text>
        </div>
      </div>
      {!frozen && (
        <Space>
          <Button
            size="small"
            icon={<ArrowUpOutlined />}
            title="Выше"
            aria-label={`Поднять ${item.displayNumber}`}
            disabled={index === 0 || busy}
            onClick={() => onMove(index, -1)}
          />
          <Button
            size="small"
            icon={<ArrowDownOutlined />}
            title="Ниже"
            aria-label={`Опустить ${item.displayNumber}`}
            disabled={index === total - 1 || busy}
            onClick={() => onMove(index, 1)}
          />
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            title="Убрать из маршрута"
            aria-label={`Убрать ${item.displayNumber}`}
            disabled={busy}
            onClick={onDetach}
          />
        </Space>
      )}
    </div>
  );
}
