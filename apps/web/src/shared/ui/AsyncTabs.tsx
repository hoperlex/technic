import { Tabs, type TabsProps } from 'antd';
import { AsyncContent } from './AsyncContent';

/**
 * Keep tab navigation visible while only the selected body waits for its module. Antd still
 * owns first mount and retention: do not force-render unseen tabs or destroy visited ones, since
 * that would download hidden code or reset filters and pending forms on every switch.
 */
export function AsyncTabs({ items, ...props }: TabsProps) {
  return (
    <Tabs
      {...props}
      items={items?.map((item) => ({
        ...item,
        children:
          item.children == null ? item.children : <AsyncContent>{item.children}</AsyncContent>,
      }))}
    />
  );
}
