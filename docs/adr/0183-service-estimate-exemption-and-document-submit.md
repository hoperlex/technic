# ADR 0183. Объём работ подают счётом, а подпись снимает заявление оператора сервиса

- Статус: Реализовано (14.09.2026) — сервер и портал; оба рубильника включены миграцией `0341`
  ([ADR 0208](0208-service-work-completed-document-flow.md)), на проде с 07.10.2026; выпуск B —
  строгая пара подписи и её источника — 12.10.2026, строгая пара ожидания подписи и его
  происхождения — 13.10.2026 (раздел «Release B» ниже). План —
  [office-equipment-on-site-and-invoice-estimate-plan.md](../office-equipment-on-site-and-invoice-estimate-plan.md),
  редакция 5, решения Р1–Р13. Схема: `0306` (форматы ревизии, роль файла, источник подписи,
  происхождение ожидания, окно приёмки, вид заморозки, карантин файла, ослабленный
  `service_requests_approval_check`), `0307` (два рубильника), `0308` (право разбора карантина),
  `0309` (двусторонний запрет роли и уникальность номера страницы). Номера взяты по файлам дерева
  перед созданием; `0182` у ADR занял соседний поток
- Домены: оргтехника, доступ, схема-и-выкат
- Область: контракты —
  [service-requests.ts](../../packages/contracts/src/service-requests.ts) (форматы ревизии, тело
  предъявления дискриминатором, `canDeclareExemption` / `evaluateExemption`,
  `closingKindsForFormat` / `isServiceClosingFile`, предикаты и схемы спора,
  `allowsEstimateApprovalInStatus`), [files.ts](../../packages/contracts/src/files.ts),
  [request-history.ts](../../packages/contracts/src/request-history.ts),
  [feature-flags.ts](../../packages/contracts/src/feature-flags.ts),
  [permissions.ts](../../packages/contracts/src/permissions.ts) (`files.quarantineAudit`); сервер —
  [service-requests.ts](../../apps/api/src/routes/service-requests.ts),
  [internal-service-requests.ts](../../apps/api/src/routes/internal-service-requests.ts),
  [files.ts](../../apps/api/src/routes/files.ts),
  [service-estimate-revision.ts](../../apps/api/src/services/service-estimate-revision.ts),
  [file-view.ts](../../apps/api/src/services/file-view.ts),
  [request-files.ts](../../apps/api/src/services/request-files.ts),
  [request-history.ts](../../apps/api/src/services/request-history.ts),
  [schema.ts](../../apps/api/src/db/schema.ts); портал —
  [estimate-editor](../../apps/web/src/features/estimate-editor),
  [service](../../apps/web/src/pages/service),
  [service-complete](../../apps/web/src/features/service-complete)
- Связано: [ADR 0085](0085-office-equipment-module.md) (модуль),
  [ADR 0133](0133-service-request-unified-cycle.md) (цикл и неизменность подписанной ревизии),
  [ADR 0145](0145-office-equipment-cycle-simplification.md),
  [ADR 0160](0160-service-request-audiences.md) (аудитории карточки),
  [ADR 0179](0179-service-request-free-estimate-and-executor-scope.md) (свободная запись и раскладка),
  [ADR 0114](0114-waste-ticket-recognition.md) («распознанное — предложение, факт делает человек»)

## Контекст

Заказчик просил две вещи, и обе про одно — сократить путь денег через портал.

**Первая.** Часть работ сервис делает прямо при диагностике, и перечень таких работ по договору
«слишком сложен для реализации и нестабилен». Значит перечня не будет: вместо него представитель
сервиса сам говорит «согласование не требуется».

**Вторая.** Объём работ приходит счётом, а не набирается по графам. Сумму из счёта система узнает
позже — распознаванием; пока её не знает никто, и подставлять ноль нельзя.

Опросы 10–11.09.2026 закрыли тринадцать развилок. Три ответа определили модель сильнее прочих: сумму
в документном режиме **не требовать** («придёт от разбора документа»), полноту данных до
распознавания **не требовать** («факт наличия документов — уже достаточное основание для закрытия»),
лимитов и политики договора **не заводить** («доверять исполнителю»).

## Решения

