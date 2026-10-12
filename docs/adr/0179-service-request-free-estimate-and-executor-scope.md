# ADR 0179. Объём работ пишут словами, а исполнитель видит только свои заявки

- Статус: Реализовано (10.09.2026) — **выпуск A**. План —
  [office-equipment-free-estimate-and-executor-scope-plan.md](../office-equipment-free-estimate-and-executor-scope-plan.md),
  редакция 5, решения Р1–Р11. Схема: право «Ведению» (`0298`), след снятия исполнителя и индекс
  автора (`0299`), ключ рубильника (`0300`), запись выпуска (`0303`); номера взяты по файлам дерева
  непосредственно перед созданием — за время волны соседние потоки заняли `0292`, `0296`, `0301`,
  `0302`. Рубильник включён миграцией `0370` (12.10.2026, решение владельца S-12, едет выкатом R1).
  Выпуски **B** (уборка `serviceRequests` из карт сквозной области) и **C** (уборка самого ключа) не
  сделаны: B — следующим выкатом, если на включение не пожалуются, C — после него
- Домены: оргтехника, доступ, схема-и-выкат
- Область: контракты —
  [service-requests.ts](../../packages/contracts/src/service-requests.ts) (`itemNameSchema` до 2000
  знаков, `putServiceEstimateBreakdownSchema`, `actsAsServiceExecutorOnly`,
  `canPickAnyServiceSubject`, `canActOnServiceRequest`, страж распоряжения записью),
  [permissions.ts](../../packages/contracts/src/permissions.ts) (`serviceRequests.estimateRewrite` и
  состав набора «Ведение»),
  [permission-catalog.ts](../../packages/contracts/src/permission-catalog.ts),
  [grants.ts](../../packages/contracts/src/grants.ts) (`PERMISSION_REQUIRES`),
  [feature-flags.ts](../../packages/contracts/src/feature-flags.ts) (ключ
  `service_request_executor_scope`); сервер —
  [access.ts](../../apps/api/src/lib/access.ts) (развилка области чтения, область действий
  `assertServiceRequestActionable`, рубеж заведения),
  [service-requests.ts](../../apps/api/src/routes/service-requests.ts) (ручка `breakdown`, след
  снятия в четырёх ветках, причина замены, область действий на общем входе и у восстановления из
  архива), [principal.ts](../../apps/api/src/auth/principal.ts) (признак рубильника полем субъекта),
  [access-manifest.ts](../../apps/api/src/lib/access-manifest.ts),
  [service-access-manifest.ts](../../apps/api/src/lib/service-access-manifest.ts),
  [service-access-inventory.ts](../../apps/api/scripts/service-access-inventory.ts),
  [schema.ts](../../apps/api/src/db/schema.ts) (`service_request_past_executors`,
  `service_requests_created_by_idx`, второй ключ рубильника); портал —
  [estimate-editor](../../apps/web/src/features/estimate-editor) (свободный режим ввода),
  [ServiceRequestEstimate.tsx](../../apps/web/src/pages/service/ServiceRequestEstimate.tsx) (вход в
  раскладку), [serviceRequestRow.ts](../../apps/web/src/pages/service/serviceRequestRow.ts)
  (`mayActOnServiceRequest` — общий сомножитель мутаций),
  [AssignServiceModal.tsx](../../apps/web/src/features/assign-service/ui/AssignServiceModal.tsx),
  [RequestHistory.tsx](../../apps/web/src/components/RequestHistory.tsx),
  [useServiceRequestCustomer.ts](../../apps/web/src/features/request-customer/model/useServiceRequestCustomer.ts);
  тесты — `service-estimate-breakdown.db.test.ts`, `service-executor-scope.db.test.ts`,
  `service-estimate-free-mode.test.tsx`, `service-reassign-reason.test.tsx`,
  `service-executor-scope-portal.test.tsx`, дополнены `office-equipment-profiles.test.ts`,
  `access-conditions.test.ts`, `service-executor-access.db.test.ts`
