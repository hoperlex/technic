import type { ReactNode } from 'react';
import { Button, Space, Table, Tag, Typography, type TableColumnType } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import {
  driverShiftReadingStatusColors,
  driverShiftReadingStatusLabels,
  type GarageDriverShiftDto,
  shiftMonthKey,
  waybillFormShortLabels,
} from '@technic/contracts';
import { garageApi, garageKeys } from '@entities/garage';
import { useAuth } from '@entities/session';
import { monthLabel, useIsMobile } from '@shared/lib';
import { EntityLink, SummaryBar, ViewModal } from '@shared/ui';
import { intakeDayHref } from './readingsAddress';
import { SUB } from './shared';

/**
 * «График» of the «Водители» tab: one driver's month of shifts (owner's decisions of 28.10.2026).
 *
 * Read-only, like the whole garage (ADR 0076). Everything that decides — which shifts are due a
 * reading, the status of each, the month's numbers, the month itself and "today" — comes from the
 * server (`GET /garage/drivers/:personId/schedule`); the window only lays it out. A status computed
 * here from the report state would be a second rule beside the server's, and the month computed
 * from the browser's clock would drift from Moscow at night.
 *
 * The one door out is the person's day in the intake registry (`intakeDayHref`), the registry's
 * own report window rather than a second view of the report. It needs `vehicleReadings.read` — the
 * readings tab is closed without it — and a day that has come: a day ahead has nothing to open.
 */

const ROW_DATE = 'DD.MM, dd';

/** Which paper the shift stands on: the route with its waybill, the weekly sheet, or none. */
function sourceCell(shift: GarageDriverShiftDto): ReactNode {
  const paper = shift.waybill
    ? `${waybillFormShortLabels[shift.waybill.formCode]} № ${shift.waybill.number}`
    : null;
  if (shift.source === 'esm2') return paper;
  if (shift.source === 'route') {
    return (
      <Space orientation="vertical" size={0}>
        <span>{shift.routeNumber}</span>
        {paper && <Typography.Text {...SUB}>{paper}</Typography.Text>}
      </Space>
    );
  }
  return (
    <Space size={4} wrap>
      <Tag style={{ marginInlineEnd: 0 }}>без листа</Tag>
      <span>{shift.routeNumber ?? shift.request?.displayNumber}</span>
    </Space>
  );
}

/** The status, and for «нет данных» its reason when the viewer may read it. */
function statusCell(shift: GarageDriverShiftDto): ReactNode {
  return (
    <Space orientation="vertical" size={0}>
      <Tag
        color={driverShiftReadingStatusColors[shift.readingStatus]}
        style={{ marginInlineEnd: 0 }}
      >
        {driverShiftReadingStatusLabels[shift.readingStatus]}
      </Tag>
      {shift.noDataReason && <Typography.Text {...SUB}>{shift.noDataReason}</Typography.Text>}
    </Space>
  );
}

export function DriverScheduleModal({
  personId,
  fullName,
  month,
  onMonthChange,
  onClose,
  date,
}: {
  personId: string;
  /** The name from the list row; a link opened without the row waits for the answer's name. */
  fullName: string | null;
  /** The month asked for; `null` — the server's current Moscow month. */
  month: string | null;
  onMonthChange: (month: string) => void;
  onClose: () => void;
  /** The page's snapshot day, kept in the registry link so Back returns to the same day. */
  date: string;
}) {
  const isMobile = useIsMobile();
  const { can } = useAuth();
  const canOpenDay = can('vehicleReadings.read');

  const query = month ? { month } : {};
  const { data, isFetching, isError } = useQuery({
    queryKey: garageKeys.driverSchedule(personId, query),
    queryFn: () => garageApi.driverSchedule(personId, query),
  });

  const shown = data?.month ?? month;
  const step = (delta: number) => {
    if (shown) onMonthChange(shiftMonthKey(shown, delta));
  };

  /** The registry door, or nothing: see the module comment for when a day has none. */
  const dayLink = (shift: GarageDriverShiftDto): ReactNode =>
    canOpenDay && shift.source !== 'no_paper' && shift.readingStatus !== 'upcoming' ? (
      <EntityLink
        to={intakeDayHref(shift.date, shift.reportId, date)}
        title={
          shift.reportId
            ? 'Открыть отчёт дня в приёме показаний'
            : 'Отчёт за день ещё не открывали — приём покажет этот день'
        }
      >
        Отчёт дня
      </EntityLink>
    ) : null;

  const columns: TableColumnType<GarageDriverShiftDto>[] = [
    {
      key: 'date',
      title: 'Дата',
      width: 90,
      render: (_v, r) => dayjs(r.date).format(ROW_DATE),
    },
    { key: 'source', title: 'Смена', width: 190, render: (_v, r) => sourceCell(r) },
    { key: 'vehicle', title: 'Техника', dataIndex: 'vehicleLabel' },
    { key: 'status', title: 'Показания', width: 210, render: (_v, r) => statusCell(r) },
    { key: 'open', title: '', width: 100, render: (_v, r) => dayLink(r) },
  ];

  const summary = data?.summary;
  const header = (
    <Space size={12} wrap>
      <Space size={4}>
        <Button
          icon={<LeftOutlined />}
          aria-label="Предыдущий месяц"
          disabled={!shown}
          onClick={() => step(-1)}
        />
        <Typography.Text strong style={{ minWidth: 120, display: 'inline-block' }}>
          {shown ? monthLabel(shown) : '…'}
        </Typography.Text>
        <Button
          icon={<RightOutlined />}
          aria-label="Следующий месяц"
          disabled={!shown}
          onClick={() => step(1)}
        />
      </Space>
      {/* «Ожидается» counts the days ahead as well: the month's plan, not only its past. */}
      <SummaryBar
        title="Смены"
        items={[
          { label: 'Ожидается', value: summary?.expected ?? 0 },
          { label: 'Передано', value: summary?.submitted ?? 0 },
          { label: 'Не передано', value: summary?.missing ?? 0 },
        ]}
      />
    </Space>
  );

  const shifts = data?.shifts ?? [];
  const empty = isError ? 'График не загрузился' : 'За этот месяц смен нет';

  return (
    <ViewModal
      title={`График — ${fullName ?? data?.fullName ?? 'водитель'}`}
      open
      onClose={onClose}
      width={880}
    >
      <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
        {header}
        {isMobile ? (
          // A phone has no room for five columns: each shift is a short block, read top-down.
          shifts.length === 0 ? (
            <Typography.Text type="secondary">{isFetching ? 'Загрузка…' : empty}</Typography.Text>
          ) : (
            shifts.map((shift) => (
              <Space
                key={shift.key}
                orientation="vertical"
                size={2}
                data-testid="schedule-shift"
                style={{ display: 'flex', borderBottom: '1px solid #f0f0f0', paddingBottom: 8 }}
              >
                <Space size={8} wrap>
                  <Typography.Text strong>{dayjs(shift.date).format(ROW_DATE)}</Typography.Text>
                  {statusCell(shift)}
                </Space>
                {sourceCell(shift)}
                <Typography.Text {...SUB}>{shift.vehicleLabel}</Typography.Text>
                {dayLink(shift)}
              </Space>
            ))
          )
        ) : (
          <Table<GarageDriverShiftDto>
            rowKey="key"
            size="small"
            columns={columns}
            dataSource={shifts}
            loading={isFetching}
            pagination={false}
            locale={{ emptyText: empty }}
            scroll={{ y: 'min(60vh, 560px)' }}
          />
        )}
      </Space>
    </ViewModal>
  );
}
