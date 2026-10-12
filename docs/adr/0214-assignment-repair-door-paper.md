# ADR 0214. Дверь ремонта истории против выданной бумаги: заполнение, его отмена и архив

- Статус: Принято (реализовано 30.09.2026). Решения 1–5 приняты опросом пользователя 29.09.2026;
  решение 6 — починка находки той же волны по уже принятым правилам плана (§8, §13). Всё
  реализовано на сервере и в портале. Схема не меняется, тела запросов те же; запись выпуска —
  миграция [`0350`](../../apps/api/drizzle/0350_releases_assignment_repair_history.sql). Portal
  half of K3a (the editor sends no term in the wide `PATCH /vehicle-requests/:id`, except for a
  «Новая» order of an account without the waybill journal) — 12.10.2026, release R1, by owner
  surveys S-21 and S-22; see the last section
- Домены: заказ-тс, путевые-листы
- Область: сервер —
  [vehicle-request-assignment-repair.ts](../../apps/api/src/routes/vehicle-request-assignment-repair.ts)
  (`paperFree` и `restoreRequired` по исполняемому плану, страж заполнения, область бумаги),
  [assignment-repair.ts](../../apps/api/src/services/assignment-repair.ts) (остаток заполнения,
  бланки отменяемого заполнения, сверка заполнения с выданными листами, группа якоря,
  `repairPaperScope`),
  [esm2-plan.ts](../../apps/api/src/services/esm2-plan.ts) (`distrustWaybillIds`),
  [assignment-crew.ts](../../apps/api/src/services/assignment-crew.ts) (замена остатка заполнения
  дверью машиниста),
  [assignment-period.ts](../../apps/api/src/services/assignment-period.ts) (порядок рукопожатий
  двери срока); тесты —
  [assignment-repair.db.test.ts](../../apps/api/test/assignment-repair.db.test.ts),
  [assignment-period.db.test.ts](../../apps/api/test/assignment-period.db.test.ts); portal (K3a) —
  [useEditorTermDoor.ts](../../apps/web/src/widgets/vehicle-request-editor/model/useEditorTermDoor.ts),
  [termEdit.ts](../../apps/web/src/features/vehicle-request-editor/model/termEdit.ts),
  [useVehicleRequestEditorSave.tsx](../../apps/web/src/widgets/vehicle-request-editor/model/useVehicleRequestEditorSave.tsx);
  tests — [vehicle-period-door.test.tsx](../../apps/web/test/vehicle-period-door.test.tsx),
  [vehicle-request-term-edit.test.ts](../../apps/web/test/vehicle-request-term-edit.test.ts)
- Уточняет: [ADR 0126](0126-assignment-periods.md) — решение 4 «заполнение неизвестных дней»:
  заполнение утверждает, кто работал, и отработанную бумагу не переоформляет; его отмена гасит
  выписанные им бланки; архивная заявка заполняется только вместе с восстановлением
- Связано: [ADR 0212](0212-assignment-old-doors-write-history.md) (служебная команда
  `assignment-drift` — ею лечатся следы, оставленные дефектами до этой починки),
  [ADR 0196](0196-assignment-cutover-command.md) (окно переключения чтения, после которого дефекты
  стали живыми), [ADR 0101](0101-backdated-correction.md) (журнал коррекций и выписка задним
  числом), [ADR 0100](0100-linear-vehicle-days.md) (бумага `on_demand` из самих листов); план —
  [docs/assignment-periods-plan.md](../assignment-periods-plan.md), Р13, Р19, Р29, Ф1, Ш4, Ц4, Э2

## Контекст

Дверь ремонта истории (`POST /vehicle-requests/:id/assignment-changes/repair`) считает план листов
ЭСМ-2 всегда, а исполняет его шагом 12 только при `read_mode = history`. До переключения чтения
бумагу вела недельная сверка, и расхождения плана с правилами никто не видел: план считался,
показывался в предпросмотре и выбрасывался. 29.09.2026 пользователь подтвердил, что прод работает
в режиме `history`, — с этого момента шаг 12 исполняет ровно тот план, который дверь посчитала.

