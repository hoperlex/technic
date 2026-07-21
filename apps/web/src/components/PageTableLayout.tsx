import type { ReactNode } from 'react';
import { Typography } from 'antd';

interface Props {
  title?: ReactNode;
  extra?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}

/**
 * Единая раскладка табличных страниц: заголовок и панель инструментов закреплены,
 * скроллится только тело таблицы (за счёт scroll.y в DataTable).
 */
export function PageTableLayout({ title, extra, toolbar, children }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      {title || extra ? (
        <div
          style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: title ? 'space-between' : 'flex-end',
            gap: 12,
          }}
        >
          {title ? (
            <Typography.Title level={4} style={{ margin: 0 }}>
              {title}
            </Typography.Title>
          ) : null}
          {extra ? <div>{extra}</div> : null}
        </div>
      ) : null}
      {toolbar ? <div style={{ flex: '0 0 auto' }}>{toolbar}</div> : null}
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>{children}</div>
    </div>
  );
}
