import { useQuery } from '@tanstack/react-query';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { driverKeys, driversApi } from '@entities/driver';

/**
 * Справочные данные окна «Сменить машиниста»: история заявки, список выбора и имя человека по
 * идентификатору.
 *
 * Вынесено из самого окна потому, что отвечает на отдельный вопрос — «как зовут того, кто назван»,
 * — и отвечает на него ДВУМЯ источниками с разными правилами (ADR 0190, Э4). Рядом с мутациями
 * команды это правило читалось как деталь загрузки, а оно предметное: список выбора снятые
 * карточки прячет, история — нет.
 */

export function useMachinistDirectory(targetId: string | null, open: boolean) {
  const history = useQuery({
    queryKey: vehicleRequestKeys.history(targetId ?? ''),
    queryFn: () => vehicleRequestsApi.assignmentHistory(targetId!),
    enabled: open,
    retry: false,
  });

  /**
   * Справочник водителей целиком — тот же список, что у поля машиниста в окне назначения: в бланке
   * ЭСМ-2 нет ни СНИЛС, ни удостоверения, и отбирать по ним некого (ADR 0055). Это список ВЫБОРА, и
   * снятые карточки он прячет — предложить удалённого человека нельзя (ADR 0190).
   */
  const machinists = useQuery({
    queryKey: driverKeys.machinistOptions(),
    queryFn: () => driversApi.list({ pageSize: 200, sortBy: 'fullName', sortOrder: 'asc' }),
    enabled: open,
  });

  /**
   * Имена «Состава по датам» приходят ВМЕСТЕ с историей, а не ищутся в списке выбора (ADR 0190,
   * Э4). Список выбора снятые карточки прячет — и заявка, у которой машиниста как раз и сняли,
   * писала бы «машиниста нет в справочнике водителей» ровно там, где человек работал и на его имя
   * выписаны бланки. Спрашивают здесь не «кого можно назначить», а «как зовут того, кто назван».
   *
   * Снятая карточка называется снятой прямо в строке: иначе «Состав по датам» выглядит исправным,
   * а следующий бланк уходит на удалённого молча.
   */
  const driverName = (personId: string) => {
    const person = history.data?.people.find((p) => p.personId === personId);
    if (person) {
      return person.cardRemovedOn ? `${person.fullName} (карточка снята)` : person.fullName;
    }
    return machinists.data?.items.find((d) => d.id === personId)?.fullName;
  };

  return { history, machinists, driverName };
}