Расхождения нашли db-тесты второго режима: файл двери ремонта ходит обоими режимами чтения, и
половина `history` утверждает, что стало с бланками. Шесть случаев не совпали с планом истории
назначения и были записаны тестами «как есть», с меткой `DIVERGENCE`:

| #   | Что было                                                                                                                                                                   | Где проявлялось                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Д1  | `paperFree` и `restoreRequired` считались по пробному плану — без разблокировок и без разрешения на прошлое. Такой план не выписывает кончившийся день и слеп к заполнению | предпросмотр говорил «бумаги не касается», выписывая бланки                                          |
| Д2  | следствие Д1: заполнение архивной заявки шло без `restore` (Р29)                                                                                                           | бланки выписывались заявке, оставшейся в архиве                                                      |
| Д3  | остаток `unknown_remainder` ставился по адресу заполнения, а не по отрезку `unknown` (Ш4, Ц4)                                                                              | заполнение «по вчерашний день» — умолчание окна — тянуло человека на сегодня и вперёд; бланки вперёд |
| Д4  | отмена заполнения не гасила его бланки: `unknown` по Р19 совпадает с любым напечатанным (Э2)                                                                               | действующие бланки на человека, которого история не называет                                         |
| Д5  | не было отказа при несовпадении с отработанным листом (Ф1)                                                                                                                 | лист сжигался, остаток его недели оставался без бланка                                               |
| Д6  | дверь срока спрашивает подписи раньше групп и разблокировок, дверь ремонта — наоборот                                                                                      | только первый видимый отказ                                                                          |

Седьмой дефект нашёлся уже при починке первых шести (Д7): исполняемый план ремонта шёл **без
области** по всему сроку, а у ремонта, задевающего прошлое, в нём стоит разрешение на прошлое. Это
разрешение действовало глобально: заполнение одной недели планировало бланки и на все прошлые дни
срока с известным человеком, у которых листа не было, — хотя команда их не касалась. Пробный тест
показал это в обоих режимах; в `history` шаг 12 такие бланки выписывал. План прямо запрещает это:
«дыра… не заполняется попутно» (§13), а формула области двери ремонта в §8 —
`documentClosure(paperRange)`.

Первое решение опроса — не выключать заполнение рубильником (`KNOWN_FILLS_ENABLED`), а чинить
волной: заполнение нужно диспетчерам, а Д3 проявляется лишь при заполнении, упирающемся в
изменяемые дни.

## Решение

### 1. Архив — только с восстановлением, `paperFree` — по исполняемому плану (Д1, Д2)

Опрос: «у архива — только с восстановлением (`restore`), `paperFree` по исполняемому плану».

`paperFree` и `restoreRequired` считаются по плану, который предпросмотр показывает, отпечаток
хеширует, а шаг 12 исполняет. Пробный план остаётся только источником списка разблокировок: его
`locked` и есть отработанные листы, которые операция обязана назвать поимённо (Р11). Архивная
заявка с непустым планом ремонтируется только с `restore` — это касается и заполнения, и его
отмены: оба выписывают или жгут бланки.

### 2. Две операции: заполнение ставит `unknown` на первый изменяемый день (Д3)

Опрос: «две операции — заполнение ставит `unknown` на первый изменяемый день, якорь — второй
операцией».

Остаток пишется по отрезку `unknown` шкалы машиниста: на `to + 1`, если день внутри срока, на нём
нет актуальной строки машиниста и другого заполнения этой же команды, а до команды машинист там
неизвестен. Заполнение до последнего отработанного дня оставляет первый изменяемый день блокером;
осмотр после него называет якорь с этого дня, и человек называет машиниста второй операцией.
Страж за правилом: команда из одних заполнений не меняет набор блокеров изменяемых дней ни в какую
сторону — иначе 422 `known_fill_touches_mutable_days`.