### 1. Освобождение от подписи — не заявление о выполнении

Чекбокс говорит «согласование не требуется», и только это. Место работ, финансовое основание и факт
выполнения — разные вещи: слитые в один флаг, они дали бы карточку, которая одновременно утверждает
«работы выполнены» и «ждём выполнения», а закрытие работ потом позволило бы отметить те же работы
невыполненными.

«По условиям договора» в интерфейсе не пишем: политики в системе нет, договор ей неизвестен, и
обещание, которого она не проверяет, было бы ложью в подписи кнопки.

### 2. Документная ревизия живёт без строк и без суммы

Отсюда каскадом: служебной «одной строки на всю сумму» нет; построчного факта при закрытии нет —
отмечать нечего; итог по акту не пишется вовсе (`NULL`), потому что `sumAmounts([])` даёт ноль, а
записанный ноль читается как «работы бесплатны»; гарантия по такой заявке не фиксируется, пока счёт
не разложен по графам (она живёт на строке); в реестр гарантий заявка не попадает по той же причине.

Закрывает документную заявку **только акт** — прямой ответ заказчика: «документ — это счёт, но
закрывается заявка актом о выполненных работах».

### 3. Роль файла — своя колонка, а не вывод из пустой ревизии

Первая редакция плана предлагала считать закрывающим тот счёт, у которого не проставлена ревизия.
Это неверно дважды: политика пускает счёт в «В работе» обычной ручкой, которая ревизии не ставит, — и
тот же файл снова закрывал бы заявку; а автозакрытие считает срок от **первого** закрывающего
документа, то есть заявка созрела бы от времени ДО работ и закрылась бы сама, без акта.

Роль (`purpose`) назначает сервер в момент подшивки, клиент её не выбирает. Правило закрывающего
документа читает роль **и** формат действующей ревизии, и его спрашивают все семь потребителей,
включая два SQL-места.

### 4. След освобождения — своя таблица, в той же транзакции

Аудит модуля пишется после фиксации, и сбой между ними оставил бы денежное решение без единой записи
о том, кто его принял. Заявление записывается при обоих исходах — и когда освобождение применилось, и
когда рубильник выключен: в этом весь режим наблюдения, до включения служба видит, сколько заявлений
приходит и на какие суммы.

### 5. Основание не снимается никогда, а секретное закрывается карантином

Страница счёта — доказательство денежного решения, и снять её не может никто, включая автора и
держателя права на чужие файлы. Ошибочный документ исправляется вперёд: новая ревизия делает прежнюю
недействующей.

Отсюда же необходимость карантина: если основание нельзя снять, ошибочно загруженные персональные
данные стали бы неустранимым инцидентом. Карантин закрывает доступ раньше всех ветвей видимости,
включая автора загрузки; имя файла тоже не уходит наружу — оно само бывает персональными данными.

### 6. Спор — сущность с исходом, а не просто заморозка

Матрица «статус × исход» решается на сервере. Спор из «Решена» с исходом «оставить» возвращается в
«Решена», а не в «В работе»: возврат в работу стёр бы факт закрытия, суммы и гарантии — то есть
отменил бы выполнение, которого никто не отменял.

Окно приёмки после спора начинается с **последнего снятого блокера**: при исходе «оставить» — с
момента разрешения, при исходе «нужна подпись» — с момента самой подписи, а до неё заявка в выборку
автозакрытия не входит вовсе.

### 7. Денежного контроля у освобождения нет — и это записано как риск

Ни лимита, ни политики, ни ловли дублей (ответы заказчика). Барьеров четыре, и все постфактум:
рубильник, письмо офису, тег в списке и спор. Система не остановит ни крупную сумму, ни дробление
одной работы на пять заявок, ни повторную подачу того же счёта.

## Что нашлось исполнением, а не чтением

Семь находок, каждую нашли независимые проверяющие, поднимая базу и приложение, — и ни одна не видна
при чтении кода.

1. **Тавтология drizzle.** Условие в форме списка столбцов односоставного запроса давало
   «закрывающий документ есть всегда» — без единого отказа.
