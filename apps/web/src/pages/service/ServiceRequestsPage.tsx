import { useSearchParams } from 'react-router';
import { serviceRequestKeys } from '@entities/service-request';
import { PageTabs } from '../../components/PageTabs';
import { useAuth } from '../../auth/AuthContext';
import { canSeeArchiveTab } from '../../utils/links';
import { RequestsTab } from './RequestsTab';
import { WarrantiesTab } from './WarrantiesTab';
import { ServiceArchiveTab } from './ArchiveTab';
import { EquipmentTab } from './EquipmentTab';
import { ConsumablesTab } from './ConsumablesTab';

/**
 * Раздел «Орг.техника» (ADR 0085): заявки на обслуживание и сам парк.
 *
 * Раздел открывают **два** права, а не одно (план `office-equipment-mail-and-history-plan.md`,
 * Р72): `serviceRequests.read` — тем, кто ведёт заявки, `officeEquipment.read` — тем, кто отвечает
 * за технику. У менеджера и диспетчера есть второе и нет первого, и до этой правки вкладка
 * «Техника» осталась бы за закрытой дверью — маршрут пускал только по праву заявок.
 *
 * Вкладки отвечают на разные вопросы: «что чинится сейчас» (заявки), «что ещё покрыто гарантией»
 * (реестр), «что было» (архив), «где что стоит» (техника) и «чего не хватает на складе»
 * (расходники). Каждая проверяет своё право сама: сервисной компании открыты заявки, но не парк —
 * реквизиты нужной ей единицы приходят снимком в самой заявке (Р7).
 *
 * Справочник оргтехники при этом остаётся в «Справочниках»: там карточку **ведут** — заводят,
 * правят, архивируют. Здесь её эксплуатируют. То же и у расходников: пятая вкладка (план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р14) открыта тем же
 * `officeEquipment.read`, но заведения, правки и удаления позиций на ней нет — за ними в
 * «Справочники» → «Оргтехника» → «Картриджи и тонеры».
 *
 * ПЕРЕЧЕНЬ ВКЛАДОК ЖИВЁТ ЗДЕСЬ, а не в общем реестре разделов: реестр (ADR 0121) отвечает на
 * вопрос «какие разделы есть у портала», а из чего состоит раздел — дело самого раздела.
 */
const TABS = ['requests', 'warranties', 'archive', 'equipment', 'consumables'] as const;

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
    /*
     * «Расходники» открывает то же право, что и «Технику», — `officeEquipment.read` (Р14): склад
     * картриджей ведут те же люди, что отвечают за парк, и второе право означало бы, что перечень
     * позиций виден, а полка нет. Плановая закупка внутри вкладки закрыта своим правом
     * (`officeEquipmentPurchases.manage`) и спрашивается там же, где показывается.
     */
    ...(canEquipment
      ? [{ key: 'consumables', label: 'Расходники', children: <ConsumablesTab /> }]
      : []),
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