Попутно. Якорь, заменяющий строку остатка, заводит свою группу: унаследовав группу заполнения, он
сделал бы её не отвечающей Ю2, и заполнение нельзя было бы отменить. То же у двери машиниста
([assignment-crew.ts](../../apps/api/src/services/assignment-crew.ts)): раньше она отказывала на
любой строке остатка («это заполнение неизвестного прошлого»), а после решения 2 остаток лежит
ровно там, где машиниста называют «Сменить машиниста» с сегодняшнего дня. Теперь остаток правится
и этой дверью — своей группой; строка `known_fill` по-прежнему правится только ремонтом. Смежные заполнения одной
командой не ставят остаток на начало соседнего — две актуальные строки на одну дату ломали частичный
UNIQUE.

### 3. Отмена заполнения гасит его бланки — по происхождению листа (Д4)

Опрос: «отмена заполнения гасит его бланки — по происхождению листа; Р19 остаётся для бумаги старше
истории».

Лист, выписанный операцией заполнения (`waybills.correction_id`) на днях заполнения, при отмене не
может ни совпасть с ожиданием, ни укоротиться (`distrustWaybillIds` плана) и уходит в `cancel`.
Разблокировки считаются прежним путём, поэтому предпросмотр называет каждый сгорающий номер. Р19
по-прежнему защищает бумагу старше истории: она говорит, кто работал, а история лишь не записала
этого; бланк заполнения говорит то, что отменяется. У заказа `on_demand` параметр не применяется:
его ожидания выводятся из самих листов.

### 4. Заполнение не переоформляет отработанную бумагу — строгий Ф1 (Д5)

Опрос: «422 с номером, если лист печатает другого человека ИЛИ граница заполнения внутри живого
листа; исключение — бланки погашенной группы `known_fill`».

Действующий лист на днях заполнения с другим человеком — 422 `known_fill_contradicts_sheet`; начало
или конец заполнения строго внутри действующего листа — 422 `known_fill_cuts_sheet`. Оба отказа
называют номер листа и ведут к коррекции экипажа («Сменить машиниста» задним числом), которая
переоформляет бланк целиком через журнал коррекций, либо к расширению заполнения до границ листа.
Бланк заполнения, отменённого позже, дни не защищает: иначе цикл «заполнил не тем — отменил —
заполняю верным» упёрся бы в 422 собственного ошибочного бланка. После решения 3 такие бланки
остаются живыми только от отмен, сделанных до этой починки.

### 5. Порядок рукопожатий двери срока безразличен (Д6)

Опрос: «порядок двери срока признать безразличным: снять метку DIVERGENCE, записать в ADR». Все
проверки идут под блокировкой и до первой записи, команда проходит только при всех — исход тот же,
записи нет, разница лишь в первом прочитанном отказе.

### 6. Область бумаги ремонта — документы дней, которые команда меняет (Д7)

План листов ремонта — и пробный, и исполняемый — считается в области `documentClosure` дней,
которые команда реально меняет: диапазоны якорей, заполнений, отменяемого заполнения и решения
хвоста, замкнутые по задетым листам и по ожиданиям до и после команды (§7, §8). Вне области не
выписывается и не гасится ничего, предпросмотр показывает ровно тот же план, а событие сверки шага
12 называет эту область. Дремлющее решение хвоста области не имеет вовсе и бумаги не касается.

`restore: true` расширяет область только в сторону живой части срока: изменяемые дни и ожидания,
которые ещё не кончились, — текущая неделя целиком, как у обычной сверки. Так восстановленная
заявка получает свою сверку (Р29, §8 «полный post-restore план»), даже когда своя область команды
пуста, а прошлое вне команды остаётся нетронутым: взять в область все действующие листы значило бы
требовать разблокировки каждого отработанного бланка заявки и выписывать старые дыры заново.

