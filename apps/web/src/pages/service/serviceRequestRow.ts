import {
  actsForCounterparty,
  type AuthUser,
  type ServiceActionRequest,
  type ServiceExecutorAssignment,
  type ServiceRequestDto,
} from '@technic/contracts';

/**
 * Карточка заявки в том виде, в каком её читают предикаты контрактов (Р2, Р11).
 *
 * Адаптер нужен потому, что DTO и предикаты описывают одно и то же разными словами: в карточке
 * сервисная компания лежит **объектом** (`service`), а поимённые исполнители — списком; предикатам
 * же нужны «есть ли контрагент» и «сколько строк» — ровно то, что сервер считает запросом, не
 * поднимая ни имён, ни названий. Разложи это каждое место по-своему — и `serviceHasExecutors`
 * отвечал бы в меню одно, а в форме другое.
 *
 * Второе, что склеивает адаптер, — согласование: в DTO оно лежит снимком `approval`, а предикат
 * возврата в правку спрашивает одну лишь ревизию подписи (Р9, «есть что снимать»).
 *
 * Одной функцией на все шесть зовущих: меню действий, правку заявки, повтор письма, вкладку объёма
 * работ и обе кнопки согласования. Дешевле держать один перевод, чем ловить расхождение на экране.
 */
export function serviceActionRow(request: ServiceRequestDto): ServiceActionRequest {
  return {
    kind: request.kind,
    status: request.status,
    serviceCounterpartyId: request.service?.id ?? null,
    executorCount: request.executors.length,
    estimatePendingRevision: request.estimatePendingRevision,
    approvedEstimateRevision: request.approval?.revision ?? null,
  };
}

/**
 * Признаки назначения на **эту** заявку — то, чего матрица прав не знает и знать не может.
 *
 * Ход исполнителя открывает не право, а назначение: поимённая строка вместе с
 * `serviceRequests.execute` либо своя компания в исполнителях (Н5). Сервер спрашивает то же самое
 * теми же двумя признаками, только читает их из таблиц, — поэтому меню и ответ маршрута не
 * расходятся.
 *
 * Рядом с `serviceActionRow`, потому что предмет один: перевод карточки в то, чем её видят
 * предикаты контрактов. Порознь эти два перевода разъехались бы — один считал бы исполнителей по
 * списку, другой по признаку.
 */
export function serviceExecutorAssignment(
  request: ServiceRequestDto,
  subject: AuthUser | null | undefined,
): ServiceExecutorAssignment {
  return {
    /*
     * ПРИБЛИЖЕНИЕ, и знать о нём надо. Сервер спрашивает «назначена ли заявка КОМПАНИИ этого
     * оператора» (`row.serviceCounterpartyId === p.counterpartyId`), портал же отвечает лишь «этот
     * субъект — оператор какой-то сервисной компании»: `counterpartyId` в `AuthUser` не приезжает,
     * и сузить ответ здесь нечем.
     *
     * До слияния статусов приближение прикрывал коридор: ход исполнителя открывался только из
     * «Назначенной», а нераспределённая стояла в «Новой». После Р1 коридор стал `new → in_work`, и
     * прикрытия не осталось — держит границу **область видимости**: заявку, не назначенную его
     * компании, оператор подрядчика не видит вовсе (`assertExecutorScope`), а значит и меню по ней
     * не строит. Дыра поэтому недостижима, но она держится на соседнем правиле, а не на этом.
     *
     * Чинится расширением `AuthUser` до `counterpartyId` — отдельной правкой, не этой: здесь она
     * задела бы вход и сессию ради приближения, которое сегодня ни на что не влияет.
     */
    actsForAssignedCounterparty: actsForCounterparty(subject, 'service'),
    isNamedExecutor: request.executors.some((e) => e.userId === subject?.id),
  };
}
