import { Tabs } from 'antd';
import { ObjectsTab } from './directories/ObjectsTab';
import { ContainerTypesTab } from './directories/ContainerTypesTab';
import { MachineTypesTab } from './directories/MachineTypesTab';

export function DirectoriesPage() {
  return (
    <div style={{ height: '100%' }}>
      <Tabs
        className="full-height-tabs"
        defaultActiveKey="objects"
        items={[
          { key: 'objects', label: 'Объекты', children: <ObjectsTab /> },
          { key: 'types', label: 'Типы контейнеров', children: <ContainerTypesTab /> },
          { key: 'machines', label: 'Типы машин', children: <MachineTypesTab /> },
        ]}
      />
    </div>
  );
}
