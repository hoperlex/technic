import { Tabs } from 'antd';
import { useIsMobile } from '@shared/lib';
import { ObjectsTab } from './directories/ObjectsTab';
import { DepartmentsTab } from './directories/DepartmentsTab';
import { CounterpartiesTab } from './directories/CounterpartiesTab';
import { WarehousesTab } from './directories/WarehousesTab';
import { ContainerTypesTab } from './directories/ContainerTypesTab';
import { WasteTariffsTab } from './directories/WasteTariffsTab';
import { VehicleTypesTab } from './directories/VehicleTypesTab';
import { VehicleSpecsTab } from './directories/VehicleSpecsTab';
import { VehiclesTab } from './directories/VehiclesTab';
import { OfficeEquipmentTab } from './directories/OfficeEquipmentTab';
import { DriversTab } from './directories/DriversTab';
import { useAuth } from '../auth/AuthContext';

export function DirectoriesPage() {
  // Вкладок восемь-девять: на телефоне они прокручиваются, и компактный размер оставляет им
  // больше места. Последняя — «Водители» — появляется по собственному праву: в карточке
  // персональные данные, и роли, которым открыты справочники, доступа к ним не получают
  // (ADR 0037).
  const isMobile = useIsMobile();
  const { can } = useAuth();
  /**
   * Раздел открывают два права (Р7): `directories.write` — на весь набор справочников,
   * `officeEquipment.write` — на одну вкладку. Поэтому основной набор собирается условием, а не
   * стоит безусловно: ответственный за оргтехнику, у которого второго права нет, не должен
   * получить объекты, контрагентов и прайс вывоза заодно с принтерами.
   */
  const canDirectories = can('directories.write');
  const items = [
    ...(canDirectories
      ? [
          { key: 'objects', label: 'Объекты', children: <ObjectsTab /> },
          // Отделы — вторая ось области (ADR 0040): офисные подразделения рядом с площадками.
          { key: 'departments', label: 'Отделы', children: <DepartmentsTab /> },
          { key: 'counterparties', label: 'Контрагенты', children: <CounterpartiesTab /> },
          // Склады идут сразу за контрагентами: склад существует только у поставщика (ADR 0051),
          // и заводят их одного за другим — сначала контрагента, потом его адреса.
          { key: 'warehouses', label: 'Склады', children: <WarehousesTab /> },
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
        ]
      : []),
    // Оргтехника (ADR 0085) — сразу за техникой: два парка рядом, и ведут их одни и те же люди.
    // Своя пара прав (Р7): `directories.read` есть у всех ролей, а карточка единицы рассказывает
    // и про её обслуживание.
    ...(can('officeEquipment.write') || canDirectories
      ? [{ key: 'office-equipment', label: 'Оргтехника', children: <OfficeEquipmentTab /> }]
      : []),
    ...(can('drivers.read')
      ? [{ key: 'drivers', label: 'Водители', children: <DriversTab /> }]
      : []),
  ];
  return (
    <div style={{ height: '100%' }}>
      <Tabs
        className="full-height-tabs"
        // Первая доступная, а не жёстко «Объекты»: у кого их нет, тому вкладка по несуществующему
        // ключу открыла бы пустое место вместо содержимого.
        defaultActiveKey={items[0]?.key}
        size={isMobile ? 'small' : undefined}
        items={items}
      />
    </div>
  );
}
