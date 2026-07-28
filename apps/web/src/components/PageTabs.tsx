import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Tabs, type TabsProps } from 'antd';
import { useQueryClient } from '@tanstack/react-query';

interface SlotValue {
  el: HTMLElement | null;
  activeKey: string;
}

const SlotContext = createContext<SlotValue>({ el: null, activeKey: '' });

interface Props extends Omit<TabsProps, 'activeKey'> {
  /** Табы управляемые: слот в шапке показывает виджет только активной вкладки. */
  activeKey: string;
  /** Ключ запросов раздела: их данные обновляются при каждом переключении вкладки. */
  refreshQueryKey?: readonly unknown[];
}

/**
 * Табы страницы с местом для виджета справа от строки вкладок. Данные виджета считает сама
 * вкладка (счётчики зависят от её фильтров), а показывается он уровнем выше — над панелью
 * инструментов, чтобы не отнимать высоту у таблицы.
 */
export function PageTabs({ activeKey, refreshQueryKey, onChange, ...rest }: Props) {
  // Контейнер держим в состоянии, а не в ref: портал должен перерисоваться, когда он появится.
  // Сама функция-ref стабильна — иначе React отцеплял бы её на каждый рендер и сбрасывал слот.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const slotRef = useCallback((node: HTMLDivElement | null) => setEl(node), []);

  const qc = useQueryClient();
  /**
   * Скрытая вкладка не размонтируется, поэтому по возвращении показала бы кэш: список мог
   * измениться, пока смотрели соседнюю. Переключение вкладки — это «покажи, как сейчас»,
   * поэтому запросы раздела перезапрашиваются, а фильтры и страница при этом сохраняются.
   */
  const handleChange = (key: string) => {
    if (refreshQueryKey) void qc.invalidateQueries({ queryKey: refreshQueryKey });
    onChange?.(key);
  };

  return (
    <SlotContext.Provider value={{ el, activeKey }}>
      <Tabs
        className="full-height-tabs"
        activeKey={activeKey}
        onChange={handleChange}
        tabBarExtraContent={{ right: <div ref={slotRef} /> }}
        {...rest}
      />
    </SlotContext.Provider>
  );
}

/**
 * Виджет вкладки в строке вкладок. Скрытые вкладки остаются смонтированными, поэтому
 * содержимое рендерится только у активной — иначе на соседней вкладке висел бы чужой виджет.
 */
export function TabsExtra({ tabKey, children }: { tabKey: string; children: ReactNode }) {
  const { el, activeKey } = useContext(SlotContext);
  if (!el || activeKey !== tabKey) return null;
  return createPortal(children, el);
}
