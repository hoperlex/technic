import { useSearchParams } from 'react-router';
import { canOrderVehicleRequestType } from '@technic/contracts';
import { PageTabs } from '../components/PageTabs';
import { useAuth } from '../auth/AuthContext';
import { VehicleRequestsTab } from './vehicle/VehicleRequestsTab';
import { VehicleRequestsOnSiteTab } from './vehicle/VehicleRequestsOnSiteTab';
import { VehicleRequestsHistoryTab } from './vehicle/VehicleRequestsHistoryTab';

// Спецтехника и грузоперевозки живут в одном списке («Заказ автотехники»): тип заявки —
// колонка и фильтр, а не отдельная вкладка. Старые ключи вкладок ведут на общий список.
const TABS = ['requests', 'on-site', 'history'] as const;

export function VehicleRequestsPage() {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();

  /**
   * «На объекте» — срез спецтехники на площадках (ADR 0036). Роли, которой спецтехника не
   * положена, вкладка показывала бы пустой список всегда: заявок этого типа у неё не бывает
   * (ADR 0040). Спрашивается коридор типов из матрицы, а не имя роли, — иначе список ролей
   * разошёлся бы с `ROLE_VEHICLE_REQUEST_TYPES` молча, вкладкой, которая ни на что не отвечает.
   */
  const showOnSite = canOrderVehicleRequestType(user, 'special_equipment');

  const items = [
    { key: 'requests', label: 'Заказ автотехники', children: <VehicleRequestsTab /> },
    ...(showOnSite
      ? [{ key: 'on-site', label: 'На объекте', children: <VehicleRequestsOnSiteTab /> }]
      : []),
    { key: 'history', label: 'История', children: <VehicleRequestsHistoryTab /> },
  ];

  const raw = sp.get('tab') ?? '';
  // Ссылка на скрытую вкладку ведёт в список, а не в пустоту: адрес переживает смену роли.
  const tab =
    (TABS as readonly string[]).includes(raw) && items.some((i) => i.key === raw)
      ? raw
      : 'requests';

  return (
    <div style={{ height: '100%' }}>
      <PageTabs
        activeKey={tab}
        onChange={(k) => setSp({ tab: k })}
        refreshQueryKey={['vehicle-requests']}
        items={items}
      />
    </div>
  );
}
