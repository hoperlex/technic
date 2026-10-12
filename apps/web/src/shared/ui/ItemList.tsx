import type { Key, ReactNode } from 'react';
import { Empty, Spin } from 'antd';

export interface ItemListProps<T> {
  items: readonly T[];
  rowKey: (item: T) => Key;
  /** The row's own content; it is laid out in one line, spread apart, with the actions last. */
  renderItem: (item: T) => ReactNode;
  /** Buttons at the end of the row, divided by thin rules. */
  actions?: (item: T) => ReactNode[];
  loading?: boolean;
  /** Text in place of the rows when there are none; antd's simple empty picture otherwise. */
  emptyText?: ReactNode;
}

/**
 * Rows with their actions at the end — what the portal used antd `List` for.
 *
 * `List` is deprecated in antd 6 as a whole, with no successor: it goes in the next major, and
 * the deprecation note asks for plain markup instead. This is that markup, for the one shape the
 * portal ever used (small rows, split by lines, actions on the right), with the antd 6.5 rules
 * ported into `styles.css` on the theme's own CSS variables — so the rows look as they did and
 * still follow a nested theme, like the driver cabinet's larger type.
 *
 * Two things are kept from `List` on purpose. The rows sit inside `Spin` even when nothing loads:
 * `Spin` is what makes the block a polite live region, through which a screen reader announces a
 * row being added (a file just uploaded). And while loading with no rows yet, the block holds a
 * fixed height instead of the empty text: "no types yet" flashing before the rows arrive would
 * read as an answer.
 */
export function ItemList<T>({
  items,
  rowKey,
  renderItem,
  actions,
  loading = false,
  emptyText,
}: ItemListProps<T>) {
  let content: ReactNode = loading ? <div style={{ minHeight: 53 }} /> : null;
  if (items.length > 0) {
    content = (
      <ul className="item-list__items">
        {items.map((item) => (
          <li key={rowKey(item)} className="item-list__item">
            {renderItem(item)}
            <ItemActions actions={actions?.(item) ?? []} />
          </li>
        ))}
      </ul>
    );
  } else if (!loading) {
    content = (
      <div className="item-list__empty">
        {emptyText || <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      </div>
    );
  }

  return (
    <div className="item-list">
      <Spin spinning={loading}>{content}</Spin>
    </div>
  );
}

function ItemActions({ actions }: { actions: ReactNode[] }) {
  if (actions.length === 0) return null;
  return (
    <ul className="item-list__actions">
      {actions.map((action, i) => (
        // Actions are a fixed set per row, never reordered: the position is their identity.
        <li key={i}>
          {action}
          {i !== actions.length - 1 && <em className="item-list__split" />}
        </li>
      ))}
    </ul>
  );
}

/** A two-line row body: the name, and a grey line of details under it. */
export function ItemListMeta({
  title,
  description,
}: {
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="item-list__meta">
      <div className="item-list__meta-content">
        <h4 className="item-list__meta-title">{title}</h4>
        {description && <div className="item-list__meta-description">{description}</div>}
      </div>
    </div>
  );
}