2. **Срок автозакрытия от первого документа** (см. решение 3): счёт-основание закрывал бы заявку сам.
3. **Замок приёмки стоял только в человеческой ручке**: воркер ту же заявку закрывал сам, то есть
   платёж уходил по отозванной подписи без участия человека.
4. **Карантин, закрытый в одной ручке, оставлял шесть путей к улике**: снятие вложения (помечает
   удалённым и ставит снос), уборка по возрасту, подшивка в другую заявку, повторное распознавание
   внешним сервисом, имя в десяти сборщиках вложений и имя в ИСТОРИИ заявки — оно пишется в журнал в
   момент подшивки, то есть до любого карантина, и гасить его приходится при чтении.
5. **Карантин нельзя было поставить на уже снятое вложение**, хотя объект живёт в хранилище ещё
   тридцать суток — то есть самый частый порядок событий («сняли, потом заметили») выходом не
   закрывался.
6. **Подрядчик снимал требование подписи сам.** После исхода спора «нужна подпись» он возвращал объём
   работ в правку, предъявлял тот же счёт с тем же освобождением — и исход считался по одному
   рубильнику, то есть подпись снова ставилась автоматически. Ни одной человеческой подписи, и
   заметить надо было успеть за сутки до автоприёмки.
7. **Обычная отмена оставляла спор открытым навсегда**: отмена снимала подрядчика, и обе двери
   разрешения закрывались.

## Цена и чего решение не обещает

- суммы документной заявки нет в отчётах до распознавания; итог по акту у неё пуст;
- дубль счёта системой не виден — реквизитов счёта не требуют;
- гарантия по документной заявке не фиксируется, пока счёт не разложен по графам;
- полный сброс сметы у заявки со счётом невозможен: переносить основание некуда, сброс обнуляет
  нумерацию, и «перенос» означал бы снятие роли основания — обход замка тем же кодом, ради которого
  замок и ставился. Сменить подрядчика по такой заявке нельзя, заводят новую;
- след освобождения и строка спора живут ровно столько, сколько ревизия, о которой спорили: полный
  сброс сметы и восстановление отменённой заявки уносят их каскадом. Факт остаётся в журнале действий;
- карантин не отзывает уже выданную подписанную ссылку — она доживает свой срок (по умолчанию две
  минуты);
- лента истории не называет спор отдельным событием: переходы видны, слова «спор» в них нет.

## Выкат

Порядок из четырёх шагов, и первые два обязательны до появления первой документной ревизии:
выпуск читателей роли и формата на всех узлах (API, воркер, портал) → проверка, что старых узлов не
осталось → рубильник документного режима → рубильник освобождения. Рубильников два, а не один: подача
счётом полезна и с обычным согласованием, и включать её вместе с обходом подписи незачем.

Запись журнала обновлений едет не с кодом, а с включением рубильников: при выключенных ключах у
пользователя не меняется ничего, и запись обещала бы возможность, которой в портале нет.

Откат к версии, читающей роль файла, свободен. Возврат к более старой — только после разбора всех
активных документных ревизий, а не одних автопринятых: их счета для старого кода снова станут
закрывающими.

## Release B: the signature and its source are one pair (2026-10-12)

Release A (`0306`) could not require "signed ⇔ source known": code that knew nothing about
`estimate_approval_source` was still serving, signing without a source and clearing a signature with
the source left behind. So release A read an empty source as `human`, and every reader had to apply
that rule (`serviceEstimateApprovalSourceOf`). Release B, roadmap item C8 of release R1, closes it.

**The audit that allows it.** Every code path that writes the signature snapshot was read at the tip
and in the release serving prod (`dc647215`), and they are identical. Both signing paths name the
source — the approval route (`PATCH /:id/estimate/approval`) writes `human` with the author, the
applied exemption on submit (`PATCH /:id/estimate/submit`) writes `auto` without one. All five
clearing paths clear the source with the date, the revision and the author: the transition reset
matrix in `applyTransition` (flag `approval`), the handover to another contractor in `assignStep`
(`PUT /:id/executors`, `POST /bulk`), the re-issue of a breakdown (`/:id/estimate/breakdown`), the
return for editing (`/:id/estimate/reopen`) and the dispute outcome "signature required"
(`/:id/estimate/dispute/resolution`). The reset matrix and a handler's patch are merged key by key,
and no patch touches one half of the pair without the other. No trigger, SQL function, worker job
or script writes these columns (the only triggers on `service_requests` are the IT signature guard
of `0199` and the deferred executor trigger of `0178`, neither of which writes them). So the old
server cannot write a row the strict constraint rejects during the migration window.

