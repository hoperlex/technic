import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Table } from 'antd';
import { DataTable } from '../src/shared/ui';
import { tableScrollY } from '../src/shared/ui/DataTable';
import { DESKTOP_VIEWPORT, setViewport } from './viewport';

/**
 * The optional summary row of the shared list table (ADR 0209, R6).
 *
 * Two things are checked, both invisible to a page-level test: the summary is PINNED (rc-table pins
 * it only when it receives `Table.Summary fixed` itself — then it is a separate block outside the
 * scrolling body), and the scroll height leaves room for it. The height itself cannot be observed
 * in jsdom — `ResizeObserver` is a stub there and the container is 0 px high — so the formula is a
 * pure function and is checked directly.
 */

interface Row {
  id: string;
  name: string;
  amount: number;
}

const ROWS: Row[] = [
  { id: 'r1', name: 'Площадка 1', amount: 10 },
  { id: 'r2', name: 'Площадка 2', amount: 20 },
];

const columns = [
  { key: 'name', title: 'Площадка', dataIndex: 'name', width: 160 },
  { key: 'amount', title: 'Сумма', dataIndex: 'amount', width: 120 },
];

function renderTable(summary?: ReactNode) {
  return render(
    <DataTable<Row>
      columns={columns}
      data={ROWS}
      total={ROWS.length}
      page={1}
      pageSize={50}
      onChange={vi.fn()}
      summary={summary}
    />,
  );
}

afterEach(() => setViewport(DESKTOP_VIEWPORT));

describe('DataTable: summary row', () => {
  it('a Table.Summary fixed from the page is pinned outside the scrolling body', () => {
    setViewport(DESKTOP_VIEWPORT);
    const { container } = renderTable(
      <Table.Summary fixed>
        <Table.Summary.Row>
          <Table.Summary.Cell index={0}>Итого</Table.Summary.Cell>
          <Table.Summary.Cell index={1}>30</Table.Summary.Cell>
        </Table.Summary.Row>
      </Table.Summary>,
    );
    const pinned = container.querySelector('div.ant-table-summary');
    expect(pinned?.textContent).toContain('Итого');
    // Not a footer inside the body: the body table has no summary of its own.
    expect(container.querySelector('.ant-table-body .ant-table-summary')).toBeNull();
  });

  it('without a summary the table renders as before', () => {
    setViewport(DESKTOP_VIEWPORT);
    const { container } = renderTable();
    expect(container.querySelector('.ant-table-summary')).toBeNull();
  });
});

describe('DataTable: scroll height', () => {
  it('subtracts the header, the pagination and the measured summary', () => {
    // 600 − 47 (header) − 64 (pagination) = 489; a two-line summary of 80 px leaves 409.
    expect(tableScrollY(600, 0)).toBe(489);
    expect(tableScrollY(600, 80)).toBe(409);
  });

  it('never goes below the floor of 160 px', () => {
    expect(tableScrollY(0, 0)).toBe(160);
    expect(tableScrollY(300, 200)).toBe(160);
  });
});
