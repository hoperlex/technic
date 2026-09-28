import { useState, type ReactNode } from 'react';
import {
  Button,
  DatePicker,
  Empty,
  Space,
  Table,
  Tooltip,
  Typography,
  type TableColumnsType,
} from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import dayjs from 'dayjs';
import { monthSchema, type WasteStatsFigures, type WasteStatsRowDto } from '@technic/contracts';
import { wasteRequestKeys, wasteRequestsApi } from '@entities/waste-request';
import { DataTable, PageTableLayout, SummaryBar } from '@shared/ui';
import { useIsMobile, useListParams } from '@shared/lib';
import { TabsExtra, useActiveTabKey } from '../../components/PageTabs';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '@entities/object';
import { FIGURES_WIDTH, figureColumns, figureSummaryCells } from './wasteStatsColumns';
import { WasteStatsObjectModal } from './WasteStatsObjectModal';

const MONTH = 'YYYY-MM';

/**
 * The "Итого" row of the site table. A plain function, not a component, and its top node is
 * `Table.Summary fixed` itself: rc-table pins the summary only after checking the element type, and
 * a wrapper component would silently turn the pinned row into a footer inside the scroll.
 */
function totalsSummary(totals: WasteStatsFigures): ReactNode {
  return (
    <Table.Summary fixed>
      <Table.Summary.Row>
        <Table.Summary.Cell index={0}>
          <Typography.Text strong>Итого</Typography.Text>
        </Table.Summary.Cell>
        {figureSummaryCells(totals, 1)}
      </Table.Summary.Row>
    </Table.Summary>
  );
}

/**
 * "Вывоз мусора" → "Статистика": per site and reporting month — how much was ordered, removed and
 * confirmed by tickets, and at what cost (ADR 0193, three-volume columns — ADR 0209).
 *
 * THE SERVER COUNTS, the portal only prints what arrived (R1): the tab and the analytics book take
 * their numbers from one layer, and there is no counting of its own here — not even adding the rows
 * up for the total. That is why the total arrives as a separate field of the response.
 *
 * THE COLUMNS (ADR 0209): Ordered · Removed · By tickets · Cost. The cost is the removed cost; the
 * planned and the confirmed cost are captions under it. Every volume goes with the money of the
 * same requests, and a money figure is a dash, not zero, when none of its volume has a price.
 *
 * NO SCRAP METAL AND NO CONTAINER OPERATIONS (R6): metal is accepted in tonnes and has no money,
 * operations are not billed. A site that had only those in the month does not appear in the tab —
 * its work is visible in "Заявки" and "История".
 */
