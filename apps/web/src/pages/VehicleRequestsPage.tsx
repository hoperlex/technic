import { useSearchParams } from 'react-router';
import { canOrderVehicleRequestType } from '@technic/contracts';
import { PageTabs } from '../components/PageTabs';
import { useAuth } from '../auth/AuthContext';
import { canSeeArchiveTab, canSeeRoutesTab } from '../utils/links';
import { VehicleRequestsTab } from './vehicle/VehicleRequestsTab';
import { VehicleRequestsOnSiteTab } from './vehicle/VehicleRequestsOnSiteTab';
import { WeeklyRequestsTab } from './vehicle/WeeklyRequestsTab';
import { VehicleRoutesTab } from './vehicle/VehicleRoutesTab';
import { VehicleRequestsHistoryTab } from './vehicle/VehicleRequestsHistoryTab';
import { VehicleRequestsArchiveTab } from './vehicle/VehicleRequestsArchiveTab';

// Спецтехника и грузоперевозки живут в одном списке («Заказ автотехники»): тип заявки —
// колонка и фильтр, а не отдельная вкладка. Старые ключи вкладок ведут на общий список.
const TABS = ['requests', 'on-site', 'weekly', 'routes', 'history', 'archive'] as const;

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
   * «Маршруты» и «Архив» — вкладки, на которые ведут ссылки из соседних списков (номер рейса в
   * строке заявки, номер заявки в составе рейса). Условие их показа спрашивается там же, где его
   * спрашивает ссылка (`utils/links`): разойдись эти два места, ссылка вела бы на вкладку,
   * которой у роли нет, — то есть в пустой экран.
   */
  const showRoutes = canSeeRoutesTab(can);
  const showArchive = canSeeArchiveTab(can);

  /**
   * «Недельные заявки» (ADR 0085) — своё право, а не заимствованное у заказов: `vehicleRequests.read`
   * есть у наблюдателя, оператора вывоза и арендодателя, а недельная заявка — это план площадки,
   * который им не показывают (Р12).
   */
  const showWeekly = can('weeklyRequests.read');

  const items = [
    { key: 'requests', label: 'Заказ автотехники', children: <VehicleRequestsTab /> },
    ...(showOnSite
      ? [{ key: 'on-site', label: 'На объекте', children: <VehicleRequestsOnSiteTab /> }]
      : []),
    ...(showWeekly
      ? [{ key: 'weekly', label: 'Недельные заявки', children: <WeeklyRequestsTab /> }]
      : []),
    ...(showRoutes ? [{ key: 'routes', label: 'Маршруты', children: <VehicleRoutesTab /> }] : []),
    { key: 'history', label: 'История', children: <VehicleRequestsHistoryTab /> },
    ...(showArchive
      ? [{ key: 'archive', label: 'Архив', children: <VehicleRequestsArchiveTab /> }]
      : []),
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
