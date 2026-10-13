# ADR 0174. Объём работ составляют там, где за работу платят: внутренний ремонт закрывается без него

- Статус: Принято (реализовано целиком — контракты, сервер, портал, db-набор). Реализация — коммит
  `cad5fa2`. Схему решение НЕ меняет: колонки объёма работ остаются на месте и у внутренних заявок
  просто не заполняются. Парная миграция волны (`0286`, переопределение частичного индекса
  срочности под отбор) к этому решению отношения не имеет и живёт своей причиной. Extended on
  2026-10-12 by wave 1 of the role-walkthrough fixes (plan
  [office-equipment-workflow-fixes-plan.md](../office-equipment-workflow-fixes-plan.md), stages
  Э2 and Э3): the estimate belongs to its author, the estimate step sits on its tab, and the
  auto-close counts from the moment of the transition — see
  [the wave 1 section](#workflow-fixes-wave-1-2026-10-12). Extended on 2026-10-13 by wave 2
  (stages Э4 and Э5): the contractor does not see the nomenclature of a consumables request and the
  warehouse does not move on it, and the IT service cancels with a permission of its own — see
  [the wave 2 section](#workflow-fixes-wave-2-2026-10-13)
- Изменяет: [ADR 0208](0208-service-work-completed-document-flow.md) — решение 4: the named in-house
  executor no longer submits the estimate document at all (workflow-fixes Р6); «Передать документ
  на согласование» stays for the administrator, the one subject left who may submit and may not
  declare the exemption
- Миграции: `*_service_request_done_at.sql` (wave 1, `done_at` and its backfill) and
  `*_service_request_cancel_grant.sql` (wave 2, the cancel right in the IT set); the numbers are the
  next free ones at integration, and the code and the tests never name them
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
  placement [serviceMenuPlacement.ts](../../apps/web/src/pages/service/serviceMenuPlacement.ts);
  wave 2 — the reader and shelf predicates in the contracts
  [service-requests.ts](../../packages/contracts/src/service-requests.ts)
  (`serviceConsumablesHiddenFrom`, `serviceRequestConsumablesAreOurs`), the file door
  [files.ts](../../apps/api/src/routes/files.ts), the letter planner
  [service-request-mail.ts](../../apps/api/src/services/service-request-mail.ts), the history
  [service-request-history.ts](../../apps/api/src/services/service-request-history.ts) and the
  consumables tab [ServiceRequestConsumablesTab.tsx](../../apps/web/src/pages/service/ServiceRequestConsumablesTab.tsx); stage Э5 — the cancel right in the dictionary
  [permissions.ts](../../packages/contracts/src/permissions.ts) and the catalog, the cancel corridor
  and the per-target status question in the contracts, the guards of the status and batch doors in the
  route, and the batch runner [service-request-bulk.ts](../../apps/api/src/services/service-request-bulk.ts)
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
- stage Э6 of the plan (Р9, the bulk reassignment and the bulk «Решена») rides release R2 with Р4:
  its «Решена» half needs the closing without a window (S-23). Stages Э4 and Э5 are the next
  section.

## Workflow-fixes wave 2 (2026-10-13)

The same plan, stages Э4 and Э5. Nothing in this wave touches the closing body or the client
floor: Р4/Р4а and Р9 stay held for release R2 (S-23), and the closing window of this wave is the
old one with one more mode.

### Э4. The service centre and the cartridges (Р7, Р8)

**Р7. The nomenclature of a consumables request is hidden from the contractor — on every channel.**
The owner asked to remove the visibility of the nomenclature «in the card and in the documents».
The rule is one pair «request × reader», `serviceConsumablesHiddenFrom(request, subject)` in the
contracts: true for the contractor's side (the counterparty type `service`) on a request of kind
`consumable`. Applied to the request alone it would hide the list from the in-house executor and
«Ведение», who fill it in; applied through the audience map it would not reach the contractor at
all, because he is on the `finance` side of that map (he sees the money of his own repair). So it is
a second cut next to the audience one, not a row of its map. The reader is asked by his
counterparty type and not by his assignment to the request: the scope already hides requests of
other companies, and a type check is fail-closed for whoever slipped through.

The server applies it on every channel that carries the rows or the names of the documents:

| Channel                              | What the contractor gets                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| card, list, response of every action | `consumables: []` and `files: []` — `forAudience` takes the principal now, so a response built without the cut does not compile                                                                             |
| history                              | the entries stay, the keys `consumables`, `consumablesIssued`, `consumablesReturned`, `filesAdded`, `filesRemoved` go (`SERVICE_HISTORY_CHANGE_NOMENCLATURE`, a closed `Record`; an unknown key is dropped) |
| direct link to a file                | `404 «Файл не найден»`, as for a missing link — the SQL predicate asks the same contracts rule with a probe of the only kind it can hide                                                                    |
| `PUT /:id/consumables`               | `403` (side), asked right after the scope, before the kind and status                                                                                                                                       |
| `POST /:id/files`                    | `403` (side), before the audience layer — he passes that one as `finance`                                                                                                                                   |
| `DELETE /:id/files/:fileId`          | `404`, the answer for «no such link»                                                                                                                                                                        |
| letter about a document              | the addressees whose source is the contractor (his live operators, the company mailbox) are struck; the own named executors stay                                                                            |

All kinds of documents are hidden, not only some: any of them can name the item («Счёт: Тонер Ricoh
MP C305.pdf»). The letter is cut by SOURCE, not by target: the `service` side includes the own named
executors, to whom the letter is rightly addressed. If the policy struck every addressee of the
target, the target is withdrawn and the outcome is `not_needed` — the word the module already uses
for «nobody is owed this» — and not `no_recipients`, which would send the administrator to fix a
mailbox that needs no fix. Copies stay: they are the company's own observers.

Named gaps, not hidden ones: free text is not filtered (the description, the discussion — the same
boundary as in ADR 0160, «not a DLP filter»), and the unit's service history in the directory card
carries no composition at all (checked, not assumed). The portal's tabs «Расходники» and
«Документы» and the items «Заполнить расходники» are a CONSEQUENCE of the server cut: a contractor
gets the tabs «Заявка» and «История», and a response that forgot the cut would still not be drawn
as a tab — but markup is never the protection, the response is.

**Р8. The request handed to a contractor does not move our warehouse.** The owner's answer is «the
warehouse does not move at all». `serviceRequestConsumablesAreOurs({ kind, serviceCounterpartyId })`
in the contracts: true for consumables without a contractor. With one on the request — alone or
next to an own administrator (a mixed assignment) — nobody marks an issue, «Ведение» and the
in-house executor included. The issue door answers `422` about the shelf, not `403`: everyone who
reaches the line holds the permission, and the shelf is not ours whoever asks. The refusal stands in
front of the status check (a list of statuses would only suggest waiting) and once more inside the
transaction, under the row lock — the assignment can change between the two (a test holds the row
from a second connection, hands the request to the contractor and lets go). The closing of such a
request does not call `applyConsumableFacts` and demands no rows: a contractor who cannot see the
composition could not fill them in. A body that still carries issue rows (a stale tab) gets the
sentence of the issue door and is neither applied nor silently dropped: the person typed
quantities, and «saved but not saved» is what the module refuses elsewhere too. A fact written
while the request was ours stays a fact (plan Н10); handing the request back to an own executor
opens the mark again.

The portal follows through the same two functions: the item «Отметить выдачу» is not drawn when the
shelf is not ours; the item `complete` of such a request is named «Перевести в «Решена»» (an item
named «Закрыть работы» by someone who issues nothing reads as a report of an issue) and its window
has a mode of its own, `supplied`: the date and words, no rows, no `consumables` key in the body.
That mode, like the whole window, goes away with Р4 in release R2.

**Compatibility with shipped bundles (client contract 4 and later).** No response field is added,
removed or retyped, no request schema becomes stricter, no header is required. Only the set of
subjects the server answers `200` to shrinks, each time with a sentence of its own: the contractor
on the composition and the document doors (`403`, `404`), the issue mark on a contractor request
(`422`), the closing of such a request with issue rows (`422`). An old bundle still draws what the
new one hides — the contractor's empty tabs, «Отметить выдачу» for «Ведение», the issue rows in its
closing window — and a press gets the sentence, shown by the shared failure handler as a toast, not
a crash. The old closing window of the contractor shows no rows (his composition is empty) and sends
`consumables: []`, which the server accepts; this is read from the code, not run in a browser.

### Э5. The IT service cancels (Р2)

The owner's walkthrough: the IT account cannot cancel a request with a comment. The cancel arcs sit
in the operator corridor behind `serviceRequests.status`, which the IT service does not have and must
not (it opens the acceptance, the return for rework and, with `requests.rollbackStatus`, the
rollbacks — the same walkthrough, item 6, asked to take exactly these away). So the cancel got a
right of its own, **`serviceRequests.cancel`**, and a corridor of its own, `SERVICE_CANCEL_TRANSITIONS`:
«Новая», «В работе», «Отложена» → «Отменена» and nothing more. A test pins it row by row against the
cancelling arcs of the operator corridor, so the IT cancel and the «Ведение» cancel cannot become two
different operations.

- **Where it lives.** The dictionary and the catalog entry (action `status`, next to the hold);
  `PERMISSION_REQUIRES` asks `serviceRequests.read`; the live composition of the IT set
  (`ROLE_ADDON_PERMISSIONS`) and the catalog migration `*_service_request_cancel_grant.sql`, which
  appends the right to that one system set and to no other. «Ведение» does not get it (it holds
  `status` and cancels with it), the contractor does not (his side answers instead of the others and
  never reaches the branch, whatever set is handed to him by hand), the administrator has the whole
  dictionary.
- **The doors.** `PATCH /:id/status` is guarded by `status` OR `cancel`; the corridor behind the
  guard still decides which move — there is no second map of rules. The batch: the route guard of
  `POST /bulk`, `canUseServiceBulk` and `canRunServiceBulkOperation('cancel')` all ask `status ∨
cancel`; the accept stays on `status`. The access manifest and its tests say the same.
- **A finding the plan did not have: the guard was part of a rule.** The corridor hands the IT service
  one more arc through the status door besides the cancel — `in_work → new` («Вернуть в «Новую»») comes
  to it from the right to assign — and the door had always been closed to it by the guard alone. Let
  the cancel right through the guard and the arc comes back through the API (the portal item already
  asked `status` itself, which is why the first walkthrough fix worked). The door therefore asks
  `holdsServiceStatusRight(subject, to)` of the contracts: `status` for any target, `status` or
  `cancel` for «Отменена». The portal's rollback item asks the same function. A test sends the
  rollback with the cancel right and gets 403; the line was checked against its removal.
- **The right works inside the executor scope (ADR 0179).** The IT account is an «executor only»
  profile, and with the scope switched on every mutating door — the cancel included — answers it for
  requests it is named on or has authored. A request of someone else's is out of reach until the IT
  service takes it by assignment; the cancel right does not bypass that, and a test pins the
  sentence. This is the existing rule meeting the new right, not a decision of this wave.
- **A latent defect found on the way and fixed in the same wave.** The batch runner switched the
  deferred executor-invariant triggers to immediate at the very START of every row's transaction,
  while a cancel removes the executors before it writes the status: the cancel of a «В работе»
  request with an in-house executor failed on its first `DELETE` with «Не удалось выполнить» — for
  every holder, «Ведение» included, and the IT service's own requests are exactly such. The statement
  moved to AFTER the row's step and before the checkpoint; `SET CONSTRAINTS` in mid-transaction acts
  retroactively, so a bad row still fails before the checkpoint with the same refusal. The whole
  batch suite and a control for «Ведение» stand on it.

**The catalog migration and the roll-out window.** The migration runs while the portal is up and
before the application restarts, so for a while only the OLD server reads the catalog with the new
row. That is safe, and verified: the old server drops a permission code it does not know at the
"database to code" boundary (`isPermission` in `loadPrincipal` and in the session builder), so a
holder's session is built from the codes it knows — the mechanism that has always carried orphan
rows (`auth-permissions.db.test.ts`). The sessions are NOT invalidated (`auth_version` stays): the
right is added, not taken away, the server computes permissions on every request, and the portal
learns the new list with the next session response — the cancel item appears after a reload, the
server accepts the move earlier. The in-file guard is relative (a snapshot before the insert against
the state after it) and compares nothing with a hard-coded size of a set, so it cannot fire on any
data; it raises, with a readable sentence, only if the insert itself did something other than it
says (the set is missing, the right landed in a second system set, the composition grew by more than
one right, a grant row appeared or vanished). A test with the fixtures BEFORE the migration (an own
database, the file found by its suffix) pins all of it, and every guard was checked by removing it.

**Compatibility with shipped bundles.** No response field is added, removed or retyped, no request
schema becomes stricter, no header is required. The set of subjects the status door and the batch
answer `200` to GROWS (the IT service, holders of the cancel); nobody is refused more, except by the
per-target question, which keeps closed what the door has always kept closed. An old bundle draws the
cancel item for the IT service only after the next session response and never draws the rollback item
for it.
