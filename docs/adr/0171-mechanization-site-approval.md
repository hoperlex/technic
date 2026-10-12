# ADR 0171. Виза ответственного лица площадки в модуле «Механизация»

- Статус: Реализовано (08.09.2026), этап Э1. План —
  [mechanization-approval-and-grants-plan.md](../mechanization-approval-and-grants-plan.md),
  редакция 3. Схема — две колонки `mech_requests.approved_by` / `approved_at` (миграция `0284`),
  состав двух системных наборов (`0285`); номера взяты по файлам дерева перед созданием. Stage 3
  (the extension visa) implemented 12.10.2026 for release R1 — the three `/:id/extension` doors,
  the `mech_request_extensions` table and the portal switch; removing the old
  `PATCH /:id/extend` is release R2 (decision S-21, see «Stage 3» below)
- Домены: механизация, доступ
- Область: контракты — [permissions.ts](../../packages/contracts/src/permissions.ts),
  [permission-catalog.ts](../../packages/contracts/src/permission-catalog.ts),
  [grants.ts](../../packages/contracts/src/grants.ts),
  [mech-requests.ts](../../packages/contracts/src/mech-requests.ts);
  API — [schema.ts](../../apps/api/src/db/schema.ts),
  [mech-requests.ts](../../apps/api/src/routes/mech-requests.ts),
  [mech-request-dto.ts](../../apps/api/src/services/mech-request-dto.ts),
  [mech-request-diff.ts](../../apps/api/src/services/mech-request-diff.ts),
  [mech-request-history.ts](../../apps/api/src/services/mech-request-history.ts),
  [mech-request-list.ts](../../apps/api/src/services/mech-request-list.ts),
  [access-manifest.ts](../../apps/api/src/lib/access-manifest.ts);
  портал — [mechRequestMenu.tsx](../../apps/web/src/pages/mech/mechRequestMenu.tsx),
  [mechRequestActions.tsx](../../apps/web/src/pages/mech/mechRequestActions.tsx),
  [mechRequestFilters.tsx](../../apps/web/src/pages/mech/mechRequestFilters.tsx),
  [mechRequestViewFields.tsx](../../apps/web/src/pages/mech/mechRequestViewFields.tsx),
  [MechStateTag.tsx](../../apps/web/src/entities/mech-request/ui/MechStateTag.tsx);
  stage 3 — contracts [mech-request-extensions.ts](../../packages/contracts/src/mech-request-extensions.ts),
  [request-history.ts](../../packages/contracts/src/request-history.ts); API
  [mech-request-extension.ts](../../apps/api/src/routes/mech-request-extension.ts) (routes),
  [mech-request-extension.ts](../../apps/api/src/services/mech-request-extension.ts) (service),
  [audit.ts](../../apps/api/src/lib/audit.ts); portal
  [mech-extend](../../apps/web/src/features/mech-extend),
  [MechRequestViewModal.tsx](../../apps/web/src/pages/mech/MechRequestViewModal.tsx); tests
  [mech-extension.db.test.ts](../../apps/api/test/mech-extension.db.test.ts),
  [mech-extension-contracts.test.ts](../../apps/api/test/mech-extension-contracts.test.ts),
  [mech-extension.test.tsx](../../apps/web/test/mech-extension.test.tsx)
- Развивает: [ADR 0152](0152-mechanization-module.md) (сам модуль),
  [ADR 0025](0025-vehicle-request-approval.md) (виза заказа техники — образец),
  [ADR 0032](0032-approval-not-automatic-for-admin.md) (автовиза не касается администратора)
- Связано: [ADR 0044](0044-vehicle-request-early-end.md) (согласуемое изменение срока — образец
  этапа 3), [ADR 0223](0223-portal-permission-oracle.md) (портал спрашивает список прав сервера),
  [ADR 0226](0226-client-floor-seven-and-deploy-preflight.md) (пол клиента 7: снятие старой ручки
  продления в R2), [ADR 0021](0021-permissions-model.md) (право — единица доступа),
  [ADR 0062](0062-department-object-link.md) и [ADR 0144](0144-department-objects-set.md)
  (площадки отдела), [ADR 0106](0106-assignable-permission-grants.md) и
  [ADR 0112](0112-site-role-and-role-grants.md) (наборы полномочий, куда уезжает подпись)

