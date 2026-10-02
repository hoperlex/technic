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

/** Show requested trips in their stable request order, independently from route visit order. */
export function RequestTripsTable({ trips }: { trips: VehicleRequestTripDto[] }) {
  return (
    <Table<VehicleRequestTripDto>
      dataSource={trips}
      rowKey="id"
      size="small"
      pagination={false}
      scroll={{ x: 'max-content' }}
      columns={[
        { key: 'num', title: '№', width: 64, render: (_value, trip) => trip.num },
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
