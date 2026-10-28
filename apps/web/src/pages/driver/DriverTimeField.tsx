import { Input, Typography } from 'antd';
import { normalizeTimeInput } from '@technic/contracts';
import { fieldLabelStyle, hintStyle, keepVisible } from './readingFieldStyles';

/**
 * A time field of the cabinet: typed (ADR 0234; ADR 0237 removed the «сейчас» button of owner
 * decision D9).
 *
 * The button marked the moment while the shift ran, but the readings are sent when it ends, so the
 * device's clock at the time of sending is not the time of the event and a tap on it wrote a wrong
 * time more often than a right one. There is no "shift running" state behind the field and none is
 * wanted: the driver types the time he knows.
 *
 * No state of its own: the value lives in the draft, as every number of the block does. A half-typed
 * «73» is stored as typed and normalized to «07:30» when the field loses focus — the same rule
 * (`normalizeTimeInput`) the portal applies to every typed time.
 */
export function TimeField({
  label,
  value,
  hint,
  error,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  hint?: string;
  error?: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const normalize = () => {
    const normalized = normalizeTimeInput(value);
    if (normalized && normalized !== value) onChange(normalized);
  };
  return (
    <label style={{ display: 'block' }}>
      <Typography.Text style={fieldLabelStyle}>{label}</Typography.Text>
      <Input
        className="driver-number"
        // `numeric`: digits are all a time needs, and «730» is read as 07:30 on blur.
        inputMode="numeric"
        size="large"
        placeholder="чч:мм"
        maxLength={5}
        value={value}
        disabled={disabled}
        status={error ? 'error' : undefined}
        onFocus={keepVisible}
        onBlur={normalize}
        onChange={(e) => onChange(e.target.value.replace(/[^\d:]/gu, '').slice(0, 5))}
      />
      {hint && (
        <div>
          <Typography.Text type="secondary" style={hintStyle}>
            {hint}
          </Typography.Text>
        </div>
      )}
      {error && (
        <div>
          <Typography.Text type="danger" style={hintStyle}>
            {error}
          </Typography.Text>
        </div>
      )}
    </label>
  );
}
