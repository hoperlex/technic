# ADR 0029. Факт выполнения заявки ТС и журнал закрытых заказов

- Статус: Принято
- Связано: [ADR 0027](0027-vehicle-request-assignment.md) (техника и ставки при переводе в работу),
  [ADR 0025](0025-vehicle-request-approval.md) (виза руководителя строительства),
  [ADR 0015](0015-vehicle-request-history.md) (история отдельной заявки),
  [ADR 0011](0011-waste-request-vehicles.md) (факт вывоза мусора — соседний приём),
  `packages/contracts/src/vehicle-requests.ts`, `apps/api/src/routes/vehicle-requests.ts`,
  `apps/web/src/pages/vehicle/VehicleCompleteModal.tsx`,
  `apps/web/src/widgets/vehicle-request-history`, миграция `0053`

## Контекст

Вкладка «История» в «Заказе ТС» была заглушкой, а спрашивают с неё вещи, которые в портале уже
почти все есть: когда и на какой объект брали технику, кто согласовал заказ, у какого арендодателя
брали. Всё это лежит в самой заявке ([ADR 0025](0025-vehicle-request-approval.md)) и в назначении
([ADR 0027](0027-vehicle-request-assignment.md)).

Не было ровно одного — «сколько стоило». Назначение отвечает «почём час» и «почём смена», но
отработанного времени портал не вёл, и [ADR 0027](0027-vehicle-request-assignment.md) прямо оставил
стоимость следующим шагом. Журнал, построенный на одних ставках, отвечал бы планом: «заказывали
три дня по 18 000» — при том что машина вышла на день позже, отработала полторы смены и простояла
два часа в ожидании фронта работ. Такой ответ хуже отсутствия ответа: его сводят с бухгалтерией.

## Решения

1. **Факт предъявляется при закрытии, а не вводится потом.** `PATCH /:id/status` со статусом `done`
   принимает `completion` и проводит его в одной транзакции со сменой статуса. Тем же приёмом
   закрывается заявка на вывоз мусора ([ADR 0011](0011-waste-request-vehicles.md)) и берётся в
   работу заявка на технику ([ADR 0027](0027-vehicle-request-assignment.md)): состояние «выполнена,
   но чем и почём — узнаем позже» в портале не существует ни у одной заявки.

2. **Мерят тем же, чем назначали ставку: часами или сменами.** `worked_unit` хранится рядом с
   `worked_amount` — «8» без единицы не значит ничего, а одну и ту же заявку закрывают то часами
   (простой полдня), то сменами (аренда на неделю). Третьей единицы («по рейсам», «по тоннам») нет
   намеренно: за что не назначена ставка, то нечем и считать.

3. **Ставку в закрытие подставляет сервер, а не клиент.** Сумма обязана объясняться той ценой, о
   которой договорились при переводе в работу, — иначе «сколько стоило» превращается в число,
   пришедшее из браузера. Клиент присылает отработанное и итог; ставку сервер берёт из назначения
   по выбранной единице и кладёт в строку закрытия снимком: повторный перевод в работу ставку
   назначения переписывает, а закрытие должно предъявлять свою — «2,5 смены × 18 000 ₽».

4. **Итог считается, но правится свободно.** Расчёт «ставка × количество» подставляется в поле, и
   его же видит человек до нажатия. Счёт арендодателя включает перегон, подачу и простой, и сходиться
   сумма заявки должна со счётом, а не с формулой. Та же логика, что у ставок в назначении
   ([ADR 0027](0027-vehicle-request-assignment.md) п. 3): расхождение с расчётом портал показывает
   подсказкой — правка должна быть видимой, а не тихой.

5. **Обязательность факта — по наличию назначения.** У аренды без суммы закрытия не бывает: это
   счёт от контрагента. У собственной машины ставок может не быть вовсе, и тогда сумма пуста —
   внутреннюю технику не всегда считают в деньгах, но отработанное время у неё всё равно факт.
   А заявка, взятая в работу до [ADR 0027](0027-vehicle-request-assignment.md), закрывается как
   раньше: машины и ставки у неё нет, спрашивать нечего. Правило живёт на сервере — принадлежность
   машины лежит в `vehicles`, и строка закрытия её не видит.

6. **Одна заявка — одно закрытие.** `vehicle_request_completions.request_id` — первичный ключ;
   повторное закрытие (после отката администратором) переписывает строку. Двух фактов об одной
   работе не бывает, а «отработали не три смены, а две» — это исправление, а не второе событие.

   Уточнено [ADR 0058](0058-request-rollback-to-new.md): факт переживает откат «Выполнена» →
   «В работе» — там исправляют закрытие состоявшейся работы, — но не возврат в «Новую»: работы, о
   которой он предъявлен, после такого отката не было.

7. **Закрытие — своё событие истории** (`vehicle_request.complete`, вид `completed`), как и
   назначение. Переход отвечает «что с заявкой», закрытие — «сколько отработали и сколько это
   стоило»; в одном событии второе читалось бы как подробность первого. Событие несёт состав
   изменений, поэтому исправление после отката видно построчно.

