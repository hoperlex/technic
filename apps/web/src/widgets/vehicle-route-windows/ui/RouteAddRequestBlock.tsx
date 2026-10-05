import { PlusOutlined } from '@ant-design/icons';
import { Button, Space, Typography } from 'antd';
import { LINEAR_DAY_DOOR_MESSAGE, type VehicleRouteDto } from '@technic/contracts';
import { tripsCountLabel } from '@entities/vehicle-request';
import { AutoSelect } from '@shared/ui';
import type { VehicleRouteWindowController } from '../model/useVehicleRouteWindow';

type Props = Pick<
  VehicleRouteWindowController,
  'adding' | 'attach' | 'candidate' | 'free' | 'setAdding'
> & { route: VehicleRouteDto };

/** Picker that adds a free request to the route or moves one in from another route. */
export function RouteAddRequestBlock({ route, adding, attach, candidate, free, setAdding }: Props) {
  return (
    <Space orientation="vertical" size={4} style={{ width: '100%' }}>
      <Space.Compact style={{ width: '100%' }}>
        <AutoSelect
          style={{ width: '100%' }}
          value={adding}
          onChange={(value) => setAdding(value as string)}
          /*
           * A request of another route is labelled with that route and its task row: the dispatcher
           * must see they are taking it from R-7, not picking a free one.
           *
           * Numbers stay plain text here on purpose: an option label is a string that the search
           * runs on (optionFilterProp="label"), so there is no room for markup in it, and a click on
           * an option belongs to choosing; a link inside would steal the list's only action. The
           * same holds for the warning below: it is about the request being added now, not a
           * composition record people go to look at.
           */
          options={free.map((request) => ({
            value: request.id,
            label: [
              /*
               * Addresses come from the FIRST trip (R2, section 9 of docs/route-trips-plan.md): a
               * request has no address pair of its own any more, and the hint needs a "where we go"
               * landmark, not the whole order. The trip count sits next to it because each trip
               * takes its own task row on the form (R11): "6 trips" explains why one row is left
               * on a seven-row 4-P after this request.
               */
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
              // The ordered vehicle type when it differs from the route's vehicle (ADR 0059). A
              // vehicle's day is assembled by sites and sites order different things: "flatbed
              // ordered" in the row explains why the request is here at all.
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
      {/* The route is the source of truth about what drives: a request moved here from another
          vehicle will ride this one. That is said before the click, not after. */}
      {candidate?.route && candidate.assignment?.vehicleId !== route.vehicleId && (
        <Typography.Text type="warning">
          {candidate.displayNumber} поедет машиной этого рейса — {route.vehicleLabel}
        </Typography.Text>
      )}
      {/* Linear orders are never in this list: a day is put into a route from the request card,
          and the route does not know which day of the term is being placed (ADR 0100 decision 8).
          It is said where people would look for them, otherwise the absence would read as loss. */}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {LINEAR_DAY_DOOR_MESSAGE}
      </Typography.Text>
    </Space>
  );
}
