import type { ReactNode } from 'react';
import { Typography } from 'antd';
import { useIsMobile } from '@shared/lib';
import { Fab } from './Fab';
import { ListToolbar } from './ListToolbar';
import type { MobileListControls } from './listControls';

interface Props {
  title?: ReactNode;
  /** The left block of the header (e.g. filters). Not wrapped into the title. */
  filters?: ReactNode;
  extra?: ReactNode;
  toolbar?: ReactNode;
  /**
   * Filters, sorting and the main action described for the phone (ADR 0030). Without it the page
   * shows the phone the same header as the desktop.
   */
  mobile?: MobileListControls;
  children: ReactNode;
}

/**
 * One layout for the table pages: the header and the toolbar are pinned, only the table body
 * scrolls (through scroll.y in DataTable). The desktop geometry lives in the page-layout classes of
 * styles.css, so a page of the same shape takes the classes instead of copying the numbers.
 *
 * On the phone the bar with the entries to filters and sorting is pinned, the list scrolls, and
 * record creation moves to a round button by the bottom navigation: the desktop filter strip would
 * take the whole screen there.
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
        {/* On the desktop the create button stands in the header (`extra`); on the phone the
            header belongs to the filters, and the main action lives as a round button over the
            list. */}
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
    <div className="page-layout__filters">{filters}</div>
  ) : null;
  return (
    <div className="page-layout">
      {left || extra ? (
        <div
          className={left ? 'page-layout__header' : 'page-layout__header page-layout__header--end'}
        >
          {left}
          {extra ? <div>{extra}</div> : null}
        </div>
      ) : null}
      {toolbar ? <div className="page-layout__toolbar">{toolbar}</div> : null}
      <div className="page-layout__body">{children}</div>
    </div>
  );
}
