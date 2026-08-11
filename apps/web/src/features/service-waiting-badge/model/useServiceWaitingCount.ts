import { useQuery } from '@tanstack/react-query';
import { actsForCounterparty } from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { useAuth } from '../../../auth/AuthContext';

/**
 * Бейдж «ждёт меня» на разделе оргтехники (ADR 0085, Р39).
 *
 * Счётчик спрашивается **не у всех, кто видит раздел**, и это не экономия, а суть: ход заявки
 * стоит только за двоими — оператором оргтехники (право `serviceRequests.assign`, приходит
 * надстройкой роли, ADR 0086) и сервисной компанией (тип контрагента, ADR 0038). У заказчика —
 * штаба и ролей отдела, то есть у основной массы видящих пункт меню, — шага в цикле нет
 * намеренно: заявку принимает оператор, а не тот, кто её завёл. Сервер ответил бы такой учётке
 * нулём всегда, и бейдж превратился бы в обещание «непрочитанного», которого в портале нет
 * вовсе, — плюс лишний запрос на каждый вход.
 *
 * Поэтому здесь именно «не спрашиваем», а не «показываем ноль». Прежде чем заводить бейдж
 * заказчику, заведите ему шаг в цикле (значение `customer` в `SERVICE_WAITING_ON` и ветку в
 * `isWaitingOn`) — иначе счётчик будет считать чужое ожидание.
 */
export function useServiceWaitingCount(): number {
  const { user, can } = useAuth();
  const inServiceLoop =
    can('serviceRequests.assign') ||
    // Виза ИТ (план модернизации, Р51) — третья сторона цикла: у согласующего шаг есть, значит
    // есть и счётчик. Спрашивается право, а не надстройка: следующий держатель визы обязан
    // получить бейдж, не переписывая это условие.
    can('serviceRequests.approveIt') ||
    actsForCounterparty(user, 'service');
  const { data } = useQuery({
    queryKey: serviceRequestKeys.waitingCount(),
    queryFn: () => serviceRequestsApi.waitingCount(),
    enabled: inServiceLoop,
    staleTime: 60_000,
  });
  return data?.count ?? 0;
}
