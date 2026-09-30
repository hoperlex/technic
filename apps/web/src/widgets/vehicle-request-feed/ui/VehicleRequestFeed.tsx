import { Button, Space } from 'antd';
import { NodeIndexOutlined, PlusOutlined } from '@ant-design/icons';
import { requestStatusLabels } from '@technic/contracts';
import { DataTable, PageTableLayout, sortOptionsFrom, SummaryBar, TabsExtra } from '@shared/ui';
import type { VehicleRequestFeedProps, VehicleRequestFeedRow } from '../model/types';
import { vehicleRequestFeedCard } from './feedCard';
import { vehicleRequestFeedColumns } from './feedColumns';
import { VehicleRequestFeedFilterBar, vehicleRequestFeedMobileFilters } from './feedFilters';

const rowId = (row: VehicleRequestFeedProps['rows'][number]): string =>
  row.kind === 'order' ? row.order.id : row.weekly.id;

/**
 * Complete visual shell of the vehicle-request feed. Data fetching and commands stay in the page;
 * this widget owns their desktop/mobile composition and exposes no page internals.
 */
export function VehicleRequestFeed({
  actions,
  children,
  filters,
  list,
  loading,
  pending,
  rights,
  rows: sourceRows,
  summary,
  total,
}: VehicleRequestFeedProps) {
  const rows: VehicleRequestFeedRow[] = sourceRows.map((row) => ({ ...row, id: rowId(row) }));
  const columns = vehicleRequestFeedColumns({ actions, pending, rights });
  const card = vehicleRequestFeedCard({ actions, pending, rights });

  return (
    <PageTableLayout
      filters={<VehicleRequestFeedFilterBar filters={filters} />}
      extra={
        rights.canCreate || rights.canCreateWeekly || rights.showRoutes ? (
          <Space size={8} wrap>
            {rights.showRoutes && (
              <Button icon={<NodeIndexOutlined />} onClick={actions.openRoutes}>
                Маршруты
              </Button>
            )}
            {rights.canCreateWeekly && (
              <Button icon={<PlusOutlined />} onClick={actions.createWeekly}>
                Заявка на неделю
              </Button>
            )}
            {rights.canCreate && (
              <Button type="primary" icon={<PlusOutlined />} onClick={actions.create}>
                Создать заявку
              </Button>
            )}
          </Space>
        ) : null
      }
      mobile={{
        filters: vehicleRequestFeedMobileFilters(filters),
        sort: {
          options: sortOptionsFrom(columns, { num: 'Номер документа' }),
          sortBy: list.sortBy,
          sortOrder: list.sortOrder,
          onChange: list.onSortChange,
        },
        // Weekly composition editing is a desktop workflow; the single phone FAB remains the
        // ordinary order, while routes stay in secondary list actions.
        primaryAction: rights.canCreate
          ? { label: 'Создать заявку', icon: <PlusOutlined />, onClick: actions.create }
          : undefined,
        secondaryActions: rights.showRoutes
          ? [{ label: 'Маршруты', icon: <NodeIndexOutlined />, onClick: actions.openRoutes }]
          : undefined,
      }}
    >
      <TabsExtra tabKey="requests">
        <SummaryBar
          title="Заявок"
          items={[
            { label: 'Не обработанных', value: summary.new },
            { label: 'Ждут визы', value: summary.awaitingApproval },
            { label: requestStatusLabels.confirmed, value: summary.confirmed },
            { label: 'Недельных ждут визы', value: summary.weeklyPending },
          ]}
        />
      </TabsExtra>

      <DataTable<VehicleRequestFeedRow>
        columns={columns}
        card={card}
        onRowClick={(row) =>
          row.kind === 'weekly' ? actions.openWeekly(row.weekly) : actions.openOrder(row.order)
        }
        data={rows}
        total={total}
        loading={loading}
        page={list.page}
        pageSize={list.pageSize}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onChange={list.onChange}
      />
      {children}
    </PageTableLayout>
  );
}
