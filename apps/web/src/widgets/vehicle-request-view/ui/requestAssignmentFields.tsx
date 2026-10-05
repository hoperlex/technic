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
    {
      key: 'assignment',
      label: 'Техника',
      full: true,
      children: request.assignment ? (
        <Space orientation="vertical" size={2}>
          <Space size={8} wrap>
            <span>{assignmentTitle(request.assignment)}</span>
            {assignmentHint && (
              <Tag color={assignmentHint.level === 'warning' ? 'orange' : 'gold'}>
                {assignmentHint.label}
              </Tag>
            )}
            <Tag color={vehicleOwnershipColors[request.assignment.ownership]}>
              {vehicleOwnershipLabels[request.assignment.ownership]}
            </Tag>
            {request.assignment.lessorName && <Tag>{request.assignment.lessorName}</Tag>}
            {onReassign && (
              <Button size="small" onClick={() => onReassign(request)}>
                Сменить технику
              </Button>
            )}
          </Space>
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
