import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { TabsProps } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useIsMobile } from '@shared/lib';
import { AsyncTabs } from './AsyncTabs';

interface SlotValue {
  el: HTMLElement | null;
  activeKey: string;
}

const SlotContext = createContext<SlotValue>({ el: null, activeKey: '' });

interface Props extends Omit<TabsProps, 'activeKey'> {
  /** Controlled tabs let the header slot show only the active tab's widget. */
  activeKey: string;
  /** Section query root: switching tabs refreshes its data without resetting tab state. */
  refreshQueryKey?: readonly unknown[];
}

/**
 * Page tabs with a widget slot beside the strip. The tab owns its counts because they depend
 * on its filters, but renders them above the toolbar so they do not take height from the table.
 */
export function PageTabs({ activeKey, refreshQueryKey, onChange, ...rest }: Props) {
  // State, not a ref, lets the portal render when its container arrives. Keep the callback stable
  // or React would detach the container and reset the slot on every render.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const slotRef = useCallback((node: HTMLDivElement | null) => setEl(node), []);
  const isMobile = useIsMobile();

  const qc = useQueryClient();
  /**
   * Hidden tabs stay mounted, so returning would otherwise show a cache predating work on the
   * neighbour. Switching means "show it as it is now": refresh section queries while preserving
   * filters and pagination.
   */
  const handleChange = (key: string) => {
    if (refreshQueryKey) void qc.invalidateQueries({ queryKey: refreshQueryKey });
    onChange?.(key);
  };

  /**
   * On phones the widget moves below the strip: at 360 px it cannot fit beside tabs, and the
   * tabs need the full width to scroll (ADR 0030).
   */
  const slotProps: Partial<TabsProps> = isMobile
    ? {
        size: 'small',
        renderTabBar: (tabBarProps, DefaultTabBar) => (
          <>
            <DefaultTabBar {...tabBarProps} />
            <div ref={slotRef} className="mobile-tabs-slot" />
          </>
        ),
      }
    : { tabBarExtraContent: { right: <div ref={slotRef} /> } };

  return (
    <SlotContext.Provider value={{ el, activeKey }}>
      <AsyncTabs
        className="full-height-tabs"
        activeKey={activeKey}
        onChange={handleChange}
        {...slotProps}
        {...rest}
      />
    </SlotContext.Provider>
  );
}

/**
 * The currently active tab. A URL card (?open=) must open in exactly one tab even though visited
 * tabs stay mounted; without this context the list, history and archive could open the same id
 * at once.
 *
 * Ask the page, not the URL: it has already resolved defaults and permission-gated availability.
 */
export function useActiveTabKey(): string {
  return useContext(SlotContext).activeKey;
}

/**
 * A tab's widget in the strip. Hidden tabs stay mounted, so only the active tab renders into
 * the slot; otherwise the neighbour would show another tab's counts.
 */
export function TabsExtra({ tabKey, children }: { tabKey: string; children: ReactNode }) {
  const { el, activeKey } = useContext(SlotContext);
  if (!el || activeKey !== tabKey) return null;
  return createPortal(children, el);
}
