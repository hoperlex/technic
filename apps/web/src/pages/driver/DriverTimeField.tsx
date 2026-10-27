import { Button, Input, Typography } from 'antd';
import dayjs from 'dayjs';
import { normalizeTimeInput } from '@technic/contracts';
import { fieldLabelStyle, hintStyle, keepVisible } from './readingFieldStyles';

/**
 * A time field of the cabinet: typed, or set in one tap by «сейчас» (ADR 0234; owner decision D9,
 * variant A of the mock-ups with a "now" button).
 *
 * The button is the whole point of D9: a driver who marks the day as it goes taps once at the
 * moment, and a driver who submits in the evening types from memory into the same field. There is
 * no "shift running" state behind it — the button writes the current time into the draft like a
 * keystroke would, and the field stays editable.
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
      <div style={{ display: 'flex', gap: 8 }}>
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
        {/* Large, as the submit button: the theme gives it 60 px — well over the 44 px touch
            target a gloved finger needs. The device's local time is the time of the event. */}
        <Button
          size="large"
          disabled={disabled}
          aria-label={`${label}: сейчас`}
          onClick={(e) => {
            // Inside a `label`, a click would also focus the input and pop the keyboard up.
            e.preventDefault();
            onChange(dayjs().format('HH:mm'));
          }}
        >
          сейчас
        </Button>
      </div>
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
