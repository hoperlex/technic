import { useEffect, useRef, useState } from 'react';
import { Button, DatePicker, Drawer, Input, Select, Switch, Typography } from 'antd';
import dayjs from 'dayjs';
import type {
  FilterDefinition,
  FilterDraft,
  FilterDraftControls,
  FilterDraftValue,
} from './listControls';

interface Props {
  open: boolean;
  onClose: () => void;
  filters: FilterDefinition[];
  draftControls?: FilterDraftControls;
}

const DATE_FORMAT = 'DD.MM.YYYY';

/**
 * A fixed tag limit keeps a full-width field from pushing the other phone filters below the
 * sheet's visible area. The desktop bar can instead size tags responsively.
 */
const SHEET_MAX_TAGS = 4;

function draftOf(filters: FilterDefinition[]): FilterDraft {
  const draft: FilterDraft = {};
  for (const filter of filters) {
    draft[filter.key] =
      filter.kind === 'dateRange' ? { from: filter.from, to: filter.to } : filter.value;
  }
  return draft;
}

function emptyValue(filter: FilterDefinition): FilterDraftValue {
  if (filter.kind === 'dateRange') return {};
  if (filter.kind === 'toggle') return false;
  if (filter.kind === 'multiSelect') return [];
  return undefined;
}

/**
 * Compare a set by members: descriptors are rebuilt on every page render, while their identity
 * and selection order do not change which rows the filter asks for.
 */
function sameSelection(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const other = new Set(b);
  return a.every((value) => other.has(value));
}

/**
 * Phone filters (ADR 0030) use the same values as the desktop bar and fill the sheet width.
 *
 * The draft is essential here: the list is covered by the sheet, so each choice would otherwise
 * reload an invisible list. Apply sends the accumulated changes once; cancel discards them.
 */
export function FilterSheet({ open, onClose, filters, draftControls }: Props) {
  const [draft, setDraft] = useState<FilterDraft>({});
  // Descriptors are rebuilt on each page render. A ref keeps an in-progress draft from being
  // overwritten before Apply.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => {
    if (open) {
      setDraft(draftOf(filtersRef.current));
      // The sheet exposes every field at once, even though no individual Select popup is open.
      for (const filter of filtersRef.current) filter.onOpen?.();
    }
  }, [open]);

  const visibleFilters = draftControls?.deriveFilters?.(draft) ?? filters;
  const set = (key: string, value: FilterDraftValue) =>
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      return draftControls?.onDraftChange?.(next, key) ?? next;
    });

  /** Unchanged values must not reset the list page. */
  const apply = () => {
    draftControls?.onApplyDraft?.(draft);
    for (const filter of filtersRef.current) {
      if (draftControls?.managedKeys?.includes(filter.key)) continue;
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
      if (filter.kind === 'multiSelect') {
        const value = (next as string[] | undefined) ?? [];
        if (!sameSelection(value, filter.value)) filter.onChange(value);
        continue;
      }
      const value = (next as string | undefined) || undefined;
      if (value !== filter.value) filter.onChange(value);
    }
    onClose();
  };

  /** Mandatory route periods and locked sites must survive clearing optional filters. */
  const reset = () => {
    const cleared: FilterDraft = {};
    for (const filter of filtersRef.current) {
      if (filter.disabled) {
        cleared[filter.key] =
          filter.kind === 'dateRange' ? { from: filter.from, to: filter.to } : filter.value;
        continue;
      }
      cleared[filter.key] =
        filter.kind === 'dateRange' && filter.required
          ? (draft[filter.key] ?? draftOf([filter])[filter.key])
          : emptyValue(filter);
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
        {visibleFilters.map((filter) => (
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
            {filter.kind === 'multiSelect' && (
              <Select
                mode="multiple"
                style={{ width: '100%' }}
                allowClear
                showSearch
                optionFilterProp="label"
                maxTagCount={filter.maxTagCount ?? SHEET_MAX_TAGS}
                maxCount={filter.maxCount}
                placeholder={filter.placeholder}
                options={filter.options}
                loading={filter.loading}
                disabled={filter.disabled}
                value={(draft[filter.key] as string[] | undefined) ?? []}
                onChange={(value: string[]) => set(filter.key, value)}
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
                allowClear={!filter.required}
                allowEmpty={filter.required ? [false, false] : [true, true]}
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
