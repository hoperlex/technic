# ADR 0206. Копию заказа техники снимают с заявки любого статуса, а срок ей считает календарь, а не статус

- Статус: Реализовано (22.09.2026; the copy from the closed-order journal followed on 12.10.2026,
  decision 8). The customer's decision of 22.09.2026, reversing their own answer of 08.09.2026.
  Schema and API do not change: the copy is the same create form, and saving goes through the same
  `POST /vehicle-requests`; the contracts gained only the address of the copy form (decision 8).
  Migrations: only release records — [`0338`](../../apps/api/drizzle/0338_releases_copy_any_status.sql)
  for decisions 1–7 (ADR 0077); the journal copy goes with the record of its deployment window
- Домены: заказ-тс
- Отменяет: **решение 2 [ADR 0173](0173-vehicle-request-copy.md)** — «копию снимают только с
  „Новой“». Вместе с ограничением снято и его основание: прошедшие даты чинит календарь формы, а
  «привязанного к машине состава» в форме заведения нет ни одним полем
- Изменяет: **решение 3 [ADR 0173](0173-vehicle-request-copy.md)** — правило календаря копии: к
  «сдвигу вперёд с сохранением длительности» добавилась третья ветка (остаток идущего заказа), а
  границу между ветками держит сегодняшний московский день, а не первый доступный
- Связано: [ADR 0004](0004-vehicle-requests.md) (заявки на технику),
  [ADR 0104](0104-vehicle-request-lead-time.md) (заблаговременность роли — она осталась полом формы
  и веткой календаря не распоряжается),
  [ADR 0101](0101-backdated-correction.md) (заведение отвергает необъявленное прошлое),
  [ADR 0058](0058-request-rollback-to-new.md) (снимка заказанного срока в системе нет),
  [ADR 0044](0044-vehicle-request-early-end.md),
  [ADR 0085](0085-weekly-vehicle-request.md),
  [ADR 0126](0126-assignment-periods.md),
  [ADR 0178](0178-completion-actual-end-date.md) (кто переписывает срок работающей заявки),
  [ADR 0006](0006-address-verification-dadata.md) (проверенный адрес обязателен при заведении),
  [ADR 0172](0172-vehicle-request-rollback-keeps-approval.md) и
  [ADR 0107](0107-linear-mode-freeze.md) (почему список непереносимого не равен тому, что стирает
  откат в «Новую»),
  [ADR 0135](0135-waste-request-completed.md) («Завершена» — статус вывоза мусора, у заказа ТС его
  не бывает), [ADR 0152](0152-mechanization-module.md) («Дублировать» у соседнего модуля отвечает
  на другой вопрос), [ADR 0029](0029-vehicle-request-completion.md) (журнал закрытых заказов)
- Область: portal — new
  [copyNotice.tsx](../../apps/web/src/features/vehicle-request-editor/ui/copyNotice.tsx) (the notice above the copy form);
  edits to [requestFormValues.ts](../../apps/web/src/features/vehicle-request-editor/model/requestFormValues.ts)
  (`copyTermPlan`, `copyScheduledPlan`, `copyFormValues`),
  [useVehicleRequestEditorState.ts](../../apps/web/src/widgets/vehicle-request-editor/model/useVehicleRequestEditorState.ts)
  (`canCopy`) and
  [VehicleRequestEditorDialog.tsx](../../apps/web/src/widgets/vehicle-request-editor/ui/VehicleRequestEditorDialog.tsx)
  (the form title and the notice),
  [vehicleRequestCardFooter.tsx](../../apps/web/src/widgets/vehicle-request-view/ui/vehicleRequestCardFooter.tsx)
  (the button caption); the journal copy (decision 8) — the gate
  [copyAccess.ts](../../apps/web/src/entities/vehicle-request/model/copyAccess.ts)
  (`canCopyVehicleRequest`, `vehicleRequestCopyLink`), the address in
  [links.ts](../../packages/contracts/src/links.ts) (`VEHICLE_REQUEST_COPY_PARAM`,
  `vehicleRequestCopyPath`), the journal card
  [VehicleRequestsHistoryTab.tsx](../../apps/web/src/pages/vehicle/VehicleRequestsHistoryTab.tsx),
  the address reader
  [useVehicleRequestOperations.tsx](../../apps/web/src/pages/vehicle/useVehicleRequestOperations.tsx)
  and the delayed customer fill
  [useCopyCustomerSync.ts](../../apps/web/src/widgets/vehicle-request-editor/model/useCopyCustomerSync.ts);
  tests — [vehicle-request-copy.test.tsx](../../apps/web/test/vehicle-request-copy.test.tsx) and the
  factory [factories/vehicle.ts](../../apps/web/test/factories/vehicle.ts) (a request in work with an
  assignment and a route — nothing could build one before this wave)

