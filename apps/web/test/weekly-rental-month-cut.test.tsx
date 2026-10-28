import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WeeklyRequestComposition } from '../src/widgets/weekly-request-workspace/ui/WeeklyRequestComposition';
import type {
  WeeklyOrderDecision,
  WeeklyOrderRow,
} from '../src/widgets/weekly-request-workspace/model/compositionState';

/**
 * The month cut of a rental extension in the composition (ADR 0238): the row says, under the date
 * the person picks, that the visa will stop the existing order at the border and open a new one.
 * The words come from the contracts (`rentalMonthSplitText`), the same the server puts in the visa
 * answer, so the test pins when the note appears, not how it is worded.
 */

const WEEK_START = '2026-11-30';
const WEEK_END = '2026-12-06';

function row(over: Partial<WeeklyOrderRow> = {}): WeeklyOrderRow {
  return {
    requestId: 'vr-1',
    displayNumber: 'ТС-42',
    title: 'Автокран · JCB (аренда)',
    effectiveDateTo: '2026-11-29',
    ownership: 'rental',
    suggestedDateTo: WEEK_END,
    extendBlockedReason: null,
    warnings: [],
    staleReason: null,
    itemId: null,
    ...over,
  };
}

function renderRow(rowValue: WeeklyOrderRow, decision: WeeklyOrderDecision) {
  render(
    <WeeklyRequestComposition
      rows={[rowValue]}
      decisions={{ [rowValue.requestId]: decision }}
      setDecision={() => undefined}
      skipReasons={new Map()}
      weekStart={WEEK_START}
      weekEnd={WEEK_END}
      editable
      suggestion={undefined}
    />,
  );
}

describe('аренда: пометка о разрезе по границе месяца в составе недели', () => {
  it('арендная единица, продлеваемая за границу месяца, получает пометку с обеими частями', () => {
    renderRow(row(), { kind: 'extend', dateTo: WEEK_END });
    expect(
      screen.getByText(
        'Аренда не идёт за границу месяца: заказ продлится до 30.11, а на 01.12–06.12 откроется новый заказ той же машины',
      ),
    ).toBeTruthy();
  });

  it('заказ, кончающийся в последний день месяца, остаётся как есть', () => {
    renderRow(row({ effectiveDateTo: '2026-11-30' }), { kind: 'extend', dateTo: WEEK_END });
    expect(screen.getByText(/заказ остаётся как есть, а на 01\.12–06\.12 откроется/)).toBeTruthy();
  });

  it('продление до границы включительно пометки не даёт', () => {
    renderRow(row(), { kind: 'extend', dateTo: '2026-11-30' });
    expect(screen.queryByText(/Аренда не идёт за границу месяца/)).toBeNull();
  });

  it('собственная техника и решение «уезжает» пометки не получают', () => {
    renderRow(row({ ownership: 'own' }), { kind: 'extend', dateTo: WEEK_END });
    expect(screen.queryByText(/Аренда не идёт за границу месяца/)).toBeNull();
  });

  it('пометка следует за выбранной датой, а серверная — для предложенной — не дублирует её', () => {
    renderRow(
      row({
        warnings: [{ kind: 'rental_month_cut', text: 'СЕРВЕРНАЯ ПОМЕТКА ДЛЯ ПРЕДЛОЖЕННОЙ ДАТЫ' }],
      }),
      { kind: 'extend', dateTo: '2026-12-03' },
    );
    expect(screen.queryByText('СЕРВЕРНАЯ ПОМЕТКА ДЛЯ ПРЕДЛОЖЕННОЙ ДАТЫ')).toBeNull();
    expect(screen.getByText(/на 01\.12–03\.12 откроется новый заказ/)).toBeTruthy();
  });
});