**The migration** (`0366_service_estimate_approval_source_strict.sql` in the executor branch; the
number is the next free one at writing time and moves if the integrator renumbers) locks
`service_requests` exclusively, backfills the two leftovers of release A's window — a signature
without a source becomes `human` (the old code could not auto-approve; the date is the test, not the
author, which a deleted account nulls), a source without a signature is cleared (no reader looks at
it) — then runs a fail-fast guard and replaces `service_requests_estimate_approval_source_check`
with the strict text, word for word the 0198 shape: `(estimate_approved_at IS NULL) =
(estimate_approval_source IS NULL)`, the value list, and no author for `auto`. The guard names up to
twenty requests the backfill could not fix; it is unreachable — the two updates cover exactly the
two mixed combinations, the release A constraint still enforces the value list and the authorless
`auto` until it is replaced, and the lock keeps every other writer out. Neither update bumps
`version`.

**The code side.** `ServiceRequestApprovalDto.source` is required and `serviceEstimateApprovalSourceOf`
is gone: the portal reads `approval.source` as sent. The server builds `approval` only when the
date, the revision and the source are present, which the two constraints make one fact. The client
contract does not change: bundles in the field already read the field, and the portal can meet
only the previous release in the rollout window, which has sent it since release A.

**Rollback.** To the previous release: free, it writes the pair consistently. Below this ADR's
release: besides the review of active document revisions above, the constraint has to be weakened
back to the release A text of `0306` first — such code signs without a source, and the strict pair
would refuse its first approval.

**Tests.** `service-estimate-approval-source-strict.db.test.ts` runs the migration file on a scene in
a rolled-back transaction: both backfill cases (including a signer whose account is gone), rows that
comply stay byte for byte, versions do not move, the strict pair refuses each of the four broken
shapes, and the guard fires with the request number when the release A constraint is removed; a
text check holds the guard predicates and the constraint body identical. The approval and revocation
flows are covered by the existing db suites (`service-estimate-dispute`,
`service-estimate-document-submit`, `service-estimate-document-complete`,
`service-estimate-breakdown`, `service-request-flow`, `service-request-auto-close`,
`service-auto-close-dispute` and the rest of the module), which now run against the strict
constraint.

**The pending side (2026-10-13).** The second half of the item makes `estimate_pending_source` one
pair with `estimate_pending_revision`: a request waits for a signature exactly when it is known what
opened the wait. The audit read every writer at the tip and in `dc647215` (identical; no commit since
prod touched them). The three opening paths name the origin — the submission (`submit`, or neither
column when the exemption applies), the re-issue of a breakdown (`submit`) and the dispute outcome
"signature required" (`dispute`); the six clearing paths — the reset matrix (flag `estimate`), the
handover in `assignStep`, approval, rejection, the return for editing and the internal close — clear
both; a plain cancellation touches neither. No trigger, function, worker job or script writes them.
The migration (`…_service_estimate_pending_source_strict.sql`) locks the table, backfills a wait
without an origin to `submit` (such waits were opened by code older than release A, `dispute` has a
single writer that always names it, and `submit` is what every reader assumed), clears an origin
without a wait (reachable only after a rollback below release A, read by nobody), runs an
unreachable guard and replaces `service_requests_estimate_pending_source_check` with
`(estimate_pending_revision IS NULL) = (estimate_pending_source IS NULL)` plus the value list.
Readers take the origin as stored: auto-close compares it with plain `<>` under a pending revision,
`ServiceRequestDto.estimatePendingSource` is required (`null` exactly when nothing is pending, and
for the requester; the wire shape is unchanged — every server since release A sends it), and the
portal no longer substitutes `null`. A rollback below ADR 0183 weakens this constraint too
(runbook). `service-estimate-pending-source-strict.db.test.ts` covers the backfill, the refusals and
the guard; the route suites assert both columns at every writer.