## Контекст

Копию заказа (ADR 0173) карточка предлагала только у «Новой». Ограничение было не осторожностью, а
ответом заказчика: вопрос ему задали 08.09.2026 отдельно, ответ — «копия только у новой», и вариант
«копия с любого статуса» лёг в отвергнутые того же решения.

22.09.2026 заказчик ответил обратное — снимать копию с заявки любого статуса, в работе, выполненной
и отменённой. Причина видна из работы: заказ повторяют не потому, что прошлая заявка ещё не начата,
а потому, что та же техника снова нужна на тот же объект. К этому моменту исходная заявка почти
всегда не «Новая»: её взяли в работу, закрыли или отменили. Именно у закрытой и видно, что заказ
состоялся и его стоит повторить; у «Новой» копия нужна реже всего — она ещё в руках заявителя, и
правится правкой.

Прежний запрет держался на двух утверждениях, и оба оказались не о том. Первое — «даты давно
прошли»: даты копии в любом случае предлагает не источник, а календарь формы, и с прошедшим сроком
он умел работать с первого дня. Второе — «состав уже привязан к назначенной машине и рейсу, копия
состояла бы из сброшенных полей»: сбрасывать в форме заведения нечего, потому что полей назначения,
рейса и факта в ней нет вовсе. Копия «Выполненной» отличается от копии «Новой» ровно одним — сроком,
который к тому времени переписан исполнением.

## Решение

### 1. Статус источника действие не спрашивает вовсе

У `canCopy` осталось три условия: заявка не в архиве, у учётки есть право `vehicleRequests.create`,
тип заявки открыт этой учётке (отделу открыта одна грузоперевозка, и копия заказа спецтехники ушла
бы к отказу сервера). Статуса среди них нет — ни у портала, ни у сервера.

Так честно по построению: копия не трогает источник ничем — к нему не уходит ни одного запроса.
Открывается та же форма заведения, что и у «Новой заявки», а сохранение уходит обычным
`POST /vehicle-requests` со всеми его проверками. Значит запрет по статусу охранял бы не данные, а
представление человека о том, что делает кнопка. С представлением спорят словами, и говорит их
решение 5.

Архив — случай другой природы: снятая запись закрыта для всех действий целиком, и копия здесь не
исключение.

### 2. У срока три ветки, и третья — остаток

Календарь спецтехники отвечал двумя способами: срок целиком впереди предлагается как есть — его и
повторяют; прошедший сдвигается вперёд с сохранением длительности — «кран на пять дней» остаётся
заказом на пять дней. Копия работающей заявки сделала обычным третий случай: начало в прошлом,
конец впереди — заказ **уже идёт**. Статуса правило при этом не спрашивает (решение 1), и такой
срок бывает и у «Новой», заведённой заранее и ещё не взятой в работу: она получает остаток на тех
же основаниях.

Прежнее правило предложило бы такому сроку прежнюю длительность от первого доступного дня, то есть
конец, уехавший за конец оригинала: копия заказала бы дни, о которых никто не договаривался. Просят
же здесь обычно обратное — дотянуть до того же дня другой машиной. Поэтому копии идущего заказа
предлагается **остаток**: начало едет на первый доступный день, конец остаётся прежним
(`copyTermPlan`, ветка `remainder`).

Остаток обязан помещаться в окно, открытое форме: конец прежнего срока проверяется **первым
доступным днём**, а не сегодняшним. Заказ, идущий до завтра, для заявителя после 15:00 остатка не
образует вовсе — заводить не раньше послезавтра, а работа к тому дню кончится, — и он уходит
сдвигом, как прошедший: там копия честно повторяет прежнюю длительность, и другого верного ответа
у неё нет.

Грузоперевозки это не касается: у неё не период, а день подачи, остатку взяться неоткуда, и правило
ADR 0173 работает прежним (`copyScheduledPlan`).

### 3. Границу ветки держит сегодняшний московский день, а не первый доступный

Спросить ветку у `minDate` соблазнительно — первый доступный день и так под рукой, им же двигается
срок. Но `minDate` несёт заблаговременность роли (ADR 0104): заявителю после 15:00 он отдаёт
послезавтра. Спроси ветку у него — и копия ещё не начавшегося чужого заказа (начало завтра, конец
через неделю) молча стала бы остатком с послезавтра, потеряв день-два работы вместо честного сдвига
всего срока вперёд.