- Решение вырастает из: [ADR 0085](0085-office-equipment-module.md) (модуль),
  [0133](0133-service-request-unified-cycle.md) (подписанная ревизия меняется только через возврат в
  правку), [0174](0174-service-request-internal-repair-without-estimate.md) (у внутреннего ремонта
  объёма работ не бывает), [0106](0106-assignable-permission-grants.md) (назначаемые полномочия),
  [0160](0160-service-request-audiences.md) (аудитории карточки),
  [0177](0177-office-equipment-request-subject.md) (рубильник как механизм выката)

## Контекст

Три просьбы заказчика от 09.09.2026, за которыми стоит одна и та же беда — модуль требует от людей
формы, которой у их работы нет.

**Первая.** Подрядчик присылает объём работ письмом: перечень позиций текстом («Узел фотобарабана в
сборе MP C2003SP … 2 шт») и одна сумма на весь заказ. Портал же требовал разложить это по графам —
вид, наименование, количество, цена, — то есть придумать цены, которых в письме нет. Наименование
вдобавок было ограничено 255 знаками, а перечень из примера занимает около 370.

**Вторая.** Системный администратор видел заявки всей компании: набор ИТ-службы несёт сквозную
область модуля. Заказчик просит обратное — исполнитель видит только свои.

**Третья.** «Причина замены» в окне смены исполнителей была обязательной, и это останавливало
обычную перестановку людей.

## Решение

**1. Свободный объём работ — режим ввода, а не вторая модель.** Свободная запись уходит одной
обычной строкой (`kind = service`, количество 1, цена = стоимость заказа), предел наименования
поднят до 2000 знаков с переводами строк. Второго источника суммы не заводится: итог, согласование,
акт, факт закрытия и реестр гарантий читают строки, и вторая дорога заставила бы каждое из этих мест
отвечать, какой источник главный. **Стоимость обязательна** — ноль означал бы «бесплатно» там, где
человек просто не дописал цифру; законным ноль остаётся ровно там, где был, — у гарантийного
ремонта, чью служебную строку собирает сервер. Переключение режимов **одностороннее**: свободная
запись раскладывается в графы всегда, обратно — только пока строка одна и в ней нет ни гарантии, ни
запчасти, ни количества больше единицы. Иначе склейка потеряла бы данные молча.

**2. Раскладку по графам делает «Ведение» своей дверью, и она переиздаёт документ.** Заведено право
`serviceRequests.estimateRewrite` и ручка `PUT /:id/estimate/breakdown`. Права `serviceRequests.estimate`
«Ведению» не выдано намеренно: оно означает «я автор объёма работ» и читается предикатами стороны
исполнителя, вплоть до подписи под собственным счётом. Дверь работает только в «В работе» — и
предъявление, и согласование требуют этого статуса, а раскладка в «Отложена» дала бы предъявление,
которое некому подписать. Дальше три ветки: черновик заменяется на месте; предъявленное ждёт ответа
и отвечает 409; **согласованное поднимает ревизию** — снимок подписи снимается, итог пересчитывается
по строкам, ставится новое предъявление, письмо уходит тем же событием, что у обычного предъявления.
Инвариант ADR 0133 остаётся нетронутым: подписанное содержимое под прежней ревизией не меняется.

**3. Область исполнителя: назначение сужает, а не расширяет.** Для субъекта, который в модуле
исполнитель и никто больше (`actsAsServiceExecutorOnly` — держатель набора ИТ-службы или набора
исполнителя, не администратор и не «Ведение»), область заявок — **назначен ∨ автор ∨ след снятия**.
Признак спрашивает коды наборов, а не право `serviceRequests.execute`: у роли `admin` это право есть
по построению, а у держателя одного ИТ-набора его нет вовсе. При включённом рубильнике карта
сквозной области по заявкам не читается вовсе, а область считается развилкой — администратор видит
всё, «Ведение» работает своей ролью и авторством, исполнитель тремя слагаемыми, остальные как
сегодня. Эта развилка **эквивалентна состоянию после уборки карты** (выпуск B), и равенство
проверяется тестом, а не рассуждением.

