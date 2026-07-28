import type { ReactNode } from 'react';
import { Divider, Typography } from 'antd';

export interface SummaryItem {
  label: string;
  value: ReactNode;
}

interface Props {
  /** Подпись слева от счётчиков («Заявок», «Заявки на оплату»). */
  title: string;
  items: SummaryItem[];
}

/**
 * Полоса-сводка в шапке табличной страницы: подпись и счётчики в одну строку. Это подсказка
 * к списку, а не самостоятельная панель, поэтому счётчики идут одним блоком, а не карточками —
 * иначе шапка забирала бы у таблицы высоту.
 */
export function SummaryBar({ title, items }: Props) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
      <Typography.Text strong>{title}</Typography.Text>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          background: '#f5f5f5',
          borderRadius: 6,
          padding: '3px 4px',
        }}
      >
        {items.map((item, i) => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && <Divider type="vertical" style={{ margin: 0 }} />}
            <span style={{ padding: '0 8px' }}>
              <Typography.Text type="secondary">{item.label}: </Typography.Text>
              <Typography.Text strong>{item.value}</Typography.Text>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
