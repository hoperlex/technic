import {
  Button,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Typography,
  type FormListFieldData,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { serviceItemKindLabels, type ServiceItemKind } from '@technic/contracts';
import { formatMoney } from '@shared/lib';
import { newEstimateRow, rowAmount, type EstimateRow } from '../model/rows';
import {
  ROWS_LIST_RULES,
  ROW_NAME_RULES,
  ROW_PRICE_RULES,
  ROW_QUANTITY_RULES,
} from '../model/estimateRules';

/** A cell's field sits in the grid row: the form's own bottom gap would push the rows apart. */
const CELL = { marginBottom: 0 };

const nullable = (value: number | null | undefined) => value ?? null;

/**
 * The composition by columns: one `Form.List` shown as two groups.
 *
 * ONE LIST, TWO GROUPS. The body keeps the order in which the rows were added (a part added after a
 * service goes after it), while the screen reads parts and services apart (§9.3). Two lists would
 * reorder the body by group; one list filtered by kind keeps both orders as they were.
 *
 * The kind and the amount are read from the store in render: the window re-renders in the same
 * event on every change of the rows (the editor needs it for the total), so the amount follows
 * each keystroke.
 */
export function EstimateRowsList({ disabled = false }: { disabled?: boolean }) {
  const form = Form.useFormInstance();
  const rowAt = (name: number) => form.getFieldValue(['rows', name]) as EstimateRow | undefined;
  return (
    <Form.List name="rows" rules={ROWS_LIST_RULES}>
      {(fields, { add, remove }, { errors }) => {
        const group = (kind: ServiceItemKind) => (
          <EstimateRowsGroup
            kind={kind}
            fields={fields.filter((field) => rowAt(field.name)?.kind === kind)}
            rowAt={rowAt}
            disabled={disabled}
            onAdd={() => add(newEstimateRow(kind))}
            onRemove={remove}
          />
        );
        return (
          <>
            {group('part')}
            {group('service')}
            {/* "Add at least one row" belongs to the list, not to a cell: it goes under both
                groups. */}
            {errors.length > 0 && (
              <Form.Item style={CELL}>
                <Form.ErrorList errors={errors} />
              </Form.Item>
            )}
          </>
        );
      }}
    </Form.List>
  );
}

/**
 * A group of the scope of work: "Запчасти" or "Услуги" (§9.3). The groups are not for looks — the
 * scope is read by them: the customer asks "which parts" apart from "what does the work cost", and
 * one list mixes the two questions.
 *
 * The row's fields wrap by themselves on a phone (`Row` with other shares on xs and sm): the editor
 * is opened from a phone too — the service types the scope standing at the machine.
 */
function EstimateRowsGroup({
  kind,
  fields,
  rowAt,
  disabled,
  onAdd,
  onRemove,
}: {
  kind: ServiceItemKind;
  fields: FormListFieldData[];
  rowAt: (name: number) => EstimateRow | undefined;
  /**
   * Editing is closed by a pending submission (R9). The fields are disabled, not hidden: the
   * composition stays visible — it is what one decides by whether to take the submission back —
   * but nothing typed in it could be saved, and a live field would promise an edit the server
   * refuses.
   */
  disabled: boolean;
  onAdd: () => void;
  onRemove: (name: number) => void;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <Typography.Text strong>{kind === 'part' ? 'Запчасти' : 'Услуги'}</Typography.Text>
      {fields.length === 0 && (
        <div>
          <Typography.Text type="secondary">
            {kind === 'part' ? 'Деталей не требуется' : 'Работы не заведены'}
          </Typography.Text>
        </div>
      )}
      {fields.map((field) => {
        const row = rowAt(field.name);
        return (
          <Row key={field.key} gutter={8} align="middle" style={{ marginTop: 8 }}>
            <Col xs={24} sm={9}>
              {/* The name is MULTI-LINE and long (plan
                  `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, R1): the limit
                  grew to 2000 characters with line breaks inside — the same field the free mode
                  keeps the contractor's list in. A one-line `Input` would show such an entry
                  through a slit and lose its line breaks on edit.

                  `autoSize` instead of a fixed height: an ordinary row stays one line high, a long
                  one grows up to six — further it scrolls inside the field. The neighbouring
                  columns are centred (`align="middle"`), so a growing field widens the row instead
                  of shifting them. */}
              <Form.Item name={[field.name, 'name']} rules={ROW_NAME_RULES} style={CELL}>
                <Input.TextArea
                  disabled={disabled}
                  maxLength={2000}
                  autoSize={{ minRows: 1, maxRows: 6 }}
                  placeholder={
                    kind === 'part' ? 'Например, ролик подачи' : 'Например, замена узла подачи'
                  }
                  aria-label={`${serviceItemKindLabels[kind]}: наименование`}
                />
              </Form.Item>
            </Col>
            <Col xs={8} sm={3}>
              <Form.Item name={[field.name, 'quantity']} rules={ROW_QUANTITY_RULES} style={CELL}>
                <InputNumber
                  style={{ width: '100%' }}
                  disabled={disabled}
                  min={0.01}
                  max={9999}
                  placeholder="Кол-во"
                  aria-label="Количество"
                />
              </Form.Item>
            </Col>
            <Col xs={8} sm={4}>
              <Form.Item name={[field.name, 'unitPrice']} rules={ROW_PRICE_RULES} style={CELL}>
                <InputNumber
                  style={{ width: '100%' }}
                  disabled={disabled}
                  min={0}
                  max={99_999_999}
                  placeholder="Цена"
                  aria-label="Цена за единицу"
                />
              </Form.Item>
            </Col>
            <Col xs={8} sm={4}>
              {/* A warranty is promised as a term, not a date: the server counts the date from the
                  day the works are done — before the request is closed there is none. */}
              <Form.Item name={[field.name, 'warrantyMonths']} normalize={nullable} style={CELL}>
                <InputNumber
                  style={{ width: '100%' }}
                  disabled={disabled}
                  min={1}
                  max={120}
                  placeholder="Гар., мес."
                  aria-label="Срок гарантии в месяцах"
                />
              </Form.Item>
            </Col>
            <Col xs={16} sm={3} style={{ textAlign: 'right' }}>
              <Typography.Text>{formatMoney(row ? rowAmount(row) : 0)}</Typography.Text>
            </Col>
            <Col xs={8} sm={1} style={{ textAlign: 'right' }}>
              <Button
                type="text"
                danger
                disabled={disabled}
                icon={<DeleteOutlined />}
                aria-label="Удалить строку"
                onClick={() => onRemove(field.name)}
              />
            </Col>
          </Row>
        );
      })}
      <Button
        type="link"
        size="small"
        disabled={disabled}
        icon={<PlusOutlined />}
        style={{ paddingInlineStart: 0, marginTop: 4 }}
        onClick={onAdd}
      >
        {kind === 'part' ? 'Добавить запчасть' : 'Добавить услугу'}
      </Button>
    </div>
  );
}