«Идёт ли заказ» — вопрос календаря, а не прав, и отвечает на него сегодняшний московский день. Пол
формы при этом остаётся прежним: остаток начинается с первого доступного дня, потому что раньше
него заведение не примет ничего.

Сегодняшний день отвечает ровно на один вопрос — «начался ли заказ». Помещается ли его остаток в
то, что примет заведение, спрашивается у первого доступного дня (решение 2): два условия делят
календарь, а не спорят за одну границу — тем же приёмом, каким заблаговременность и задний ход
делят его в самой форме (ADR 0104, ADR 0101).

Идущим считается и заказ, **начатый сегодня**: техника вышла на объект с утра, и повторяют её на те
же оставшиеся дни. Граница «начался раньше сегодня» ошибалась здесь в ту же сторону, от которой
заводился остаток: заказ 22.09–30.09, скопированный заявителем после 15:00, уезжал сдвигом на
24.09–02.10, то есть на два дня за конец оригинала. Третьим условием ветки стоит «есть что
двигать» — у того, кому доступен сегодняшний день, заказ с сегодняшним началом остатка не образует
вовсе, и срок предлагается нетронутым.

### 4. Копируется срок в нынешней редакции заявки — другого в системе нет

Снимка «как заказывали» не существует. `date_to` — это текущее значение, и переписывают его перевод
в работу, продление недельной заявкой ([ADR 0085](0085-weekly-vehicle-request.md)), досрочное
завершение (ADR 0044), периоды назначения (ADR 0126) и закрытие фактической датой (ADR 0178); откат
в «Новую» (ADR 0058) заказанного срока тоже не хранит — он стирает работу, а не возвращает заявку в
редакцию заведения.

Отсюда следствие, которое надо называть вслух: копия «Выполненной» наследует **фактический** срок.
Заказ на 15 дней, закрытый на третий, копируется трёхдневным. Восстановить заказанное нечем, а
догадка («взять разницу дат из истории») вывела бы число из событий, которые пишутся не для этого,
и однажды соврала бы там, где ей поверили.

Поэтому окно копии называет предложенный срок **датами**: число дней не должно выводиться из
статуса источника — его показывают.

### 5. Окно объявляет источник и ветвится по данным, а не по статусу

Надпись над формой (`copyNotice`) говорит четыре вещи, и каждую только тогда, когда ей есть что
сказать:

- **шапка** — «Заявка Т-42 не меняется» с хвостом по состоянию источника («она остаётся в работе»,
  «копия не возобновляет отменённую»). Хвост берётся полным словарём статусов: разбери мы частные
  случаи — и пропущенный напечатал бы пустоту ровно там, где человека успокаивают;
- **срок** — предложенные даты и то, откуда они взялись: прежний срок, остаток идущего или те же
  дни вперёд. Выбирает строку **ветка календаря**, та же самая, что подставляет даты в поля. У
  сдвига при этом спрашивается ещё и причина: срок мог не пройти, а просто не дотянуть до первого
  доступного дня — «прежний срок прошёл» на заказе, который начинается завтра, человек прочтёт как
  сбой портала и полезет править верные даты;
- **наследство** — «техника и рейс остаются у Т-42», перечнем из того, что у заявки есть: печатай
  его целиком — и заказу с назначенной машиной, но без рейса и факта пообещали бы сберечь две
  сущности, которых у него нет, ровно там, где человек решает, заводить ли копию;
- **продление** — только у спецтехники в работе: «нужна та же машина дольше — копия не поможет».

Ветвление по данным, а не по статусу, здесь не стилистика. У отменённой заявки срок бывает будущим,
а у «Новой» — прошедшим, и текст, выбранный статусом, разошёлся бы с полями формы: человек увидел
бы одно объяснение и другие даты. Статус называет одна шапка, и та лишь повторяет словами то, что
видно в карточке.

Календарь копии — и первый доступный день, и сегодняшний — снимается **один раз, при открытии
формы** (`CopySource`), и обеим сторонам отдаётся один и тот же. Спроси его каждая заново — и
форма, пережившая 15:00 или московскую полночь, объясняла бы человеку один срок, показывая в полях
другой: оба дня считаются от текущего момента (ADR 0104), а поля заполнены при открытии. Правило
срока стало от этого чистой функцией: тех же входов — те же ветка и даты, когда бы её ни позвали.

