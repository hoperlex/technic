import { Button, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import dayjs from 'dayjs';
import {
  assignmentRateLabel,
  assignmentTitle,
  type Permission,
  type VehicleRequestDriverDto,
  type VehicleRequestDto,
  vehicleOwnershipColors,
  vehicleOwnershipLabels,
} from '@technic/contracts';
import { vehicleRouteLink } from '@entities/vehicle-route';
import { PhoneLink } from '@entities/user-account';
import { formatDateTime } from '@shared/lib';
import { EntityLink, type ViewField } from '@shared/ui';

interface AssignmentFieldOptions {
  request: VehicleRequestDto;
  asksDriver: boolean;
  assignmentHint: { label: string; level: string } | null;
  can: (permission: Permission) => boolean;
  canTransfer: boolean;
  driver: VehicleRequestDriverDto | null | undefined;
  isDriverPending: boolean;
  onChangeMachinist?: (request: VehicleRequestDto) => void;
  onReassign?: (request: VehicleRequestDto) => void;
  onTransfer?: (request: VehicleRequestDto) => void;
  openedRouteId: string | null;
  openRoute: (routeId: string) => void;
  openRoutesList: () => void;
  showAllRoutes: boolean;
}

/** Fields describing the assigned vehicle, crew and containing route. */
export function requestAssignmentFields({
  request,
  asksDriver,
  assignmentHint,
  can,
  canTransfer,
  driver,
  isDriverPending,
  onChangeMachinist,
  onReassign,
  onTransfer,
  openedRouteId,
  openRoute,
  openRoutesList,
  showAllRoutes,
}: AssignmentFieldOptions): ViewField[] {
  return [
    /*
     * What closed the request: vehicle, route, waybill, relocations, completion fact.
     *
     * Assigned vehicle (ADR 0027): a "New" request has none; for the rest it answers "with what and
     * at what rate", together with who assigned it and when.
     */
    {
      key: 'assignment',
      label: 'Техника',
      full: true,
      children: request.assignment ? (
        <Space orientation="vertical" size={2}>
          <Space size={8} wrap>
            <span>{assignmentTitle(request.assignment)}</span>
            {/* What closed the request when it differs from what was ordered (ADR 0045, ADR 0059):
                the vehicle's classifier position plus the direction ("larger", "smaller than
                ordered"). No tag on a match: repeating the order one line below adds nothing. */}
            {assignmentHint && (
              <Tag color={assignmentHint.level === 'warning' ? 'orange' : 'gold'}>
                {assignmentHint.label}
              </Tag>
            )}
            <Tag color={vehicleOwnershipColors[request.assignment.ownership]}>
              {vehicleOwnershipLabels[request.assignment.ownership]}
            </Tag>
            {request.assignment.lessorName && <Tag>{request.assignment.lessorName}</Tag>}
            {/* Vehicle change sits next to the value, not in the window footer: the footer acts on
                the whole request, while here one field changes (ADR 0048). */}
            {onReassign && (
              <Button size="small" onClick={() => onReassign(request)}>
                Сменить технику
              </Button>
            )}
          </Space>
          {/* Rate and the person working on the vehicle are one level of the "with what and at
              what rate" answer. On a narrow screen Space wraps the contact as a whole. */}
          <Space size={[16, 4]} wrap>
            <Typography.Text>
              {assignmentRateLabel(request.assignment) || 'Ставка не указана'}
            </Typography.Text>
            {asksDriver ? (
              <Space size={8} wrap>
                <Typography.Text type="secondary">Водитель:</Typography.Text>
                {isDriverPending ? (
                  <Spin size="small" />
                ) : driver ? (
                  <>
                    <span>{driver.fullName}</span>
                    {driver.phone ? (
                      <PhoneLink phone={driver.phone} />
                    ) : (
                      <Typography.Text type="secondary">телефон не указан</Typography.Text>
                    )}
                    {/* The person's card was removed from the directory (ADR 0190). That does
                        not cancel the work (they are on this vehicle today), but the order will
                        issue one more strict-accounting form to a removed person, and that must
                        be said here rather than discovered by the customer's accounting. The
                        "change machinist" button is right next to it: the mark is an invitation
                        to use it. */}
                    {driver.cardRemovedOn && (
                      <Tooltip
                        title={`Карточка снята ${dayjs(driver.cardRemovedOn).format('DD.MM.YYYY')}. Выписанные бланки остаются в силе, а новые пойдут на снятую карточку — назначьте другого машиниста.`}
                      >
                        <Tag color="warning">снят из справочника</Tag>
                      </Tooltip>
                    )}
                  </>
                ) : (
                  <Typography.Text type="secondary">не назначен</Typography.Text>
                )}
                {/* Machinist change sits next to the person, not in the footer: the footer acts on
                    the whole request, here one decision changes: who works and from which date
                    (docs/assignment-periods-plan.md, section 9). "Crew by date" opens from there
                    too: "who worked in March" is asked while looking at this line, and the line
                    only answers about today. */}
                {onChangeMachinist && (
                  <Button size="small" onClick={() => onChangeMachinist(request)}>
                    Сменить машиниста
                  </Button>
                )}
              </Space>
            ) : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Назначил {request.assignment.assignedByName || '—'} ·{' '}
            {formatDateTime(request.assignment.assignedAt)}
          </Typography.Text>
        </Space>
      ) : (
        <Typography.Text type="secondary">
          Не назначена — заявку ещё не брали в работу
        </Typography.Text>
      ),
    },
    /*
     * The route the request rides (ADR 0050) and the door to the route list. The valued row appears
     * for a request placed in a route: "Route: -" on a new request would read as a forgotten route,
     * and freight in progress without a route is flagged by a tag in the list. Transfer sits next
     * to the value, like vehicle change: one field changes, not the whole request (ADR 0052).
     *
     * A request without a route still gets the row, but only for "All routes" and only for those
     * entitled to the list: this is where people go looking for a route to put the request in.
     * There is no dash in it; the absence is said in words, otherwise the "forgotten route" the row
     * was hidden for would return.
     */
    ...(request.route || showAllRoutes
      ? [
          {
            key: 'route',
            label: 'Маршрут',
            full: true,
            children: (
              <Space size={8} wrap>
                {request.route ? (
                  <>
                    <span>
                      {/* The route opens as a window over the card instead of leaving for its own
                          tab: "what is that route" is asked from the request, and the answer must
                          not cost the screen it was asked from. A link, not a button: Ctrl and
                          middle click must still open the route in a new browser tab (EntityLink).
                          The route this card was opened over stays plain text (openedRouteId). */}
                      {request.route.id === openedRouteId ? (
                        request.route.displayNumber
                      ) : (
                        <EntityLink
                          to={vehicleRouteLink(can, request.route.id)}
                          title="Открыть маршрут"
                          onActivate={() => openRoute(request.route!.id)}
                        >
                          {request.route.displayNumber}
                        </EntityLink>
                      )}{' '}
                      · строка {request.route.position}
                    </span>
                    {request.route.hasWaybill ? (
                      <Typography.Text type="secondary">
                        лист выписан — состав рейса заморожен
                      </Typography.Text>
                    ) : (
                      canTransfer && (
                        <Button size="small" onClick={() => onTransfer?.(request)}>
                          Перенести в другой рейс
                        </Button>
                      )
                    )}
                  </>
                ) : (
                  <Typography.Text type="secondary">Не поставлена в рейс</Typography.Text>
                )}
                {showAllRoutes && (
                  <Button size="small" onClick={openRoutesList}>
                    Все маршруты
                  </Button>
                )}
              </Space>
            ),
          },
        ]
      : []),
  ];
}
