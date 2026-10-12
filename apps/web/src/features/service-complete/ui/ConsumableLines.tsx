import { Form } from 'antd';
import { ServiceConsumableFactRows, type ConsumableFactRow } from '@entities/service-request';
import { consumableLineRule } from '../model/completeRules';

/**
 * The issued fact of a consumables request as the `lines` list of the form (R3, §6.2): one form
 * field per line, holding the whole line.
 *
 * The line is drawn by `ServiceConsumableFactRows` of `entities`, not by a row of this feature:
 * the same table serves the fact-correction window, and a second table with the same fields would
 * drift from the first on the first edit. That component is a controlled table of rows, so each
 * line is handed to it as a one-row table, and its `(id, patch)` change becomes the field's new
 * value. The field — not each input — carries the rule, so a fault is named under its line and
 * the scroll of ADR 0094 lands on that line.
 */
export function ConsumableLines() {
  return (
    <Form.List name="lines">
      {(fields) => (
        <div>
          {fields.map((field) => (
            <Form.Item
              key={field.key}
              name={field.name}
              rules={[consumableLineRule]}
              style={{ marginBottom: 0 }}
            >
              <ConsumableLineField />
            </Form.Item>
          ))}
        </div>
      )}
    </Form.List>
  );
}

/**
 * A custom form control: `Form.Item` passes `value`, `onChange` and `id`. The `id` goes on the
 * wrapper, because `scrollToField` finds a field without an input ref by that id.
 */
function ConsumableLineField({
  id,
  value,
  onChange,
}: {
  id?: string;
  value?: ConsumableFactRow;
  onChange?: (line: ConsumableFactRow) => void;
}) {
  if (!value) return null;
  return (
    <div id={id}>
      <ServiceConsumableFactRows
        rows={[value]}
        onChange={(_, patch) => onChange?.({ ...value, ...patch })}
      />
    </div>
  );
}