Живёт надпись отдельным файлом от вкладки: `VehicleRequestsTab` стоит в бюджете длины
(`scripts/quality.mjs`), а «что сказать о заявке перед копией» — законченный вопрос, о показе
формы не знающий ничего.

### 6. Кнопка называется «Завести такую же», заголовок формы — «по образцу Т-42»

«Создать копию» у «Новой» читалось верно, у «Выполненной» — уже нет: слово «копия» обещает
наследование состояния — техники, рейса, факта, — которого в новой заявке не будет. Формулировка
взята из самого ADR 0173, где действие и описано словами «заведи такую же»; заголовок формы говорит
то же — «Новая заявка на автотехнику — по образцу Т-42».

Соседний модуль с его «Дублировать» (механизация, ADR 0152) не трогается, и это не разнобой, а
разные вопросы: там из одной заявки делают две **на тот же срок**, потому что ставка задаётся за
единицу, — здесь повторяют тот же заказ на другой срок.

### 7. Что не переносится — и почему это форма данных, а не список

Копия несёт заказ: тип, заказчика, позицию классификатора, контакт на объекте, комментарий, ездки
грузоперевозки целиком. Не переносится всё остальное: назначенная техника со ставками, рейс и
перегоны, факт, дни и смены, ожидающий запрос на досрочное завершение, виза, номер, автор, история
и вложения (файл по построению принадлежит одной заявке, `assertFilesAttachable`).

Держит эту границу не перечисление, а форма данных: исполнение живёт отдельными таблицами и в схеме
заведения не выражено ни одним полем. Пройти через форму оно не может в принципе — потому список
выше и не нуждается в стороже.

Сказать короче — «не переносится ровно то, что стирает откат в „Новую“» — было бы неправдой: откат
визу **бережёт** ([ADR 0172](0172-vehicle-request-rollback-keeps-approval.md)), а заморозку
линейности снимает не он ([ADR 0107](0107-linear-mode-freeze.md)). Два набора совпадают не
полностью, и сведение их в одно правило завело бы второй носитель того же знания — расходящийся
молча.

### 8. The copy is also taken from the closed-order journal — by address, behind one gate

Added on 12.10.2026; this is the option the first wave postponed (see the rejected alternatives).
The journal card is read-only and stays so: the only action it carries is «Завести такую же», and
that one it carries as a **link**. The section has exactly one create form, in the order list, so
the journal card closes and leads to `/vehicle-requests?tab=requests&copy=<id>`; the first tab
reads the parameter, fetches the source by id (a closed order is not among its rows), drops the
parameter from the address and opens the same copy form as its own card does. Everything decisions
1–7 say about the copy holds unchanged: the address changes the door, not the copy rule.

- **The address lives in the contracts** (`VEHICLE_REQUEST_COPY_PARAM`, `vehicleRequestCopyPath` in
  `packages/contracts/src/links.ts`): the journal builds the link and the list reads it, and two
  separately written names would land on a tab that does not recognise the parameter. It is a key
  of its own, not the shared `open`: `open` shows a card for reading, `copy` opens the create form,
  and one key with two meanings would diverge silently.
- **The parameter is one-shot.** It leaves the address as soon as the form opens — left in place,
  "back" and every return to the tab would reopen the form over the work begun in it. A forwarded
  link opened later says what went wrong in words: a source that is gone or out of scope («Заявка
  для копии не найдена или недоступна»), archived, or of a kind the account may not order — instead
  of a silently empty tab or a form whose save the server would refuse.
- **One gate for both screens.** The journal button, the list card's button and the address reader
  all ask `canCopyVehicleRequest` (`apps/web/src/entities/vehicle-request/model/copyAccess.ts`;
  `vehicleRequestCopyLink` pairs it with the address). Its conditions are decision 1's: not
  archived, the `vehicleRequests.create` permission, and the account's corridor of request kinds.
  A second copy of the gate would offer the copy on one screen and hide it on the other.
