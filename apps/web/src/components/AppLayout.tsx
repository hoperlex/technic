import { useState } from 'react';
import { Avatar, Dropdown, Layout, Menu, type MenuProps, Typography } from 'antd';
import {
  DatabaseOutlined,
  FileTextOutlined,
  KeyOutlined,
  LogoutOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { roleLabels } from '@technic/contracts';
import { useAuth } from '../auth/AuthContext';

const { Sider, Content } = Layout;

export function AppLayout() {
  const { user, logout, hasRole } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const items: MenuProps['items'] = [
    { key: '/waste', icon: <FileTextOutlined />, label: 'Вывоз мусора' },
    ...(hasRole('admin', 'manager')
      ? [{ key: '/directories', icon: <DatabaseOutlined />, label: 'Справочники' }]
      : []),
    ...(hasRole('admin')
      ? [{ key: '/admin', icon: <TeamOutlined />, label: 'Администрирование' }]
      : []),
  ];

  const selectedKey =
    ['/waste', '/directories', '/admin'].find((k) => location.pathname.startsWith(k)) ?? '/waste';

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
    <Layout style={{ height: '100vh' }}>
      <Sider
        theme="light"
        width={230}
        collapsedWidth={64}
        collapsible
        collapsed={collapsed}
        trigger={null}
        style={{ borderInlineEnd: '1px solid rgba(0,0,0,0.06)' }}
      >
        <div style={{ height: '100%', display: 'flex', flexDirection: 'row' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {!collapsed && (
              <div
                style={{
                  height: 56,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 16px',
                  fontWeight: 600,
                  fontSize: 16,
                }}
              >
                Портал
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {!collapsed && (
                <Menu
                  mode="inline"
                  selectedKeys={[selectedKey]}
                  items={items}
                  onClick={({ key }) => navigate(key)}
                  style={{ borderInlineEnd: 'none' }}
                />
              )}
            </div>
            <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', padding: 8 }}>
              <Dropdown menu={userMenu} trigger={['click']} placement="topLeft">
                <div className={`sider-account${collapsed ? ' sider-account--collapsed' : ''}`}>
                  <Avatar size="small" icon={<UserOutlined />} />
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
          <div
            className="sider-toggle"
            role="button"
            aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
            onClick={() => setCollapsed((v) => !v)}
          >
            <span className="sider-toggle-arrow">{collapsed ? '›' : '‹'}</span>
          </div>
        </div>
      </Sider>
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
