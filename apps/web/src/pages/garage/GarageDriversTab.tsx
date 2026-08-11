import type { ReactNode } from 'react';
import { Select, Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  driverDocumentGapLabel,
  formatPhone,
  GARAGE_DRIVER_STATES,
  type GarageDriverDto,
  garageDriverStateColors,
  garageDriverStateLabels,
  type GarageDriverState,
} from '@technic/contracts';
import { garageApi, garageKeys } from '@entities/garage';
import { DataTable, type CardConfig } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { SummaryBar } from '@shared/ui';
import { textColumn } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { TabsExtra } from '../../components/PageTabs';
import { formatDateOnly } from '../../utils/date';
import { BusyCell, busyLine } from './shared';

/**
 * Гараж → «Водители»: кто из действующих водителей занят в выбранный день, а кто свободен
 * (ADR 0076).
 *
 * Перечень тот же, что в справочнике: человек с действующей специализацией водителя. Пробелы
 * комплекта документов считаются **на выбранный день** и идут пометкой, а не фильтром по
 * умолчанию (ADR 0064): они говорят, какие графы бланка останутся пустыми, а не запрещают работу.
 */

const STATE_OPTIONS = GARAGE_DRIVER_STATES.map((state) => ({
  value: state,
  label: garageDriverStateLabels[state],
}));

const DOCUMENT_OPTIONS = [
  { value: 'complete', label: 'Комплект полный' },
  { value: 'incomplete', label: 'Есть пробелы' },
];

/**
 * Чего не хватает для листа: тег с расшифровкой — теми же словами, что в справочнике. Документ
 * назван своим именем (ADR 0095): за экскаватор садятся по удостоверению тракториста-машиниста, и
 * «нет действующего ВУ» отправило бы искать не ту бумагу.
 */
function gapsTag(r: GarageDriverDto) {
  if (r.gaps.length === 0) return null;
  return (
    <Tooltip
      title={r.gaps.map((gap) => driverDocumentGapLabel(gap, r.credentialTypeCode)).join('; ')}
    >
      <Tag color="orange" style={{ marginInlineEnd: 0 }}>
        документы: {r.gaps.length}
      </Tag>
    </Tooltip>
  );
}

