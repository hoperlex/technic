import type { ReactNode } from 'react';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import { Table, Tooltip, Typography, type TableColumnsType } from 'antd';
import type { WasteStatsFigures } from '@technic/contracts';
import {
  costNotes,
  costText,
  doneCostWarning,
  plannedNotes,
  ticketWarning,
  volumeText,
  type StatsNote,
  type StatsWarning,
} from './wasteStatsNumbers';

/**
 * Figure columns of the waste "Statistics" tab (ADR 0209): Ordered · Removed · By tickets · Cost.
 * One builder for the site table and the site window — the same figure must look the same on both
 * screens, otherwise people start reconciling them by eye.
 *
 * Width budget (together with the 180 px site column): 1366 px at 125 % Windows scale is 1092 CSS
 * px, minus the 230 px side menu and 2 × 16 px paddings leaves 830; the body gets a vertical
 * scrollbar (~17 px) as soon as it scrolls, so the columns must fit in about 810 — 180 + 120 + 120 +
 * 160 + 230. The cost column is the widest because it carries a figure and two captions, each of
 * which may end with a warning icon ("по талонам 1 234 567,89 ₽" plus the icon is the longest).
 */
export const FIGURES_WIDTH = 120 + 120 + 160 + 230;

/**
 * The warning icon of a figure (ADR 0213). The reasons live in the tooltip, not in the cell: a cell
 * of reservations hid the figures it was reserving.
 *
 * The icon is focusable and the tooltip opens on click as well: a phone has no hover, and a
 * keyboard user would otherwise have no way to read why the figure is marked. The same lines go to
 * `aria-label`, so a screen reader hears them without opening anything.
 */
function WarningMark({ warning }: { warning: StatsWarning }): ReactNode {
  if (warning.length === 0) return null;
  return (
    <Tooltip
      trigger={['hover', 'focus', 'click']}
      title={warning.map((line) => (
        <div key={line}>{line}</div>
      ))}
    >
      <Typography.Text
        type="warning"
        tabIndex={0}
        role="img"
        aria-label={warning.join('. ')}
        style={{ marginLeft: 4, cursor: 'help' }}
      >
        <ExclamationCircleOutlined aria-hidden />
      </Typography.Text>
    </Tooltip>
  );
}

/**
 * A figure in large type and its captions under it, each caption on its own line. The captions are
 * block elements on purpose: inline `Typography.Text` nodes in a row are glued into one string
 * ("…1 500,00 ₽1 без цены"). Keys are the caption names, not their texts.
 */
export function figureCell(
  value: string,
  notes: StatsNote[],
  strong = false,
  warning: StatsWarning = [],
): ReactNode {
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>
        {strong ? <Typography.Text strong>{value}</Typography.Text> : value}
        <WarningMark warning={warning} />
      </div>
      {notes.map((note) => (
        <div key={note.key} style={{ fontSize: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {note.text}
          </Typography.Text>
          <WarningMark warning={note.warning ?? []} />
        </div>
      ))}
    </div>
  );
}

/** The four figure cells of one row, the total included — the table and the window share them. */
function plannedCell(r: WasteStatsFigures, strong = false): ReactNode {
  return figureCell(volumeText(r.plannedVolumeM3), plannedNotes(r), strong);
}

// No caption under the removed volume (decision Z7 of ADR 0209).
function doneCell(r: WasteStatsFigures, strong = false): ReactNode {
  return figureCell(volumeText(r.doneVolumeM3), [], strong);
}

function ticketCell(r: WasteStatsFigures, strong = false): ReactNode {
  return figureCell(volumeText(r.ticketVolumeM3), [], strong, ticketWarning(r));
}

function costCell(r: WasteStatsFigures, strong = false): ReactNode {
  return figureCell(costText(r.doneCost), costNotes(r), strong, doneCostWarning(r));
}

export function figureColumns<T extends WasteStatsFigures>(): TableColumnsType<T> {
  return [
    {
      key: 'planned',
      title: 'Заказано',
      align: 'right',
      width: 120,
      render: (_v, r) => plannedCell(r),
    },
    {
      key: 'done',
      title: 'Вывезено',
      align: 'right',
      width: 120,
      render: (_v, r) => doneCell(r),
    },
    {
      key: 'tickets',
      title: 'По талонам',
      align: 'right',
      width: 160,
      render: (_v, r) => ticketCell(r),
    },
    {
      key: 'cost',
      title: 'Стоимость',
      align: 'right',
      width: 230,
      render: (_v, r) => costCell(r),
    },
  ];
}

/**
 * Cells of the "Итого" row for the four figure columns, starting at column `from`. Only the cells:
 * the caller wraps them into `Table.Summary fixed` itself, because rc-table pins the summary only
 * when the element it gets IS `Table.Summary` with `fixed` — it checks the element type, and a
 * wrapper component would silently turn the pinned row into a footer inside the scroll.
 */
export function figureSummaryCells(totals: WasteStatsFigures, from: number): ReactNode {
  return (
    <>
      <Table.Summary.Cell index={from} align="right">
        {plannedCell(totals, true)}
      </Table.Summary.Cell>
      <Table.Summary.Cell index={from + 1} align="right">
        {doneCell(totals, true)}
      </Table.Summary.Cell>
      <Table.Summary.Cell index={from + 2} align="right">
        {ticketCell(totals, true)}
      </Table.Summary.Cell>
      <Table.Summary.Cell index={from + 3} align="right">
        {costCell(totals, true)}
      </Table.Summary.Cell>
    </>
  );
}