**4. Видимость и полномочия — две разные области.** Чтение и действие разведены: `assertScope`
отвечает «видно ли», `assertServiceRequestActionable` — «можно ли трогать». Вторая сужает ровно одну
категорию (исполнительский профиль: назначен либо автор), всем прочим отвечает «да» — иначе правку
потерял бы обычный коллега по площадке, который распоряжается заявкой по своей роли. Бывший
исполнитель заявку читает и пишет в переписку (сторона обсуждения у него от ИТ-набора), но не
действует. Восстановление из архива — единственная мутация мимо общего входа — спрашивает область
действий отдельно.

**5. След снятия — своей таблицей, только вперёд.** `service_request_past_executors` пишется во всех
четырёх ветках, где строка исполнителя удаляется. Мягкое снятие колонкой в живой таблице отвергнуто:
её читают из восьми файлов, и забытый фильтр оставил бы снятому письма и кнопки. Backfill
невозможен — старые строки удалены физически, — и семантика названа вслух: след ведётся с даты
выката.

**6. Предмет заявки опирается на область парка.** Площадка аппарата, отдел-заказчик и площадка
сообщения о технике — это справочник, а не лента заявок, поэтому заведение спрашивает
`canPickAnyServiceSubject` (сквозная область парка либо администратор). Без этого выпуск B сузил бы
заведение молча — под именем уборки строки. Обратная сторона: заведение шире чтения, и разницу
закрывает ось авторства — завёл, значит видишь.

**7. Причина замены необязательна.** Отказ сервера снят, подмена «причина, а если её нет — комментарий
исполнителю» отменена: в историю идёт только причина, а событие без неё показывает прочерк. Сам
комментарий исполнителю теперь хотя бы доезжает в журнал действий — до этой волны он не сохранялся
нигде.

## Совместимость и порядок выката

**Три выпуска.** **A** (этот) — весь код и три миграции, ключ `service_request_executor_scope`
заведён **выключенным**: поведение области остаётся сегодняшним, пока его не включат. **B** — уборка
`serviceRequests` из `GRANT_MODULE_WIDE_SCOPE` и парной `ADDON_MODULE_WIDE_SCOPE` (их равенство
сверяет тест, править по одной нельзя). **C** — уборка ключа.

Порядок внутри A обязателен: **миграции → полное переключение API → портал → включение ключа**. При
постепенной выкатке старые экземпляры отдают все заявки и не пишут след снятия, то есть сужение и
его исключение разъезжаются как раз в окне выката; старый портал вдобавок рисовал бы действия, на
которые новый сервер уже отвечает 403. Включение — `UPDATE feature_flags SET is_enabled = true WHERE
key = 'service_request_executor_scope'`, аварийное выключение — обратный `UPDATE`. Открытые сессии
подхватывают признак следующим ответом сессии, поэтому включение сопровождается обновлением сессии
на клиентах и smoke-проверкой существующей сессией, а не только свежим входом.

Схему волна меняет тремя вещами, и все обратимы: право в наборе (строка каталога), таблица следа с
индексом и индекс автора, второй ключ рубильника.

## Switch ON (2026-10-12)

**Decision.** Owner decision S-12 of 12.10.2026: switch the key on in the nearest release; release B
one release later if nobody complains; release C after it. The switch is migration
`0370_service_request_executor_scope_enable.sql`, the way 0297 opened the candidate intake: a manual
`UPDATE` leaves no trace, and a database restored from an older backup or a second environment
would differ from prod with nothing telling it.

