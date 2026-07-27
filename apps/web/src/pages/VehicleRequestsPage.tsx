import { Tabs } from 'antd';
import { useSearchParams } from 'react-router';
import { VehicleRequestsTab } from './vehicle/VehicleRequestsTab';
import { VehicleRequestsOnSiteTab } from './vehicle/VehicleRequestsOnSiteTab';

// Спецтехника и грузоперевозки живут в одном списке («Заказ автотехники»): тип заявки —
// колонка и фильтр, а не отдельная вкладка. Старые ключи вкладок ведут на общий список.
const TABS = ['requests', 'on-site'] as const;

export function VehicleRequestsPage() {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab') ?? '';
  const tab = (TABS as readonly string[]).includes(raw) ? raw : 'requests';

  return (
    <div style={{ height: '100%' }}>
      <Tabs
        className="full-height-tabs"
        activeKey={tab}
        onChange={(k) => setSp({ tab: k })}
        items={[
          { key: 'requests', label: 'Заказ автотехники', children: <VehicleRequestsTab /> },
          { key: 'on-site', label: 'На объекте', children: <VehicleRequestsOnSiteTab /> },
        ]}
      />
    </div>
  );
}
