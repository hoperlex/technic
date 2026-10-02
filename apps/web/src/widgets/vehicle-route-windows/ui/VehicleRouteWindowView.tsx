import { EditOutlined, PlusOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Space, Tag, Typography } from 'antd';
import {
  LINEAR_DAY_DOOR_MESSAGE,
  ROUTE_FROZEN_MESSAGE,
  routePurposeLabels,
  type VehicleRouteDto,
  WAYBILL_LOCKED_MESSAGE,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { tripsCountLabel, vehicleRequestViewLink } from '@entities/vehicle-request';
import { blockerMessage, canOpenRoute } from '@entities/vehicle-route';
import { PrintWaybillButton } from '@entities/waybill';
import { useRouteModal } from '@features/route-modal';
import { formatDateOnly } from '@shared/lib';
import { AutoSelect, EntityLink, ViewModal } from '@shared/ui';
import type { VehicleRouteWindowController } from '../model/useVehicleRouteWindow';
import { RoutePointsBlock } from './RoutePointsBlock';
import { RouteRequestRow } from './RouteRequestRow';
import { RouteTaskRowsBlock } from './RouteTaskRowsBlock';
import { VehicleRouteCorrectionModal } from './VehicleRouteCorrectionModal';
import { VehicleRouteTransferCorrectionModal } from './VehicleRouteTransferCorrectionModal';

interface Props {
  routeId: string | null;
  onClose: () => void;
  onEdit?: (route: VehicleRouteDto) => void;
  state: VehicleRouteWindowController;
}

/** Present a route card while its controller owns data and commands. */
export function VehicleRouteWindowView({ routeId, onClose, onEdit, state }: Props) {
  const { can } = useAuth();
  const { openRequest, openRoutesList } = useRouteModal();
  const {
    adding,
    afterChange,
    assembly,
    attach,
    blocking,
    canAddRequest,
    candidate,
    confirmCancelWaybill,
    confirmIssue,
    correcting,
    correction,
    detach,
    driverGaps,
    fail,
    free,
    frozen,
    isFetching,
    issue,
    readiness,
    relocation,
    route,
    setAdding,
    setCorrecting,
    setTransferring,
    sourceRequest,
    transferring,
    waybillEditable,
  } = state;

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
            {canOpenRoute(can) && (
              <Button
                icon={<UnorderedListOutlined />}
                title="Список рейсов на день этого маршрута"
                onClick={() => openRoutesList({ focusDate: route.routeDate })}
              >
                Все маршруты
              </Button>
            )}
            {onEdit && (
              <Button
                icon={<EditOutlined />}
                disabled={frozen}
                title={frozen ? ROUTE_FROZEN_MESSAGE : 'Изменить дату, водителя и реквизиты'}
                onClick={() => onEdit(route)}
              >
                Редактировать
              </Button>
            )}
            {route.waybill && route.waybill.status !== 'cancelled' && (
              <PrintWaybillButton
                waybillId={route.waybill.id}
                number={route.waybill.number}
                status={route.waybill.status}
              />
            )}
            {correction && (
              <Button
                danger
                disabled={!correction.ok}
                title={
                  correction.ok
                    ? 'Привести рейс к тому, что было на самом деле: машина, водитель, реквизиты'
                    : `${correction.reason}${correction.blocking.length > 0 ? ` (${correction.blocking.join(', ')})` : ''}`
                }
                onClick={() => setCorrecting(true)}
              >
                Исправить исполнение
              </Button>
            )}
            {route.waybill && can('waybills.cancel') && (
              <Button
                danger
                disabled={!waybillEditable}
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
              disabled={!readiness?.ok || !!blocking}
              title={
                !readiness?.ok
                  ? readiness?.reason
                  : blocking && assembly
                    ? blockerMessage(blocking, assembly)
                    : 'Выписать путевой лист'
              }
              onClick={confirmIssue}
            >
              Выписать лист
            </Button>
          </Space>
        )
      }
    >
      {route && (
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions column={1} size="small">
            <Descriptions.Item label="Техника">
              {route.vehicleLabel}
              {route.withTrailer && ` · с прицепом ${route.trailerLabel}`}
            </Descriptions.Item>
            <Descriptions.Item label="Водитель">
              {route.driverName || <Tag color="orange">не назначен</Tag>}
            </Descriptions.Item>
            {relocation && (
              <Descriptions.Item label={routePurposeLabels[route.purpose]}>
                {route.moveFrom} → {route.moveTo}
                {sourceRequest && (
                  <>
                    {' · по заявке '}
                    <EntityLink
                      to={vehicleRequestViewLink(can, sourceRequest.requestId)}
                      title="Открыть заявку"
                      onActivate={() => openRequest(sourceRequest.requestId)}
                    >
                      {sourceRequest.displayNumber}
                    </EntityLink>
                  </>
                )}
              </Descriptions.Item>
            )}
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

          {frozen && <Alert type="info" showIcon title={ROUTE_FROZEN_MESSAGE} />}
          {!frozen && readiness && !readiness.ok && (relocation || route.requests.length > 0) && (
            <Alert type="warning" showIcon title={readiness.reason} />
          )}
          {!frozen && driverGaps && (
            <Alert
              type="warning"
              showIcon
              title="Документы водителя внесены не полностью"
              description={driverGaps}
            />
          )}

          {!relocation && assembly && (
            <>
              <RoutePointsBlock
                route={route}
                assembly={assembly}
                frozen={frozen}
                onChanged={afterChange}
                onFail={fail}
              />
              <RouteTaskRowsBlock
                route={route}
                formCode={route.formCode}
                assembly={assembly}
                frozen={frozen}
                onChanged={afterChange}
                onFail={fail}
              />
            </>
          )}

          {!relocation && (
            <div>
              <Typography.Title level={5}>Заявки рейса ({route.requests.length})</Typography.Title>
              {route.requests.length === 0 && (
                <Typography.Paragraph type="secondary">
                  Рейс пуст: положите в него заявку, взятую в работу на эту машину и дату.
                  {can('waybills.issueBlank') &&
                    ' Либо выпишите пустой лист — с машиной, водителем и датой, но без задания.'}
                </Typography.Paragraph>
              )}
              <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                {route.requests.map((item) => (
                  <RouteRequestRow
                    key={item.requestId}
                    item={item}
                    frozen={frozen}
                    busy={detach.isPending}
                    onDetach={() => detach.mutate(item.requestId)}
                    onTransfer={
                      correction
                        ? {
                            disabledReason: correction.ok
                              ? null
                              : `${correction.reason}${correction.blocking.length > 0 ? ` (${correction.blocking.join(', ')})` : ''}`,
                            onClick: () => setTransferring(item),
                          }
                        : null
                    }
                  />
                ))}
              </Space>
            </div>
          )}

          {canAddRequest && (
            <Space orientation="vertical" size={4} style={{ width: '100%' }}>
              <Space.Compact style={{ width: '100%' }}>
                <AutoSelect
                  style={{ width: '100%' }}
                  value={adding}
                  onChange={(value) => setAdding(value as string)}
                  options={free.map((request) => ({
                    value: request.id,
                    label: [
                      request.requestType === 'freight_transport'
                        ? [
                            request.displayNumber,
                            request.trips[0] &&
                              `${request.trips[0].fromLocation} → ${request.trips[0].toLocation}`,
                            request.trips.length > 1 && tripsCountLabel(request.trips.length),
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : request.displayNumber,
                      request.vehicleTypeId !== route.vehicleTypeId
                        ? `заказан ${request.vehicleTypeName}`
                        : null,
                      request.route
                        ? `из ${request.route.displayNumber}, строка ${request.route.position}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  }))}
                  showSearch
                  optionFilterProp="label"
                  placeholder={
                    free.length > 0
                      ? 'Заявка в работе — свободная или из другого рейса'
                      : 'Подходящих заявок на эту дату нет'
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
                  {candidate?.route ? 'Перенести' : 'Добавить'}
                </Button>
              </Space.Compact>
              {candidate?.route && candidate.assignment?.vehicleId !== route.vehicleId && (
                <Typography.Text type="warning">
                  {candidate.displayNumber} поедет машиной этого рейса — {route.vehicleLabel}
                </Typography.Text>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {LINEAR_DAY_DOOR_MESSAGE}
              </Typography.Text>
            </Space>
          )}
        </Space>
      )}
      {!route && isFetching && <Typography.Text type="secondary">Загружаем рейс…</Typography.Text>}

      <VehicleRouteCorrectionModal
        route={correcting ? (route ?? null) : null}
        onClose={() => setCorrecting(false)}
        onSaved={(updated) => {
          setCorrecting(false);
          afterChange(updated);
        }}
      />
      <VehicleRouteTransferCorrectionModal
        route={transferring ? (route ?? null) : null}
        request={transferring}
        onClose={() => setTransferring(null)}
        onDone={(result) => {
          setTransferring(null);
          afterChange(result.source);
        }}
      />
    </ViewModal>
  );
}
