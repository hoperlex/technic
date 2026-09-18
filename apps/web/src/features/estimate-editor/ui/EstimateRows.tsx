import { Button, Col, Input, InputNumber, Row, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { serviceItemKindLabels, type ServiceItemKind } from '@technic/contracts';
import { rowAmount, type EstimateRow } from '../model/rows';
import { formatMoney } from '../../../utils/format';

/**
 * Группа объёма работ: «Запчасти» или «Услуги» (§9.3). Группы разведены не для красоты — по ним
 * читают объём: заказчик спрашивает «что за детали» отдельно от «сколько стоит работа», и в общем
 * списке эти два вопроса перемешиваются.
 *
 * Поля строки на телефоне переносятся сами (`Row` с разными долями на xs и sm): редактор
 * открывают и с телефона — сервис вводит объём работ, стоя у аппарата.
 */
export function EstimateRowsGroup({
  kind,
  rows,
  disabled = false,
  onAdd,
  onChange,
  onRemove,
}: {
  kind: ServiceItemKind;
  rows: EstimateRow[];
  /**
   * Правка закрыта висящим предъявлением (Р9). Поля гасятся, а не прячутся: состав остаётся
   * виден — по нему и решают, отзывать ли предъявление, — но набранное в нём сохранить нечем, и
   * живое поле обещало бы правку, которую сервер не примет.
   */
  disabled?: boolean;
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
            {/* Наименование МНОГОСТРОЧНОЕ и длинное (план
                `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, Р1): предел вырос
                до 2000 символов, и переводы строк внутри разрешены — это одно и то же поле, в
                котором свободный режим держит перечень из письма подрядчика. Однострочный `Input`
                показывал бы такую запись в щёлочку и терял бы переводы строк при правке: увидеть
                их было бы негде, а стереть — легко.

                `autoSize` вместо фиксированной высоты: у обычной строки («ролик подачи») поле
                остаётся ровно в одну строку и колонку не раздувает, а длинная растёт до шести —
                дальше уже прокрутка внутри поля. Соседние колонки при этом выровнены по центру
                (`align="middle"` у ряда), то есть растущее поле их не сдвигает, а раздвигает ряд. */}
            <Input.TextArea
              disabled={disabled}
              value={row.name}
              maxLength={2000}
              autoSize={{ minRows: 1, maxRows: 6 }}
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
              disabled={disabled}
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
              disabled={disabled}
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
              disabled={disabled}
              min={1}
              max={120}
              value={row.warrantyMonths}
              placeholder="Гар., мес."
              aria-label="Срок гарантии в месяцах"
              onChange={(v) => onChange(row.key, { warrantyMonths: v ?? null })}
            />
          </Col>
          <Col xs={16} sm={3} style={{ textAlign: 'right' }}>
            <Typography.Text>{formatMoney(rowAmount(row))}</Typography.Text>
          </Col>
          <Col xs={8} sm={1} style={{ textAlign: 'right' }}>
            <Button
              type="text"
              danger
              disabled={disabled}
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
        disabled={disabled}
        icon={<PlusOutlined />}
        style={{ paddingInlineStart: 0, marginTop: 4 }}
        onClick={() => onAdd(kind)}
      >
        {kind === 'part' ? 'Добавить запчасть' : 'Добавить услугу'}
      </Button>
    </div>
  );
}
