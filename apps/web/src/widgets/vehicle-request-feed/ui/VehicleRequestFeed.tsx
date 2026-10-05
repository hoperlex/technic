import { Button, Space } from 'antd';
import { NodeIndexOutlined, PlusOutlined } from '@ant-design/icons';
import { requestStatusLabels } from '@technic/contracts';
import { DataTable, PageTableLayout, sortOptionsFrom, SummaryBar, TabsExtra } from '@shared/ui';
import type { VehicleRequestFeedProps, VehicleRequestFeedRow } from '../model/types';
import { vehicleRequestFeedCard } from './feedCard';
import { vehicleRequestFeedColumns } from './feedColumns';
import { VehicleRequestFeedFilterBar, vehicleRequestFeedMobileFilters } from './feedFilters';

/**
 * DataTable distinguishes rows by one field name, while the discriminated union has no common id
 * field and must not have one: an order and a week are different documents. Both ids are UUIDs
 * from two tables, so the key stays unique across the whole feed.
 */
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
        /* Two entries side by side: an ordinary order and a weekly request. The weekly request is
           not "one more request type" but a basis document over orders
           (docs/adr/0085-weekly-vehicle-request.md), and this list, where those orders are
           visible, is the only place where both questions are decided together. It has its own
           right: the document can now be seen by people who do not create it.

           The routes button creates nothing; it opens the route list as a window (ADR 0120) where
           its tab used to be. It is first and unhighlighted: the main action of the list is the
           order, routes come as an add-on. */
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
        // The only round phone button is the order: a weekly request is assembled at a desk, its
        // composition is edited line by line, which is not phone work.
        primaryAction: rights.canCreate
          ? { label: 'Создать заявку', icon: <PlusOutlined />, onClick: actions.create }
          : undefined,
        // Routes sit next to "Фильтры" on a phone: the desktop extra slot is not rendered there,
        // and the round button is taken by the order. A second round button would read as one
        // more "create" rather than a jump into another list.
        secondaryActions: rights.showRoutes
          ? [{ label: 'Маршруты', icon: <NodeIndexOutlined />, onClick: actions.openRoutes }]
          : undefined,
      }}
    >
      {/* The summary sits at tab level, above filters and buttons: it is about the whole list. */}
      <TabsExtra tabKey="requests">
        <SummaryBar
          title="Заявок"
          items={[
            { label: 'Не обработанных', value: summary.new },
            // A request without approval never moves past "Новая", and statuses alone do not show
            // that (ADR 0025).
            { label: 'Ждут визы', value: summary.awaitingApproval },
            { label: requestStatusLabels.confirmed, value: summary.confirmed },
            // The number the weekly requests once had a separate tab for: the site's week waits
            // for a decision, and terms extend only by approval
            // (docs/adr/0085-weekly-vehicle-request.md, Р6). It is counted over the account's
            // scope, not over the feed filters: like the three numbers before it, it is about
            // pending work, not about the current page of results.
            { label: 'Недельных ждут визы', value: summary.weeklyPending },
          ]}
        />
      </TabsExtra>

      <DataTable<VehicleRequestFeedRow>
        columns={columns}
        card={card}
        // A row click opens the card, the same gesture as tapping a phone card (card.onOpen). The
        // "Открыть карточку" button in the actions column stays: a keyboard cannot reach a row,
        // and cells with active content do not pass the click to the row (opensRow). A weekly row
        // opens no card at all: the week has a separate page with its own address.
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
