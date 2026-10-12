import { Form } from 'antd';
import type { FactRow } from '../model/fact';
import { CompleteRow } from './CompleteRow';

/**
 * The closing rows as the `rows` list of the form (§9.3). The list is fixed — the rows are the
 * agreed estimate, closing neither adds nor removes any — so there are no list operations here,
 * only one `CompleteRow` per row.
 *
 * `rows` is the watched value of the same list: the form store holds the row's agreed quantity,
 * price and name next to its fact, but a field never sees the keys it does not edit, and the row
 * needs them for its labels and its disabled state. A field index the watch has not caught up
 * with yet (the store is reset by an effect, the watch follows a render later) renders nothing for
 * that one render instead of a row without a name.
 */
export function CompleteRows({ rows }: { rows: readonly FactRow[] }) {
  return (
    <Form.List name="rows">
      {(fields) => (
        <div>
          {fields.map((field) => {
            const row = rows[field.name];
            return row ? <CompleteRow key={field.key} name={field.name} row={row} /> : null;
          })}
        </div>
      )}
    </Form.List>
  );
}