export function WasteStatsTab() {
  const active = useActiveTabKey() === 'stats';
  const isMobile = useIsMobile();
  const [sp, setSp] = useSearchParams();

  /**
   * The reporting month lives in the address (R9): "statistics for August" is sent as a link, while
   * the tab's state is not — it is lost on reload and on "back".
   *
   * A garbage value does not break the tab: the portal falls back to the current month, and the
   * value never reaches the server. A FUTURE month is valid and is not replaced: a request delivered
   * in September belongs to September and brings its ordered volume there (R2), so the statistics
   * of next month answer "how much is already ordered". Replacing it with the current month would
   * make the only screen answering that question impossible to open.
   */
  const raw = sp.get('month') ?? '';
  /*
   * Validity of the month is asked from the CONTRACT, not from dayjs: `dayjs('2026-13-01')` considers
   * itself a valid date and silently moves the month to January of the next year — the portal would
   * send a value the server rejects by its schema, and the person would get a validation error
   * instead of a screen. The schema is the very one the route checks the request with.
   */
  const month = monthSchema.safeParse(raw).success ? raw : dayjs().format(MONTH);
  /*
   * `tab` is written together with the month on purpose: the page switches tabs via
   * `setSp({ tab })`, i.e. it clears the whole address — losing the month when leaving for "Заявки"
   * is fine, but losing `tab` while changing the month would send the person back to "Заявки" by a
   * click on the calendar.
   */
  const setMonth = (next: string) => setSp({ tab: 'stats', month: next });

  const { params, onTableChange } = useListParams<Record<string, never>>({}, { searchKeys: [] });
  /**
   * The site of the open window is state, not address: the subject of a link here is the month, and
   * the window shows what already came with the table without a request of its own (R11).
   */
  const [openObjectId, setOpenObjectId] = useState<string | null>(null);

  const { data, isFetching } = useQuery({
    queryKey: wasteRequestKeys.stats(month),
    queryFn: () => wasteRequestsApi.stats(month),
    /*
     * Only on its own tab: a hidden tab is not unmounted (`PageTabs`), and without this condition
     * the month would be recounted on the server every time the request list is opened.
     */
    enabled: active,
  });

  /*
   * A new build against an old server — the rollout window or a tab that survived
   * `deploy-auto --previous` — gets a response without the ADR 0209 fields. There is no error
   * boundary in the portal, so printing it would throw in render and blank the whole portal; the
   * tab shows a stub instead. One field is enough: the server always sends all of them together.
   */
  const outdated = data !== undefined && typeof data.totals.doneVolumeM3 !== 'number';

  const rows = outdated ? [] : (data?.rows ?? []);
  // The portal pages the response itself: it arrives whole and is shown with the same content.
  const page = rows.slice((params.page - 1) * params.pageSize, params.page * params.pageSize);
  const totals = data?.totals;
  const opened = rows.find((r) => r.objectId === openObjectId) ?? null;

  // The volumes and the money live in the "Итого" row now (decision Z9): the bar keeps the counts.
  const summaryItems = totals
    ? [
        { label: 'Площадок', value: rows.length },
        { label: 'Заявок', value: totals.requests },
        { label: 'Вывозов', value: totals.removals },
      ]
    : [];

  const columns: TableColumnsType<WasteStatsRowDto> = [
    {
      key: 'name',
      title: 'Площадка',
      width: OBJECT_COLUMN_WIDTH,
      /*
       * The name is the entry to the breakdown: "what are these 412 m3 made of" is asked of it. A
       * button, not a link: the window does not change the address, and a real link would promise
       * navigation.
       */
      render: (_v, r) => (
        <Button
          type="link"
          style={{ padding: 0, height: 'auto', textAlign: 'left' }}
          onClick={() => setOpenObjectId(r.objectId)}
        >
          <ObjectCell name={r.name} hint={r.code} />
        </Button>
      ),
    },
    ...figureColumns<WasteStatsRowDto>(),
  ];

  /*
   * How far the numbers can be trusted (R10): the same counters as the "Data quality" sheet of the
   * book. A table where "confirmed 0 of 340 m3" looks like under-delivery rather than a pile of
   * unreviewed tickets misleads more surely than no table.
   *
   * On the desktop the bar stands ABOVE the table: the table takes 100 % of the height, and under it
   * the bar fell below the `overflow: hidden` of the tabs. On a phone the pinned toolbar would turn
   * five quality rows into a permanent band over the list, so there it stays after the table,
   * inside the scrolling body.
   */
  const qualityBar =
    data && !outdated && data.quality.length > 0 ? (
      <Space size={16} wrap>
        {/*
         * "Of visible requests": the scope and the type filter are part of the query, so these
         * numbers are about the table, not the whole organisation. The same counters in the book
         * have other denominators, and the caption must say so in words.
         */}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          По видимым заявкам вывоза за месяц:
        </Typography.Text>
        {data.quality.map((q) => (
          <Tooltip key={q.key} title={q.note}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {q.label}: {q.value}
              {q.outOf != null ? ` из ${q.outOf}` : ''}
            </Typography.Text>
          </Tooltip>
        ))}
      </Space>
    ) : null;

  return (
    <PageTableLayout toolbar={isMobile ? undefined : qualityBar}>
      <TabsExtra tabKey="stats">
        <Space size={12} wrap>
          <DatePicker
            picker="month"
            allowClear={false}
            /*
             * The format is a string, not a function: a function prints the same "май 2026" but
             * takes the input away — antd parses what was typed by exactly this format, and the
             * calendar would remain the only way to pick a month. The caption equals `monthLabel`.
             */
            format="MMMM YYYY"
            value={dayjs(`${month}-01`)}
            onChange={(v) => {
              if (v) setMonth(v.format(MONTH));
            }}
          />
          <SummaryBar title="Отчётный месяц" items={summaryItems} />
        </Space>
      </TabsExtra>

      {outdated ? (
        <Empty description="Сервер ещё отдаёт статистику в прежнем виде — обновите страницу" />
      ) : (
        <DataTable<WasteStatsRowDto>
          rowKey="objectId"
          columns={columns}
          data={page}
          total={rows.length}
          loading={isFetching}
          page={params.page}
          pageSize={params.pageSize}
          fitWidth={OBJECT_COLUMN_WIDTH + FIGURES_WIDTH}
          // rc-table draws a summary even under an empty table: "Итого 0 м³" under "no data".
          summary={totals && rows.length > 0 ? totalsSummary(totals) : undefined}
          onRowClick={(r) => setOpenObjectId(r.objectId)}
          onChange={onTableChange}
        />
      )}

      {isMobile && qualityBar && <div style={{ padding: '8px 0' }}>{qualityBar}</div>}

      {/*
       * The window is rendered into a portal over the whole page, so only its own tab shows it:
       * without the `active` check, leaving for "Заявки" would leave it hanging over another list.
       */}
      {active && opened && (
        <WasteStatsObjectModal row={opened} month={month} onClose={() => setOpenObjectId(null)} />
      )}
    </PageTableLayout>
  );
}
