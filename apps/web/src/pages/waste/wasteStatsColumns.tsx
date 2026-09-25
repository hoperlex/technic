import type { ReactNode } from 'react';
import { Table, Typography, type TableColumnsType } from 'antd';
import type { WasteStatsFigures } from '@technic/contracts';
import {
  confirmedNotes,
  costNotes,
  costText,
  plannedNotes,
  volumeText,
  type StatsNote,
} from './wasteStatsNumbers';

/**
 * Figure columns of the waste "Statistics" tab (ADR 0209): Ordered · Removed · By tickets · Cost.
 * One builder for the site table and the site window — the same figure must look the same on both
 * screens, otherwise people start reconciling them by eye.
 *
 * Width budget (together with the 180 px site column): 1366 px at 125 % Windows scale is 1092 CSS
 * px, minus the 230 px side menu and 2 × 16 px paddings leaves 830; the body gets a vertical
 * scrollbar (~17 px) as soon as it scrolls, so the columns must fit in about 810 — 180 + 120 + 120 +
 * 160 + 230. The cost column is the widest because it carries up to three captions ("план … ₽, без
 * цены … м³" is the longest).
 */
export const FIGURES_WIDTH = 120 + 120 + 160 + 230;

/**
 * A figure in large type and its captions under it, each caption on its own line. The captions are
 * block elements on purpose: inline `Typography.Text` nodes in a row are glued into one string
 * ("…1 500,00 ₽1 без цены"). Keys are the caption names, not their texts — two captions of one
 * cell may read the same ("без цены 5 м³" under two figures).
 */
export function figureCell(value: string, notes: StatsNote[], strong = false): ReactNode {
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>{strong ? <Typography.Text strong>{value}</Typography.Text> : value}</div>
      {notes.map((note) => (
        <Typography.Text key={note.key} type="secondary" style={{ display: 'block', fontSize: 12 }}>
          {note.text}
        </Typography.Text>
      ))}
    </div>
  );
}

export function figureColumns<T extends WasteStatsFigures>(): TableColumnsType<T> {
  return [
    {
      key: 'planned',
      title: 'Заказано',
      align: 'right',
      width: 120,
      render: (_v, r) => figureCell(volumeText(r.plannedVolumeM3), plannedNotes(r)),
    },
    {
      key: 'done',
      title: 'Вывезено',
      align: 'right',
      width: 120,
      // No caption under the removed volume (decision Z7).
      render: (_v, r) => figureCell(volumeText(r.doneVolumeM3), []),
    },
    {
      key: 'confirmed',
      title: 'По талонам',
      align: 'right',
      width: 160,
      render: (_v, r) => figureCell(volumeText(r.confirmedVolumeM3), confirmedNotes(r)),
    },
    {
      key: 'cost',
      title: 'Стоимость',
      align: 'right',
      width: 230,
      render: (_v, r) => figureCell(costText(r.doneCost), costNotes(r)),
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
        {figureCell(volumeText(totals.plannedVolumeM3), plannedNotes(totals), true)}
      </Table.Summary.Cell>
      <Table.Summary.Cell index={from + 1} align="right">
        {figureCell(volumeText(totals.doneVolumeM3), [], true)}
      </Table.Summary.Cell>
      <Table.Summary.Cell index={from + 2} align="right">
        {figureCell(volumeText(totals.confirmedVolumeM3), confirmedNotes(totals), true)}
      </Table.Summary.Cell>
      <Table.Summary.Cell index={from + 3} align="right">
        {figureCell(costText(totals.doneCost), costNotes(totals), true)}
      </Table.Summary.Cell>
    </>
  );
}
