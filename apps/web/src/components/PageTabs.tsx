import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Tabs, type TabsProps } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useIsMobile } from '@shared/lib';

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
  const isMobile = useIsMobile();

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

  /**
   * На телефоне виджет уезжает из строки вкладок под неё: рядом с вкладками на 360 px ему нет
   * места, а сами вкладки должны прокручиваться во всю ширину (ADR 0030).
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
      <Tabs
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
 * Ключ вкладки, открытой сейчас. Спрашивают его вкладки, которым мало собственного состояния:
 * карточку, названную в адресе (`?open=`), должна открыть ровно одна из них, а смонтированы они
 * все — без этой проверки один и тот же идентификатор открыли бы разом список, история и архив.
 *
 * Берётся у страницы, а не из адреса: ключ она уже посчитала — с умолчанием и с оглядкой на то,
 * какие вкладки этой роли положены.
 */
export function useActiveTabKey(): string {
  return useContext(SlotContext).activeKey;
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
