import { useState, type ReactNode } from 'react';
import { Dropdown, Layout, Menu, type MenuProps, Typography } from 'antd';
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
import { roleLabels } from '@technic/contracts';
import { useAuth } from '../auth/AuthContext';
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
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleCollapsed = () =>
    setCollapsed((v) => {
      writeCollapsed(!v);
      return !v;
    });

  const navItems: { key: string; icon: ReactNode; label: string }[] = [
    // Руководитель строительства отвечает за технику на объекте, вывоз мусора ведёт штаб (ADR 0025).
    ...(can('wasteRequests.read')
      ? [{ key: '/waste', icon: <FileTextOutlined />, label: 'Вывоз мусора' }]
      : []),
    // Оператор вывоза — внешний перевозчик: заказ ТС к его работе отношения не имеет (ADR 0010).
    ...(can('vehicleRequests.read')
      ? [{ key: '/vehicle-requests', icon: <CarOutlined />, label: 'Заказ ТС' }]
      : []),
    ...(can('directories.write')
      ? [{ key: '/directories', icon: <DatabaseOutlined />, label: 'Справочники' }]
      : []),
    ...(can('users.manage')
      ? [{ key: '/admin', icon: <TeamOutlined />, label: 'Администрирование' }]
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
                items={navItems}
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
