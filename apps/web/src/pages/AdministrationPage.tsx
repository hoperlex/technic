import { Tabs } from 'antd';
import { UsersTab } from './admin/UsersTab';

export function AdministrationPage() {
  return (
    <div style={{ height: '100%' }}>
      <Tabs
        className="full-height-tabs"
        defaultActiveKey="users"
        items={[{ key: 'users', label: 'Пользователи', children: <UsersTab /> }]}
      />
    </div>
  );
}
