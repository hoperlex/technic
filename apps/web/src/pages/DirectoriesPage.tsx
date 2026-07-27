import { Tabs } from 'antd';
import { ObjectsTab } from './directories/ObjectsTab';
import { CounterpartiesTab } from './directories/CounterpartiesTab';
import { ContainerTypesTab } from './directories/ContainerTypesTab';
import { VehicleTypesTab } from './directories/VehicleTypesTab';
import { VehiclesTab } from './directories/VehiclesTab';

export function DirectoriesPage() {
  return (
    <div style={{ height: '100%' }}>
      <Tabs
        className="full-height-tabs"
        defaultActiveKey="objects"
        items={[
          { key: 'objects', label: 'Объекты', children: <ObjectsTab /> },
          { key: 'counterparties', label: 'Контрагенты', children: <CounterpartiesTab /> },
          { key: 'types', label: 'Типы контейнеров', children: <ContainerTypesTab /> },
          { key: 'vehicle-types', label: 'Типы ТС', children: <VehicleTypesTab /> },
          { key: 'vehicles', label: 'Техника', children: <VehiclesTab /> },
        ]}
      />
    </div>
  );
}
