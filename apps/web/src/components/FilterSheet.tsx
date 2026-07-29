import { useEffect, useRef, useState } from 'react';
import { Button, DatePicker, Drawer, Input, Select, Switch, Typography } from 'antd';
import dayjs from 'dayjs';
import type { FilterDefinition, FilterDraftValue } from './listControls';

interface Props {
  open: boolean;
  onClose: () => void;
  filters: FilterDefinition[];
}

const DATE_FORMAT = 'DD.MM.YYYY';

function draftOf(filters: FilterDefinition[]): Record<string, FilterDraftValue> {
  const draft: Record<string, FilterDraftValue> = {};
  for (const filter of filters) {
    draft[filter.key] =
      filter.kind === 'dateRange' ? { from: filter.from, to: filter.to } : filter.value;
  }
  return draft;
}

/** Значение фильтра по умолчанию — то, к которому его возвращает «Сбросить». */
function emptyValue(filter: FilterDefinition): FilterDraftValue {
  if (filter.kind === 'dateRange') return {};
  if (filter.kind === 'toggle') return false;
  return undefined;
}

/**
 * Фильтры списка на телефоне (ADR 0030): те же значения, что в панели над таблицей на десктопе,
 * но во всю ширину экрана и с черновиком.
 *
 * Черновик здесь принципиален. На десктопе каждый выбор сразу уходит в запрос — это дёшево,
 * панель видна целиком, и промах виден сразу. В шите список закрыт, и «выбрал — запрос, выбрал —
 * ещё запрос» означал бы четыре загрузки на один заход. Поэтому значения копятся, а список
 * перезапрашивается один раз, по «Применить»; «Отмена» не меняет ничего.
 */
export function FilterSheet({ open, onClose, filters }: Props) {
  const [draft, setDraft] = useState<Record<string, FilterDraftValue>>({});
  // Массив описаний пересобирается на каждый рендер страницы: держим его в ref, иначе черновик
  // затирался бы сам собой между открытием шита и нажатием «Применить».
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    if (open) setDraft(draftOf(filtersRef.current));
  }, [open]);

  const set = (key: string, value: FilterDraftValue) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  /** Применяются только изменённые: лишний вызов onChange сбрасывал бы страницу без причины. */
  const apply = () => {
    for (const filter of filtersRef.current) {
      const next = draft[filter.key];
      if (filter.kind === 'dateRange') {
        const range = (next ?? {}) as { from?: string; to?: string };
        if (range.from !== filter.from || range.to !== filter.to) {
          filter.onChange(range.from, range.to);
        }
        continue;
      }
      if (filter.kind === 'toggle') {
        const value = next === true;
        if (value !== filter.value) filter.onChange(value);
        continue;
      }
      const value = (next as string | undefined) || undefined;
      if (value !== filter.value) filter.onChange(value);
    }
    onClose();
  };

  /** Сброс чистит черновик, а не параметры: пока не нажали «Применить», список не трогаем.
      Зафиксированный ролью фильтр (объект у штаба) остаётся — его и менять нельзя. */
  const reset = () => {
    const cleared: Record<string, FilterDraftValue> = {};
    for (const filter of filtersRef.current) {
      if (filter.disabled) {
        cleared[filter.key] =
          filter.kind === 'dateRange' ? { from: filter.from, to: filter.to } : filter.value;
        continue;
      }
      cleared[filter.key] = emptyValue(filter);
    }
    setDraft(cleared);
  };

  return (
    <Drawer
      title="Фильтры"
      open={open}
      onClose={onClose}
      placement="bottom"
      size="auto"
      styles={{ body: { maxHeight: '70dvh', overflowY: 'auto' } }}
      footer={
        <div className="sheet-footer">
          <Button size="large" block onClick={reset}>
            Сбросить
          </Button>
          <Button size="large" block type="primary" onClick={apply}>
            Применить
          </Button>
        </div>
      }
    >
      <div className="filter-sheet">
        {filters.map((filter) => (
          <div key={filter.key} className="filter-sheet__row">
            <Typography.Text type="secondary" className="filter-sheet__label">
              {filter.label}
            </Typography.Text>
            {filter.kind === 'select' && (
              <Select
                style={{ width: '100%' }}
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder={filter.placeholder}
                options={filter.options}
                loading={filter.loading}
                disabled={filter.disabled}
                value={(draft[filter.key] as string | undefined) || undefined}
                onChange={(value: string | undefined) => set(filter.key, value)}
              />
            )}
            {filter.kind === 'text' && (
              <Input
                allowClear
                placeholder={filter.placeholder}
                disabled={filter.disabled}
                value={(draft[filter.key] as string | undefined) ?? ''}
                onChange={(e) => set(filter.key, e.target.value)}
              />
            )}
            {filter.kind === 'toggle' && (
              <Switch
                checked={draft[filter.key] === true}
                disabled={filter.disabled}
                onChange={(checked) => set(filter.key, checked)}
              />
            )}
            {filter.kind === 'dateRange' && (
              <DatePicker.RangePicker
                style={{ width: '100%' }}
                format={DATE_FORMAT}
                inputReadOnly
                allowEmpty={[true, true]}
                disabled={filter.disabled}
                value={(() => {
                  const range = (draft[filter.key] ?? {}) as { from?: string; to?: string };
                  return [range.from ? dayjs(range.from) : null, range.to ? dayjs(range.to) : null];
                })()}
                onChange={(range) =>
                  set(filter.key, {
                    from: range?.[0]?.format('YYYY-MM-DD'),
                    to: range?.[1]?.format('YYYY-MM-DD'),
                  })
                }
              />
            )}
          </div>
        ))}
      </div>
    </Drawer>
  );
}
