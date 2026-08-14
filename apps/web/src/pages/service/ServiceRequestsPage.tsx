import { useSearchParams } from 'react-router';
import { serviceRequestKeys } from '@entities/service-request';
import { PageTabs } from '../../components/PageTabs';
import { useAuth } from '../../auth/AuthContext';
import { canSeeArchiveTab } from '../../utils/links';
import { RequestsTab } from './RequestsTab';
import { WarrantiesTab } from './WarrantiesTab';
import { ServiceArchiveTab } from './ArchiveTab';
import { EquipmentTab } from './EquipmentTab';

/**
 * Раздел «Орг.техника» (ADR 0085): заявки на обслуживание и сам парк.
 *
 * Раздел открывают **два** права, а не одно (план `office-equipment-mail-and-history-plan.md`,
 * Р72): `serviceRequests.read` — тем, кто ведёт заявки, `officeEquipment.read` — тем, кто отвечает
 * за технику. У менеджера и диспетчера есть второе и нет первого, и до этой правки вкладка
 * «Техника» осталась бы за закрытой дверью — маршрут пускал только по праву заявок.
 *
 * Вкладки отвечают на разные вопросы: «что чинится сейчас» (заявки), «что ещё покрыто гарантией»
 * (реестр), «что было» (архив) и «где что стоит» (техника). Каждая проверяет своё право сама:
 * сервисной компании открыты заявки, но не парк — реквизиты нужной ей единицы приходят снимком в
 * самой заявке (Р7).
 *
 * Справочник оргтехники при этом остаётся в «Справочниках»: там карточку **ведут** — заводят,
 * правят, архивируют. Здесь её эксплуатируют.
 */
const TABS = ['requests', 'warranties', 'archive', 'equipment'] as const;

export function ServiceRequestsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();

  const canRequests = can('serviceRequests.read');
  const canEquipment = can('officeEquipment.read');
  // Условие показа архива спрашивается там же, где его спрашивает ссылка (`utils/links`):
  // разойдись эти два места, ссылка вела бы на вкладку, которой у роли нет.
  const showArchive = canRequests && canSeeArchiveTab(can);

  const items = [
    ...(canRequests
      ? [
          { key: 'requests', label: 'Заявки', children: <RequestsTab /> },
          { key: 'warranties', label: 'Гарантии', children: <WarrantiesTab /> },
        ]
      : []),
    ...(showArchive ? [{ key: 'archive', label: 'Архив', children: <ServiceArchiveTab /> }] : []),
    ...(canEquipment ? [{ key: 'equipment', label: 'Техника', children: <EquipmentTab /> }] : []),
  ];

  const raw = sp.get('tab') ?? '';
  /**
   * Ссылка на недоступную вкладку ведёт на первую доступную, а не на жёсткое «Заявки»: адрес
   * переживает смену роли, а у того, кому заявки закрыты, вкладка «Заявки» — это пустой экран с
   * отказами в запросах.
   */
  const tab =
    (TABS as readonly string[]).includes(raw) && items.some((i) => i.key === raw)
      ? raw
      : (items[0]?.key ?? 'requests');

  return (
    <div style={{ height: '100%' }}>
      <PageTabs
        activeKey={tab}
        onChange={(k) => setSp({ tab: k })}
        refreshQueryKey={serviceRequestKeys.root}
        items={items}
      />
    </div>
  );
}
