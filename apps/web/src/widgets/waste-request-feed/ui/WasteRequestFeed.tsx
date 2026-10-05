import { Button, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { requestStatusLabels, type WasteRequestDto } from '@technic/contracts';
import { TicketAuditButton, useTicketAuditMobileAction } from '@features/ticket-audit';
import { TicketRecognitionBanner } from '@features/waste-ticket-review';
import { DataTable, PageTableLayout, sortOptionsFrom, SummaryBar, TabsExtra } from '@shared/ui';
import type { WasteRequestFeedProps } from '../model/types';
import { useWasteRequestFeedState } from '../model/useWasteRequestFeedState';
import { wasteRequestFeedCard } from './feedCard';
import { wasteRequestFeedColumns } from './feedColumns';
import { WasteRequestFeedFilterBar, wasteRequestFeedMobileFilters } from './feedFilters';

/** Complete working-list shell; page-level code supplies commands and operation windows only. */
export function WasteRequestFeed({
  actions,
  children,
  pending,
  rights,
  sources,
}: WasteRequestFeedProps) {
  const state = useWasteRequestFeedState(sources, rights.canReviewTickets);
  const auditAction = useTicketAuditMobileAction(rights.canAuditTickets);
  const columns = wasteRequestFeedColumns({ actions, pending, rights });
  const card = wasteRequestFeedCard({ actions, pending, rights });

  return (
    <PageTableLayout
      filters={<WasteRequestFeedFilterBar options={state.filterOptions} />}
      extra={
        <Space size={8}>
          {/* Desktop has room for a separate audit entry; mobile exposes it as a list action. */}
          <TicketAuditButton allowed={rights.canAuditTickets} />
          {rights.canCreate ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={actions.create}>
              Создать заявку
            </Button>
          ) : null}
        </Space>
      }
      mobile={{
        filters: wasteRequestFeedMobileFilters(state.filterOptions),
        sort: {
          options: sortOptionsFrom(columns, {
            createdAt: 'Дата создания',
            num: 'Номер заявки',
          }),
          sortBy: state.list.sortBy,
          sortOrder: state.list.sortOrder,
          onChange: state.list.onSortChange,
        },
        primaryAction: rights.canCreate
          ? { label: 'Создать заявку', icon: <PlusOutlined />, onClick: actions.create }
          : undefined,
        secondaryActions: auditAction ? [auditAction] : undefined,
      }}
    >
      <TabsExtra tabKey="requests">
        <SummaryBar
          title="Заявок"
          items={[
            ...(rights.isOperator ? [] : [{ label: 'Не обработанных', value: state.summary.new }]),
            { label: requestStatusLabels.confirmed, value: state.summary.confirmed },
            // Done requests remain in the working list until a reviewer completes the paperwork.
            { label: requestStatusLabels.done, value: state.summary.done },
          ]}
        />
      </TabsExtra>

      {/* Registry-level health must be visible where reviewers expect pending paper to appear. */}
      {rights.canReviewTickets && <TicketRecognitionBanner enabled />}

      <DataTable<WasteRequestDto>
        columns={columns}
        card={card}
        onRowClick={actions.open}
        data={state.rows}
        total={state.total}
        loading={state.loading}
        page={state.list.page}
        pageSize={state.list.pageSize}
        sortBy={state.list.sortBy}
        sortOrder={state.list.sortOrder}
        onChange={state.list.onChange}
      />
      {children}
    </PageTableLayout>
  );
}