## Контекст

Аренда малой механизации стоит денег каждый день, и между «площадка попросила виброплиту» и «офис
договорился с арендодателем» до сих пор не стояло ничьё согласие: заявку заводил любой заказчик, а
дальше её брал в работу менеджер. У заказа техники такое согласие есть с ADR 0025 — виза
руководителя строительства, — и заказчик 08.09.2026 попросил ту же подпись здесь, добавив, что
**право визы у площадки одно на портал**: подписывающий отвечает за площадку, а не за модуль.

Модуль при этом устроен иначе, чем заказ техники, и разница мешает перенести решение дословно. У
заказа заказчик — объект **либо** отдел (`num_nonnulls(object_id, department_id) = 1`), и ось роли
однозначно выбирает, что сравнивать. У аренды площадка есть **всегда** (она же место эксплуатации и
ось области), а отдел — необязательный заявитель поверх неё (ADR 0152, Р17), и обе колонки бывают
заполнены разом.

## Решения

### 1. Право визы — своё, `mechRequests.approve`

Седьмое право модуля. Переиспользовать `vehicleRequests.approve` было бы «ноль новых прав», но это
означало бы право одного модуля, открывающее ручку другого: витрина механизации показывала бы право
«Заказа ТС», `MODULE_SCOPE` пришлось бы толковать поперёк модулей, а манифест маршрутов перестал бы
отвечать, чем именно защищена ручка. Модульность прав — инвариант ADR 0021; **единая подпись
площадки выражается составом набора, а не одним правом поперёк модулей**.

Право объявлено в `PERMISSION_REQUIRES` зависящим от `mechRequests.read` (подписывают то, что
видят) и стоит в `MODULE_SCOPE` наравне с остальными шестью: держатель с пустой площадочной
областью раздела не видит и подписывать ему нечего.

### 2. Подпись живёт и в матрице ролей, и в наборах каталога

Целевое состояние — набор: `mechRequests.approve` добавлен в **«Визу объекта»** (`site_approval`) и
**«Визу отдела»** (`department_approval`), которыми после этапов 8 и 9 реформы доступа собираются
сегодняшние `rukstroy` и `department_head`. Второго набора «Виза механизации» не заводится: у
площадки это одна должность и одна ответственность.

Одних наборов, однако, недостаточно, пока живы упраздняемые роли: права набора считаются
соединением с `grant_roles`, а там у обоих наборов стоит целевая роль. Дописать `rukstroy` туда
нельзя — это прямо отвергнуто миграцией `0155`: строка открыла бы администратору выдачу визы заказа
техники рядовому штабу. Поэтому право **одновременно** стоит в матрице ролей у `rukstroy` и
`department_head` — ровно так, как там сегодня живёт `vehicleRequests.approve`. Это обычное
состояние перехода: до перевода учёток подпись приходит ролью, после — набором, а тождества реформы
сохраняются, потому что растут обе стороны.

**Следствие названо вслух:** «Виза отдела» действует уже сегодня (её совместимая роль `department`
живая), и её держатели получают визу механизации в момент выката — объявленное расширение доступа,
а не побочный эффект.

### 3. Виза держит вход в работу, и только его

`new → confirmed` у неподписанной заявки запрещён (`mechTransitionBlocker`): за «взяли в работу»
стоит договорённость с арендодателем и деньги площадки. Остальных переходов подпись не касается —
отмену неподписанной заявки закрывать нужно именно отменой, а завершение решают те, кто ведёт
аренду.

