import { EditOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Space, Tag, Typography } from 'antd';
import {
  ROUTE_FROZEN_MESSAGE,
  routePurposeLabels,
  type VehicleRouteDto,
  WAYBILL_LOCKED_MESSAGE,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { vehicleRequestViewLink } from '@entities/vehicle-request';
import { blockerMessage, canOpenRoute } from '@entities/vehicle-route';
import { PrintWaybillButton } from '@entities/waybill';
import { useRouteModal } from '@features/route-modal';
import { formatDateOnly } from '@shared/lib';
import { EntityLink, ViewModal } from '@shared/ui';
import type { VehicleRouteWindowController } from '../model/useVehicleRouteWindow';
import { RouteAddRequestBlock } from './RouteAddRequestBlock';
import { RoutePointsBlock } from './RoutePointsBlock';
import { RouteRequestRow } from './RouteRequestRow';
import { RouteTaskRowsBlock } from './RouteTaskRowsBlock';
import { VehicleRouteCorrectionModal } from './VehicleRouteCorrectionModal';
import { VehicleRouteTransferCorrectionModal } from './VehicleRouteTransferCorrectionModal';

interface Props {
  routeId: string | null;
  onClose: () => void;
  /**
   * Open the header edit (day, driver, header fields). A separate window rather than inputs here:
   * the card answers "what route is this and what to do with it", and inputs amid the composition
   * would turn it into a form.
   */
  onEdit?: (route: VehicleRouteDto) => void;
  state: VehicleRouteWindowController;
}

/**
 * Route card presentation; useVehicleRouteWindow owns data and commands (see there for the freeze
 * and visit-order invariants). The nested correction windows are mounted here so the route stays
 * visible behind them.
 */
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
            {/* The door to the route list: the tab people used to reach it by is gone (ADR
                0120), and the card is one of its three replacements (section 3.3 of
                docs/vehicle-routes-modal-plan.md). The route day is always passed: coming from
                a route of the day before yesterday, a list left on its own period would show
                neither it nor its day neighbours, and the neighbours are why people leave the
                card ("what else is this vehicle doing").

                On the left rather than next to "Issue waybill": that one spends a form number,
                and a navigation button shoulder to shoulder with it would compete for the click
                with an irreversible action.

                The right is asked by its own call although the card cannot open without it (the
                URL host drops ?route=). The button leads to the LIST, closed by the same
                canOpenRoute, and deducing "the card is open, so the list is allowed" would be a
                rule that holds only until the first change of access conditions. */}
            {canOpenRoute(can) && (
              <Button
                icon={<UnorderedListOutlined />}
                title="Список рейсов на день этого маршрута"
                onClick={() => openRoutesList({ focusDate: route.routeDate })}
              >
                Все маршруты
              </Button>
            )}
            {/* Route edit uses the same right as everything else in the card: the day is moved
                and the driver changed on the morning of that day, which is the most common
                reason to open the card. */}
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
            {/* A cancelled waybill cannot be printed (canPrintWaybill), and the button does not
                even mention it: the route is already unfrozen, and the talk here must be about
                the new form, not the written-off number. */}
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
                // A disabled button explains itself, otherwise it reads as broken.
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
            {/* A relocation's task is not a composition but two lines "from -> to" (migration
                0082). */}
            {relocation && (
              <Descriptions.Item label={routePurposeLabels[route.purpose]}>
                {route.moveFrom} → {route.moveTo}
                {/* The relocation's request uses the same transition as a freight route's
                    composition: a relocation has no composition at all, and this line is the only
                    way from it to the request the equipment is moved for. */}
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
          {/* Driver document gaps are shown before "Issue waybill", not in the confirmation:
              assigning another person is easier while the form is not spent yet. A frozen route
              stays silent: its waybill is printed, and it is too late to talk about empty
              columns. */}
          {!frozen && driverGaps && (
            <Alert
              type="warning"
              showIcon
              title="Документы водителя внесены не полностью"
              description={driverGaps}
            />
          )}

          {/* Visit order and the form task exist only for a freight route: a relocation moves one
              unit of equipment for one request, has no points, and its task is printed from the
              route itself ("from -> to" in the header, migration 0082). */}
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

          {/* The composition is how work is added to and removed from the route. It no longer sets
              the order: task rows are printed in point order (R11), and the arrows moved there.
              What stays here is the request's own: its state, ticket and the retroactive transfer
              door. */}
          {!relocation && (
            <div>
              {/* The counter is just the request count, without "of seven": paper is measured
                  by task rows, not requests (R11), and a request with six trips takes six of
                  seven rows while staying one entry here. Capacity is named by the "Waybill
                  task" block, where printed rows are counted. */}
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
                    // Readiness uses the same rule as route correction: the server asks it for both
                    // routes, and the button must not promise what the endpoint refuses. A disabled
                    // one explains itself: with a closed request in the composition the transfer
                    // becomes a joint job (R38).
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
            <RouteAddRequestBlock
              route={route}
              adding={adding}
              attach={attach}
              candidate={candidate}
              free={free}
              setAdding={setAdding}
            />
          )}
        </Space>
      )}
      {!route && isFetching && <Typography.Text type="secondary">Загружаем рейс…</Typography.Text>}

      {/* The correction window lies over the card so the route being fixed stays visible behind
          it: composition, waybill number and day. Its own window rather than card fields, because
          its action has a different price. */}
      <VehicleRouteCorrectionModal
        route={correcting ? (route ?? null) : null}
        onClose={() => setCorrecting(false)}
        onSaved={(updated) => {
          setCorrecting(false);
          afterChange(updated);
        }}
      />
      {/* Retroactive transfer (R30) has its own window because it burns two numbers at once and
          must name both before the click. It opens from the source side: the ticket is seen where
          it stands. */}
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
