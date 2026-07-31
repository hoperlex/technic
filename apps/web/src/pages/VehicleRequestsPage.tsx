import { useSearchParams } from 'react-router';
import { canOrderVehicleRequestType } from '@technic/contracts';
import { PageTabs } from '../components/PageTabs';
import { useAuth } from '../auth/AuthContext';
import { VehicleRequestsTab } from './vehicle/VehicleRequestsTab';
import { VehicleRequestsOnSiteTab } from './vehicle/VehicleRequestsOnSiteTab';
import { VehicleRoutesTab } from './vehicle/VehicleRoutesTab';
import { VehicleRequestsHistoryTab } from './vehicle/VehicleRequestsHistoryTab';

// Спецтехника и грузоперевозки живут в одном списке («Заказ автотехники»): тип заявки —
// колонка и фильтр, а не отдельная вкладка. Старые ключи вкладок ведут на общий список.
const TABS = ['requests', 'on-site', 'routes', 'history'] as const;

export function VehicleRequestsPage() {
  const { user, can } = useAuth();
  const [sp, setSp] = useSearchParams();

  /**
   * «На объекте» — срез спецтехники на площадках (ADR 0036). Роли, которой спецтехника не
   * положена, вкладка показывала бы пустой список всегда: заявок этого типа у неё не бывает
   * (ADR 0040). Спрашивается коридор типов из матрицы, а не имя роли, — иначе список ролей
   * разошёлся бы с `ROLE_VEHICLE_REQUEST_TYPES` молча, вкладкой, которая ни на что не отвечает.
   */
  const showOnSite = canOrderVehicleRequestType(user, 'special_equipment');

  /**
   * «Маршруты» — рейсы собственных машин: кто едет, с кем и в каком порядке. Спрашиваются оба
   * права, которыми закрыты сами ручки рейсов: `waybills.read` — потому что в рейсе виден
   * водитель (персональные данные, ADR 0037 п. 13), `vehicleRequests.status` — потому что рейс
   * ведёт тот же, кто двигает заявки. Заказчику со стороны объекта и арендодателю вкладка не
   * положена ни на чтение.
   */
  const showRoutes = can('waybills.read') && can('vehicleRequests.status');

  const items = [
    { key: 'requests', label: 'Заказ автотехники', children: <VehicleRequestsTab /> },
    ...(showOnSite
      ? [{ key: 'on-site', label: 'На объекте', children: <VehicleRequestsOnSiteTab /> }]
      : []),
    ...(showRoutes ? [{ key: 'routes', label: 'Маршруты', children: <VehicleRoutesTab /> }] : []),
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
