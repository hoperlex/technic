import { Button, Col, Input, InputNumber, Row, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { serviceItemKindLabels, type ServiceItemKind } from '@technic/contracts';
import { rowAmount, type EstimateRow } from '../model/rows';

/** Денежная сумма в строке редактора: тот же вид, что в карточке заявки и в смете на согласовании. */
function money(value: number): string {
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Группа сметы: «Запчасти» или «Услуги» (§9.3). Группы разведены не для красоты — по ним читают
 * смету: заказчик спрашивает «что за детали» отдельно от «сколько стоит работа», и в общем
 * списке эти два вопроса перемешиваются.
 *
 * Поля строки на телефоне переносятся сами (`Row` с разными долями на xs и sm): редактор
 * открывают и с телефона — сервис вводит смету, стоя у аппарата.
 */
export function EstimateRowsGroup({
  kind,
  rows,
  onAdd,
  onChange,
  onRemove,
}: {
  kind: ServiceItemKind;
  rows: EstimateRow[];
  onAdd: (kind: ServiceItemKind) => void;
  onChange: (key: string, patch: Partial<EstimateRow>) => void;
  onRemove: (key: string) => void;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <Typography.Text strong>{kind === 'part' ? 'Запчасти' : 'Услуги'}</Typography.Text>
      {rows.length === 0 && (
        <div>
          <Typography.Text type="secondary">
            {kind === 'part' ? 'Деталей не требуется' : 'Работы не заведены'}
          </Typography.Text>
        </div>
      )}
      {rows.map((row) => (
        <Row key={row.key} gutter={8} align="middle" style={{ marginTop: 8 }}>
          <Col xs={24} sm={9}>
            <Input
              value={row.name}
              maxLength={255}
              placeholder={
                kind === 'part' ? 'Например, ролик подачи' : 'Например, замена узла подачи'
              }
              aria-label={`${serviceItemKindLabels[kind]}: наименование`}
              onChange={(e) => onChange(row.key, { name: e.target.value })}
            />
          </Col>
          <Col xs={8} sm={3}>
            <InputNumber
              style={{ width: '100%' }}
              min={0.01}
              max={9999}
              value={row.quantity}
              placeholder="Кол-во"
              aria-label="Количество"
              onChange={(v) => onChange(row.key, { quantity: v })}
            />
          </Col>
          <Col xs={8} sm={4}>
            <InputNumber
              style={{ width: '100%' }}
              min={0}
              max={99_999_999}
              value={row.unitPrice}
              placeholder="Цена"
              aria-label="Цена за единицу"
              onChange={(v) => onChange(row.key, { unitPrice: v })}
            />
          </Col>
          <Col xs={8} sm={4}>
            {/* Гарантия обещается сроком, а не датой: дату сервер посчитает от дня выполнения
                работ — до закрытия заявки её попросту нет. */}
            <InputNumber
              style={{ width: '100%' }}
              min={1}
              max={120}
              value={row.warrantyMonths}
              placeholder="Гар., мес."
              aria-label="Срок гарантии в месяцах"
              onChange={(v) => onChange(row.key, { warrantyMonths: v ?? null })}
            />
          </Col>
          <Col xs={16} sm={3} style={{ textAlign: 'right' }}>
            <Typography.Text>{money(rowAmount(row))}</Typography.Text>
          </Col>
          <Col xs={8} sm={1} style={{ textAlign: 'right' }}>
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label="Удалить строку"
              onClick={() => onRemove(row.key)}
            />
          </Col>
        </Row>
      ))}
      <Button
        type="link"
        size="small"
        icon={<PlusOutlined />}
        style={{ paddingInlineStart: 0, marginTop: 4 }}
        onClick={() => onAdd(kind)}
      >
        {kind === 'part' ? 'Добавить запчасть' : 'Добавить услугу'}
      </Button>
    </div>
  );
}
