import { useState, type MouseEvent, type ReactNode } from 'react';
import { Typography } from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import { ActionSheet, type ActionSheetItem } from './ActionSheet';
import { NO_ROW_CLICK } from './columns';

/** Mobile rendering of the same row shown by DataTable (ADR 0030). */
export interface CardConfig<T> {
  title: (record: T) => ReactNode;
  badge?: (record: T) => ReactNode;
  primary?: (record: T) => ReactNode;
  lines?: ((record: T) => ReactNode)[];
  actions?: (record: T) => ActionSheetItem[];
  onOpen?: (record: T) => void;
}

/**
 * Both desktop rows and mobile cards use this rule. A portal click can bubble through React from
 * outside the row's DOM, and a control or text selection must keep its own action instead of opening
 * the row. Keeping the rule shared prevents links inside cards from opening two records at once.
 */
export function opensRow(e: MouseEvent<HTMLElement>): boolean {
  const target = e.target as HTMLElement | null;
  if (!target || !e.currentTarget.contains(target)) return false;
  if (target.closest(`button, a, input, textarea, label, .ant-select, .${NO_ROW_CLICK}`)) {
    return false;
  }
  return !window.getSelection()?.toString();
}

export function ListCard<T>({ record, card }: { record: T; card: CardConfig<T> }) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const actions = card.actions?.(record) ?? [];
  const lines = (card.lines ?? []).map((line) => line(record)).filter(Boolean);
  const openable = !!card.onOpen;

  return (
    <div
      className={`list-card${openable ? ' list-card--openable' : ''}`}
      role={openable ? 'button' : undefined}
      tabIndex={openable ? 0 : undefined}
      onClick={
        openable
          ? (e) => {
              if (opensRow(e)) card.onOpen?.(record);
            }
          : undefined
      }
      onKeyDown={
        openable
          ? (e) => {
              if (e.key === 'Enter') card.onOpen?.(record);
            }
          : undefined
      }
    >
      <div className="list-card__head">
        <Typography.Text strong>{card.title(record)}</Typography.Text>
        <div className="list-card__badge">{card.badge?.(record)}</div>
      </div>
      {card.primary && <div className="list-card__primary">{card.primary(record)}</div>}
      {lines.map((line, index) => (
        <div key={index} className="list-card__line">
          {line}
        </div>
      ))}
      {actions.length > 0 && (
        <>
          <button
            type="button"
            className="list-card__more"
            aria-label="Действия"
            onClick={(e) => {
              e.stopPropagation();
              setActionsOpen(true);
            }}
          >
            <MoreOutlined />
          </button>
          <ActionSheet open={actionsOpen} onClose={() => setActionsOpen(false)} items={actions} />
        </>
      )}
    </div>
  );
}
