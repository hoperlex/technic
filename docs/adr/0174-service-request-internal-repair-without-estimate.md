# ADR 0174. Объём работ составляют там, где за работу платят: внутренний ремонт закрывается без него

- Статус: Принято (реализовано целиком — контракты, сервер, портал, db-набор). Реализация — коммит
  `cad5fa2`. Схему решение НЕ меняет: колонки объёма работ остаются на месте и у внутренних заявок
  просто не заполняются. Парная миграция волны (`0286`, переопределение частичного индекса
  срочности под отбор) к этому решению отношения не имеет и живёт своей причиной. Extended on
  2026-10-12 by wave 1 of the role-walkthrough fixes (plan
  [office-equipment-workflow-fixes-plan.md](../office-equipment-workflow-fixes-plan.md), stages
  Э2 and Э3): the estimate belongs to its author, the estimate step sits on its tab, and the
  auto-close counts from the moment of the transition — see
  [the last section](#workflow-fixes-wave-1-2026-10-12)
- Изменяет: [ADR 0208](0208-service-work-completed-document-flow.md) — решение 4: the named in-house
  executor no longer submits the estimate document at all (workflow-fixes Р6); «Передать документ
  на согласование» stays for the administrator, the one subject left who may submit and may not
  declare the exemption
- Миграции: `*_service_request_done_at.sql` (wave 1, `done_at` and its backfill); the number is the
  next free one at integration, and the code and the tests never name it
- Домены: оргтехника
- Область: контракты —
  [service-requests.ts](../../packages/contracts/src/service-requests.ts) (`serviceRequestNeedsEstimate`,
  `serviceRequestHasEffectivePendingEstimate`, три предиката объёма работ, `canAssignServiceExecutors`,
  `ServiceWaitingRequest`, политика видов документов, схема смены статуса); сервер —
  [service-requests.ts](../../apps/api/src/routes/service-requests.ts) (страж `assertEstimateApplies`,
  три ветки закрытия работ, обе половины оси очередей, сброс объёма работ при появлении подрядчика,
  поля решения при отмене); портал —
  [ServiceRequestViewModal.tsx](../../apps/web/src/pages/service/ServiceRequestViewModal.tsx) (вкладка),
  [service-complete](../../apps/web/src/features/service-complete) (третий режим окна),
  новый слайс [service-cancel](../../apps/web/src/features/service-cancel),
  [serviceRequestEstimateMenu.tsx](../../apps/web/src/pages/service/serviceRequestEstimateMenu.tsx);
  wave 1 of the workflow fixes — the auto-close
  [internal-service-requests.ts](../../apps/api/src/routes/internal-service-requests.ts), the
  schema [schema.ts](../../apps/api/src/db/schema.ts) (`done_at`), the estimate tab
  [ServiceRequestEstimate.tsx](../../apps/web/src/pages/service/ServiceRequestEstimate.tsx) and the
  placement [serviceMenuPlacement.ts](../../apps/web/src/pages/service/serviceMenuPlacement.ts)
- Решение вырастает из: [ADR 0085](0085-office-equipment-module.md) (модуль),
  [0125](0125-service-request-cycle-changes.md) (цикл после слияния статусов),
  [0160](0160-service-request-audiences.md) (аудитории карточки),
  [0162](0162-service-request-actions-single-entry.md) (один вход в действие). План волны —
  [office-equipment-card-and-list-cleanup-plan.md](../office-equipment-card-and-list-cleanup-plan.md)

## Контекст

Заявку на обслуживание ведёт либо сервисная компания, либо свой сотрудник. Цикл же был написан под
первый случай и требовал одного и того же от обоих: исполнитель составляет объём работ со строками и
ценами, «Ведение» его согласует, и только по согласованной ревизии работы закрываются.

Для подрядчика это и есть предмет договора: по объёму работ спорят, по нему платят, и подпись под
ним — основание акта. Для своего сисадмина, поменявшего картридж или блок питания, всё это —
церемония вокруг работы, которой никто не оплачивает: стоимость внутренних работ компания не
фиксирует нигде, и цифры в такой смете не значат ничего.

**Мало того, без этой церемонии заявка не закрывалась вовсе.** Закрытие требовало равенства
`approved_estimate_revision` и `estimate_revision`, а у заявки, где объём работ ни разу не
предъявляли, первое пусто, второе — ноль: `NULL != 0` истинно, и переход в «Решена» отвечал `409`.
То есть свой сотрудник обязан был выписать смету себе, дождаться, пока её подпишет оператор, и
только потом сказать «сделано». Заказчик просил снять этот шаг (разбор 08.09.2026, п. 2).

## Решение

**Р1. «Нужен ли объём работ» — свойство пары «вид заявки + исполнитель», и живёт оно одной функцией
контрактов.** `serviceRequestNeedsEstimate({kind, serviceCounterpartyId})` истинна для ремонта с
назначенным контрагентом. Функция намеренно повторяет форму соседки
`serviceRequestNeedsClosingDocument`: обе отвечают на один вопрос — «за эту работу платят снаружи?»
— и обе обязаны отвечать одинаково, иначе заявка требовала бы акт, не имея сметы.

Спрашивают её семеро: три предиката объёма работ, страж четырёх ручек, вкладка карточки, окно
закрытия и очередь ожидания. Своей копии условия нет ни у одного — портал, посчитавший это правило
сам, разошёлся бы с сервером молча, и первым признаком стала бы кнопка, отвечающая отказом.

**Р2. Смешанный состав считается подрядческим.** Признак смотрит на контрагента, а не на «есть ли
поимённые исполнители»: работа подрядчика оплачивается независимо от того, помогал ли ему свой
сотрудник.

**Р3. Внутреннее закрытие — дата и комментарий.** Ветка закрытия для внутреннего ремонта не читает
строк, не считает итога, не ставит гарантий и не двигает склад; `final_total_amount` остаётся
пустым, а метаданные аудита не содержат ни ревизии, ни сумм. Ноль в этих полях был бы не «нет
данных», а зафиксированной стоимостью работ, которой не существует.

**Р4. Историческое предъявление перестаёт быть ожиданием, но не стирается.** У заявок, заведённых до
решения, `estimate_pending_revision` мог остаться непогашенным. Согласовать его больше нельзя, и
потому очередь считает эффективное ожидание — `serviceRequestHasEffectivePendingEstimate`, — а не
сырую колонку: иначе такая заявка вечно висела бы в «ждут согласования» и вечно запрещала бы смену
исполнителя. Само значение не переписывается миграцией: закрытие гасит его тем же патчем, которым
пишет дату выполнения.

Ось очередей при этом переписана ОБЕИМИ половинами. Условие «предъявление висит» и условие «не
висит» обязаны покрывать все строки; поправь мы только первое — заявка с историческим
предъявлением не подошла бы ни к одной половине и пропала бы из очередей вовсе, включая ту, куда её
отправляет карточка.

**Р5. Появление подрядчика начинает денежный этап с чистого листа.** Прежний сброс объёма работ
пропускал переход «никого → компания» при сохранённых своих исполнителях, и назначенный подрядчик
наследовал чужие строки с чужими ценами. Условие сброса теперь читает изменение контрагента.
Побочно это открывает ветку отказа: у заявки, по строкам которой обращались по гарантии, назначение
подрядчика ответит `409` — состав такого объёма работ не меняют ни при каких переназначениях.

**Р6. «Рекомендована замена» получает второй вход.** Пометка и решение при отказе ставились ТОЛЬКО
отказом по объёму работ, которого у внутреннего ремонта больше не бывает, — и список «что пора
менять» собирать стало бы нечем. Оба поля переехали в отдельное окно отмены: у ремонта они
спрашиваются, при отмеченной замене решение обязательно. Массовая отмена их не ставит — решение
относится к одному аппарату, а не к пачке.

**Р7. Отказ, а не молчание.** Четыре ручки объёма работ отвечают `422` «Заявку ведёт свой сотрудник
— объём работ по ней не составляют», а внутреннее закрытие отбивает присланные строки, расходники и
скидку. Правило стоит в единственном страже `assertEstimateApplies`, через который проходят все
четыре двери. `422`, а не `403`: право у человека есть, негоден предмет.

## Совместимость и порядок выката

Решение выкатывается тремя шагами, и это не осторожность, а требование: одновременный выкат сервера
и портала совместимости не даёт — ни один порядок двух несовместимых версий не безопасен.

1. **A — расширяющий сервер.** Принимает новое простое закрытие, но ничего не запрещает: действия
   старой сборки портала ещё не получают транспортных отказов.
2. **B — портал.** Вкладка, третий режим окна закрытия, окно отмены.
3. **C — ужесточение.** Отказы `422` включаются после того, как старая сборка перестала раздаваться.
   Залежавшаяся вкладка получает объяснимый отказ и после обновления страницы работает по-новому.

Шаги A и C обязаны быть разными деплоями. В истории репозитория они лежат ОДНИМ коммитом
(`cad5fa2`): разрез потребовал бы хирургии по хункам одного файла, а выигрыш — только в окне для
открытых вкладок. Кто катит — обязан знать это ограничение.

Данных решение не переписывает. Незакрытые внутренние заявки с историческим объёмом работ считаются
запросом из §8 плана; после выката они остаются на месте, но не входят в очередь согласования.

## Последствия

- Внутренний ремонт перестаёт порождать **гарантии по строкам**: строк у него нет, и реестр
  «Гарантии» такие заявки не увидит. Принято сознательно — гарантию даёт подрядчик; понадобится
  учитывать внутреннюю, это отдельная модель.
- Столбец «Сумма» у новых внутренних заявок пуст. Это ответ «стоимость не фиксируется», а не потеря.
- Состояние «внутренняя заявка со строками объёма работ» через API больше недостижимо: единственным
  способом его собрать была закрываемая ручка. Тесты, которым такое состояние нужно, заводят его
  прямым `INSERT` — и это честнее, чем держать ручку открытой ради фикстуры.

## Отвергнутые варианты

- **Оставить объём работ доступным как черновик без согласования.** Сохранял бы лишний экран и
  вопрос «а надо ли его заполнять» у каждого своего сотрудника; заказчик просил снять этап, а не
  сделать его необязательным.
- **Перечень выполненных работ без цен.** Дороже (вторая форма таблицы и правка денежной части DTO)
  и не отвечает ни на один заданный вопрос: что сделали, пишут комментарием закрытия.
- **Считать признак по «есть ли строки».** Заявка с историческими строками, но без подрядчика,
  закрывалась бы старым путём — то есть решение зависело бы от прошлого, а не от того, кто работает.
- **Стереть исторические ревизии миграцией.** Уничтожило бы основание уже принятых решений ради
  чистоты колонки.

## Workflow-fixes wave 1 (2026-10-12)

The owner's role walkthrough of 08.09.2026 produced the
[workflow-fixes plan](../office-equipment-workflow-fixes-plan.md), its forks closed the same day.
This wave implements the part of stages Э2 and Э3 that ships first (release R1) on top of this
decision. What was done, what was stopped, and what is held back.

### Р6. The estimate belongs to its author, not to every assigned person

`actsAsEstimateAuthor(subject, assignment, has)` in the contracts: the operator of the assigned
contractor, or the holder of `serviceRequests.estimate` (outside the service counterparty — the
administrator). It is narrower than `actsAsServiceExecutor` by exactly one branch — the named own
employee. On a mixed assignment (an own administrator plus a service company)
`serviceRequestNeedsEstimate` is true, and the wide side let the own employee write, submit,
withdraw and document the contractor's invoice through the API. Every estimate door asks the one
function: `PUT /:id/estimate` (the guard `assertEstimateAuthor`, replacing `assertExecutorSide`
there), `canSubmitServiceEstimate`, `canReopenServiceEstimate`, and the side of the `estimate`
file kind — a side of its own, `estimate_author` («назначенная сервисная компания»), because
`executor` also serves acts, invoices and coupons. The portal's menu and tab follow through the
same predicates. Approval is untouched, as the plan says. `PUT /:id/estimate` now asks the subject
(422 «объём работ по ней не составляют») before the side, the order the submit and reopen doors
always had: on an internal request nobody is the estimate's author, and the refusal must name the
request. ADR 0208's decision 4 («Передать документ на согласование» for whoever may submit but may
not declare) now has one subject left — the administrator.