**Откат «Выполнена → В работе» барьером не запирается**, и это не послабление: аренда уже
состоялась, откатом её открывают, чтобы поправить факт, а у заявок старше визы подписи нет и взяться
ей неоткуда — требуй барьер её здесь, вся прошлая история модуля стала бы неисправимой.

**Инварианта «в работе ⇒ завизирована» в базе нет** по той же причине: условие упало бы на первой
существующей строке в момент наката, а подписать её задним числом некому. Барьер держит сервер —
тот же выбор, что у `vehicle_requests`.

**Визу ставят и снимают, пока заявка «Новая»** (`isMechApprovalChangeable`). Откат `confirmed → new`
подпись **бережёт**: он стирает договорённость и факт по построению, но согласия площадки этим не
отменяет — тот же ответ, что дал заказу техники ADR 0172.

### 4. Область подписи — своя сторона заявки, по оси роли

`canApproveMechRequest` — одна функция на портал и сервер:

```text
нет права `mechRequests.approve`  → нет
объектная ось                     → площадка заявки среди своих объектов
отдельская ось                    → заявитель-отдел свой И площадка закреплена за отделом сейчас
без своей оси (администратор)     → да
```

Ветвление идёт по **оси роли**, а не дизъюнкцией «совпал объект ИЛИ отдел». У роли отдела есть
производный список площадок (ADR 0062/0144), и спроси мы по нему — руководитель отдела визировал бы
заявки самой площадки, которых его отдел не заводил. Отсюда прямой ответ на вопрос заказчика:
заявку отдела подписывают **оба** — площадка и руководитель отдела, кто первый; заявку самой
площадки отдел не подписывает никогда.

### 5. Заявка визирующего согласована подачей

`approvesOwnMechRequestOnCreate` — дословно правило ADR 0025 п. 5: подпись случается сама только у
того, кто отвечает за подразделение заказчика. Администратор под правило не подпадает (ADR 0032):
он заводит заявку за того, кто до портала не добрался, и согласования этим не происходит — иначе
визу обходили бы просьбой «заведи за меня». Дублирование идёт той же веткой: копия — новая заявка,
и виза исходной на неё не переносится.

### 6. Существенная правка снимает визу

Снимают её модель, срок, площадка и заявитель; комментарий, вложения и контакт ответственного — нет:
подписывают технику, срок и место, а не того, кто встретит машину на воротах. Условий четыре и все
обязательны: подпись стоит, заявка «Новая», правит не тот, кто может её визировать, и правка меняет
суть. Третье — потому что визирующий подтверждает изменение самим фактом правки.

### 7. Виза и её отзыв — строгие события журнала

Оба пишутся `writeAuditTx` внутри той же транзакции, что меняет строку, и приходят в карточку
готовыми видами истории `approved` / `approvalRevoked` — общими с заказом техники: подпись площадки
это одно и то же действие во всех модулях. Событие — **единственный носитель факта**: после отзыва
колонки пусты, и что подпись была, кто её поставил и когда, не помнит больше ничто. Автоматическое
снятие правкой пишет то же событие той же транзакцией.

Сама ручка (`PATCH /:id/approval`, постановка и отзыв одним маршрутом) идёт общим протоколом мутаций
модуля: замок первым действием, существование и область, сверка версии **до** предметных проверок,
CAS. Повтор того же состояния — тихий успех без записи в историю.

## Последствия

- на площадке появляется работа, которой не было: неподписанные заявки видны тегом «ждёт визы» и
  отбираются фильтром — им же офис отбирает подписанные, готовые к работе;
- **площадка без держателя визы встаёт**: заявку нельзя взять в работу вовсе. Тот же риск давно
  живёт в заказе техники и решается организационно — перед выкатом сверяется, что визировать есть
  кому;
- заявки, взятые в работу до этого выката, остаются без подписи навсегда — прошлое не переписываем,
  и фильтр «виза: нет» их показывает;
- держатели набора «Виза отдела» получают подпись механизации сразу (решение 2);
- писем нет: у модуля нет почтового контура вовсе, и «ждёт вашей визы» — отдельная работа.

