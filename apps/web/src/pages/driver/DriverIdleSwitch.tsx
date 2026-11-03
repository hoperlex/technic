import { Radio, Switch, Typography } from 'antd';
import { IDLE_REASONS, idleReasonLabels, type IdleReason } from '@technic/contracts';
import { fieldLabelStyle } from './readingFieldStyles';

/**
 * «Не работал» of one vehicle block (ADR 0244, owner decisions D3, D4): a switch, and the reason
 * from the list once it is on. Per block, not per day — a driver with two vehicles closes only the
 * one that stood, and two shifts of one vehicle are answered apart.
 *
 * The switch hides the numbers and times without erasing them (they come back when it is off), and
 * «Другое» asks for its word in the block's ordinary comment, which the block relabels.
 */
export function IdleSwitch({
  idle,
  reason,
  error,
  disabled,
  onChange,
}: {
  idle: boolean;
  reason: IdleReason | '';
  error?: string;
  disabled: boolean;
  onChange: (patch: { idle?: boolean; idleReason?: IdleReason }) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Switch
          checked={idle}
          disabled={disabled}
          onChange={(checked) => onChange({ idle: checked })}
        />
        <Typography.Text>Не работал</Typography.Text>
      </label>
      {idle && (
        <div>
          <Typography.Text style={fieldLabelStyle}>Причина</Typography.Text>
          <Radio.Group
            value={reason || undefined}
            disabled={disabled}
            onChange={(e) => onChange({ idleReason: e.target.value as IdleReason })}
            style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            options={IDLE_REASONS.map((value) => ({ value, label: idleReasonLabels[value] }))}
          />
          {error && <Typography.Text type="danger">{error}</Typography.Text>}
        </div>
      )}
    </div>
  );
}
