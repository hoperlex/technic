import type { ReactNode } from 'react';
import { Space, Tooltip, Typography } from 'antd';

/**
 * The metric caption and the card expansion line — one pair for the whole «Аудит талонов» slice.
 *
 * All four row views (summary, accuracy, cohorts, event feed) are built the same way: a table on
 * desktop, cards on a phone, and inside an expanded card the caption on the left and the value on
 * the right. With the pair copied into four files (as it used to be), a change to a gap or a
 * tooltip reached one view out of four.
 */

/**
 * A column title carrying the metric's definition: a number without one reads as knowledge.
 *
 * Without a hint the caption is printed muted: in the event feed «Модель» and «Автор» are not
 * metrics but names of record fields, and there is nothing to define. A tooltip over them would
 * promise an explanation that does not exist.
 */
export function ColumnTitle({ title, hint }: { title: string; hint?: string }) {
  if (hint === undefined) return <Typography.Text type="secondary">{title}</Typography.Text>;
  return (
    <Tooltip title={hint}>
      <span>{title}</span>
    </Tooltip>
  );
}

/**
 * An expansion line: the metric caption on the left, the value on the right — a table cell turned
 * into a column.
 */
export function CardLine({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
      <ColumnTitle title={title} hint={hint} />
      {children}
    </Space>
  );
}
