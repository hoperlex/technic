import type { ReactNode } from 'react';
import { Typography } from 'antd';

interface Props {
  title?: ReactNode;
  /** Левый блок шапки (напр. фильтры). Не оборачивается в заголовок. */
  filters?: ReactNode;
  extra?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}

/**
 * Единая раскладка табличных страниц: заголовок и панель инструментов закреплены,
 * скроллится только тело таблицы (за счёт scroll.y в DataTable).
 */
export function PageTableLayout({ title, filters, extra, toolbar, children }: Props) {
  const left = title ? (
    <Typography.Title level={4} style={{ margin: 0 }}>
      {title}
    </Typography.Title>
  ) : filters ? (
    // Фильтров может быть много: блок занимает свободную ширину и переносит их по строкам,
    // а кнопка справа остаётся на месте.
    <div style={{ flex: '1 1 auto', minWidth: 0 }}>{filters}</div>
  ) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      {left || extra ? (
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: left ? 'space-between' : 'flex-end',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          {left}
          {extra ? <div>{extra}</div> : null}
        </div>
      ) : null}
      {toolbar ? <div style={{ flex: '0 0 auto' }}>{toolbar}</div> : null}
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>{children}</div>
    </div>
  );
}
