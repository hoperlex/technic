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

const { Header, Sider, Content } = Layout;

export function AppLayout() {
  const { user, logout, hasRole } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

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
      <Sider theme="light" width={230} style={{ borderInlineEnd: '1px solid rgba(0,0,0,0.06)' }}>
        <div style={{ height: 56, display: 'flex', alignItems: 'center', padding: '0 16px', fontWeight: 600, fontSize: 16 }}>
          Портал
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={items}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '0 16px',
            borderBottom: '1px solid rgba(0,0,0,0.06)',
          }}
        >
          <Dropdown menu={userMenu} trigger={['click']}>
            <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Avatar size="small" icon={<UserOutlined />} />
              <div style={{ lineHeight: 1.2 }}>
                <div>{user?.fullName}</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {user?.role ? roleLabels[user.role] : '—'}
                </Typography.Text>
              </div>
            </div>
          </Dropdown>
        </Header>
        <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 16 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
