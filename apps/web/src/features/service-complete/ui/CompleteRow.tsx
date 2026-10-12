import { Checkbox, Col, DatePicker, Form, InputNumber, Row, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { FieldAddons } from '@shared/ui';
import type { FactRow } from '../model/fact';
import { factRowRule } from '../model/completeRules';

const DATE = 'YYYY-MM-DD';

/*
 * The warranty date is held as `YYYY-MM-DD` — the shape of `FactRow` and of the closing body — and
 * only shown as a date: a `Dayjs` in the store would need a second translation on the way out, and
 * the body test pins that the server receives exactly the string it always did.
 */
const warrantyProps = (value: string | null | undefined) => ({
  value: value ? dayjs(value) : null,
});
const warrantyValue = (date: Dayjs | null) => (date ? date.format(DATE) : null);

/**
 * One closing row (§9.3): the "performed" mark, the actual quantity and the warranty date of a
 * row of the agreed estimate. `name` is the row's index in the `rows` list of the form; `row` is
 * the same row as the window watches it, for the labels and the disabled state.
 *
 * An unchecked mark does not remove the row, it greys it out: the agreed item has not gone
 * anywhere — it was said to be "not needed". So the fields switch off, the row stays visible and
 * goes to the server with `performed: false`.
 */
export function CompleteRow({ name, row }: { name: number; row: FactRow }) {
  return (
    <Row gutter={8} align="middle" style={{ marginTop: 8 }}>
      <Col xs={24} sm={10}>
        <Form.Item name={[name, 'performed']} valuePropName="checked" noStyle>
          <Checkbox>{row.name}</Checkbox>
        </Form.Item>
      </Col>
      <Col xs={10} sm={5}>
        <Form.Item
          name={[name, 'actualQuantity']}
          rules={[factRowRule(name)]}
          // Unchecking the row withdraws its fact from the check: without the dependency an
          // "enter the quantity" mark would stay on a field the person has just switched off.
          dependencies={[['rows', name, 'performed']]}
          style={{ marginBottom: 0 }}
        >
          <FieldAddons before="факт">
            <InputNumber
              style={{ width: '100%' }}
              min={0.01}
              // Never above the agreed quantity: a price rise goes through reopening the
              // estimate, not through closing the work, so the upper bound sits in the field.
              max={row.quantity}
              disabled={!row.performed}
              aria-label={`Фактическое количество: ${row.name}`}
            />
          </FieldAddons>
        </Form.Item>
      </Col>
      <Col xs={14} sm={9}>
        {/* The slip's date: empty — the server counts it from the work date and the promised term. */}
        <Form.Item
          name={[name, 'warrantyUntil']}
          noStyle
          getValueProps={warrantyProps}
          normalize={warrantyValue}
        >
          <DatePicker
            style={{ width: '100%' }}
            format="DD.MM.YYYY"
            disabled={!row.performed}
            placeholder={
              row.warrantyMonths ? `гарантия ${row.warrantyMonths} мес.` : 'гарантия по талону'
            }
            aria-label={`Гарантия до: ${row.name}`}
          />
        </Form.Item>
      </Col>
      <Col span={24}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          согласовано {row.quantity} ×{' '}
          {row.unitPrice.toLocaleString('ru-RU', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}{' '}
          ₽
        </Typography.Text>
      </Col>
    </Row>
  );
}
