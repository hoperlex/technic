# ADR 0144. Площадки отдела множеством

- Статус: Принято
- Изменяет: [ADR 0062](0062-department-object-link.md) решение 1 («у отдела объект — не больше
  одного») в части кардинальности; остальные его решения остаются в силе слово в слово
- Связано: [ADR 0040](0040-department-scope.md) (ось отдела),
  [ADR 0039](0039-user-multiple-objects.md) (множественная привязка — образец хранилища),
  [ADR 0060](0060-directory-record-purge.md) (удаление насовсем),
  [ADR 0069](0069-address-directory-pick.md) (подсказка мест в заказе ТС),
  [ADR 0106](0106-assignable-permission-grants.md) решение 7 (журнал доступа в той же транзакции),
  [план работы](../department-objects-set-plan.md),
  `apps/api/drizzle/0221_department_objects.sql`, `apps/api/src/services/user-scopes.ts`,
  `apps/api/src/routes/departments.ts`, `apps/api/src/auth/sessions.ts`,
  `packages/contracts/src/departments.ts`

## Контекст

Гарантийный отдел заказывает вывоз мусора с гарантийных объектов. Список таких объектов меняется —
редко, но меняется, — и объектов в нём несколько. Права на модуль у роли отдела есть целиком
(ADR 0062 решение 5); упирается всё в область, а она приходит из **одной** колонки
`departments.construction_object_id`.

Кардинальность «один объект у отдела» была решением заказчика 05.08.2026, а не следствием модели:
на тот момент отдел с площадкой означал отдел, стоящий на стройке. Гарантийный отдел устроен иначе
— он отвечает за площадки, которые компания уже сдала, и их у него столько, сколько сейчас на
гарантии.

Рассматривались и отвергнуты: признак «объект на гарантии» в справочнике объектов (доступ начал бы
ездить за предметным флажком, который однажды поставят ради отчёта) и собственная область у
полномочия, `grant_construction_objects` (верное общее решение того же класса задач, но своё ADR
поверх 0106 и другой объём). Отдельные фиктивные отделы «Гарантия — объект X» работали бы сегодня
без единой строки кода, но засоряют справочник и всплывают заказчиком в трёх других модулях.

## Решения

1. **Площадок у отдела — сколько нужно, и хранятся они таблицей связи.**
   `department_construction_objects` по образцу `user_construction_objects` (ADR 0039): PK по паре,
   `created_by`/`created_at`, отдельный индекс по объекту. Решение 1 ADR 0062 отменяется только в
   числе: сторона хранения та же — набор ведут у **отдела**, а не у каждой учётки, и довод ADR 0062
   («первая же новая площадка развела бы карточки между собой») остаётся в силе.

2. **Внешние ключи разной силы, и это то же правило, что было.** Отдел — `CASCADE` (привязки
   отдела и есть часть отдела), объект — `RESTRICT`: объект, назначенный площадкой, не удаляется
   насовсем, пока привязку не снимут в карточке отдела (ADR 0060).

3. **Механика доступа не меняется ни строкой.** `wasteObjectScopeIds`, `canUse`/`MODULE_SCOPE`,
   `wasteRequestVisibilityWhere`, `assertWasteObjectScope`, `Principal.departmentObjectIds` и
   портальный `useWasteObjectScope` работали со **списком** с самого начала — объектная роль всегда
   имела несколько объектов. Меняется единственное: источник `departmentObjectIdsExpr`. Отсюда и
   выбор этого варианта из пяти рассмотренных.

4. **Колонка не сносится сразу — она становится совместимой проекцией.** Штатный деплой накатывает
   миграции до перезапуска, поэтому старый код какое-то время работает на новой схеме; а откат
   версии при наборе из нескольких площадок вернул бы отделу площадку, которую уже сняли, — не
   сужение доступа, а расширение на снятый объект. Поэтому: единственный писатель набора пишет в
   колонку проекцию (единственный объект при наборе из одного, иначе `NULL`), а триггер
   `department_object_sync` отражает записи старого кода обратно в таблицу. Откат при одной площадке
   возвращает её же, при нескольких — даёт пустую область. Колонка, триггер и функция снимаются
   отдельным релизом по [протоколу выката](../schema-cutover-protocol.md).

5. **Совместимость API — в обе стороны и на один релиз.** `DepartmentDto` отдаёт `objects`, но
   сохраняет `object` deprecated-проекцией по правилу решения 4. Одного входного алиаса мало:
   старая вкладка заполняет форму из `r.object?.id ?? null` и отправляет это поле при **каждом**
   сохранении, поэтому ответ без `object` превратил бы правку названия в снос всего набора. Вход
   принимает старое поле, только когда текущий набор не больше одного; против набора из нескольких
   площадок такой запрос получает 409 с просьбой обновить страницу — отказ вместо молчаливой
   потери, потому что выразить набор старая форма не может.

