import { useSearchParams } from 'react-router';
import { mechRequestKeys } from '@entities/mech-request';
import { PageTabs } from '../../components/PageTabs';
import { useAuth } from '../../auth/AuthContext';
import { canSeeArchiveTab } from '../../utils/links';
import { RequestsTab } from './RequestsTab';
import { RentalsTab } from './RentalsTab';
import { HistoryTab } from './HistoryTab';
import { MechArchiveTab } from './ArchiveTab';

/**
 * Раздел «Механизация» (план `docs/mechanization-module-plan.md`): аренда виброплит, компрессоров,
 * генераторов и тепловых пушек — всего, что стоит на площадке неделями и стоит денег каждый день.
 *
 * Вкладок четыре: «Заявки» — то, что ведут, «В аренде» — то, что сейчас стоит на площадках
 * (присутствие по предикату Р2), «История» — закрытое, с итогами за отбор (Э3), и «Архив» — то,
 * что снесли.
 *
 * Порядок вкладок — порядок вопросов к разделу: сначала «что взять в работу», потом «что вернуть
 * и продлить», следом «во что нам это обошлось», в конце разбор удалённого. «В аренде» стоит
 * второй, а не первой, хотя открывают её чаще: первой встречает та, где заводят заявку, — иначе
 * площадка, пришедшая заказать виброплиту, попадала бы на чужой список без кнопки «Заказать
 * технику». «История» стоит после неё, а не рядом с «Архивом»: закрытая заявка — это состоявшаяся
 * работа, а архив — след ошибки, и соседство сваливало бы их в одну кучу.
 *
 * ПЕРЕЧЕНЬ ВКЛАДОК ЖИВЁТ ЗДЕСЬ, а не в общем реестре разделов: реестр (ADR 0121) отвечает на
 * вопрос «какие разделы есть у портала», а из чего состоит раздел — дело самого раздела.
 *
 * Право на сам раздел проверяет маршрут (`RequireSection` по строке реестра): у механизации оно
 * одно — `mechRequests.read`, — и области здесь тоже значимы. Отдел без закреплённых площадок
 * раздела не видит вовсе (Р10): арендовать ему некуда.
 */
const TABS = ['requests', 'rentals', 'history', 'archive'] as const;

export function MechRequestsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();

  // Условие показа архива спрашивается там же, где его спрашивает ссылка (`utils/links`):
  // разойдись эти два места, ссылка вела бы на вкладку, которой у роли нет.
  const showArchive = canSeeArchiveTab(can);

  const items = [
    { key: 'requests', label: 'Заявки', children: <RequestsTab /> },
    // «В аренде» видна всем, кому виден раздел: своего права у присутствия нет — это тот же
    // список заявок, отобранный предикатом, и область смотрящего сужает его тем же барьером.
    { key: 'rentals', label: 'В аренде', children: <RentalsTab /> },
    // «История» — тоже без своего права: это те же заявки, отобранные закрытыми статусами, и
    // область смотрящего сужает журнал тем же барьером, что и список.
    { key: 'history', label: 'История', children: <HistoryTab /> },
    ...(showArchive ? [{ key: 'archive', label: 'Архив', children: <MechArchiveTab /> }] : []),
  ];

  /**
   * Ссылка на недоступную вкладку ведёт на первую доступную, а не на жёсткое «Заявки»: адрес
   * переживает смену роли. Сюда же приземляются адреса вкладок, которых у роли нет: ссылка на
   * архив открывает список, а не пустой экран.
   */
  const raw = sp.get('tab') ?? '';
  const tab =
    (TABS as readonly string[]).includes(raw) && items.some((i) => i.key === raw)
      ? raw
      : (items[0]?.key ?? 'requests');

  return (
    <div style={{ height: '100%' }}>
      <PageTabs
        activeKey={tab}
        onChange={(k) => setSp({ tab: k })}
        refreshQueryKey={mechRequestKeys.root}
        items={items}
      />
    </div>
  );
}
