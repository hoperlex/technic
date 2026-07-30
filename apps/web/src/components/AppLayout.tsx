import { useState, type ReactNode } from 'react';
import { Badge, Dropdown, Layout, Menu, type MenuProps, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  CarOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  KeyOutlined,
  LeftOutlined,
  LogoutOutlined,
  RightOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { formatShortName, roleLabels } from '@technic/contracts';
import { usersApi } from '../api/resources';
import { useAuth } from '../auth/AuthContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { MobileAppBar } from './MobileAppBar';
import { MobileNav, type MobileNavItem } from './MobileNav';
import { PortalLogo } from './PortalLogo';
import { UserAvatar } from './UserAvatar';

const { Sider, Content } = Layout;

const SIDER_WIDTH = 230;
const SIDER_COLLAPSED_WIDTH = 64;
const COLLAPSED_STORAGE_KEY = 'technic:sider-collapsed';

// localStorage недоступен в приватном режиме части браузеров — состояние меню не критично, молча игнорируем.
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* состояние просто не переживёт перезагрузку */
  }
}

export function AppLayout() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleCollapsed = () =>
    setCollapsed((v) => {
      writeCollapsed(!v);
      return !v;
    });

  /**
   * Заявки на регистрацию никуда не уведомляют — почты у портала нет. Бейдж в меню и есть
   * единственный сигнал администратору, что кто-то ждёт активации (ADR 0034).
   */
  const { data: pendingUsers } = useQuery({
    queryKey: ['users', 'pending-count'],
    queryFn: () => usersApi.pendingCount(),
    enabled: can('users.manage'),
    staleTime: 60_000,
  });

  // `short` — подпись для нижней навигации мобильного режима: на 360 px пункту достаётся
  // четверть экрана, и полное название раздела туда не помещается (ADR 0030).
  const navItems: (MobileNavItem & { icon: ReactNode })[] = [
    // Руководитель строительства отвечает за технику на объекте, вывоз мусора ведёт штаб (ADR 0025).
    ...(can('wasteRequests.read')
      ? [{ key: '/waste', icon: <FileTextOutlined />, label: 'Вывоз мусора', short: 'Вывоз' }]
      : []),
    // Оператор вывоза — внешний перевозчик: заказ ТС к его работе отношения не имеет (ADR 0010).
    ...(can('vehicleRequests.read')
      ? [
          {
            key: '/vehicle-requests',
            icon: <CarOutlined />,
            label: 'Заказ ТС',
            short: 'Заказ ТС',
          },
        ]
      : []),
    ...(can('directories.write')
      ? [
          {
            key: '/directories',
            icon: <DatabaseOutlined />,
            label: 'Справочники',
            short: 'Справ.',
          },
        ]
      : []),
    ...(can('users.manage')
      ? [
          {
            key: '/admin',
            icon: (
              <Badge count={pendingUsers?.count ?? 0} size="small" offset={[4, -2]} color="gold">
                <TeamOutlined />
              </Badge>
            ),
            label: 'Администрирование',
            short: 'Админ.',
          },
        ]
      : []),
  ];

  // Подсвечен тот пункт, на страницу которого зашли; если такого пункта у роли нет — никакой.
  const selectedKey = navItems.find((it) => location.pathname.startsWith(it.key))?.key ?? '';

  const userMenu: MenuProps = {
    items: [
      { key: 'change-password', icon: <KeyOutlined />, label: 'Сменить пароль' },
      { type: 'divider' },
      { key: 'logout', icon: <LogoutOutlined />, label: 'Выйти', danger: true },
    ],
    onClick: ({ key }) => {
      if (key === 'logout') void logout().then(() => navigate('/login'));
      if (key === 'change-password') navigate('/change-password');
    },
  };

  /**
   * Мобильная раскладка (ADR 0030): разделы — нижней навигацией, учётная запись — в верхней
   * панели. Высота остаётся фиксированной, как на десктопе: страницы внутри рассчитывают её
   * сами (вкладки и тело таблицы со своей прокруткой), и менять это здесь — не дело каркаса.
   */
  if (isMobile) {
    const title = navItems.find((it) => it.key === selectedKey)?.label ?? 'Заказ Автотехники';
    return (
      <div className="mobile-shell">
        {/* На 360 px полное ФИО в панель не помещается; части ФИО есть (ADR 0034) — значит
            можно показать «Иванов И. И.», а не обрезать строку многоточием. */}
        <MobileAppBar
          title={title}
          userName={user ? formatShortName(user) : undefined}
          menu={userMenu}
        />
        <main className="mobile-content">
          <Outlet />
        </main>
        <MobileNav items={navItems} selectedKey={selectedKey} onSelect={(key) => navigate(key)} />
      </div>
    );
  }

  return (
    <Layout style={{ height: '100dvh', position: 'relative' }}>
      <Sider
        theme="light"
        width={SIDER_WIDTH}
        collapsedWidth={SIDER_COLLAPSED_WIDTH}
        collapsible
        collapsed={collapsed}
        trigger={null}
        style={{ borderInlineEnd: '1px solid rgba(0,0,0,0.06)' }}
      >
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              height: 56,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: collapsed ? 0 : '0 16px',
              justifyContent: collapsed ? 'center' : 'flex-start',
            }}
          >
            <PortalLogo size={28} />
            {!collapsed && (
              <span
                style={{
                  fontWeight: 600,
                  fontSize: 14,
                  lineHeight: 1.05,
                  textAlign: 'right',
                  whiteSpace: 'nowrap',
                }}
              >
                Заказ
                <br />
                Автотехники
              </span>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {collapsed ? (
              <div className="sider-mini-nav">
                {navItems.map((it) => (
                  <button
                    key={it.key}
                    type="button"
                    className={`sider-mini-item${
                      selectedKey === it.key ? ' sider-mini-item--active' : ''
                    }`}
                    onClick={() => navigate(it.key)}
                    title={it.label}
                    aria-label={it.label}
                  >
                    {it.icon}
                  </button>
                ))}
              </div>
            ) : (
              <Menu
                mode="inline"
                selectedKeys={[selectedKey]}
                // Пункт меню antd получает ровно те же поля, что и раньше: короткая подпись
                // нужна только нижней навигации мобильного режима.
                items={navItems.map(({ key, icon, label }) => ({ key, icon, label }))}
                onClick={({ key }) => navigate(key)}
                style={{ borderInlineEnd: 'none' }}
              />
            )}
          </div>
          <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', padding: 8 }}>
            <Dropdown menu={userMenu} trigger={['click']} placement="topLeft">
              <div className={`sider-account${collapsed ? ' sider-account--collapsed' : ''}`}>
                <UserAvatar name={user?.fullName} size="small" />
                {!collapsed && (
                  <div style={{ lineHeight: 1.2, minWidth: 0 }}>
                    <div
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {user?.fullName}
                    </div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {user?.role ? roleLabels[user.role] : '—'}
                    </Typography.Text>
                  </div>
                )}
              </div>
            </Dropdown>
          </div>
        </div>
      </Sider>
      {/* Кнопка на стыке панели и контента: видна всегда, «едет» вместе с краем сайдера */}
      <button
        type="button"
        className="sider-toggle"
        aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
        style={{ left: collapsed ? SIDER_COLLAPSED_WIDTH : SIDER_WIDTH }}
      >
        {collapsed ? <RightOutlined /> : <LeftOutlined />}
      </button>
      <Layout>
        <Content
          style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 16 }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