Осмотр (`GET …/repair/state`) работы не несёт, области у него нет, и план в нём прежний — по всему
сроку, как подсказка первого шага окна; исполнять его нечему.

## Последствия

**Что увидит диспетчер.**

- Заполнение «по вчерашний день» у заказа, чей пробел продолжается в сегодня, больше не закрывает
  историю: она остаётся «не полной», окно просит машиниста с сегодняшнего дня, и это вторая
  операция. Бланки выписываются только за отработанные дни.
- Заполнение поверх выданного листа с другим человеком или «разрезающее» лист отклоняется с номером
  листа. Раньше такой лист молча сгорал, и дни его недели после заполнения оставались без бланка.
- Отмена заполнения показывает в предпросмотре и гасит все бланки, выписанные этим заполнением.
- Архивную заявку заполнить или отменить заполнение без восстановления нельзя; восстановление —
  право `archive.restore`, то есть администратора.
- Ремонт-коррекция выписывает и гасит бланки только на своих днях. Прошлые недели с известным
  человеком, но без листа, остаются без листа, пока их не чинят отдельно. Частичный ремонт больше не
  жжёт лист, лежащий целиком на днях другого, нечиненого пробела: его судьбу решит ремонт того
  пробела.

**Чего решение не делает.**

- Следы дефектов на проде (протёкшие заполнения и бланки вперёд — Д3, пережившие отмену бланки —
  Д4, недели без бланка — Д5, заполнения архива — Д2) дверь не лечит. Протёкшее заполнение, чей
  человек дотянулся до изменяемых дней, этой дверью не отменяется вовсе: отмена вернула бы
  блокеры, и Р27 её отклонит. Лечение — служебной командой `assignment-drift`
  ([ADR 0212](0212-assignment-old-doors-write-history.md), решение 5), расширяемой отдельно.
- Окно подтверждения предупреждений по листам и ход «две операции» в портале — отдельная работа
  волны: сервер отдаёт то же, что и раньше, плюс новые коды отказа.

**Тесты.** Меток `DIVERGENCE` в файлах двери ремонта и двери срока больше нет: все шесть случаев
утверждают исправленное поведение в обоих режимах чтения, добавлены случаи строгого Ф1, повторного
заполнения после отмены, остатка отмены до этой починки, смежных заполнений и стража. Область
бумаги (Д7) проверяется заполнением с отменой и якорем-коррекцией рядом с прошлой дырой без листа и
восстановлением с решением хвоста; каждый из этих случаев без области краснеет.

## Альтернативы

- **Д1+Д2.** Пробный план с разрешением на прошлое, но без разблокировок, — половинчато: слеп к
  переоформлению отработанных листов. Запретить заполнение архива вовсе — продуктовое ограничение,
  которого не просили.
- **Д3.** 422 при заполнении, упирающемся в изменяемые дни, — тупик: окно по умолчанию предлагает
  ровно такое заполнение.
- **Д4.** Узаконить уцелевшие бланки (переписать Э2) — бумага и история разошлись бы навсегда.
  Отказывать в отмене, пока живы бланки заполнения, — отмена стала бы недостижимой в `history`.
- **Д5.** Буквальный Ф1 (только «человек не тот») оставлял сгорание листа, разрезанного границей.
  Не адресовать заполнением дни с живым листом — лишало заполнение случая, когда лист верен.
- **Д6.** Выровнять порядок под дверь ремонта — правка ради первого прочитанного отказа, без
  изменения исхода.
- **Д7.** Оставить план по всему сроку, но снять разрешение на прошлое вне дней команды, — второй
  план с двумя разрешениями ради того, что область уже выражает одним параметром. `restore` по
  букве §8 («union действующих листов») — требовал бы разблокировки всех отработанных бланков
  заявки и возвращал выписку старых дыр при восстановлении с коррекцией.

## K3a, portal half (2026-10-12, surveys S-21 and S-22)

