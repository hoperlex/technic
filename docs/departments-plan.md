# План: справочник отделов, роли отдела, множественная привязка

Рабочий план, не ADR. Решения, принятые при постановке, помечены **Р**; их обоснование
переезжает в ADR на этапе реализации.

---

## Принятые решения

**Р1. Отдел и объект — одна ось, а не две.** Отделы — офис, с объектами строительства они не
пересекаются. Учётка привязана **либо** к объектам, **либо** к отделам; заявка ТС принадлежит
**либо** объекту, **либо** отделу. Двойственности нет ни у учётки, ни у заявки.

**Р2. Визирует только руководитель отдела.** Заявка отдела визируется руководителем своего
отдела, заявка объекта — руководителем строительства. Виза одна, колонки `approved_by` /
`approved_at` остаются как есть.

**Р3. Руководители в карточке отдела выводятся из учёток**, а не хранятся полем: это учётки с
ролью «Руководитель отдела», привязанные к отделу. Набор правится с обеих сторон — из карточки
отдела и из карточки учётки, — как связь «объект ↔ оператор вывоза».

**Р4. `users.construction_object_id` удаляется.** Привязка целиком переезжает в M2M-таблицу.
Цена: CHECK `users_rukstroy_object_check` (миграция 0050) снимается — инвариант «объектной роли
обязателен объект» перестаёт держать база и начинает держать API плюс тест. Второй инвариант
(«объекты XOR отделы») в БД тоже невыразим — он кросс-табличный.

**Следствие Р1, главная цена плана:** `vehicle_requests.object_id` становится nullable, рядом
появляется `department_id`, ровно один из них заполнен. Это 6 `innerJoin(construction_objects)` →
`leftJoin`, ~30 обращений к `objectId` в `routes/vehicle-requests.ts`, поля DTO становятся
nullable (ошибки найдёт компилятор), бланк путевого листа получает ветку «заказчик — отдел».

---

## Что появляется

### Роли

| Код               | Подпись             | Область | Права                                                           |
| ----------------- | ------------------- | ------- | --------------------------------------------------------------- |
| `department`      | Отдел               | отделы  | `directories.read`, `vehicleRequests.read/create/update/delete` |
| `department_head` | Руководитель отдела | отделы  | то же + `vehicleRequests.approve`                               |

Подпись «Отдел» — по образцу «Штаб» (роль называется подразделением, а не должностью). Прав на
вывоз мусора нет вовсе: раздел закрывается правом, и меню скроет его само.

**Коридор типов заявки.** Обеим ролям доступна только грузоперевозка. Выражается таблицей рядом
с матрицей, а не правом и не `if` по имени роли — тем же приёмом, что `ROLE_STATUS_TRANSITIONS`:

```ts
const ROLE_VEHICLE_REQUEST_TYPES: Partial<Record<Role, readonly VehicleRequestType[]>> = {
  department: ['freight_transport'],
  department_head: ['freight_transport'],
};
export function allowedVehicleRequestTypes(subject: AccessSubject): readonly VehicleRequestType[];
```

Отдельное право (`vehicleRequests.freight`) не заводим: право отвечает «что учётка делает», а
здесь ограничение по типу строки — это область, и в матрице оно завело бы колонку-исключение.

### Область видимости — третий вид

К «по объекту» и «по контрагенту» добавляется «по отделу»:

```ts
export const DEPARTMENT_SCOPED_ROLES = ['department', 'department_head'] as const;
export function isDepartmentScopedRole(role): boolean;
export function isScopedToPlace(role): boolean; // объектная ИЛИ отдельская — общий предикат
```

---

## Этап A. Множественная привязка учётки к объектам — **сделано**

Самостоятельная ценность, ролей не добавляет — идёт первым и отдельно проверяется.

**Миграции** (номера уточнить перед созданием — потоки параллельные; последняя сейчас `0062`):

- `00XX_user_construction_objects.sql`
  - таблица `user_construction_objects (user_id, construction_object_id, created_by, created_at)`,
    PK по паре, FK `user_id → users` ON DELETE CASCADE, `construction_object_id → construction_objects`
    ON DELETE CASCADE, индекс по объекту (обратный вопрос «кто на объекте»);
  - backfill из `users.construction_object_id`;
  - `DROP CONSTRAINT users_rukstroy_object_check`;
  - `DROP COLUMN construction_object_id`.

**Сервер**

- `services/user-scopes.ts` — по образцу `services/object-operators.ts`: `objectsByUserIds`,
  `replaceUserObjects`, `assertAllObjectsExist`. Набор передаётся целиком, сервер считает разницу.