export function GarageDriversTab({
  date,
  dayControls,
}: {
  /** День среза: общий у обеих вкладок, приходит от страницы вместе с органами управления им. */
  date: string;
  dayControls: ReactNode;
}) {
  const { params, setParams, setSort, onTableChange } = useListParams<{
    state?: GarageDriverState;
    documents?: 'complete' | 'incomplete';
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }>({ sortBy: 'state', sortOrder: 'asc' }, { searchKeys: ['fullName'] });

  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const query = { ...params, on: date };
  const { data, isFetching } = useQuery({
    queryKey: garageKeys.drivers(query),
    queryFn: () => garageApi.drivers(query),
  });

  // Сводка не сужается ни состоянием, ни комплектом: обе цифры — её собственные ответы.
  const summaryQuery = { ...query, state: undefined, documents: undefined };
  const { data: summary } = useQuery({
    queryKey: garageKeys.driversSummary(summaryQuery),
    queryFn: () => garageApi.driversSummary(summaryQuery),
  });

  const summaryItems = [
    { label: 'Водителей', value: summary?.total ?? 0 },
    { label: 'Свободны', value: summary?.free ?? 0 },
    { label: 'Назначены', value: summary?.assigned ?? 0 },
    { label: 'Документы неполны', value: summary?.documentsIncomplete ?? 0 },
  ];

  const columns: TableColumnType<GarageDriverDto>[] = [
    {
      ...textColumn<GarageDriverDto>({
        key: 'fullName',
        title: 'Водитель',
        dataIndex: 'fullName',
        width: 240,
        render: (_v, r) => (
          <Space direction="vertical" size={0}>
            <span>{r.fullName}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {[r.personnelNo ? `таб. № ${r.personnelNo}` : null, formatPhone(r.phone) || null]
                .filter(Boolean)
                .join(' · ')}
            </Typography.Text>
          </Space>
        ),
      }),
    },
    {
      // Удостоверением не сортируют: спрашивают его строкой — по какому документу выпишется лист
      // и до какого числа он годен.
      key: 'license',
      title: 'Удостоверение',
      width: 190,
      render: (_v, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.categories.length > 0 ? r.categories.join(', ') : '—'}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {[
              r.licenseNumber || null,
              r.licenseExpiresOn ? `до ${formatDateOnly(r.licenseExpiresOn)}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Typography.Text>
        </Space>
      ),
    },
    {
      key: 'state',
      title: 'Состояние',
      width: 140,
      sorter: true,
      defaultSortOrder: 'ascend',
      render: (_v, r) => (
        <Space direction="vertical" size={2}>
          <Tag color={garageDriverStateColors[r.state]} style={{ marginInlineEnd: 0 }}>
            {garageDriverStateLabels[r.state]}
          </Tag>
          {gapsTag(r)}
        </Space>
      ),
    },
    {
      key: 'busy',
      title: 'Занятость',
      // Машина у каждой занятости своя — здесь её и называют: колонки техники на этой вкладке нет.
      render: (_v, r) => <BusyCell entries={r.busy} showVehicle />,
    },
  ];

  const filters = (
    <Space size={[12, 8]} wrap>
      <Select<GarageDriverState>
        allowClear
        placeholder="Любое состояние"
        style={{ width: 180 }}
        options={STATE_OPTIONS}
        value={params.state}
        onChange={(v) => applyFilter({ state: v })}
      />
      <Select<'complete' | 'incomplete'>
        allowClear
        placeholder="Любые документы"
        style={{ width: 190 }}
        options={DOCUMENT_OPTIONS}
        value={params.documents}
        onChange={(v) => applyFilter({ documents: v })}
      />
    </Space>
  );

  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'state',
      label: 'Состояние',
      value: params.state,
      options: [...STATE_OPTIONS],
      placeholder: 'Любое состояние',
      onChange: (v) => applyFilter({ state: v as GarageDriverState | undefined }),
    },
    {
      kind: 'select',
      key: 'documents',
      label: 'Документы',
      value: params.documents,
      options: DOCUMENT_OPTIONS,
      placeholder: 'Любые документы',
      onChange: (v) => applyFilter({ documents: v as 'complete' | 'incomplete' | undefined }),
    },
  ];

  const card: CardConfig<GarageDriverDto> = {
    title: (r) => r.fullName,
    badge: (r) => (
      <Tag color={garageDriverStateColors[r.state]}>{garageDriverStateLabels[r.state]}</Tag>
    ),
    primary: (r) => (r.categories.length > 0 ? r.categories.join(', ') : '—'),
    lines: [
      (r) => (r.busy.length === 0 ? 'на этот день ничего не назначено' : null),
      ...Array.from({ length: 3 }, (_, i) => (r: GarageDriverDto) => {
        const entry = r.busy[i];
        return entry ? `${entry.vehicleLabel} · ${busyLine(entry)}` : null;
      }),
      (r) =>
        r.gaps.length === 0
          ? null
          : r.gaps.map((gap) => driverDocumentGapLabel(gap, r.credentialTypeCode)).join('; '),
    ],
  };

  return (
    <PageTableLayout
      filters={filters}
      mobile={{
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { fullName: 'ФИО', state: 'Состояние' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      <TabsExtra tabKey="drivers">
        <Space size={12} wrap>
          {dayControls}
          <SummaryBar title="Водители" items={summaryItems} />
        </Space>
      </TabsExtra>

      <DataTable<GarageDriverDto>
        columns={columns}
        rowKey="personId"
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
      />
    </PageTableLayout>
  );
}
