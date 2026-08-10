import { Navigate, useSearchParams } from 'react-router';
import { canOrderVehicleRequestType } from '@technic/contracts';
import { PageTabs } from '../components/PageTabs';
import { useAuth } from '../auth/AuthContext';
import { canSeeArchiveTab, canSeeRoutesTab } from '../utils/links';
import { VehicleRequestsTab } from './vehicle/VehicleRequestsTab';
import { VehicleRequestsOnSiteTab } from './vehicle/VehicleRequestsOnSiteTab';
import { VehicleRoutesTab } from './vehicle/VehicleRoutesTab';
import { VehicleRequestsHistoryTab } from './vehicle/VehicleRequestsHistoryTab';
import { VehicleRequestsArchiveTab } from './vehicle/VehicleRequestsArchiveTab';

// Спецтехника, грузоперевозки и недельные заявки живут в одном списке («Заказ автотехники»): вид
// документа — колонка и фильтр, а не отдельная вкладка. Старые ключи вкладок ведут на общий список.
const TABS = ['requests', 'on-site', 'routes', 'history', 'archive'] as const;

export function VehicleRequestsPage() {
  const { user, can } = useAuth();
  const [sp, setSp] = useSearchParams();

  /**
   * Старый адрес вкладки «Недельные заявки» (`?tab=weekly`) ведёт в общий список, заранее суженный
   * до недельных, — а не в пустоту. Он остался в закладках и в кнопке «Назад» страницы недели, и
   * молчаливый сброс на «все заявки» читался бы как «мои недельные пропали».
   *
   * Переходом на отрисовке, а не эффектом после неё: вид документа список читает из адреса ровно
   * один раз, при первом состоянии фильтров, — успей вкладка смонтироваться до правки адреса, она
   * запомнила бы «все виды», и правка адреса ничего бы уже не изменила.
   *
   * Заменой записи в истории (`replace`): «назад» после перехода обязан вернуть туда, откуда
   * человек пришёл, а не на адрес, с которого его только что увели.
   */
  if (sp.get('tab') === 'weekly') {
    return <Navigate to="/vehicle-requests?tab=requests&kind=weekly" replace />;
  }

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

  const items = [
    { key: 'requests', label: 'Заказ автотехники', children: <VehicleRequestsTab /> },
    ...(showOnSite
      ? [{ key: 'on-site', label: 'На объекте', children: <VehicleRequestsOnSiteTab /> }]
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
