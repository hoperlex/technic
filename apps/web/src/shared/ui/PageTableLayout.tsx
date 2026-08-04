import type { ReactNode } from 'react';
import { Typography } from 'antd';
import { useIsMobile } from '@shared/lib';
import { Fab } from './Fab';
import { ListToolbar } from './ListToolbar';
import type { MobileListControls } from './listControls';

interface Props {
  title?: ReactNode;
  /** Левый блок шапки (напр. фильтры). Не оборачивается в заголовок. */
  filters?: ReactNode;
  extra?: ReactNode;
  toolbar?: ReactNode;
  /**
   * Описания фильтров, сортировки и главного действия для телефона (ADR 0030). Не передан —
   * страница на телефоне показывает ту же шапку, что и на десктопе.
   */
  mobile?: MobileListControls;
  children: ReactNode;
}

/**
 * Единая раскладка табличных страниц: заголовок и панель инструментов закреплены,
 * скроллится только тело таблицы (за счёт scroll.y в DataTable).
 *
 * На телефоне закреплена панель со входом в фильтры и сортировку, прокручивается список, а
 * создание записи уезжает круглой кнопкой к нижней навигации: полоса фильтров десктопа заняла
 * бы там весь экран.
 */
export function PageTableLayout({ title, filters, extra, toolbar, mobile, children }: Props) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div className="mobile-page">
        {title ? (
          <Typography.Title level={5} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
        ) : null}
        {mobile ? <ListToolbar {...mobile} /> : filters ? <div>{filters}</div> : null}
        {toolbar ? <div>{toolbar}</div> : null}
        <div className="mobile-page__body">{children}</div>
        {/* Кнопка создания на десктопе стоит в шапке (`extra`); на телефоне шапка отдана
            фильтрам, и главное действие живёт круглой кнопкой поверх списка. */}
        {mobile?.primaryAction ? <Fab {...mobile.primaryAction} /> : null}
        {!mobile && extra ? <div>{extra}</div> : null}
      </div>
    );
  }

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
