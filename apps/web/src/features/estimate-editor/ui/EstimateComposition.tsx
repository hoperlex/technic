import { Space, Typography } from 'antd';
import type { EstimateMode, EstimateRow } from '../model/rows';
import { EstimateFreeFields, EstimateModeSwitch } from './EstimateFreeMode';
import { EstimateRowsList } from './EstimateRows';

/**
 * THE COMPOSITION ON SCREEN: the switch of the input mode, the fields themselves and the total.
 *
 * A piece of its own because it leaves the screen whole for the submission by invoice (R10 of
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`): a document revision has no rows at
 * all, and everything listed — the switch, the columns, the description, the price, the total — is
 * not filled there. Gathered in one place, it is removed by one condition; spread over the window,
 * it would leave behind the price field somebody forgot.
 *
 * THE FIELDS ARE REMOVED, NOT DISABLED, and that is not taste: the window already has a real
 * disabled state — the lock of a pending submission — and it means something else ("take the
 * submission back first"). Two states looking alike would send the person looking for a button
 * that does not exist.
 */
export function EstimateComposition({
  mode,
  rows,
  total,
  disabled = false,
  onSwitchMode,
}: {
  mode: EstimateMode;
  /** The watched rows: the switch decides by them whether the road back is open. */
  rows: readonly EstimateRow[];
  /** The total is counted from the same rows that will leave — they cannot diverge. */
  total: number;
  /** Editing is closed by a pending submission (R9). */
  disabled?: boolean;
  onSwitchMode: (next: EstimateMode) => void;
}) {
  return (
    <>
      {/* The switch stands ABOVE the composition: it changes what is under it, and the input mode
          is decided before typing, not after reading down to the total. */}
      <Space size={8}>
        <Typography.Text type="secondary">Как набрать:</Typography.Text>
        <EstimateModeSwitch mode={mode} rows={rows} disabled={disabled} onChange={onSwitchMode} />
      </Space>

      {mode === 'free' && rows[0] ? (
        <EstimateFreeFields disabled={disabled} />
      ) : (
        <EstimateRowsList disabled={disabled} />
      )}

      {/* The total is a line, not a field: the sum of the rows counts it, and it cannot diverge
          from them. The submission by invoice has none at all, and that is no gap in the markup:
          it has zero rows, and a "0,00 ₽" counted from them would read as the price of the works —
          exactly the error §8 of the plan removes wherever the sum is not known yet. */}
      <Space size={8} style={{ justifyContent: 'flex-end', width: '100%' }}>
        <Typography.Text type="secondary">Итого по объёму работ:</Typography.Text>
        <Typography.Text strong style={{ fontSize: 16 }}>
          {total.toLocaleString('ru-RU', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}{' '}
          ₽
        </Typography.Text>
      </Space>
    </>
  );
}
