import type { ComponentProps, ReactNode } from 'react';
import { Form, InputNumber, Space, type InputNumberProps } from 'antd';

type NumberValue = string | number;

export type AddonInputNumberProps<T extends NumberValue = NumberValue> = Omit<
  InputNumberProps<T>,
  'addonBefore' | 'addonAfter'
> & {
  /** Text in a cell glued to the start of the field ("шт", "факт"). */
  before?: ReactNode;
  /** Text in a cell glued to the end of the field ("₽", "дн."). */
  after?: ReactNode;
  ref?: ComponentProps<typeof InputNumber>['ref'];
};

/**
 * `InputNumber` with a text cell glued to it, for a field that lives under a `Form.Item`.
 *
 * antd 6 deprecates `addonBefore`/`addonAfter` for `Space.Compact`, and antd 6.5 already renders
 * the old props as exactly that: `Space.Compact` > `Space.Addon` + `InputNumber` + `Space.Addon`.
 * This component is that same composition written with the public parts, so the field looks and
 * behaves as before and survives the major that drops the props. Written inline under a
 * `Form.Item` it would break in two places, which is why it is a component:
 *
 *  - the value: `Form.Item` hands `value`, `onChange`, `id` and `ref` to its only child. Were that
 *    child `Space.Compact`, the number would never reach the input; this component takes them and
 *    passes them on to `InputNumber`, so the form, the label's `for` and the scroll to a failed
 *    field (ADR 0094) keep pointing at the input;
 *  - the error colour: the old addon took the field's validation status and turned red with the
 *    input. `Space.Addon` reads no form context, so the status is read here and handed to it —
 *    without that the cell would stay grey next to a red field.
 *
 * `Form.Item.useStatus` warns outside a `Form.Item`, so a field with no form around it (a row of
 * a hand-held table) writes the composition inline instead; there is no status to carry there.
 */
export function AddonInputNumber<T extends NumberValue = NumberValue>({
  before,
  after,
  rootClassName,
  ...props
}: AddonInputNumberProps<T>) {
  const { status: itemStatus } = Form.Item.useStatus();
  // The precedence antd itself applies: an explicit status wins over the form item's one.
  const status = props.status || itemStatus;
  const addon = (content: ReactNode) =>
    content ? (
      <Space.Addon variant={props.variant} disabled={props.disabled} status={status}>
        {content}
      </Space.Addon>
    ) : null;

  return (
    // `rootClassName` belongs to the whole group, as with the old props: antd put it on the
    // compact wrapper, not on the input.
    <Space.Compact rootClassName={rootClassName}>
      {addon(before)}
      <InputNumber<T> {...props} />
      {addon(after)}
    </Space.Compact>
  );
}