## Альтернативы

**Переиспользовать `vehicleRequests.approve`.** Отвергнуто решением 1: комендант, у которого заказа
техники нет вовсе, не смог бы визировать аренду на своей площадке никогда, а витрина показывала бы
право чужого модуля.

**Отдельный набор «Виза механизации».** Отвергнуто: подпись площадки — одна должность, и разводить
её по модулям значило бы предлагать администратору выбор, которого в работе не существует.

**CHECK «в работе ⇒ завизирована».** Отвергнуто решением 3: упал бы на первой существующей строке.

**Дизъюнкция «объект или отдел» в области подписи.** Отвергнуто решением 4: отдала бы руководителю
отдела чужие заявки площадки.

## Stage 3: the extension visa (2026-10-12)

The customer's fourth answer of 08.09.2026 — «продление тоже визирует площадка» — was left for stage
3 of the plan (R10, R12, R13). It is implemented here; this section records what was built and
where it deviates from the plan, which is intent, not state.

### 8. An extension is asked by the office and signed by the site

Before this stage `PATCH /:id/extend` moved `planned_to` at once with `mechRequests.extend` (the
dispatcher). Now the same shape as the vehicle early end (ADR 0044) applies, for the same reason:
between "asked" and "moved" stands someone else's decision, and it can be "no".

- **`POST /:id/extension`** (`mechRequests.extend`) — the request: the new return date and a
  required reason. Only a running rental (the whole predicate `isMechRentalRunning`), the date
  strictly later than the current one. A repeated request overwrites the row whatever it held; the
  chain stays in the history. The term does not move.
- **`PATCH /:id/extension`** (`mechRequests.approve`) — the decision `{ approved, comment, version }`:
  approval moves `planned_to` **in the same transaction** as the signature, so "approved, term
  unchanged" never exists; a refusal requires its reason.
- **`DELETE /:id/extension?version=N`** (`mechRequests.extend`) — withdrawal of the pending request
  by any `.extend` holder, not only its author: the dispatch office keeps one queue. A decided row
  is not withdrawn; the next request replaces it.

All three follow the module's protocol (lock of the request first, the client's version before the
subject checks, CAS) and bump the request's version even when only `updated_at` changes in it: the
request's version is the one etag of the card, and a CAS on the child table without its own version
does not exist. The permission `.extend` does not move to the site: the dispatcher still talks to
the lessor, the site signs the agreement instead of making it. Its catalogue label now reads
«Запрашивает продление аренды механизации».

### 9. Only the site signs an extension

`canApproveMechExtension(subject, row, has?)`: the visa permission, the **object** axis and the
request's own site; a department role never decides; an axis-less role (the administrator) does.
This deliberately differs from decision 4: the department head signs a request his department filed
on its site, but not the further cost of a rental already running there. The refusal of scope is
403 «Продление аренды визирует ответственное лицо этой площадки». The third argument is the
permission oracle (ADR 0223): the server leaves the matrix default, the portal passes its `can` over
the server's list.

### 10. The state is re-read at the moment of the signature

Approval requires the request to be pending, the rental still running, `planned_to` equal to the
snapshot `previous_planned_to` taken when the request was filed, and the new date still later —
otherwise «Срок аренды изменился после запроса — нужен новый запрос продления» (or «Аренда больше
не идёт» when it ended). A refusal requires only a pending request. Both rules live in
`mechExtensionApprovalBlocker`; the portal's buttons are `mechExtensionAccess`, built from the same
blockers, so a shown button does not end in a 422.

### 11. One row per request, dropped with the rental's end

Table `mech_request_extensions` with its own enum `mech_extension_status` (`pending`, `approved`,
`rejected`), primary key `request_id → mech_requests ON DELETE CASCADE`, the snapshot
`previous_planned_to`, the author and the decision with `RESTRICT` on both accounts, and checks:
the decision pair, `(status = 'pending') = (decided_at IS NULL)`, forward only, a non-blank reason, a
reasoned refusal. No index on pending rows: nothing lists them across requests yet.

