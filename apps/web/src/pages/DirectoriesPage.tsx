import { Tabs } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
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
  const qc = useQueryClient();
  /**
   * Переключение вкладки — это «покажи, как сейчас»: скрытая вкладка не размонтируется, поэтому по
   * возвращении она показала бы кэш, набранный до правок на соседней. Здесь это заметнее, чем
   * где-либо ещё: справочники ссылаются друг на друга, и сервер приклеивает поля соседа к списку —
   * у техники это названия типа и категории, у прайса объём контейнера, по которому считают
   * стоимость. Переименовал тип на одной вкладке, вернулся на другую — там старое название, и
   * висит оно до перезагрузки страницы, а не десять секунд.
   *
   * Гасится весь кэш, а не корень открываемой вкладки: перечислять, чьи поля попали в чей список,
   * пришлось бы вручную и заново после каждой правки сервера — забытая связь и есть тот самый
   * дефект. Дорого это не обходится: перезапрашивается только показанное — сама вкладка и каркас,
   * остальное лишь помечается устаревшим до своего открытия.
   */
  const refreshOnSwitch = () => void qc.invalidateQueries();
  /**
   * Раздел открывают два права (Р7): `directories.write` — на весь набор справочников,
   * `officeEquipment.write` — на одну вкладку. Поэтому основной набор собирается условием, а не
   * стоит безусловно: ответственный за оргтехнику, у которого второго права нет, не должен
   * получить объекты, контрагентов и прайс вывоза заодно с принтерами.
   */
  const canDirectories = can('directories.write');
  /**
   * Вкладка «Оргтехника» открывается тому, кому есть что на ней делать, а не тому, чьё право
   * исторически стояло в этом условии первым.
   *
   * Работ на вкладке теперь три, и права у них разные (план расходников, Р10): парк техники ведут
   * по `officeEquipment.write`, весь набор справочников — по `directories.write`, а номенклатуру
   * картриджей и правку их остатка — по своим двум правам. Ведут номенклатуру окном «Картриджи и
   * тонеры», которое живёт только здесь, и без этой строки человек с новым набором до своей работы
   * не дошёл бы вовсе — кнопка внутри вкладки ему открыта, а самой вкладки в разделе нет.
   *
   * Наполовину пустой вкладка при этом не откроется: оба права номенклатуры требуют
   * `officeEquipment.read` (`grants.ts`), а объекты и отделы для отборов читаются общим
   * `directories.read`, который есть у всех ролей. Править парк вкладка ему тоже не даст —
   * «Добавить технику», окна типов и моделей и действия строк спрашивают `officeEquipment.write`
   * сами, а не выводятся из факта, что вкладка открылась.
   */
  const canOfficeEquipment =
    can('officeEquipment.write') ||
    canDirectories ||
    can('officeEquipmentConsumables.manage') ||
    can('officeEquipmentConsumables.stock');
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
    // Своё право на вкладку (Р7): `directories.read` есть у всех ролей, а карточка единицы
    // рассказывает и про её обслуживание, — поэтому вкладка собирается условием выше.
    ...(canOfficeEquipment
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
        onChange={refreshOnSwitch}
        size={isMobile ? 'small' : undefined}
        items={items}
      />
    </div>
  );
}
