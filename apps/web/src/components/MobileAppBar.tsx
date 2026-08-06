import { Badge, Dropdown, type MenuProps, Typography } from 'antd';
import { PortalLogo } from './PortalLogo';
import { UserAvatar } from './UserAvatar';

interface Props {
  /** Название открытого раздела: на телефоне подписи разделов в навигации сокращены. */
  title: string;
  userName?: string | null;
  /** Меню учётной записи — то же, что в подвале боковой панели на десктопе. */
  menu: MenuProps;
  /** Непрочитанные обновления портала (ADR 0077) — точкой на аватаре, см. ниже. */
  hasNews?: boolean;
}

/**
 * Верхняя панель мобильного режима (ADR 0030). Заголовок отвечает «где я», аватар — «кто я»
 * и открывает меню учётной записи. Навигация по разделам сюда не попадает: она внизу, под
 * большим пальцем.
 */
export function MobileAppBar({ title, userName, menu, hasNews }: Props) {
  return (
    <header className="mobile-appbar">
      <PortalLogo size={24} />
      <Typography.Text strong ellipsis className="mobile-appbar__title">
        {title}
      </Typography.Text>
      <Dropdown menu={menu} trigger={['click']} placement="bottomRight">
        <button type="button" className="mobile-appbar__account" aria-label="Учётная запись">
          {/* Точка продублирована на аватаре: на телефоне служебные пункты лежат внутри меню
              учётной записи (ADR 0030), а точка у пункта закрытого меню не извещает никого —
              её видит только тот, кто и без неё решил заглянуть в меню. */}
          <Badge dot={hasNews} offset={[-2, 2]}>
            <UserAvatar name={userName} size="small" />
          </Badge>
        </button>
      </Dropdown>
    </header>
  );
}