A pending request is deleted when withdrawn and, in the same transaction, when the rental ends
under it — by completion and by the revoked issue mark. Cancellation is not among the exits: a
request exists only on an issued rental, and an issued rental cannot be cancelled. A decided row
survives the end of the rental as the last answer.

### 12. History and audit

The approval keeps writing `mech_request.extend`, so the event keeps its meaning "the term moved"
and its kind `mechExtended`, now at the moment of the visa and with the visa holder's remark when
there is one. Three new actions, each with its own kind: `mech_request.extend_request` →
`mechExtendRequested` (current → asked date, reason), `.extend_reject` → `mechExtendRejected`
(reason), `.extend_drop` → `mechExtendDropped` (`withdrawn`, `completed` or `issue_revoked` in the
metadata, words in the card). All four are strict (`writeAuditTx`): the row is overwritten and
deleted, so the events are the only carriers of the chain.

### 13. The portal

The menu item «Продлить» became «Запросить продление» («Изменить запрос продления» while one is
pending) and opens the request window; the visa holder gets «Согласовать продление» and «Отклонить
продление» (one decision window in two modes), the dispatcher «Отозвать запрос продления». The card
shows the strip «Продление до … ждёт визы площадки» with the same actions, and a refusal while the
rental runs. The list tag gets a fourth value, «продление ждёт визы», by which the visa holder finds
the rentals waiting for him; the «В аренде» tab shows the new items. Availability is
`mechExtensionAccess` over the server's list (ADR 0223); the older items of the menu still ask the
matrix (roadmap item Q6).

### 14. The old door stays until R2, unchanged (decision S-21)

The plan removed `PATCH /:id/extend` together with a client-floor raise in the same release. The
owner's decision S-21 of 12.10.2026 split it: the R1 bundle carries contract 7 (ADR 0226), so the
server doors and the portal switch go into R1 **before** the deploy, and R2 removes the old door
under the same floor 7 — one floor raise for every debt. The contract-7 portal never calls
`/extend`; a web test pins that.

Until R2 the door keeps its old behaviour for tabs of contract 6 or older: it moves the term at once
and writes `mech_request.extend`. It is **not** routed into the request model. The plan rejects an
alias in so many words — an old tab would say «Продлено» while the term did not move — and S-21
places the new doors "next to" the old one; keeping the old tabs' behaviour unchanged is the only
choice that tells those tabs the truth. Two consequences are accepted with it:

- between R1 and the floor operation an old tab can still extend without the visa, as it could
  before R1; the floor operation closes it by forcing those tabs to reload;
- the old door does not consume a pending request. If it moves the term under one, the approval
  refuses with "the term changed", so one snapshot cannot move the term twice; the request is then
  refused or withdrawn.

R2 removes the route, its manifest line, `extendMechRequestSchema` with `ExtendMechRequestInput`,
and the old door's suite `mech-extend.db.test.ts` (or rewrites it against the new doors) — together
with `REQUIRED_CLIENT_FLOOR = 7`, after the confirmed floor operation (ADR 0226). The client contract
is not raised by this stage: ADR 0226 already raised it to 7 in R1 for all floor-gated debts.

### 15. The deploy window

The migration is additive: a new enum and a new table, no change to existing tables or data, no
guard. The release serving production (`dc647215`) neither reads nor writes either; its hard delete
and purge of a request remove an extension row by cascade, and no row exists before the new code
runs. Proof: the `dc647215` mechanization db suite (ten `mech-*.db.test.ts` files, 108 tests) is
green against its own schema plus this migration.

### What stage 3 does not do

No mail (the module has no mail contour); no filter "pending extensions" (the tag answers the
visa holder's question in the list); no automatic approval for a requester who could also sign —
the dispatcher never holds the visa, and the administrator's own request is not signed by itself
([ADR 0032](0032-approval-not-automatic-for-admin.md)).
