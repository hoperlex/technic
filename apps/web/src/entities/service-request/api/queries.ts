import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@shared/api';
import { serviceExecutorKeys } from './keys';
import { serviceRequestKeys } from './keys';
import { serviceRequestsApi } from './serviceRequestsApi';

export const serviceWaitingCountQuery = () =>
  queryOptions({
    queryKey: serviceRequestKeys.waitingCount(),
    queryFn: () => serviceRequestsApi.waitingCount(),
  });

export const serviceChatUnreadCountQuery = () =>
  queryOptions({
    queryKey: serviceRequestKeys.chatUnreadCount(),
    queryFn: () => serviceRequestsApi.chatUnreadCount(),
  });

/**
 * Кандидаты в поимённые исполнители ЭТОЙ заявки — своей ручкой модуля, а не отбором из списка
 * учёток.
 *
 * `GET /users` закрыт правом `users.manage`, которого нет ни у «Ведения», ни у ИТ-службы: поле
 * выбора заполнялось бы только у администратора портала, а у того, кто заявки и распределяет,
 * оставалось бы пустым. Ручка модуля закрыта тем самым правом, которым назначают
 * (`serviceRequests.assign`), и отбирает держателей `serviceRequests.execute` по **эффективным**
 * правам — то есть с гейтом совместимости набора с ролью.
 *
 * Заявка в запросе обязательна (план аудита исполнителей, Р7): сервер отвечает не «кого вообще
 * можно назначить», а «кто сможет работать по ЭТОЙ заявке», — тем же предикатом, которым
 * пригодность проверяет само назначение. Список поэтому и не предлагает «мёртвых» кандидатов:
 * решает это сервер, а не окно.
 */
export const serviceExecutorCandidatesQuery = (requestId: string) =>
  queryOptions({
    queryKey: serviceExecutorKeys.options(requestId),
    queryFn: () =>
      apiFetch<{ items: { id: string; fullName: string }[] }>(
        `/service-requests/executor-candidates?requestId=${requestId}`,
      ),
    select: (r) => r.items.map((u) => ({ value: u.id, label: u.fullName })),
  });
