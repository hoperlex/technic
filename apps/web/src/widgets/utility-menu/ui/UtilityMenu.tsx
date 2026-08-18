import { Menu } from 'antd';
import type { UtilityMenuModel } from '../model/useUtilityMenu';

/**
 * Служебные пункты в боковой панели — своей полосой над учётной записью и отдельно от разделов:
 * это не места, куда переходят работать, а помощь и новости о самом портале.
 *
 * Свёрнутая панель рисует их кнопками, той же разметкой, что и разделы: у пункта остаётся одна
 * иконка, и назван он только `title` — им же, а не текстом, читает пункт экранный диктор.
 */
export function UtilityMenu({ menu, collapsed }: { menu: UtilityMenuModel; collapsed: boolean }) {
  return (
    <div className="sider-utility">
      {collapsed ? (
        <div className="sider-mini-nav">
          {menu.items.map((it) => (
            <button
              key={it.key}
              type="button"
              className="sider-mini-item"
              disabled={it.disabled}
              onClick={() => menu.openUtility(it.key)}
              title={it.title}
              aria-label={it.title}
            >
              {it.icon}
            </button>
          ))}
        </div>
      ) : (
        <Menu
          mode="inline"
          selectable={false}
          items={menu.menuItems}
          onClick={({ key }) => menu.openUtility(key)}
          style={{ borderInlineEnd: 'none' }}
        />
      )}
    </div>
  );
}