**The split (S-21).** Roadmap item C9-K3a removes `dateFrom`/`dateTo` from the wide
`PATCH /vehicle-requests/:id`, so that the term moves through the term door of decision 5
(`PATCH /vehicle-requests/:id/period`). The R1 bundle (client contract 7,
[ADR 0226](0226-client-floor-seven-and-deploy-preflight.md)) still sent the full body, dates
included — and a removal is safe at floor 7 only if the contract-7 bundle no longer depends on what
is removed. The owner decided: the portal half lands in R1, before its deploy; the server removal is
R2, under the same floor 7, with no second floor raise.

**The door stays closed to the customer roles (S-22).** The door's route guards ask `waybills.read`
on both handlers: its preview names sheet numbers and the people on them. The customer roles that
edit their own «Новая» orders — `shtab`, `rukstroy`, `site` with «Заказ техники», `department`,
`department_head` — hold `vehicleRequests.update` without `waybills.read` (the journal is the
separate «Путевые листы: просмотр и печать» grant, ADR 0192). The owner decided that rights do not
change: the door keeps its guard, the wide PATCH keeps the dates for orders in status «Новая», and
R2 removes the dates from the wide PATCH **only for orders in work**. There is no access-model
change in K3a. A «Новая» order has no vehicle, no paper and no history, so the door would have had
nothing to show these roles anyway.

**What the portal does now.**

- **A «Новая» order edited by an account without `waybills.read`** sends its term in the wide
  PATCH — one command, as before K3a (`termRidesWideEdit`). The right is read from the server's
  permission list through the portal's `can` (ADR 0223), the same list the door's guard reads. This
  route is permanent by S-22, not a fallback: the door is not asked at all.
- **Everyone else** — every order in work, and a «Новая» order of a journal reader — sends no term
  and, with it, no `backdateReason` and no `operationId` in the wide PATCH: without a term that body
  moves no calendar and has nothing to declare. The server already read an absent date as
  "untouched", so no server change was needed for this. Creation, conversion
  (`PATCH /:id/request-type`) and the freight edit keep their calendars — they are not the wide edit
  of an on-site order.
- A changed term goes through the door **first**, the rest second with the version the door
  returned. The term step is the one with refusals of its own (lead time, the shortening ban,
  backdate rights, a stale preview) and the only one the person may decline in the consequences
  window; going first, a refusal or a cancel writes nothing. The reverse order would save the
  comment and leave the term unchanged after the person's own "Cancel".
- The one half-applied state left — the term applied, the rest refused — is named ("Срок работ
  изменён, но остальные правки не сохранены: …"), the editor stays open, and the applied result is
  kept: the next "Save" compares the form with the applied term, finds nothing to move and sends
  only the rest with the door's version (a second door call would be the empty command the door
  refuses).
- An unchanged term never touches the door.
- A running order of a journal reader opens the consequences window, as in wave 4a. A «Новая»
  order of a journal reader asks the preview and applies a silent one at once (nothing burns or
  gets issued, nothing is cancelled or re-issued, no sheet asks for a signature; a backdated move's
  reason comes from the form). A loud preview opens the window. The same rule as the silent vehicle
  change.
- **No fallback on 403.** A refusal by right from the door is shown as it is and not retried through
  the wide PATCH. It can reach only an account that edits an order in work without the journal: no
  shipped role does (place roles edit «Новая» only), a hand-made grant set could, and for an order
  in work S-22 keeps the door as the only route — R2 refuses dates there anyway.

**What R2 must hold.** The wide PATCH refuses `dateFrom`/`dateTo` for an order whose stored status
is not «Новая» and keeps accepting them for a «Новая» one; the decision is the server's, under the
row lock, by the stored status. The contract-7 bundle sends dates only on the «Новая» route above,
so R2 needs no further portal change. The portal's rule and the server's share one condition — the
status «Новая»; if R2 introduces a contract predicate for it, `termRidesWideEdit` should ask it
rather than compare the status itself.