8. **«История» — журнал закрытых заказов, а не лента событий раздела.** В неё попадают «Выполнена»
   и «Отменена»; открытая заявка итога ещё не имеет, а хронология событий каждой заявки живёт в её
   карточке ([ADR 0015](0015-vehicle-request-history.md)) — двух мест для одного рассказа не нужно.
   Отменённая заявка из журнала не исключается: «почему не поехали» — такой же вопрос к прошлому,
   и ответ на него уже есть в причине отмены.

9. **Журнал — отдельный маршрут, а не фильтр общего списка.** `GET /vehicle-requests/history`
   и `/history/summary`: у журнала другие вопросы, а значит другой фильтр (арендодатель), другой
   порядок по умолчанию (по сроку работ, а не по дате создания) и своя денежная сводка. Границы
   видимости при этом те же, что у списка: штаб видит свой объект, архив — тот, кому он открыт;
   отдельного права на журнал нет.

10. **Строка журнала называет обоих подтвердивших.** Руководитель строительства завизировал заказ
    ([ADR 0025](0025-vehicle-request-approval.md)), диспетчер взял его в работу конкретной машиной
    и ценой ([ADR 0027](0027-vehicle-request-assignment.md)). По одной подписи непонятно, с кого
    спрашивать за сам заказ, по другой — за его стоимость.

11. **Сводка честна к тому, чего не знает.** Рядом с суммой стоит число выполненных заявок без
    стоимости. Без него итог читается как «столько всего и потратили», хотя часть работ закрыта
    своей техникой без ставки или заявками, закрытыми до этой версии.

## Последствия

- Заявки, выполненные до миграции `0053`, остаются без факта: задним числом отработанное время не
  восстанавливается. В журнале у них прочерк в «Отработано» и «Стоимости», и они же попадают в
  счётчик «без суммы».
- Стоимость в журнале — это сумма закрытия, а не бухгалтерская проводка: портал не знает ни НДС, ни
  того, оплачен ли счёт. Сводить журнал с оплатами придётся вручную, пока в портале нет счетов.
- Фильтр по арендодателю собственную технику не показывает никогда — у неё арендодателя нет. Это
  верно по смыслу («у кого брали»), но означает, что расходы по своему парку из журнала сводятся
  только через фильтр по объекту и типу.
- Учёт времени остаётся событием одного момента: портал знает, сколько отработано всего, но не по
  каким дням. Посуточный табель — дело вкладки «На объекте», и он же потом должен подставлять сюда
  количество вместо ручного ввода.
- Закрытие требует одного числа там, где на объекте бывает сложнее (два дня по 8 часов и один по
  4). Такое закрытие сводят в часы — единица для того и есть; если практика покажет, что этого мало,
  строка закрытия расширяется до нескольких, а не переделывается.

## Freight hours from the driver's stop times (2026-10-27)

The consequence above — «the daily record … must later prefill the amount instead of manual
entry» — now holds for freight as well. Since [ADR 0234](0234-driver-shift-and-stop-times.md) the
driver records the arrival at stop 1 and every departure of a route, and the request snapshot of
each stop says whose work it was. Stage 3 of
[readings-shifts-merge-plan.md](../readings-shifts-merge-plan.md) (§8, owner decisions D6, D7, D12)
uses it:

- **«Время по заявке».** `GET /vehicle-requests/:id/route-time` reads the request's recorded stops
  and its share of the route time: the segment from the previous departure (the arrival for stop 1)
  to a stop's departure belongs to the requests of that stop in equal shares
  (`routeTimeByRequest`), split from the snapshot taken at capture, never from live roles — a
  rebuild of the route or a detached request does not move recorded work. The card shows it as
  «Факт по точкам» ([request-route-time.ts](../../apps/api/src/services/request-route-time.ts),
  [RequestRouteFact.tsx](../../apps/web/src/widgets/vehicle-request-view/ui/RequestRouteFact.tsx)).
- **The prefill (D7, D12).** The closing window of a freight request proposes the unit "hours" and
  the share rounded UP to a whole hour after summing (2 h 10 min → 3 h;
  `routeTimePrefill` in [request-route-time.ts](../../packages/contracts/src/request-route-time.ts)).
  The amount stays editable: the completion must match the carrier's invoice. A previous completion
  still wins on a repeated closing.
- **No prefill, said aloud.** No submitted reading, a `no_data` shift, a reading without stop times,
  an incomplete set or a stop without a request give no number; the window and the card name the
  reason (`routeTimeIssueLabels`). The total is all or nothing: a partial sum would bill less than
  the work.
- **Access (D10).** The times and the share go to everyone who reads the request, the lessor
  included; who submitted the reading, its report state, the `no_data` reason and the comment only
  to `vehicleReadings.read` ([access-model.md](../access-model.md) §9.3).

The server does not require the prefill: it is a portal default, and the status door accepts any
amount as before. Tests: `request-driver-times.db.test.ts` (the split from the snapshot, a rebuild
and a detached request, the reasons, the diagnostics), `request-driver-times-contracts.test.ts`
(the rounding), `freight-route-time.test.tsx` (the card block and the prefill).