- `auth/principal.ts` — `constructionObjectId: string | null` → `constructionObjectIds: string[]`.
  Списки собираются `array_agg`-подзапросом в том же `select`: принципал грузится на каждом
  запросе, лишний round-trip там не нужен.
- `lib/access.ts`:
  - `requestVisibilityWhere` → `inArray(col, ids)`; пустой список → `NEVER_MATCH` (по-прежнему
    «не видит ничего», а не «видит всё»);
  - `assertObjectScope(p, objectId)` → проверка вхождения в набор;
  - `canApproveForObject`, `approvesOwnRequestOnCreate` — то же по набору.
- `routes/users.ts` — `constructionObjectIds: string[]`; объектной роли требуется непустой набор
  (инвариант, ушедший из CHECK); смена набора ⇒ `authVersion + 1` + `revokeAllForUser` — область
  сменилась, как при смене контрагента.
- `contracts/users.ts` — `constructionObjectIds` в create/update/DTO; `USER_SORT_FIELDS` теряет
  `constructionObjectName` (сортировать по списку нечем) — вместо колонки-имени колонка «Область».

**Портал**

- `MeDto` / `AuthContext` — `constructionObjectIds`.
- `UsersTab.tsx` — множественный выбор объектов; колонка «Область» тегами.
- `WasteRequestsPage.tsx`, `vehicle/VehicleRequestsTab.tsx`, `VehicleRequestsHistoryTab.tsx`,
  `VehicleRequestsOnSiteTab.tsx` — фильтр объекта у объектной роли сужается до своих объектов
  вместо `disabled`; `disabled` остаётся только когда объект один. В форме заявки объект
  подставляется, если он один, иначе выбирается из своих.

**Тесты**: `access-scope.test.ts` — видимость по нескольким объектам, пустой набор → ничего,
автовиза на любом своём объекте; `permissions.test.ts` без изменений; новый
`user-scopes-contracts.test.ts` — непустой набор у объектной роли.

## Этап B. Справочник отделов и роли отдела — **сделано**

**Миграции**

- `00XX_role_department_values.sql` — `ALTER TYPE role ADD VALUE 'department'` и
  `'department_head'` **отдельным файлом**: в одной миграции добавленное значение enum
  использовать нельзя (ограничение Postgres).
- `00XX_departments.sql` — справочник `departments (id, code, name, is_active, created_at,
updated_at)` по образцу `construction_objects`: unique по `code`, trgm-индекс по `name`.
  Сид тестовых данных: «Отдел1», «Отдел2».
- `00XX_user_departments.sql` — `user_departments (user_id, department_id, created_by, created_at)`,
  PK по паре, индекс по отделу («кто в отделе» — вопрос карточки отдела).

**Сервер**

- `contracts/enums.ts` — `ROLES`, `roleLabels`, `roleColors`, `DEPARTMENT_SCOPED_ROLES`.
- `contracts/permissions.ts` — две строки `ROLE_PERMISSIONS` полным перечислением.
- `contracts/departments.ts` — схемы списка/создания/правки, `DepartmentDto` с `heads[]`.
- `routes/departments.ts` — CRUD по образцу `routes/objects.ts`: чтение `directories.read`,
  запись `directories.write`, удаление = деактивация. Карточка отдаёт руководителей (Р3).
- `services/user-scopes.ts` — `departmentsByUserIds`, `headsByDepartmentIds`,
  `replaceUserDepartments`, `replaceDepartmentHeads`.
- `routes/users.ts` — `departmentIds`; правила активации: отдельской роли нужен непустой набор
  отделов, и наборы объектов и отделов одновременно непусты быть не могут (Р1).
- `lib/access.ts` — `departmentVisibilityWhere`, ветка «роль отдела в чужом модуле не видит
  ничего» (тем же явным условием, что у внешнего исполнителя: право и область выдаются порознь).

**Портал**: `directories/DepartmentsTab.tsx` (по образцу `ObjectsTab.tsx`, в карточке —
множественный выбор руководителей), вкладка в `DirectoriesPage.tsx`, поле отделов в `UsersTab`.

**Тесты**: `permissions.test.ts` — наборы прав новых ролей, `isDepartmentScopedRole`, отсутствие
прав вывоза; `access-matrix.test.ts` подхватит новые субъекты сам (`ACCESS_PROFILES` выводится
из `ROLES`) — сверить ожидаемые 403; `route-authorization.test.ts` — пометка `authz` у
`/departments`.

