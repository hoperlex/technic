import { Tabs } from 'antd';
import { useIsMobile } from '../hooks/useIsMobile';
import { ObjectsTab } from './directories/ObjectsTab';
import { CounterpartiesTab } from './directories/CounterpartiesTab';
import { ContainerTypesTab } from './directories/ContainerTypesTab';
import { WasteTariffsTab } from './directories/WasteTariffsTab';
import { VehicleTypesTab } from './directories/VehicleTypesTab';
import { VehicleSpecsTab } from './directories/VehicleSpecsTab';
import { VehiclesTab } from './directories/VehiclesTab';

export function DirectoriesPage() {
  // Вкладок семь: на телефоне они прокручиваются, и компактный размер оставляет им больше места.
  const isMobile = useIsMobile();
  return (
    <div style={{ height: '100%' }}>
      <Tabs
        className="full-height-tabs"
        defaultActiveKey="objects"
        size={isMobile ? 'small' : undefined}
        items={[
          { key: 'objects', label: 'Объекты', children: <ObjectsTab /> },
          { key: 'counterparties', label: 'Контрагенты', children: <CounterpartiesTab /> },
          { key: 'types', label: 'Типы контейнеров', children: <ContainerTypesTab /> },
          // Отдельной вкладки «Типы мусора» нет (ADR 0017): тип заводится и правится здесь же,
          // в прайсе, — сам по себе, без цены, он ничего не значит.
          {
            key: 'waste-tariffs',
            label: 'Стоимость вывоза мусора',
            children: <WasteTariffsTab />,
          },
          { key: 'vehicle-types', label: 'Типы ТС', children: <VehicleTypesTab /> },
          { key: 'vehicle-specs', label: 'ТТХ', children: <VehicleSpecsTab /> },
          { key: 'vehicles', label: 'Техника', children: <VehiclesTab /> },
        ]}
      />
    </div>
  );
}
