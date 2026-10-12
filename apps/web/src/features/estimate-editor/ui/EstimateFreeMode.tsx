import { Form, Input, InputNumber, Segmented, Tooltip, Typography } from 'antd';
import { fitsFreeMode, type EstimateMode, type EstimateRow } from '../model/rows';
import { FREE_NAME_RULES, FREE_PRICE_RULES } from '../model/estimateRules';

/**
 * Why "Одной строкой" is unavailable — in the words the plan states the rule in (R8). A tooltip,
 * not silence: a disabled switch without an explanation reads as a broken window.
 */
const GLUE_LOCKED_HINT =
  'Свернуть в одну запись нечего: в объёме работ больше одной строки либо у единственной стоит ' +
  'запчасть, срок гарантии, количество не единица или нулевая стоимость. Свободная запись — это ' +
  'описание и цена всего заказа: остальное склейка потеряла бы молча, а ноль читался бы в ней как ' +
  '«работы бесплатны» вместо «стоимость не проставили».';

/**
 * The switch of the input mode (plan
 * `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, R1 and R8).
 *
 * ONE OF THE TWO ROADS CLOSES, AND IT IS ALWAYS THE SAME ONE. "По графам" is open from the free
 * mode unconditionally — unfolding loses nothing. Back is let only by `fitsFreeMode`: the free
 * record has two fields, and whatever does not fit in them — the kind "Запчасть", a warranty term,
 * a quantity, a second row — would vanish on folding without a single question.
 *
 * The disabled item stays VISIBLE: hidden, it would read as "there is no such mode", and a person
 * who typed the estimate by columns would not understand where the contractor's letter, typed
 * freely an hour ago, has gone.
 */
export function EstimateModeSwitch({
  mode,
  rows,
  disabled = false,
  onChange,
}: {
  mode: EstimateMode;
  /** What is typed right now: it decides whether the road back is open. */
  rows: readonly EstimateRow[];
  /** Editing is closed by a pending submission (R9) — the mode is not changed then either. */
  disabled?: boolean;
  onChange: (next: EstimateMode) => void;
}) {
  const mayGlue = fitsFreeMode(rows);
  return (
    <Segmented<EstimateMode>
      value={mode}
      disabled={disabled}
      onChange={onChange}
      options={[
        {
          value: 'free',
          disabled: !mayGlue,
          label: mayGlue ? (
            'Одной строкой'
          ) : (
            // The tooltip hangs on the caption, not on the item: a disabled `Segmented` item gives
            // no mouse events, and a tooltip on it would never appear.
            <Tooltip title={GLUE_LOCKED_HINT}>
              <span>Одной строкой</span>
            </Tooltip>
          ),
        },
        { value: 'rows', label: 'По графам' },
      ]}
    />
  );
}

/**
 * The free input of the scope of work: the description of the list and the price of the whole
 * order (R1, customer answers V1 and V10 of 09.09.2026).
 *
 * TWO FIELDS, NOT A TABLE OF ONE ROW. The contractor sends the scope in a letter: a list of items
 * with quantities and one sum for all of it. It cannot be broken down by columns without inventing
 * prices — the letter has none — and a table with "Кол-во" and "Цена" columns invites exactly that.
 * So the mode has its own look: what the person carries over, and what was agreed.
 *
 * THE DESCRIPTION IS MULTI-LINE AND LONG (2000 characters): a letter's list is five or six lines,
 * and its line breaks are part of the meaning. The counter is there so the limit is not discovered
 * as a cut tail after the save.
 *
 * THE PRICE IS REQUIRED and marked with an asterisk by hand: the headings are the window's own
 * text, not form labels, and the requirement must be visible before the press. Both fields are the
 * first row of the form's `rows` (`['rows', 0, …]`): in the database the free record is that row.
 */
export function EstimateFreeFields({ disabled = false }: { disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <Typography.Text strong>Описание</Typography.Text>
        <Form.Item name={['rows', 0, 'name']} rules={FREE_NAME_RULES} style={{ marginBottom: 0 }}>
          <Input.TextArea
            // A contractor's letter is several lines of a list: a two-line field would make it
            // read through a slit exactly where it is agreed upon.
            autoSize={{ minRows: 5, maxRows: 16 }}
            maxLength={2000}
            showCount
            disabled={disabled}
            placeholder={
              'Что входит в заказ — перечнем, как в письме подрядчика:\n' +
              'Ремонт МФУ (RICOH MP C 2011, № 86228), 1 шт;\n' +
              'Узел фотобарабана в сборе, 2 шт'
            }
            aria-label="Описание объёма работ"
          />
        </Form.Item>
      </div>
      <div>
        <Typography.Text strong>
          Стоимость <Typography.Text type="danger">*</Typography.Text>
        </Typography.Text>
        <Form.Item
          name={['rows', 0, 'unitPrice']}
          rules={FREE_PRICE_RULES}
          style={{ marginBottom: 0 }}
        >
          <InputNumber
            style={{ width: 220 }}
            min={0}
            max={99_999_999}
            disabled={disabled}
            placeholder="Общая стоимость заказа"
            aria-label="Стоимость заказа"
          />
        </Form.Item>
        {/* Said in words, not shown by a refusal: an empty price means "not priced", and a zero in
            its place would write "free" under something nobody counted (answer V10). Zero is lawful
            only for the warranty repair, and that is submitted by a button of its own. */}
        <Typography.Text type="secondary">
          Сумма на весь заказ: по позициям её не раскладывают — так её и присылают. Ноль здесь не
          принимается: он означал бы «не оценено», а работы без оплаты предъявляют гарантийным
          ремонтом.
        </Typography.Text>
      </div>
    </div>
  );
}
