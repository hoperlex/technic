import { useSearchParams } from 'react-router';
import { serviceRequestKeys } from '@entities/service-request';
import { PageTabs } from '../../components/PageTabs';
import { useAuth } from '../../auth/AuthContext';
import { canSeeArchiveTab } from '../../utils/links';
import { RequestsTab } from './RequestsTab';
import { ServiceArchiveTab } from './ArchiveTab';

/**
 * Раздел «Орг.техника» (ADR 0085): заявки на обслуживание оргтехники.
 *
 * Раздел закрывает одно право — `serviceRequests.read` (маршрут в `App.tsx`), вкладок пока две.
 * Реестр гарантий (§9.5) придёт третьей вкладкой отдельным этапом: он отвечает на свой вопрос —
 * «что ещё на гарантии», — и заводить его пустым значило бы обещать ответ, которого нет.
 *
 * Справочник оргтехники живёт не здесь, а в «Справочниках» (Р7): его ведёт тот же человек, что
 * объекты и контрагентов, а исполнителю справочник закрыт вовсе.
 */
const TABS = ['requests', 'archive'] as const;

export function ServiceRequestsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();

  // Условие показа архива спрашивается там же, где его спрашивает ссылка (`utils/links`):
  // разойдись эти два места, ссылка вела бы на вкладку, которой у роли нет.
  const showArchive = canSeeArchiveTab(can);

  const items = [
    { key: 'requests', label: 'Заявки', children: <RequestsTab /> },
    ...(showArchive ? [{ key: 'archive', label: 'Архив', children: <ServiceArchiveTab /> }] : []),
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
        refreshQueryKey={serviceRequestKeys.root}
        items={items}
      />
    </div>
  );
}
