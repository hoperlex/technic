import { Checkbox, Col, DatePicker, InputNumber, Row, Space, Typography } from 'antd';
import dayjs from 'dayjs';
import type { FactRow } from '../model/fact';

const DATE = 'YYYY-MM-DD';

/**
 * Строки закрытия: по каждой — отметка «выполнено» и фактическое количество (§9.3).
 *
 * Снятая отметка не удаляет строку, а гасит её: согласованная позиция никуда не делась — про неё
 * сказано «не понадобилась». Поэтому поля выключаются, а сама строка остаётся видимой и уходит
 * на сервер с `performed: false`.
 */
export function CompleteRows({
  rows,
  onChange,
}: {
  rows: FactRow[];
  onChange: (id: string, patch: Partial<FactRow>) => void;
}) {
  return (
    <div>
      {rows.map((row) => (
        <Row key={row.id} gutter={8} align="middle" style={{ marginTop: 8 }}>
          <Col xs={24} sm={10}>
            <Checkbox
              checked={row.performed}
              onChange={(e) => onChange(row.id, { performed: e.target.checked })}
            >
              {row.name}
            </Checkbox>
          </Col>
          <Col xs={10} sm={5}>
            {/* Inline rather than `AddonInputNumber`: no `Form.Item` here, so the cell has no
                validation status to carry — only the field's own `disabled`. */}
            <Space.Compact>
              <Space.Addon disabled={!row.performed}>факт</Space.Addon>
              <InputNumber
                style={{ width: '100%' }}
                min={0.01}
                // Never above the agreed quantity: a price rise goes through reopening the
                // estimate, not through closing the work, so the upper bound sits in the field.
                max={row.quantity}
                value={row.actualQuantity}
                disabled={!row.performed}
                aria-label={`Фактическое количество: ${row.name}`}
                onChange={(v) => onChange(row.id, { actualQuantity: v })}
              />
            </Space.Compact>
          </Col>
          <Col xs={14} sm={9}>
            {/* Дата из талона: пусто — сервер посчитает её от даты выполнения и обещанного срока. */}
            <DatePicker
              style={{ width: '100%' }}
              format="DD.MM.YYYY"
              value={row.warrantyUntil ? dayjs(row.warrantyUntil) : null}
              disabled={!row.performed}
              placeholder={
                row.warrantyMonths ? `гарантия ${row.warrantyMonths} мес.` : 'гарантия по талону'
              }
              aria-label={`Гарантия до: ${row.name}`}
              onChange={(d) => onChange(row.id, { warrantyUntil: d ? d.format(DATE) : null })}
            />
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
      ))}
    </div>
  );
}
