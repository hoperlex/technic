import { Col, Input, InputNumber, Row, Typography } from 'antd';
import {
  consumableFactDelta,
  consumableLabel,
  type ConsumableFactRow,
} from '../model/consumables';

/** Куда уйдёт разница: событие журнала пишется на неё, а не на всё количество (Р6). */
function deltaHint(row: ConsumableFactRow): string {
  const delta = consumableFactDelta(row);
  if (delta > 0) return `спишется со склада ${delta}`;
  if (delta < 0) return `вернётся на склад ${-delta}`;
  return 'склад не двинется';
}

/**
 * Строки отметки о выдаче (Р3): по каждой — сколько выдали и почему это не то, что просили.
 *
 * Одним компонентом на закрытие работ и на правку факта: величина у обоих окон одна, и вторая
 * таблица с теми же полями разошлась бы с первой на первой же правке. Различает их подсказка о
 * движении склада — при закрытии списывается весь факт, при правке только разница, и в первом
 * случае говорить про разницу не о чем.
 *
 * Причина спрашивается ровно тогда, когда факт разошёлся с запрошенным (`serviceConsumableIssueIssue`):
 * поле показано всегда, но обязательным становится по расхождению — и это то же условие, которым
 * отвечает сервер и `CHECK` базы.
 */
export function ServiceConsumableFactRows({
  rows,
  onChange,
  showDelta,
}: {
  rows: ConsumableFactRow[];
  onChange: (id: string, patch: Partial<ConsumableFactRow>) => void;
  /** Окно правки факта: рядом со строкой видно, что уйдёт со склада или вернётся на него. */
  showDelta?: boolean;
}) {
  return (
    <div>
      {rows.map((row) => {
        const mismatch = row.issuedQuantity !== row.requestedQuantity;
        return (
          <Row key={row.id} gutter={8} align="middle" style={{ marginTop: 8 }}>
            <Col xs={24} sm={11}>
              <Typography.Text>{consumableLabel(row)}</Typography.Text>
            </Col>
            <Col xs={10} sm={5}>
              <InputNumber
                style={{ width: '100%' }}
                min={0}
                max={1000}
                value={row.issuedQuantity}
                addonBefore="выдано"
                aria-label={`Выдано: ${row.name}`}
                onChange={(v) => onChange(row.id, { issuedQuantity: v })}
              />
            </Col>
            <Col xs={14} sm={8}>
              {/* Причина живёт в самой строке заявки, а не только в событии журнала (Р3): её
                  читают в карточке и в отчёте по расходу. */}
              <Input
                maxLength={500}
                value={row.issueNote}
                status={mismatch && !row.issueNote.trim() ? 'error' : undefined}
                placeholder={mismatch ? 'Почему разошлось' : 'Причина не нужна'}
                aria-label={`Причина расхождения: ${row.name}`}
                onChange={(e) => onChange(row.id, { issueNote: e.target.value })}
              />
            </Col>
            <Col span={24}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                просили {row.requestedQuantity}
                {showDelta ? ` · ${deltaHint(row)}` : ''}
              </Typography.Text>
            </Col>
          </Row>
        );
      })}
    </div>
  );
}
