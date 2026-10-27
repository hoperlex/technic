import { Space, Spin, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  driverReportStateLabels,
  type RequestRouteReadingDto,
  type RequestRouteStopDto,
  type RequestRouteTimeDto,
  routeDurationLabel,
  routeTimeIssueLabels,
  type VehicleRequestDto,
} from '@technic/contracts';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { formatDateOnly } from '@shared/lib';

const dash = <Typography.Text type="secondary">—</Typography.Text>;

/** «на 2 заявки», «на 5 заявок», «на 21 заявку» — the accusative after «на». */
function requestsLabel(count: number): string {
  const tail = count % 100;
  const last = count % 10;
  const form =
    tail >= 11 && tail <= 14
      ? 'заявок'
      : last === 1
        ? 'заявку'
        : last >= 2 && last <= 4
          ? 'заявки'
          : 'заявок';
  return `${count} ${form}`;
}

const columns = [
  {
    key: 'location',
    title: 'Точка',
    render: (_value: unknown, stop: RequestRouteStopDto) => (
      <span>
        {stop.position}. {stop.location}
      </span>
    ),
  },
  {
    key: 'arrivedAt',
    title: 'Прибытие',
    width: 100,
    // The arrival is recorded at the first stop only: it is the start of the shift (D6).
    render: (_value: unknown, stop: RequestRouteStopDto) => stop.arrivedAt ?? dash,
  },
  {
    key: 'departedAt',
    title: 'Отправление',
    width: 110,
    render: (_value: unknown, stop: RequestRouteStopDto) => stop.departedAt ?? dash,
  },
  {
    key: 'segment',
    title: 'Отрезок заявки',
    width: 170,
    // The segment the share is counted from: from the previous departure (the arrival at stop 1)
    // to this departure, split equally between the requests of the stop (D6).
    render: (_value: unknown, stop: RequestRouteStopDto) => (
      <div style={{ lineHeight: 1.35 }}>
        <div>
          {stop.segmentFrom && stop.departedAt ? `${stop.segmentFrom} – ${stop.departedAt}` : dash}
        </div>
        {stop.sharedBy > 1 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            поровну на {requestsLabel(stop.sharedBy)}
          </Typography.Text>
        )}
      </div>
    ),
  },
];

/** «Время по заявке» in words: the exact total, or why there is none. */
export function routeTimeSummary(time: RequestRouteTimeDto): string {
  if (time.seconds !== null) return routeDurationLabel(time.seconds);
  return `нет — ${routeTimeIssueLabels[time.issues[0] ?? 'no_readings']}`;
}

function ReadingFact({
  reading,
  time,
}: {
  reading: RequestRouteReadingDto;
  time: RequestRouteTimeDto;
}) {
  // Who submitted and in which state the report is: diagnostics, only for `vehicleReadings.read`
  // (D10) — the server leaves the block out for anyone else.
  const diagnostics = time.driver?.readings.find((d) => d.readingId === reading.readingId);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Space size={[8, 4]} wrap>
        <Typography.Text>{formatDateOnly(reading.reportDate)}</Typography.Text>
        {reading.issue && <Tag color="orange">{routeTimeIssueLabels[reading.issue]}</Tag>}
        {reading.seconds !== null && (
          <Typography.Text type="secondary">{routeDurationLabel(reading.seconds)}</Typography.Text>
        )}
        {diagnostics && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {diagnostics.personName} · отчёт:{' '}
            {driverReportStateLabels[diagnostics.reportState].toLowerCase()}
            {diagnostics.noDataReason ? ` · ${diagnostics.noDataReason}` : ''}
          </Typography.Text>
        )}
      </Space>
      {reading.stops.length > 0 && (
        <Table<RequestRouteStopDto>
          rowKey="position"
          size="small"
          dataSource={reading.stops}
          columns={columns}
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
      )}
    </div>
  );
}

/**
 * «Факт по точкам» of a freight request (readings-shifts-merge plan §8, D6, D7): the arrival and
 * departures the driver recorded at this request's stops, and «время по заявке» — its share of the
 * route time. The numbers come from the server, split from the stop snapshot taken when the times
 * were recorded; the card does no arithmetic of its own, so it cannot disagree with the completion
 * window, which proposes the same share rounded up to a whole hour (D12).
 *
 * A request not taken into work has no route yet, and the block stays silent rather than saying
 * "the driver has not submitted" about work nobody has planned.
 */
export function RequestRouteFact({ request }: { request: VehicleRequestDto }) {
  const { data, isPending } = useQuery({
    queryKey: vehicleRequestKeys.routeTime(request.id),
    queryFn: () => vehicleRequestsApi.routeTime(request.id),
    enabled: request.requestType === 'freight_transport',
  });
  if (request.requestType !== 'freight_transport') return null;
  if (isPending) return <Spin size="small" />;
  if (!data) return null;
  const inWork = request.status === 'confirmed' || request.status === 'done';
  if (data.readings.length === 0 && !inWork) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Typography.Text strong>Факт по точкам</Typography.Text>
      <div>
        <Typography.Text type="secondary">Время по заявке: </Typography.Text>
        {data.seconds !== null ? (
          <Typography.Text strong>{routeTimeSummary(data)}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">{routeTimeSummary(data)}</Typography.Text>
        )}
      </div>
      {data.readings.map((reading) => (
        <ReadingFact key={reading.readingId} reading={reading} time={data} />
      ))}
    </div>
  );
}
