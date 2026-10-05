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
          {/* Entry into the recognition audit. On a phone the panel belongs to filters and no
              second round button is added next to "Создать заявку"; there it is a list action. */}
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
          // Captions where the column header is two-line markup.
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
        // The audit entry on a phone: the round button is taken by request creation, and without
        // this action the right holder could open the audit window only from a link.
        secondaryActions: auditAction ? [auditAction] : undefined,
      }}
    >
      {/* The summary sits at tab level, above filters and the button: it is about the whole list,
          not the toolbar, and takes no height from the table there. */}
      <TabsExtra tabKey="requests">
        <SummaryBar
          title="Заявок"
          items={[
            // An operator executes requests rather than processing them (ADR 0010): it has no
            // "Новые", requests reach its list already moved into work.
            ...(rights.isOperator ? [] : [{ label: 'Не обработанных', value: state.summary.new }]),
            { label: requestStatusLabels.confirmed, value: state.summary.confirmed },
            // "Выполнена" is the completion queue (ADR 0135): hauled, but the paperwork is still
            // being reviewed. The number belongs here because the "История" tab does not have such
            // requests, and without it nobody sees how many closures await review.
            { label: requestStatusLabels.done, value: state.summary.done },
          ]}
        />
      </TabsExtra>

      {/* Recognition outage banner here too, not only in the card (Р29): whoever keeps the
          registry expects warnings in the list, and a silent service looks like a calm day from
          here. Asked by the same right as the review itself. */}
      {rights.canReviewTickets && <TicketRecognitionBanner enabled />}

      <DataTable<WasteRequestDto>
        columns={columns}
        card={card}
        // A row click opens the card, the same gesture as tapping a phone card (card.onOpen), as in
        // the waste archive and the vehicle feed. The "Открыть карточку" action button stays: a
        // keyboard cannot reach a row, and cells with active content do not pass the click to the
        // row (opensRow).
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