6. **Смена набора гасит сессии в той же транзакции.** `auth_version + 1` инвалидирует выданные
   access-токены, но живую refresh-сессию не трогает, поэтому нужен и отзыв сессий. Он идёт внутри
   транзакции правки: отзыв после коммита негарантирован, а откат правки обязан откатывать и отзыв.
   Это пересмотр прежнего правила «чистка сессий живёт вне транзакции»; правило было верно для
   вызова мимо транзакции и ограничено теперь путём справочника отделов.

7. **Отзыв и ротация сериализуются порядком `users` → `refresh_sessions`.** Ротация раньше
   блокировала строку сессии и не трогала учётку, поэтому сессия, созданная одновременно с отзывом,
   оставалась живой. Блокировка учётки в ротации обязана браться **до** блокировки сессии: обратный
   порядок дал бы взаимную блокировку со сменой области. Сессия после ожидания перечитывается —
   ради этого блокировка и берётся; вход (`createRefreshSession`) блокирует учётку по той же
   причине.

8. **Разница набора пишется журналом доступа в той же транзакции.** `department.create` и
   `department.update` несут `objects: { added, removed }` кодами объектов, и пишут их оба писателя
   — карточка и загрузка справочника файлом. Это расширение закрытого перечня `writeAuditTx`, и оно
   прямое: перечень заведён ради изменений доступа (ADR 0106 решение 7), а набор площадок отдела и
   есть область доступа. Нигде больше разница не хранится: карточка показывает только «сейчас».

9. **Набор площадок остаётся под `directories.write`** (решение заказчика 28.08.2026). Узкое право
   `departmentScopes.write` не заводится; при пересмотре его спрашивают при самом наличии поля,
   включая пустой массив, — очистка набора меняет область так же, как выдача.

## Последствия

Приняты заказчиком 28.08.2026 и названы здесь, потому что объяснять их придётся тому, кто спросит
«почему отдел это видит»:

- отдел **читает недельные заявки** своих площадок целиком (состав, сроки, история): у роли есть
  `weeklyRequests.read`, а область недель для оси отдела — те же `departmentObjectIds`. Ведения и
  визы у него нет;
- очередь заявок вывоза на площадке **общая**: отдел правит и безвозвратно удаляет чужие «Новые»
  наравне со штабом — авторской области в модуле нет и не заводится;
- в «Заказе ТС» и оргтехнике область не меняется; подсказка адреса предлагает все площадки отдела.

## Stage 9 release A (2026-10-12)

Release A of stage 9 is implemented on branch `r1-access` for release R1; release B (the column
drop, `apps/api/drizzle/pending/department-object-column-drop.sql`) stays prepared and unnumbered.

- `replaceDepartmentObjects` no longer projects the set into `departments.construction_object_id`.
  The one-release compatibility of decision 5 is over: `normalizeLegacyObjectId` and
  `withLegacyObjectId` left the contract, `object` left `DepartmentDto`, and the route lost its
  legacy marker and the 409 branch. A body with the old key `constructionObjectId` is parsed with the
  key stripped, so it neither sets nor clears anything. That is safe because no portal bundle with
  client contract 4 or later (the prod floor) sends that key or reads `object`: the web code was
  checked from the first contract 4 build (`ffd4be8a`) through prod `dc647215`; the portal moved to
  the set on 28.08.2026 (`4219c191`).
- The column also left the drizzle schema, earlier than the release B plan in the pending file says.
  Drizzle names every schema column in `select()` and `insert()` (checked: on `origin/main` the
  department select and insert both list `construction_object_id`), and release B's drop runs before
  the restart, so release A code with the column in its schema would fail on every department read
  and insert during that window.
- The column, its `RESTRICT` key, the partial index, the trigger and its function stay in the
  database. The old code `dc647215` never reads the column (the scope comes from the link table since
  `0221`); it writes the projection first and the set second, which stays correct while the trigger
  lives, so rolling back to it is safe.
- Found by the implementation, to be handled before release B:
  - the column goes stale on the first set change after release A, and nothing writes it again;
  - a stale value can still hold an object through the `RESTRICT` key: the purge of an object the
    department no longer has passes the route's link-table count and then fails with «площадки
    отделов» until release B;
  - the guard prepared in release B (the column must equal the set's projection) fires for every
    department whose set changed after release A — reproduced on a PostgreSQL 17 scratch database.
    Release B has to replace it, for example by dropping the trigger and the column without the
    projection check: every column write since `0221` reached the set through the trigger, so the
    column holds nothing the set lacks. Its step "remove the column from `schema.ts`" is already done.