Compatibility with shipped bundles: no field is added, removed or retyped and no request schema
changes; only the set of subjects the server answers 200 to shrinks. A bundle that predates the
wave still draws the estimate entries for the own employee of a mixed assignment (it asks the old
wide predicate); pressing one gets 403 or 422 with the server's sentence, which the estimate
window's shared failure handler shows as a toast — a readable refusal, not a crash.

### Р10. The estimate step is taken on its tab

The «Объём работ» tab takes the READY item `estimate` of the action set («Работы выполнены» or
«Передать документ на согласование») and shows it next to the decision buttons; the card menu
(both forms) strikes it (`HIDDEN_IN_CARD_MENU`), the list menus keep it. The entries registry and
the accessibility suites follow; a contractor's card in «В работе» may now have no «Действия» at
all — each of his items has its own place. A new suite, `service-request-actions-profiles`, pins
the composition of the action set per profile: the IT service on an internal request has no
estimate item at all, the own employee of a mixed assignment has neither submit, nor reopen, nor
the attachment of the estimate kind, the contractor on a repair has the money step and the closing
but no cancel, urgency or move.

The second half of Р10 — moving the upload of the `estimate` kind into the estimate window — was
NOT done: since ADR 0183/0208 the estimate is submitted as a document and the window already
uploads it (`EstimateDocumentFiles`), so the attachment the owner asked for exists, in another
form; and the window was being rewritten by a parallel stream (Q10). Stopped and reported.