**Why the order of this ADR holds although the migration runs before the restart.** The order is
"migrations → the whole API → the portal → the key". The first three steps shipped with release A
on 10.09.2026, and the release serving the migration window (prod `dc647215`) is release A code: it
reads the key per request inside `loadPrincipal` with no cache, writes the removal trace on all four
removal paths, and its portal asks `hasFeature(user, 'service_request_executor_scope')`. The scope
branch (`apps/api/src/lib/access.ts`, the predicates in `packages/contracts/src/service-requests.ts`,
the session's `features`) did not change between `dc647215` and this release. So the key takes effect
on the old server at commit, exactly as the documented manual `UPDATE` would.

**What the migration does.** A precondition guard (the key row of 0300 and the trace table of 0299
exist), a snapshot of all keys, then one statement that flips the key only if it is off and, in the
same statement, raises `auth_version` of every holder of the two executor-profile grants
(`office_equipment_it_approver`, `office_equipment_executor`), then a result guard: the key is on and
no other key changed. A rerun on an open database changes nothing — neither `updated_at` of the key
nor anybody's session.

**Session refresh.** The server is safe at once; the portal is not, because an open tab keeps the
`features` of its last session answer and would keep showing actions the server now refuses until
its access token expires. Raising `auth_version` is the mechanism grant changes already use: the
tab's next request gets 401, the transport refreshes silently, the refreshed `AuthUser` replaces
the old one and drops the query cache. The set is a superset of `actsAsServiceExecutorOnly` on
purpose — computing that predicate in SQL would be a second copy of a contract rule, and an
administrator or operator who also holds one of the grants pays one silent refresh. Bumping every
account was rejected: `POST /auth/refresh` is limited to 10 per minute per client address, and an
office behind one NAT refreshing all its tabs at once would turn the 429 into a sign-out.

**Smoke.** `service-executor-scope.db.test.ts`, block «миграция включения рубильника (S-12)»: a
migrated database has the key on; switched back off and run through the migration's own text, the key flips, exactly the
holders' versions rise, an existing access token of a system administrator gets 401, the refresh
returns the key in `features`, and the refreshed session lists the administrator's own requests
(assigned, authored, taken off) and none of the others; a rerun bumps nobody; without the key row
the migration refuses in words instead of updating zero rows. Seven db files written against release
A's model (the IT grant's module-wide scope over requests) pin the key off through
`apps/api/test/executor-scope-flag.ts`; release B, which makes off equal to on, is where their scope
expectations get rewritten.

**Emergency off** stays the reverse `UPDATE … SET is_enabled = false` on the live database, without a
deploy; the previous release reads the same key, so a code rollback needs nothing either. Release B
(dropping `serviceRequests` from `GRANT_MODULE_WIDE_SCOPE` and `ADDON_MODULE_WIDE_SCOPE` together,
with a guard "the key is on") is R2; release C (removing the key, never deleting the row while code
reads it) is R3.

## Последствия

- сисадмин перестаёт видеть чужие заявки, и вместе с ними — чужие заявки в истории ремонтов
  аппарата; сам аппарат остаётся виден целиком (парк не сужается);
- право распределять заявки у ИТ-набора остаётся, но работает только на своих: сценарий «взять чужую
  заявку, назначив себя», ради которого оно заводилось, исчезает — памятки правятся вместе с волной;
- заявки, переданные другому исполнителю **до** выката, бывшему исполнителю не видны: следа по ним
  нет и взяться ему неоткуда;
- раскладка согласованного объёма работ требует новой подписи — это лишний круг согласования,
  принятый сознательно взамен подмены подписанного документа;
- у «Ведения» появилось право переписывать чужой объём работ: оно не делает его автором сметы, но
  след в журнале обязателен, и он пишется составом «до → после».

## Отвергнутые варианты

- **Свободный текст и сумма отдельными полями заявки** — завёл бы второй источник итога рядом с
  первым; шесть мест, читающих строки, начали бы отвечать по-разному.
- **Раскладка без подъёма ревизии, с проверкой равенства суммы** — равенство суммы не защищает
  предмет подписи: под тем же итогом заменяются работы и гарантии.
- **Мягкое снятие исполнителя колонкой `removed_at`** — см. решение 5.
- **Сужать область одним правилом для всех субъектов** — отобрало бы правку у обычного коллеги по
  площадке, то есть переделало бы модель действий под видом сужения одного профиля.
- **Снять карту сквозной области сразу, в этом же выпуске** — тогда рубильник не управлял бы ничем:
  выключенный ключ не вернул бы прежнее поведение, а обратный `UPDATE` не дал бы отката.
