import { Tabs } from 'antd';
import { ObjectsTab } from './directories/ObjectsTab';
import { ContainerTypesTab } from './directories/ContainerTypesTab';
import { VehicleTypesTab } from './directories/VehicleTypesTab';

export function DirectoriesPage() {
  return (
    <div style={{ height: '100%' }}>
      <Tabs
        className="full-height-tabs"
        defaultActiveKey="objects"
        items={[
          { key: 'objects', label: 'Объекты', children: <ObjectsTab /> },
          { key: 'types', label: 'Типы контейнеров', children: <ContainerTypesTab /> },
          { key: 'vehicle-types', label: 'Типы/подтипы ТС', children: <VehicleTypesTab /> },
        ]}
      />
    </div>
  );
}