### Р3 was stopped: a later customer decision already answered it

The plan (08.09) says the reassignment reason disappears and the history gets the executor
comment. The code carries the owner's LATER answer of 09.09.2026 (free-estimate plan Р6, В8, ADR
0179): the reason is optional, the history shows the reason or a dash, the comment goes to the
audit only — because the comment is written to the NEW executor and reads as a false reason in the
history. Doing Р3 literally would reverse that decision; it is reported to the integrator instead.

### Н14. The auto-close anchor is the moment of the transition

`completed_at` held the chosen date at midnight, so a request closed with yesterday's date was
mature the second it entered «Решена». The migration `*_service_request_done_at.sql` adds
`service_requests.done_at`: `applyTransition` writes it with the same `now` as `status_changed_at`
on every real entry into `done` and clears it on leaving; a `done → done` move leaves it alone; the
auto-close's own exit clears it. Every status change of a request goes through `applyTransition`
(the auto-close is the one other writer and clears the anchor in its own SQL), so the anchor
cannot fall behind the status; the requester-mail suite walks the whole cycle and compares the two
columns after every step. The backfill fills the requests in «Решена» only — the last real entry
from the history (`from_status IS DISTINCT FROM 'done'`), otherwise `GREATEST(status_changed_at,
completed_at)`, never `completed_at` alone — with a fail-fast guard that cannot plausibly fire
(`status_changed_at` is `NOT NULL`). The selection counts from `COALESCE(done_at,
status_changed_at)`; the first closing document and `auto_close_not_before` still push it later.
No new index: the selection stays driven by the `(status, status_changed_at)` one.