- **Why a portal gate over the server's list, not a contracts predicate.** The permission is
  membership in the list the server computed for the session (the portal's `can`); the corridor is
  the contracts predicate `canOrderVehicleRequestType`, which keeps its rule in one place. A
  contracts `canCopyVehicleRequest(subject, …)` would have to call the contracts `can()` — that is,
  recompute the permission matrix over the session's subject, which agrees with the server's list
  only by convention and misses nothing today only because no one has assembled a set the matrix
  does not know. ADR 0223 (`docs/adr/0223-portal-permission-oracle.md`) records this as the
  portal's rule: availability that depends on a permission is decided by the server's list, and a
  contract predicate that needs a permission takes the membership from it. The wave first placed
  the gate in the contracts and moved it to the entity slice for exactly this reason. The server
  remains the last gate: `POST /vehicle-requests` checks the permission and the corridor itself.
- **The customer of a copy is filled one render later** (`useCopyCustomerSync`). The picker's
  composition follows the request kind standing in the form — the place axis for on-site equipment,
  scope plus departments for freight (ADR 0201) — and inside the click that opens the copy the form
  still holds the previous opening's kind. Answered there, "is this customer on offer" was answered
  about the wrong kind: a department with its own sites copying an on-site order faced an empty
  required field. The fill now waits for the picker to follow the source kind and never overwrites
  a customer chosen by hand; a customer outside the account's offer stays empty, as decision 3 of
  ADR 0173 requires.

## Совместимость и порядок выката

The change is entirely the portal's: schema, permissions and API do not change, and the form sends
no new fields — so the client floor is not raised, and an old tab next to a new build works as it
did (it simply shows no button on a non-«Новая» request, and no journal button). The contracts
gained only the copy-form address (decision 8), which the server does not read. Deployment is an
ordinary portal build; rollback is the previous build. Decisions 1–7 shipped with the release record
[`0338`](../../apps/api/drizzle/0338_releases_copy_any_status.sql); the journal copy goes with the
record of its deployment window.

## Последствия

- повторный заказ набирается с любой заявки, которую нашли в списке, — а находят там чаще
  работающую и закрытую, чем «Новую»;
- **копия «Выполненной» несёт фактический срок, а не заказанный** (решение 4). Заказ на 15 дней,
  закрытый на третий, копируется трёхдневным, и человек либо правит дату окончания, либо получает
  заказ короче задуманного. Предложенный срок поэтому назван в окне датами, а не подразумевается;
- **непроверенный адрес ездки перестал быть редким случаем.** ADR 0173 называл его таким ровно
  потому, что «копию снимают с „Новой“, то есть со свежей заявки»; с этим решением копию снимают и
  с закрытой грузоперевозки, а у заведённой до ужесточения ADR 0006 адреса ездок часто легаси
  (`NULL`/`manual`). Поломкой это не стало — форма потребует выбрать адрес заново, до отправки и
  полем, а не отказом сервера, — но прежнее объяснение «случай редкий» больше не действует;
- **второй заказ на ту же технику и площадку никто не отбивает**: пересечения сроков сервер не
  проверяет, и две заявки на одну машину встанут рядом. Портал отвечает на это словами — строкой
  про продление у спецтехники в работе, — а не запретом: «оставить ту же машину дольше» решается
  продлением срока и недельной заявкой ([ADR 0085](0085-weekly-vehicle-request.md)), и копия этих
  дверей не заменяет;
- ADR 0173 остаётся действующим во всём остальном: копия — по-прежнему форма заведения (решение 1),
  ездки копии — новые строки (решение 4), связь «копия чего» не хранится (решение 5);
- **a closed order is repeated from where it is read** — the journal (decision 8) — and a copy link
  can be forwarded: it opens the form once for whoever may create such a request, and explains
  itself to anyone else.

## Отвергнутые варианты

**Серверная ручка `POST /vehicle-requests/:id/copy` по образцу «Дублировать» механизации.** У
соседа она работает потому, что его заведение принимает срок источника как есть. У заказа ТС схема
заведения сама отвергает необъявленное прошлое (ADR 0101), а у работающей заявки начало срока в
прошлом **всегда**: ручке пришлось бы либо сочинять календарь за человека — своим правилом,
параллельным тому, что считает форма, — либо объявлять коррекцией прошлого то, что ею не является.
Решение 1 ADR 0173 остаётся в силе, и это решение лишь расширяет его область.

**Хранимая связь «копия чего».** Решение 5 ADR 0173 в силе и с новой областью: вопроса «сколько раз
повторяли этот заказ» заказчик не задавал, а колонка-родитель потребовала бы миграции, поля в DTO и
ответа на «что делать, если исходную заявку удалили». Источник копии живёт ровно столько, сколько
открыта форма, и назван в её заголовке и в надписи.

**A create form of its own in the closed-order journal** (the second tab, ADR 0029). The first wave
postponed the journal copy altogether: the journal card carries no actions — it is read-only — and
a copy there needs either its own create form in the second tab or a move to the first one by
address. Decision 8 took the second move on 12.10.2026; a second form was rejected, because it
would be a second copy of the one create form, its gates and its PICK-freshness rules, drifting
from the first with every edit.
