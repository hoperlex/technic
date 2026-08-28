import { useQuery } from '@tanstack/react-query';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { useAuth } from '../../../auth/AuthContext';

/**
 * Синий бейдж раздела: сколько заявок несут непрочитанное, адресованное МНЕ (ADR 0141, решение 5).
 *
 * Отдельный от золотого «ждёт меня», и складывать их нельзя: «где меня ждут» и «где мне написали» —
 * разные вопросы, а сумма не отвечает ни на один и вела бы в очередь, отобранную не тем фильтром.
 *
 * Спрашивается только у тех, кому видны сами заявки (`serviceRequests.read` — тот же страж, что и
 * у ручки). Раздел открывает ещё и `officeEquipment.read`: у менеджера с одним лишь парком техники
 * заявок нет вовсе, и счётчик отвечал бы ему отказом на каждый вход. Приём тот же, что у соседнего
 * `useServiceWaitingCount`: не «показать ноль», а не спрашивать.
 *
 * Считается только яркое: чужая переписка живёт блёклой точкой в строке и в бейдж не идёт — иначе
 * у «Ведения», видящего все заявки модуля, он горел бы всегда.
 */
export function useServiceChatUnreadCount(): number {
  const { can } = useAuth();
  const { data } = useQuery({
    queryKey: serviceRequestKeys.chatUnreadCount(),
    queryFn: () => serviceRequestsApi.chatUnreadCount(),
    enabled: can('serviceRequests.read'),
    staleTime: 60_000,
  });
  return data?.count ?? 0;
}
