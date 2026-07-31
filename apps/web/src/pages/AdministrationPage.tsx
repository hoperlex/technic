import { Tabs } from 'antd';
import { useIsMobile } from '../hooks/useIsMobile';
import { UsersTab } from './admin/UsersTab';

export function AdministrationPage() {
  // Компактная полоса вкладок на телефоне — как в справочниках: на 360 px обычная съедает
  // высоту, которой не хватает списку.
  const isMobile = useIsMobile();
  return (
    <div style={{ height: '100%' }}>
      <Tabs
        className="full-height-tabs"
        size={isMobile ? 'small' : undefined}
        defaultActiveKey="users"
        items={[{ key: 'users', label: 'Пользователи', children: <UsersTab /> }]}
      />
    </div>
  );
}
