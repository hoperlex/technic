import type { ReactNode } from 'react';
import { Button, Checkbox, DatePicker, Input, Select, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { PhoneInput } from '../../components/PhoneInput';
import type { VehicleClassificationGroup } from '../../hooks/useVehicleClassifications';
import type { WeeklyNewRow } from './weeklyComposition';

/**
 * Блок «Нужна дополнительно» (§5 шаг 3): строка обычной заявки, урезанная до недели — позиция
 * классификатора, срок внутри недели, контакт встречающего и доставка по желанию.
 *
 * Конкретную машину строка не называет: её подбирает диспетчер при переводе в работу — площадка
 * не видит парка и не знает занятости (Р5).
 */

const DATE = 'YYYY-MM-DD';
const { RangePicker } = DatePicker;

/** Подпись над полем: строки состава — не форма antd, и `Form.Item` тут не из чего собрать. */
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
  /** Почему строку не примут — тем же предикатом, что и на сервере (`newItemBlocker`). */
  issues: Map<string, string>;
  /** Построчные причины отказа применения (§9): «тип ТС погашен», «объект погашен». */
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
  // Срок строки не выходит за пн–вс своей недели: то же ограничение держит CHECK базы и
  // `newItemBlocker` — форма просто не даёт выбрать то, что всё равно не примут.
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
                {/* Тот же ввод под маской, что во всех контактах портала (ADR 0066). */}
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
                      // Снятая доставка не оставляет за собой места отправления: сервер такую
                      // пару всё равно не примет, а поле выглядело бы заполненным.
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