**Deploy window.** Migrations run while the previous server serves. It neither reads nor writes
`done_at` (drizzle names its columns), so a request it moves into «Решена» after the backfill keeps
the column empty and matures by `status_changed_at` — exactly 24 hours after its real transition
(the auto-close db test imitates this writer). No constraint ties the column to the status, for
the same reason.

**The residual, stated honestly.** The statement «keeps `done_at` empty» holds only for a request
the old server moves into «Решена» from another status. A request ALREADY in «Решена» at the
backfill has a non-empty `done_at`; if the old server re-enters `done` with it inside the window
(rework and close again, hold and resume, accepted → done), the old code writes
`status_changed_at` but not the column, the stale backfilled `done_at` wins in
`COALESCE(done_at, status_changed_at)`, and that request can mature at the next five-minute tick —
it may close early. The window is minutes long and the case needs both the backfilled row and a
move in it. The plan chose the backfill and the `COALESCE` reader on purpose and they are kept:
reading the later of the two would let the touch of a `done → done` move restart the objection
window, the very thing the anchor exists to stop. Outside this residual the new anchor is never
earlier than the old one for the same request, so the first run after the release closes no more
than the old rule would have. The runbook section on the auto-close is rewritten (it said «no
migrations» and counted from `completed_at`) and names the residual and the manual repair.

### Held for R2 (S-23)

Plan items Р4 (closing the work without a window: `PATCH /:id/complete` takes `{ version }` and
nothing else) and Р4а («Ведение» edits the completion: a new `PATCH /:id/completion`) are prepared
on a separate branch and are NOT part of this wave. The reason is the strict body: the closing
schema required `completedOn` and `items` in every contract revision shipped so far, the old
window was its only caller, and consumables requests also send `consumables` rows — so a strict
`{ version }` body refuses every shipped portal bundle until its tab is reloaded. The owner's
decision S-23 puts them into release R2 together with the client floor raised to 7
([ADR 0226](0226-client-floor-seven-and-deploy-preflight.md): R1 carries contract 7, R2 requires
floor 7 and drops the doors the old bundles use), so an old bundle is turned away at the gate
instead of at the button. Until then the closing window and the
closing schema stay exactly as they were, and the date of the work is still chosen in the window;
Н14 does not depend on them (the anchor is the moment of the transition however the date is set).

### Not done here, on purpose

- the bulk `assign` keeps its required reason (plan Р3 bullet, Р9 of stage Э6);
- stages Э4–Э6 of the plan (Р7, Р8, Р2, Р9) are the next wave.
