import type { ReactNode } from 'react';
import { Button, Checkbox, DatePicker, Input, Select, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { PhoneInput } from '@entities/user-account';
import type { VehicleClassificationGroup } from '@entities/vehicle-type';
import type { WeeklyNewRow } from '../model/compositionState';

/**
 * Additional demand names a classification, dates, contact and optional delivery. It deliberately
 * does not name a fleet vehicle because dispatch selects one with access to availability.
 */

const DATE = 'YYYY-MM-DD';
const { RangePicker } = DatePicker;

/** Label a field without implying that composition rows belong to an antd Form. */
function Field({ label, width, children }: { label: string; width: number; children: ReactNode }) {
  return (
    <div style={{ flex: `1 1 ${width}px`, minWidth: Math.min(width, 220) }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Typography.Text>
      <div>{children}</div>
    </div>
  );
}

interface Props {
  rows: WeeklyNewRow[];
  /** Contract-owned reason why the server would reject this row. */
  issues: Map<string, string>;
  /** Row-level application failures such as retired classification or site. */
  skipReasons: Map<string, string>;
  weekStart: string;
  weekEnd: string;
  editable: boolean;
  groups: VehicleClassificationGroup[];
  loading: boolean;
  onAdd: () => void;
  onUpdate: (key: string, patch: Partial<WeeklyNewRow>) => void;
  onRemove: (key: string) => void;
}

export function WeeklyRequestNewItems(props: Props) {
  const { rows, editable, weekStart, weekEnd } = props;
  // Keep dates inside the target week, matching both the database check and `newItemBlocker`.
  const outsideWeek = (d: dayjs.Dayjs) => {
    const key = d.format(DATE);
    return key < weekStart || key > weekEnd;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.length === 0 && (
        <Typography.Text type="secondary">
          Дополнительная техника не заказана — неделю можно собрать и одними продлениями.
        </Typography.Text>
      )}
      {rows.map((row, index) => {
        const issue = props.issues.get(row.key);
        const skip = row.itemId ? props.skipReasons.get(row.itemId) : undefined;
        return (
          <div
            key={row.key}
            style={{
              border: '1px solid rgba(0,0,0,0.08)',
              borderRadius: 8,
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography.Text strong>Позиция {index + 1}</Typography.Text>
              {editable && (
                <Button
                  size="small"
                  danger
                  type="text"
                  icon={<DeleteOutlined />}
                  aria-label="Убрать позицию"
                  onClick={() => props.onRemove(row.key)}
                />
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <Field label="Тип/категория ТС" width={280}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  style={{ width: '100%' }}
                  placeholder="Выберите тип или категорию"
                  loading={props.loading}
                  disabled={!editable}
                  options={props.groups}
                  value={row.classificationKey}
                  onChange={(v: string) => props.onUpdate(row.key, { classificationKey: v })}
                />
              </Field>
              <Field label="Срок внутри недели" width={260}>
                <RangePicker
                  style={{ width: '100%' }}
                  format="DD.MM.YYYY"
                  allowClear={false}
                  disabled={!editable}
                  disabledDate={outsideWeek}
                  value={[dayjs(row.dateFrom), dayjs(row.dateTo)]}
                  onChange={(v) => {
                    if (!v?.[0] || !v[1]) return;
                    props.onUpdate(row.key, {
                      dateFrom: v[0].format(DATE),
                      dateTo: v[1].format(DATE),
                    });
                  }}
                />
              </Field>
              <Field label="Ответственный на объекте" width={220}>
                <Input
                  placeholder="Фамилия и имя"
                  maxLength={200}
                  disabled={!editable}
                  value={row.responsibleName}
                  onChange={(e) => props.onUpdate(row.key, { responsibleName: e.target.value })}
                />
              </Field>
              <Field label="Телефон" width={200}>
                {/* Use the portal-wide masked phone input (ADR 0066). */}
                <PhoneInput
                  disabled={!editable}
                  value={row.responsiblePhone}
                  onChange={(v) => props.onUpdate(row.key, { responsiblePhone: v })}
                />
              </Field>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
              <div style={{ flex: '0 0 auto' }}>
                <Checkbox
                  disabled={!editable}
                  checked={row.deliveryNeeded}
                  onChange={(e) =>
                    props.onUpdate(row.key, {
                      deliveryNeeded: e.target.checked,
                      // Disabling delivery also clears its origin so a hidden stale value cannot
                      // form a command the server rejects.
                      ...(e.target.checked ? {} : { deliveryFrom: '' }),
                    })
                  }
                >
                  Нужна доставка на объект
                </Checkbox>
              </div>
              {row.deliveryNeeded && (
                <Field label="Откуда доставить" width={300}>
                  <Input
                    placeholder="Адрес или площадка отправления"
                    maxLength={1000}
                    disabled={!editable}
                    value={row.deliveryFrom}
                    onChange={(e) => props.onUpdate(row.key, { deliveryFrom: e.target.value })}
                  />
                </Field>
              )}
              <Field label="Комментарий" width={320}>
                <Input
                  placeholder="Что делать на объекте"
                  maxLength={2000}
                  disabled={!editable}
                  value={row.comment}
                  onChange={(e) => props.onUpdate(row.key, { comment: e.target.value })}
                />
              </Field>
            </div>
            {issue && editable && <Typography.Text type="danger">{issue}</Typography.Text>}
            {skip && <Typography.Text type="danger">Не применена: {skip}</Typography.Text>}
          </div>
        );
      })}
      {editable && (
        <div>
          <Button icon={<PlusOutlined />} onClick={props.onAdd}>
            Добавить технику
          </Button>
        </div>
      )}
    </div>
  );
}
