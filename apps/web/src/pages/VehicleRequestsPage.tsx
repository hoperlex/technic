import { Tabs } from 'antd';
import { useSearchParams } from 'react-router';
import { SpecialEquipmentRequestsTab } from './vehicle/SpecialEquipmentRequestsTab';
import { FreightTransportRequestsTab } from './vehicle/FreightTransportRequestsTab';
import { VehicleRequestsOnSiteTab } from './vehicle/VehicleRequestsOnSiteTab';

const TABS = ['special-equipment', 'freight-transport', 'on-site'] as const;

export function VehicleRequestsPage() {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab') ?? '';
  const tab = (TABS as readonly string[]).includes(raw) ? raw : 'special-equipment';

  return (
    <div style={{ height: '100%' }}>
      <Tabs
        className="full-height-tabs"
        activeKey={tab}
        onChange={(k) => setSp({ tab: k })}
        items={[
          {
            key: 'special-equipment',
            label: 'Заказ спецтехники',
            children: <SpecialEquipmentRequestsTab />,
          },
          {
            key: 'freight-transport',
            label: 'Грузоперевозки',
            children: <FreightTransportRequestsTab />,
          },
          { key: 'on-site', label: 'На объекте', children: <VehicleRequestsOnSiteTab /> },
        ]}
      />
    </div>
  );
}
