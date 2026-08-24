import { queryOptions } from '@tanstack/react-query';
import { wasteTicketsApi } from './wasteTicketsApi';
import { wasteTicketKeys } from './keys';

/**
 * Талоны заявки с посчитанными замечаниями. `enabled` оставлен вызывающему: ручка закрыта правом
 * `ticketReview` целиком, и спрашивать её тому, у кого права нет, значит получать 403 на каждом
 * открытии карточки.
 */
export const wasteTicketsQuery = (requestId: string | null, enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.list(requestId ?? ''),
    queryFn: () => wasteTicketsApi.list(requestId!),
    enabled: enabled && !!requestId,
    staleTime: 15_000,
  });

/**
 * Состояние подсистемы для баннера. Обновляется сам раз в минуту: распознавание асинхронное, и
 * человек, открывший карточку в момент сбоя, должен увидеть его без перезагрузки страницы.
 */
export const ticketRecognitionHealthQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.health(),
    queryFn: () => wasteTicketsApi.health(),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
