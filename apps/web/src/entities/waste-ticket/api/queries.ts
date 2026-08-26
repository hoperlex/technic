import { queryOptions } from '@tanstack/react-query';
import type { TicketAuditEventsQuery, TicketAuditPeriod } from '@technic/contracts';
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

/**
 * Очередь заданий слепой перепроверки (Р31). Обновляется при возврате на вкладку: задание берёт
 * первый приславший чтение, и висящий список показывал бы уже разобранное.
 */
export const wasteTicketBlindQueueQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.blindQueue(),
    queryFn: () => wasteTicketsApi.blindCheckQueue(),
    enabled,
    staleTime: 10_000,
  });

/**
 * Сводка аудита распознавания за период (ADR 0137). `enabled` оставлен вызывающему по той же
 * причине, что и у списка талонов: ручка закрыта правом `wasteRequests.ticketAudit` целиком, и
 * спрашивать её без права значит получать 403 на каждом открытии окна.
 *
 * Само не обновляется и живёт минуту: это отчёт за прошедший период, а не состояние «сейчас», и
 * числа, дёрнувшиеся под читающим человеком, он прочтёт как ошибку счёта, а не как новый талон.
 */
export const ticketAuditSummaryQuery = (period: TicketAuditPeriod, enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.auditSummary(period),
    queryFn: () => wasteTicketsApi.auditSummary(period),
    enabled,
    staleTime: 60_000,
  });

/**
 * Когорты аудита за период (ADR 0137, §5.2). Правила те же, что у сводки: право спрашивает
 * вызывающий, и запрос живёт минуту — это отчёт за прошедшие дни, а не состояние «сейчас».
 *
 * Отдельным запросом, а не полем сводки: экран когорт открывают не всегда, и незачем считать
 * разбор по конфигурациям тому, кто пришёл посмотреть долю исправлений.
 */
export const ticketAuditCohortsQuery = (period: TicketAuditPeriod, enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.auditCohorts(period),
    queryFn: () => wasteTicketsApi.auditCohorts(period),
    enabled,
    staleTime: 60_000,
  });

/**
 * Лента событий за период с фильтрами и постранично (§5.3). Право и здесь спрашивает вызывающий:
 * ручка закрыта тем же `wasteRequests.ticketAudit`.
 *
 * Живёт минуту, как соседи, и по той же причине: это журнал за прошедшие дни, а не состояние
 * «сейчас». Прежняя страница при листании не удерживается намеренно — экран показывает загрузку и
 * потом строки, и человек не читает старые события под новым номером страницы.
 */
export const ticketAuditEventsQuery = (query: TicketAuditEventsQuery, enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.auditEvents(query),
    queryFn: () => wasteTicketsApi.auditEvents(query),
    enabled,
    staleTime: 60_000,
  });

/**
 * Точность за период (ADR 0137, §5.5). Право спрашивает вызывающий, как и у соседей, и живёт
 * запрос минуту: это отчёт за прошедшие дни, а не состояние «сейчас».
 *
 * Отдельным запросом от сводки — по прямому указанию §5.5: экран со сводкой не соседствует и в
 * одну плитку с долей исправлений не сводится. Подтверждение оператора независимым чтением не
 * является, и общий кэш на двоих однажды свёл бы эти числа в один ответ.
 */
export const ticketAuditAccuracyQuery = (period: TicketAuditPeriod, enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.auditAccuracy(period),
    queryFn: () => wasteTicketsApi.auditAccuracy(period),
    enabled,
    staleTime: 60_000,
  });

/**
 * Состояние подсистемы (§5.4). Единственный запрос раздела, который обновляется сам, — и по той
 * же причине, по которой у него нет периода: очередь и состояние это снимок «сейчас», а не отчёт
 * за прошедшие дни. Вкладка, открытая со вчера, показывала бы вчерашнюю очередь под видом текущей,
 * а «сбоев не обнаружено за последний час» — час, который давно кончился.
 *
 * Минута выбрана по соседнему баннеру состояния (`ticketRecognitionHealthQuery`): два экрана,
 * отвечающие на один вопрос с разной частотой, спорили бы друг с другом на глазах у дежурного.
 * Момент ответа (`generatedAt`) экран всё равно печатает: обновление может и не дойти.
 */
export const ticketAuditOperationsQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.auditOperations(),
    queryFn: () => wasteTicketsApi.auditOperations(),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