**Отличия от плана по факту работы.** Коридор типов заявки (`ROLE_VEHICLE_REQUEST_TYPES`) отложен
в этап C: без привязки заявки к отделу он нечего не ограничивает, а объявленная и никем не
спрашиваемая таблица читается как действующее правило. До этапа C роли отдела заведены, но заявок
не видят и завести не могут — их область написана явными ветками в `lib/access.ts` и пуста.
Правка руководителей из карточки отдела поднимает `auth_version` и гасит сессии затронутых
учёток — второй путь записи обязан повторять правило первого (ADR 0040 п. 7).

## Этап C. Заявка отдела

**Миграция** `00XX_vehicle_request_department.sql`:

- `ADD COLUMN department_id uuid REFERENCES departments(id) ON DELETE RESTRICT`;
- `ALTER COLUMN object_id DROP NOT NULL`;
- `CHECK (num_nonnulls(object_id, department_id) = 1)` — заказчик ровно один;
- `CHECK (department_id IS NULL OR request_type = 'freight_transport')` — у отдела бывает только
  грузоперевозка (коридор типов, продублированный в БД);
- индекс по `department_id`; индекс «ждут визы» — второй, по отделу.

**Сервер**

- `lib/access.ts` — единая проверка заказчика вместо объектной:
  `assertRequestScope(p, { objectId, departmentId })`, `canApproveRequest(p, scope)`,
  `approvesOwnRequestOnCreate(p, scope)`, `assertScopedRoleEditable` (переименование
  `assertObjectRoleEditable` — правило «правит только Новую» общее для обеих осей),
  `assertVehicleRequestTypeAllowed(p, requestType)`.
- `routes/vehicle-requests.ts` — основной объём:
  - 6 `innerJoin(constructionObjects)` → `leftJoin`, рядом `leftJoin(departments)`;
  - `requestSelect` / `toDto`: `objectId|objectCode|objectName` становятся nullable, добавляются
    `departmentId|departmentCode|departmentName`;
  - создание: `objectId` XOR `departmentId` в zod-refine; `assertRequestScope`;
    `assertDepartmentActive` рядом с `assertObjectActive`;
  - правка: смена заказчика снимает визу так же, как сейчас смена объекта (`changed(...)`);
  - фильтры списков: рядом с `q.objectId` — `q.departmentId`;
  - сводка `count(DISTINCT object_id)` считает заказчиков (объекты + отделы).
- `routes/waybills.ts`, `services/waybill-issue.ts` — `innerJoin` → `leftJoin`; в бланке 4-П поле
  заказчика заполняется отделом, когда объекта нет.
- `routes/files.ts` — `decideFileAccess` ходит по видимости заявок; провести ветку отдела.

**Портал**

- `VehicleRequestsTab.tsx` — отдельской роли вместо фильтра «Объект» фильтр «Отдел»; в форме поле
  «Отдел» вместо «Объект», тип заявки зафиксирован «Грузоперевозка».
- `VehicleRequestViewModal.tsx`, `vehicle/shared.tsx`, `components/columns.tsx` — колонка и поле
  «Объект» → «Заказчик» (объект или отдел).
- `VehicleRequestsOnSiteTab.tsx` — вкладка про спецтехнику на площадке; отдельской роли не нужна
  (сузится сама, но проверить, что не показывается пустой).

**Тесты**: `access-scope.test.ts` — видимость по отделам, автовиза руководителя отдела на заявке
своего отдела, отказ на чужом отделе, отказ на спецтехнике; `waybill-template.test.ts` — бланк с
отделом вместо объекта; `permissions-ui.test.tsx` — меню отдельских ролей (только «Заказ ТС»).

## Этап D. Документация

- ADR «Отдел как вторая ось области видимости» — почему одна ось, а не пересечение (Р1), почему
  виза одна (Р2), почему коридор типов таблицей, а не правом.
- ADR «Множественная привязка учётки» — почему колонка удалена (Р4) и куда переехал инвариант.
- `docs/access-model.md` — §1 роли, §2 матрица, §5 область, §6 активация, §12 «как добавить роль».
- `docs/database-schema.md` — три новые таблицы и колонка.
- `docs/guide-department.md` — памятка сотруднику отдела по образцу `guide-rukstroy.md`
  (необязательно, по готовности этапа C).

---

## Не входит в план

- **Пожелание роли при саморегистрации** (`registration_role_request`): чтобы сотрудник отдела мог
  назвать себя при регистрации, нужны два значения enum и уточнение «отдел» текстом — отдельная
  миграция с CHECK по образцу `0057`. Пока такой заявитель выбирает «Другое».
- **Отдел в вывозе мусора** — прав на модуль у ролей отдела нет, колонка заказчика в
  `waste_requests` не трогается.
- **Триггер на инвариант «объекты XOR отделы»** — кросс-табличная проверка, держит API и тест.
