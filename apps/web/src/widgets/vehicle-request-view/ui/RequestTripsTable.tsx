import { Table, Typography } from 'antd';
import { tripCargoLabel, type VehicleRequestTripDto } from '@technic/contracts';
import { AddressCell } from '@entities/address';
import { ResponsibleValue } from '@entities/user-account';
import { formatDateTime } from '@shared/lib';

function TripEnd({
  location,
  meta,
  name,
  phone,
}: {
  location: string;
  meta: VehicleRequestTripDto['fromAddress'];
  name: string;
  phone: string;
}) {
  return (
    <div style={{ lineHeight: 1.35 }}>
      <AddressCell text={location} meta={meta} />
      <div style={{ fontSize: 12 }}>
        <ResponsibleValue name={name} phone={phone} />
      </div>
    </div>
  );
}

/**
 * Request trips as a table (R1, section 9 of docs/route-trips-plan.md), one row per trip in the
 * order of their numbers.
 *
 * Shown only when there is more than one trip: a single-trip request (before the plan every
 * request was one, R24) names it with the "Loading/Unloading" field pair as it always did. A
 * one-row table is a header, a frame and a scroll bar for what fits in two card fields.
 *
 * There is no visit order here and cannot be: it belongs to the route, not to the order (R1), and
 * is asked of the route card. This table answers "what the customer asked to carry", not "in which
 * order the vehicle will visit it".
 *
 * No editing here and none planned: trips are edited by the request form (section 4.1,
 * RequestTripsBlock), and a second editor of the same list would drift from the first.
 */
export function RequestTripsTable({ trips }: { trips: VehicleRequestTripDto[] }) {
  return (
    <Table<VehicleRequestTripDto>
      dataSource={trips}
      rowKey="id"
      size="small"
      pagination={false}
      // Addresses are long and the card window does not grow: the table scrolls sideways by itself
      // instead of stretching the window or breaking the phone layout (ADR 0030).
      scroll={{ x: 'max-content' }}
      columns={[
        {
          key: 'num',
          title: '№',
          width: 64,
          // The trip number within the request, not the list position: it is immutable and never
          // reused (R13a), and the issued waybill names the trip by it ("TS-40/2").
          render: (_value, trip) => trip.num,
        },
        {
          key: 'from',
          title: 'Погрузка',
          render: (_value, trip) => (
            <TripEnd
              location={trip.fromLocation}
              meta={trip.fromAddress}
              name={trip.fromResponsibleName}
              phone={trip.fromResponsiblePhone}
            />
          ),
        },
        {
          key: 'to',
          title: 'Разгрузка',
          render: (_value, trip) => (
            <TripEnd
              location={trip.toLocation}
              meta={trip.toAddress}
              name={trip.toResponsibleName}
              phone={trip.toResponsiblePhone}
            />
          ),
        },
        {
          key: 'cargo',
          title: 'Груз',
          width: 160,
          // The cargo label is the one the form prints (tripCargoLabel): different units on the
          // card and on the waybill would start an argument about what was carried. The trip note
          // goes on the second line; it is what explains "sand, call an hour ahead".
          render: (_value, trip) => (
            <div style={{ lineHeight: 1.35 }}>
              <div>{tripCargoLabel(trip) || '—'}</div>
              {!!trip.comment && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {trip.comment}
                </Typography.Text>
              )}
            </div>
          ),
        },
        {
          key: 'scheduledAt',
          title: 'Подача',
          width: 150,
          // A trip's own time (R3) refines the request's: empty means "same as the request", and
          // that is said in words. A dash would read as "no time at all", while there is one, the
          // request's.
          render: (_value, trip) =>
            trip.scheduledAt ? (
              formatDateTime(trip.scheduledAt)
            ) : (
              <Typography.Text type="secondary">как у заявки</Typography.Text>
            ),
        },
      ]}
    />
  );
}
