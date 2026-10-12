import {
  cloneElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { Form, Space } from 'antd';

type CellProps = ComponentProps<typeof Space.Addon>;

/** What the cells copy from the control, exactly as antd did for the old props. */
interface ControlLook {
  disabled?: boolean;
  variant?: CellProps['variant'];
  status?: CellProps['status'];
}

export interface FieldAddonsProps {
  /** Text in a cell glued to the start of the control ("шт", "факт"). */
  before?: ReactNode;
  /** Text in a cell glued to the end of the control ("₽", "дн."). */
  after?: ReactNode;
  /** The one control, e.g. `InputNumber`. */
  children: ReactElement<ControlLook>;
}

/**
 * A control with text cells glued to it, for a field that lives under a `Form.Item`.
 *
 * antd 6 deprecates `addonBefore`/`addonAfter` for `Space.Compact`, and antd 6.5 already renders
 * the old props as exactly that: `Space.Compact` > `Space.Addon` + control + `Space.Addon`. This
 * is the same composition written with the public parts, so the field looks and behaves as before
 * and survives the major that drops the props. Written inline under a `Form.Item` it would break
 * in two places, which is why it is a component:
 *
 *  - the value: `Form.Item` hands `value`, `onChange`, `id`, `aria-*` and `ref` to its only child.
 *    Were that child `Space.Compact`, the number would never reach the input; this component takes
 *    them and passes them on to the control, so the form, the label's `for` and the scroll to a
 *    failed field (ADR 0094) keep pointing at the input;
 *  - the error colour: the old addon took the field's validation status and turned red with the
 *    input. `Space.Addon` reads no form context, so the status is read here and handed to it —
 *    without that the cell would stay grey next to a red field.
 *
 * The control is a child rather than built in (an `AddonInputNumber`) because of the bundle:
 * `@shared/ui` is in the entry closure, and importing `InputNumber` here moved it into the first
 * screen of every route (+6.8 KB gzip). `Form` and `Space` are there already.
 *
 * `Form.Item.useStatus` warns outside a `Form.Item`, so a control with no form around it (a row of
 * a hand-held table) writes the composition inline instead; there is no status to carry there.
 */
export function FieldAddons({
  before,
  after,
  children,
  ...fromFormItem
}: FieldAddonsProps & Record<string, unknown>) {
  const { status: itemStatus } = Form.Item.useStatus();
  const own = children.props;
  // The precedence antd itself applies: the control's explicit status wins over the item's one.
  const status = own.status || itemStatus;
  const cell = (content: ReactNode) =>
    content ? (
      <Space.Addon variant={own.variant} disabled={own.disabled} status={status}>
        {content}
      </Space.Addon>
    ) : null;

  return (
    <Space.Compact>
      {cell(before)}
      {cloneElement(children, passOn(fromFormItem, own as Record<string, unknown>))}
      {cell(after)}
    </Space.Compact>
  );
}

/**
 * What `Form.Item` gave this component, for the control. A handler the control also has of its own
 * runs after the form's one, and refs are joined: that is what `Form.Item` does for a direct child,
 * and a plain override would silently drop an `onChange` written on the control.
 */
function passOn(fromFormItem: Record<string, unknown>, own: Record<string, unknown>) {
  const props: Record<string, unknown> = { ...fromFormItem };
  for (const [name, given] of Object.entries(fromFormItem)) {
    const mine = own[name];
    if (name === 'ref') props.ref = joinRefs(given as Ref<unknown>, mine as Ref<unknown>);
    else if (typeof given === 'function' && typeof mine === 'function')
      props[name] = (...args: unknown[]) => {
        given(...args);
        mine(...args);
      };
  }
  return props;
}

function joinRefs(a: Ref<unknown> | undefined, b: Ref<unknown> | undefined): Ref<unknown> {
  if (!a || !b) return a ?? b ?? null;
  return (node: unknown) => {
    for (const ref of [a, b]) {
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    }
  };
}
