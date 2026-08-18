import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  DEPARTMENT_SCOPED_ROLES,
  isDepartmentScopedRole,
  isPermission,
  roleLabels,
  SYSTEM_GRANT_CODES,
  type DepartmentHeadRefDto,
  type GrantOrigin,
  type Permission,
  type Role,
  type RoleAddon,
  type UserDepartmentRefDto,
  type UserGrantRefDto,
  type UserObjectRefDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  departments,
  grantPermissions,
  grantRoles,
  grants,
  userConstructionObjects,
  userDepartments,
  userGrants,
  userRoleAddons,
  users,
} from '../db/schema';
import { err } from '../lib/errors';

// Область учётки: объекты (ADR 0039) или отделы (ADR 0040) — две связи «учётка ↔ подразделение»,
// многие-ко-многим. Отдельным сервисом, а не внутри routes/users.ts, по той же причине, что и
// связь «объект ↔ оператор»: набор правится не из одного места — отделы правятся ещё и из
// карточки справочника, — и правила синхронизации должны быть одни и те же с любой стороны.
//
// Здесь же живут надстройки роли (ADR 0086): область они не меняют, но читаются и синхронизируются
// тем же приёмом и в тех же местах — принципал на каждом запросе и карточка учётки.
//
// Надстройки переезжают в назначаемые полномочия (ADR 0106), и переход идёт шагами. С 1c доступ
// считается по `user_grants` (`grantCodesExpr`, `grantPermissionsExpr`, `grantCodesByUserIds`,
// `grantPermissionsByUserIds` — их читают принципал, вход и витрина учёток), а с 1d туда же ушла и
// запись: единственный писатель назначений — `applyAddonGrants`, и `user_role_addons` не пишется
// вовсе. Снаружи путь `addons` при этом прежний — старый портал шлёт тот же набор, и выдача из него
// по-прежнему даёт и отнимает права.
//
// **Откат «через шаг» с 1d перестал быть безопасным.** Старая таблица отстаёт на всё, что выдано
// после прекращения записи, поэтому версия, читающая надстройки (1b и глубже), молча отберёт доступ
// у этих учёток; вернуться туда можно только после обратной сверки — из новых таблиц в старую
// (§15 плана реструктуризации). Откат на 1c безопасен: та версия старую таблицу тоже не читает.
//
// Мёртвые читатели старой таблицы (`roleAddonsExpr`, `addonsByUserIds`) оставлены до 1e, который
// уносит их вместе с самой таблицей.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читателю транзакция не нужна: наборы учёток спрашивают и вне правки (список учёток, карточка). */
type Reader = Tx | typeof db;

/**
 * Объекты учётки одним выражением — для запросов, которые и так отдают строку пользователя
 * целиком (принципал на каждом запросе, вход, смена пароля). Подзапросом, а не join'ом с
 * группировкой: размножать строку пользователя по числу его объектов ради одного массива незачем.
 *
 * Требует, чтобы в запросе участвовала таблица `users` — выражение ссылается на её `id`.
 */
export const constructionObjectIdsExpr = sql<string[]>`(
  SELECT coalesce(array_agg(uco.construction_object_id), '{}')
  FROM user_construction_objects uco
  WHERE uco.user_id = ${users.id}
)`;

/**
 * Объекты учёток одним запросом: список пользователей не должен порождать запрос на строку.
 *
 * **Читатель приходит параметром, но последним и с умолчанием** — в отличие от `grantCodesByUserIds`,
 * где он стоит первым. Причина в порядке появления: область читают из десятка мест списками, и
 * переставить их все ради единообразия значило бы тронуть код, к правке отношения не имеющий.
 * Умолчание `db` оставляет эти вызовы как есть.
 *
 * Зачем читатель понадобился: правка учётки собирает карточку «после» **внутри своей ещё не
 * закоммиченной транзакции** — журнал доступа пишется той же транзакцией (план «полномочия в окне
 * учётки», §5.1), а перечень изменений считается по этой карточке. Снятая мимо транзакции, она
 * описывала бы состояние «до», и журнал молчал бы ровно о том, что правка изменила.
 */
export async function objectsByUserIds(
  userIds: string[],
  reader: Reader = db,
): Promise<Map<string, UserObjectRefDto[]>> {
  const map = new Map<string, UserObjectRefDto[]>();
  if (userIds.length === 0) return map;
  const rows = await reader
    .select({
      userId: userConstructionObjects.userId,
      id: constructionObjects.id,
      code: constructionObjects.code,
      name: constructionObjects.name,
    })
    .from(userConstructionObjects)
    .innerJoin(
      constructionObjects,
      eq(userConstructionObjects.constructionObjectId, constructionObjects.id),
    )
    .where(inArray(userConstructionObjects.userId, userIds))
    .orderBy(constructionObjects.name);
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push({ id: row.id, code: row.code, name: row.name });
    map.set(row.userId, list);
  }
  return map;
}

/** Текущий набор объектов учётки — нужен, чтобы понять, менялась ли область (отзыв токенов). */
export async function objectIdsOfUser(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: userConstructionObjects.constructionObjectId })
    .from(userConstructionObjects)
    .where(eq(userConstructionObjects.userId, userId));
  return rows.map((r) => r.id);
}

/**
 * Неактивный объект пропускаем: привязка описывает зону ответственности, а не готовность
 * принимать заявки прямо сейчас — деактивация объекта не должна молча обрезать область учётки.
 */
async function assertAllObjectsExist(tx: Tx, objectIds: string[]): Promise<void> {
  if (objectIds.length === 0) return;
  const rows = await tx
    .select({ id: constructionObjects.id })
    .from(constructionObjects)
    .where(inArray(constructionObjects.id, objectIds));
  if (rows.length !== new Set(objectIds).size) {
    throw err.badRequest('Объект не найден', { constructionObjectIds: 'Объект не найден' });
  }
}

/**
 * Заменяет набор объектов учётки целиком (приём из replaceObjectOperators): клиент присылает то,
 * что должно остаться, сервер считает разницу. Возвращает `true`, если набор изменился, — по
 * этому ответу маршрут решает, гасить ли выданные токены: сменившаяся область меняет и то, какие
 * заявки учётке видны.
 */
export async function replaceUserObjects(
  tx: Tx,
  userId: string,
  objectIds: string[],
  actorUserId: string,
): Promise<boolean> {
  const ids = [...new Set(objectIds)];
  await assertAllObjectsExist(tx, ids);
  const before = new Set(await objectIdsOfUser(tx, userId));
  const changed = before.size !== ids.length || ids.some((id) => !before.has(id));
  if (!changed) return false;

  await tx.delete(userConstructionObjects).where(eq(userConstructionObjects.userId, userId));
  if (ids.length > 0) {
    await tx
      .insert(userConstructionObjects)
      .values(
        ids.map((constructionObjectId) => ({
          userId,
          constructionObjectId,
          createdBy: actorUserId,
        })),
      )
      .onConflictDoNothing();
  }
  return true;
}

/** Отделы учётки одним выражением — рядом с объектами и по той же причине (ADR 0040). */
export const departmentIdsExpr = sql<string[]>`(
  SELECT coalesce(array_agg(ud.department_id), '{}')
  FROM user_departments ud
  WHERE ud.user_id = ${users.id}
)`;

/**
 * Площадки отделов учётки (ADR 0062) — производная область: в её пределах роль отдела ведёт
 * вывоз мусора. Считается из справочника, а не хранится у учётки: объект задаётся отделу, и
 * второе хранилище разошлось бы с ним при первой же правке.
 *
 * `DISTINCT`: два отдела учётки могут стоять на одной площадке, и дубль в наборе означал бы
 * лишнее значение в `IN` и лишнюю строку в токене — не ошибку, но и не правду о числе объектов.
 */
export const departmentObjectIdsExpr = sql<string[]>`(
  SELECT coalesce(array_agg(DISTINCT d.construction_object_id), '{}')
  FROM user_departments ud
  JOIN departments d ON d.id = ud.department_id
  WHERE ud.user_id = ${users.id} AND d.construction_object_id IS NOT NULL
)`;

/**
 * Отделы учёток одним запросом — то же, что objectsByUserIds, второй осью.
 *
 * Признак руководителя идёт той же строкой (`is_head`, миграция 0149), потому что он и лежит в ней:
 * это единственное чтение отделов учётки, и без признака портал спрашивал бы «руководит ли» с
 * другой стороны связи — вторым запросом в справочник, который выключенные отделы не отдаёт.
 *
 * Читатель — последним параметром с умолчанием, по причине из `objectsByUserIds`: обе оси области
 * читаются вместе, и разными способами их читать нельзя.
 */
export async function departmentsByUserIds(
  userIds: string[],
  reader: Reader = db,
): Promise<Map<string, UserDepartmentRefDto[]>> {
  const map = new Map<string, UserDepartmentRefDto[]>();
  if (userIds.length === 0) return map;
  const rows = await reader
    .select({
      userId: userDepartments.userId,
      id: departments.id,
      code: departments.code,
      name: departments.name,
      isHead: userDepartments.isHead,
    })
    .from(userDepartments)
    .innerJoin(departments, eq(userDepartments.departmentId, departments.id))
    .where(inArray(userDepartments.userId, userIds))
    .orderBy(departments.name);
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push({ id: row.id, code: row.code, name: row.name, isHead: row.isHead });
    map.set(row.userId, list);
  }
  return map;
}

/** Текущий набор отделов учётки — по нему видно, менялась ли область (отзыв токенов). */
export async function departmentIdsOfUser(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: userDepartments.departmentId })
    .from(userDepartments)
    .where(eq(userDepartments.userId, userId));
  return rows.map((r) => r.id);
}

async function assertAllDepartmentsExist(tx: Tx, departmentIds: string[]): Promise<void> {
  if (departmentIds.length === 0) return;
  const rows = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(inArray(departments.id, departmentIds));
  if (rows.length !== new Set(departmentIds).size) {
    throw err.badRequest('Отдел не найден', { departmentIds: 'Отдел не найден' });
  }
}

/**
 * Заменяет набор отделов учётки целиком; возвращает `true`, если он изменился.
 *
 * **Идёт разницей, а не «снести и вставить заново», — и это требование признака руководителя**
 * (`is_head`, миграция 0149). У объектов разницы не нужно: в строке связи нет ничего, кроме самой
 * связи. У отделов с этапа 5 реформы (§11.1 плана) в строке живёт ответ карточки справочника
 * «кто здесь главный», и пересоздание строки при добавлении соседнего отдела снимало бы
 * руководство молча — правкой, которая его не касалась. Оставшиеся связи поэтому не трогаются
 * вовсе: признак, автор и время привязки у них те же, что были.
 *
 * Отдел, ушедший из набора, уносит и руководство: человек в отделе больше не состоит, а
 * «руководитель отдела, к которому не привязан» — состояние, которого в предметной области нет.
 */
export async function replaceUserDepartments(
  tx: Tx,
  userId: string,
  departmentIds: string[],
  actorUserId: string,
): Promise<boolean> {
  const ids = [...new Set(departmentIds)];
  await assertAllDepartmentsExist(tx, ids);
  const before = new Set(await departmentIdsOfUser(tx, userId));
  const toRemove = [...before].filter((id) => !ids.includes(id));
  const toAdd = ids.filter((id) => !before.has(id));
  if (toRemove.length === 0 && toAdd.length === 0) return false;

  if (toRemove.length > 0) {
    await tx
      .delete(userDepartments)
      .where(
        and(eq(userDepartments.userId, userId), inArray(userDepartments.departmentId, toRemove)),
      );
  }
  if (toAdd.length > 0) {
    await tx
      .insert(userDepartments)
      // `isHead` не проставляется: из карточки учётки задают участие в отделе, а не руководство им
      // (его назначают из карточки отдела). Умолчание колонки — `false`.
      .values(toAdd.map((departmentId) => ({ userId, departmentId, createdBy: actorUserId })))
      .onConflictDoNothing();
  }
  return true;
}

/**
 * Надстройки учётки (ADR 0086) одним выражением — рядом с объектами и отделами и по той же
 * причине: принципал читается на каждом запросе, и размножать строку пользователя ради набора
 * из нескольких значений незачем.
 *
 * `::text` обязателен: pg разбирает только встроенные типы массивов, а у массива пользовательского
 * enum'а OID свой в каждой базе — такой столбец вернулся бы строкой `{office_equipment_operator}`
 * вместо массива, и `can` молча не нашёл бы ни одной надстройки.
 *
 * **Читателей у выражения с шага 1c нет** (см. заголовок файла): принципал и вход спрашивают
 * `grantCodesExpr`. Оставлено до шага 1e, который уносит его вместе с таблицей, — но вернуть чтение
 * сюда уже нельзя: с 1d в `user_role_addons` никто не пишет, и всё выданное после того релиза
 * выражение попросту не покажет. Это был бы не откат, а тихое снятие доступа.
 */
export const roleAddonsExpr = sql<RoleAddon[]>`(
  SELECT coalesce(array_agg(ura.addon::text ORDER BY ura.addon), '{}')
  FROM user_role_addons ura
  WHERE ura.user_id = ${users.id}
)`;

/**
 * Надстройки учёток одним запросом — то же, что objectsByUserIds, третьей осью.
 *
 * Как и `roleAddonsExpr`, с шага 1c никем не читается: список и карточка учёток спрашивают
 * `grantCodesByUserIds`, — и так же, как у него, вернуть чтение сюда с шага 1d нельзя: старая
 * таблица отстала на всё выданное после прекращения записи.
 */
export async function addonsByUserIds(userIds: string[]): Promise<Map<string, RoleAddon[]>> {
  const map = new Map<string, RoleAddon[]>();
  if (userIds.length === 0) return map;
  const rows = await db
    .select({ userId: userRoleAddons.userId, addon: userRoleAddons.addon })
    .from(userRoleAddons)
    .where(inArray(userRoleAddons.userId, userIds))
    // Порядок — объявления enum'а: набор показывается пометками рядом с ролью, и он не должен
    // переставляться от того, в каком порядке надстройки выдавали.
    .orderBy(userRoleAddons.addon);
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push(row.addon);
    map.set(row.userId, list);
  }
  return map;
}

/*
 * ── Чтение назначаемых полномочий (ADR 0106, шаг 1c) ─────────────────────────────────────────────
 *
 * Выражения ниже — действующий источник прав: их читают принципал на каждом запросе
 * (`auth/principal.ts`), вход со сменой пароля (`routes/auth.ts`) и витрина учёток
 * (`routes/users.ts`). Разрешила переключение нулевая двусторонняя сверка (`backfill:grants
 * --check`, шаг 1b), а не готовность кода; сами выражения по-прежнему проверяются своим db-тестом
 * (`user-grants-read.db.test.ts`) — он единственный, где видны гейт по роли, фильтр `deleted_at` и
 * право-сирота.
 */

/**
 * Коды наборов учётки одним выражением — рядом с `roleAddonsExpr` и по той же причине: принципал
 * читается на каждом запросе, и размножать строку пользователя ради набора из нескольких значений
 * незачем.
 *
 * `deleted_at IS NULL` — единственный фильтр здесь и стоит он на **наборе**, а не на назначении:
 * мягко удалённый набор перестаёт действовать у всех держателей сразу, а строки `user_grants`
 * остаются — реестр выдач обязан объяснять прошлые назначения (`grant_id` под RESTRICT именно
 * ради этого).
 *
 * Порядок — по коду: ответ не должен переставляться от того, в каком порядке наборы выдавали.
 * Пометки рядом с ролью упорядочивает при этом не он, а словарь (`systemAddonsOf`): у надстроек
 * порядок был enum'ный, и алфавит кодов переставил бы две пометки местами на ровном месте.
 * `::text` здесь, в отличие от надстроек, не нужен — код набора и в базе `text`, а не значение
 * пользовательского enum'а.
 *
 * Совместимости с ролью выражение не спрашивает намеренно: коды отвечают на «что учётке выдано», и
 * витрина обязана показывать выданный набор даже тогда, когда роль сменили и права он больше не
 * даёт. Гейт по роли стоит там, где считаются права (`grantPermissionsExpr`).
 *
 * **`${users}.id`, а не `${users.id}`, и это не стилевая мелочь.** Столбец, подставленный в шаблон
 * `sql`, drizzle печатает по-разному в зависимости от **внешнего** запроса: в выборке из одной
 * таблицы он снимает квалификатор и оставляет голое `"id"` (`buildSelection`, `isSingleTable`), а
 * при первом же join'е возвращает `"users"."id"`. Соседним выражениям это сходило с рук — в их
 * подзапросах одна таблица и столбца `id` в ней нет вовсе, — а здесь голое `"id"` попадает в область
 * видимости, где `id` есть и у `user_grants`, и у `grants`: Postgres отвечает «column reference "id"
 * is ambiguous». Имя таблицы drizzle не переписывает никогда, поэтому ссылка наружу собирается из
 * него, а на выбор квалификатора чтением уже не влияет ничто.
 */
export const grantCodesExpr = sql<string[]>`(
  SELECT coalesce(array_agg(g.code ORDER BY g.code), '{}')
  FROM user_grants ug
  JOIN grants g ON g.id = ug.grant_id
  WHERE ug.user_id = ${users}.id AND g.deleted_at IS NULL
)`;

/**
 * Права, которые дают учётке её наборы, — то, чем на шаге переключения заменится перебор надстроек
 * внутри `can`.
 *
 * **Соединение с `grant_roles` — это гейт совместимости, а не оптимизация.** Сегодня он стоит
 * внутри `can`: `canAttachAddon(role, addon)` спрашивается на каждой надстройке, потому что матрица
 * обязана отвечать одинаково на любой субъект, откуда бы он ни пришёл. Учётка, которой сменили роль
 * мимо валидации формы (правкой в базе, восстановлением из архива, будущим переводом ролей),
 * остаётся держателем набора — и права по нему сегодня не получает. Убери мы это соединение,
 * переключение источника **расширило** бы доступ такой учётке, а выглядело бы это как перенос без
 * изменения поведения: ни один тест матрицы такую учётку не собирает, потому что через форму её не
 * собрать.
 *
 * Соединение по `ug.grant_id`, а не по `g.id`, — то же значение, но без зависимости от порядка
 * join'ов при чтении. `users.role` у неактивированной учётки NULL, и тогда условие не выполняется ни
 * для одной строки: прав нет вовсе — тот же ответ, что у `can` без роли.
 *
 * **`${users}.role` пишется именно так по причине из `grantCodesExpr`, и цена ошибки здесь выше.**
 * Столбец в шаблоне `sql` drizzle печатает без квалификатора, когда снаружи выборка из одной
 * таблицы, — а голое `"role"` в этой области видимости разрешается в `gr.role`, потому что второй
 * колонки с таким именем в подзапросе нет. Условие превратилось бы в `gr.role = gr.role`, то есть в
 * тавтологию, и гейт совместимости исчез бы **молча**: ни ошибки базы, ни пустого ответа — просто
 * права набора начали бы доставаться любой роли. Ссылка наружу поэтому собирается из имени таблицы,
 * которое drizzle не переписывает.
 *
 * Тип — `string[]`, а не `Permission[]`, и это продолжение решения хранить право текстом: после
 * выката, снявшего право из словаря, здесь придёт строка-сирота. Отсеивает её читатель
 * (`isPermission` в контрактах); `Permission[]` пообещал бы, что отсеивать нечего.
 *
 * `DISTINCT` обязателен: одно право лежит в двух наборах учётки штатно — «Оператор (оргтехника)» и
 * будущий административный набор пересекаются по `serviceRequests.status`, — и дубль в массиве
 * означал бы, что число прав зависит от того, сколько наборов их дало.
 */
export const grantPermissionsExpr = sql<string[]>`(
  SELECT coalesce(array_agg(DISTINCT gp.permission), '{}')
  FROM user_grants ug
  JOIN grants g ON g.id = ug.grant_id
  JOIN grant_roles gr ON gr.grant_id = ug.grant_id AND gr.role = ${users}.role
  JOIN grant_permissions gp ON gp.grant_id = ug.grant_id
  WHERE ug.user_id = ${users}.id AND g.deleted_at IS NULL
)`;

/**
 * Коды наборов у списка учёток одним запросом — то же, что `addonsByUserIds`, но по новой схеме:
 * список учёток не должен порождать запрос на строку.
 *
 * Читатель приходит параметром, а не берётся из модуля, в отличие от `addonsByUserIds`: наборы
 * спрашивает и список учёток (вне транзакции), и правка, которой нужно увидеть состояние внутри
 * своей (пересчёт прав перед `authVersion`). Второй функции ради этого не заводится — `Reader`
 * принимает и то и другое.
 *
 * Возвращает строки, а не `SystemGrantCode`: рядом с системными в базе лежат наборы, собранные
 * администратором, и сузить тип здесь значило бы соврать про содержимое.
 */
export async function grantCodesByUserIds(
  reader: Reader,
  userIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (userIds.length === 0) return map;
  const rows = await reader
    .select({ userId: userGrants.userId, code: grants.code })
    .from(userGrants)
    .innerJoin(grants, eq(grants.id, userGrants.grantId))
    // Мягко удалённый набор не действует ни у кого — тем же правилом, что в `grantCodesExpr`.
    .where(and(inArray(userGrants.userId, userIds), sql`${grants.deletedAt} IS NULL`))
    .orderBy(grants.code);
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push(row.code);
    map.set(row.userId, list);
  }
  return map;
}

/**
 * Назначения учёток для карточки — то, чем окно рисует чекбоксы и чем портал собирает высказывание
 * (план «полномочия назначаются в окне учётки», §4; `UserAccountDto.grants`).
 *
 * **Отдаются все живые назначения, а не только совместимые с ролью, и это требование полноты, а не
 * щедрость ответа.** Форма обязана высказаться о каждом наборе, чьё действие переключает смена роли
 * (§4.2), а версию для такой строки взять больше неоткуда: каталог, отфильтрованный по роли,
 * несовместимый набор не содержит вовсе. Отдай мы здесь только совместимые — правило полноты стало
 * бы невыполнимым ровно в том переходе, ради которого оно и заведено.
 *
 * Отсюда и `roleMismatch` отдельным полем: назначение живо, а прав по нему набор не даёт (§13.1
 * плана реструктуризации), и различить эти два состояния снаружи нечем. Считается он **тем же
 * соединением с `grant_roles`**, что стоит гейтом в выражении чтения прав (`grantPermissionsExpr`):
 * два ответа на «действует ли набор» разошлись бы первой же правкой одного из них, и форма
 * показывала бы галочкой доступ, которого сервер не даёт. Роль учётки NULL (нерассмотренная заявка)
 * не совпадает ни с одной строкой `grant_roles` — набор не действует, `roleMismatch` истинен.
 *
 * `LEFT JOIN`, а не `INNER`: несовпадение роли — законное состояние, и внутреннее соединение
 * попросту потеряло бы такую строку. Размножения строк оно не даёт — `grant_roles` уникальна по
 * паре «набор + роль» (первичный ключ).
 *
 * Мягко удалённый набор отсеивается тем же правилом, что в `grantCodesExpr`: он не действует ни у
 * кого, и показывать его чекбоксом нечего. Порядок — по коду, как у `grantCodes`: две половины
 * одного ответа не должны перечислять наборы по-разному.
 */
export async function grantRefsByUserIds(
  reader: Reader,
  userIds: string[],
): Promise<Map<string, UserGrantRefDto[]>> {
  const map = new Map<string, UserGrantRefDto[]>();
  if (userIds.length === 0) return map;
  const rows = await reader
    .select({
      userId: userGrants.userId,
      id: grants.id,
      code: grants.code,
      name: grants.name,
      version: grants.version,
      origin: userGrants.origin,
      compatibleRole: grantRoles.role,
    })
    .from(userGrants)
    .innerJoin(grants, eq(grants.id, userGrants.grantId))
    .innerJoin(users, eq(users.id, userGrants.userId))
    .leftJoin(
      grantRoles,
      and(eq(grantRoles.grantId, userGrants.grantId), eq(grantRoles.role, users.role)),
    )
    .where(and(inArray(userGrants.userId, userIds), isNull(grants.deletedAt)))
    .orderBy(grants.code);
  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push({
      id: row.id,
      code: row.code,
      name: row.name,
      version: row.version,
      roleMismatch: row.compatibleRole === null,
      origin: row.origin as GrantOrigin,
    });
    map.set(row.userId, list);
  }
  return map;
}

/**
 * Права наборов у пачки учёток одним запросом — пакетный близнец `grantPermissionsExpr`, заведённый
 * ради того же, ради чего рядом стоит `grantCodesByUserIds`: витрина учёток отдаёт эффективные права
 * (план реструктуризации §12, этап 2б), а страница списка не должна порождать запрос на строку.
 *
 * **Гейт совместимости с ролью — то же соединение с `grant_roles`, что в выражении, и по той же
 * причине** (см. `grantPermissionsExpr`): набор, выданный до смены роли, прав больше не даёт, и
 * пакетное чтение обязано отвечать ровно то же, что ответит принципал следующему запросу. Разойдись
 * они — витрина рассказывала бы про доступ, которого сервер не даёт (или наоборот), то есть перестала
 * бы годиться в критерий готовности этапов, ради которого её и переводят на серверные права.
 *
 * Отсюда и соединение с `users`: роль лежит в её строке, а не в назначении. `role IS NULL` (учётка
 * без роли, то есть нерассмотренная заявка) не совпадает ни с одной строкой `grant_roles` — прав нет
 * вовсе, тот же ответ, что у `can` без роли.
 *
 * `selectDistinct` вместо `array_agg(DISTINCT …)` из выражения — то же требование другими словами:
 * одно право лежит в двух наборах учётки штатно, и дубль означал бы, что число прав зависит от того,
 * сколько наборов их дало.
 *
 * **Возвращает `Permission[]`, а не строки: граница «база → код» проходит здесь.** Право хранится
 * текстом, и выкат, снявший его из словаря, оставляет в `grant_permissions` строку-сироту — её
 * отсеивает `isPermission`, тем же приёмом и в том же месте, что у принципала (`loadPrincipal`).
 * Доступа сирота не даёт ни на одном маршруте, и списку прав в карточке о ней рассказывать нечего;
 * отказ молчаливый по той же причине — ронять карточку из-за строки, которая ничего не разрешает,
 * незачем.
 *
 * Читатель приходит параметром — как у `grantCodesByUserIds`: наборы спрашивает и список учёток вне
 * транзакции, и правка, которой нужно увидеть состояние внутри своей.
 */
export async function grantPermissionsByUserIds(
  reader: Reader,
  userIds: string[],
): Promise<Map<string, Permission[]>> {
  const map = new Map<string, Permission[]>();
  if (userIds.length === 0) return map;
  const rows = await reader
    .selectDistinct({ userId: userGrants.userId, permission: grantPermissions.permission })
    .from(userGrants)
    .innerJoin(grants, eq(grants.id, userGrants.grantId))
    .innerJoin(users, eq(users.id, userGrants.userId))
    .innerJoin(
      grantRoles,
      and(eq(grantRoles.grantId, userGrants.grantId), eq(grantRoles.role, users.role)),
    )
    .innerJoin(grantPermissions, eq(grantPermissions.grantId, userGrants.grantId))
    // Мягко удалённый набор не действует ни у кого — тем же правилом, что в `grantCodesExpr`.
    .where(and(inArray(userGrants.userId, userIds), isNull(grants.deletedAt)));
  for (const row of rows) {
    if (!isPermission(row.permission)) continue;
    const list = map.get(row.userId) ?? [];
    list.push(row.permission);
    map.set(row.userId, list);
  }
  return map;
}

/**
 * Надстройки, которые видны в наборах учётки, — пересечение её кодов с системными (ADR 0106,
 * шаг 1c).
 *
 * Нужно затем, что поле `addons` в ответах API формы не меняет: список и карточка учёток отдают
 * `RoleAddon[]`, портал рисует по нему пометку рядом с ролью (`roleAddonLabels`,
 * `roleAddonColors`), а форма правки присылает набор обратно. Источник поля при этом уже новый —
 * `user_grants`, — и переводить витрину на коды наборов будет свой шаг (§10.1 плана).
 *
 * Отсюда и фильтр, а не приведение всего списка кодов к `RoleAddon[]`. Рядом с двумя системными в
 * базе лежат наборы, собранные администратором: попав в `addons`, такой код дал бы в подписи и цвете
 * `undefined` — пустую пометку рядом с ролью, — а вернувшись из формы правки, был бы отклонён схемой
 * как значение вне enum'а, то есть учётку стало бы нельзя сохранить, не сняв набор.
 *
 * **Перебор идёт по словарю, а не по кодам учётки, и это не стилевая мелочь — это порядок пометок.**
 * `roleAddonsExpr` отдавал надстройки в порядке объявления enum'а («Оператор (оргтехника)», потом
 * «Согласование ИТ»), а `grantCodesExpr` сортирует по коду, где алфавит переставляет их местами.
 * Держателю обоих наборов пометки после переключения источника поменялись бы местами ни от чего —
 * шаг обязан менять хранение и ничего больше. Порядок словаря к тому же и есть тот, который нужен:
 * пометки не должны переставляться от того, в каком порядке наборы выдавали.
 *
 * Совпадение кодов держится не соглашением, а `SYSTEM_GRANT_CODES ... satisfies readonly RoleAddon[]`
 * в контрактах — оттуда же и тип результата. Функция уходит вместе с полем `addons` на шаге 1e.
 */
export function systemAddonsOf(codes: readonly string[]): RoleAddon[] {
  // `includes` по двум системным кодам: множество на каждый запрос дороже самого перебора.
  return SYSTEM_GRANT_CODES.filter((code) => codes.includes(code));
}

/**
 * Текущий набор надстроек учётки. Нужен ровно затем же, зачем наборы объектов и отделов: по нему
 * видно, менялись ли права (отзыв токенов), и он же служит «итоговым состоянием», с которым
 * сверяется новая роль, когда набор не прислали (`routes/users.ts`).
 *
 * **Читает назначения, а не `user_role_addons`, и это требование шага 1d.** С прекращением записи
 * старая таблица перестала описывать что бы то ни было, а разница правки считается именно отсюда:
 * читай мы мёртвое состояние, снятая надстройка молча возвращалась бы при первой же правке
 * карточки, а выданную не удалось бы снять. Источник у чтения и у записи обязан быть один.
 *
 * Отсюда и пересечение с системными кодами (`systemAddonsOf`), а не весь список: рядом с двумя
 * системными наборами у учётки лежат собранные администратором, и надстройками они не являются —
 * ни в поле `addons`, ни в разнице `replaceUserAddons` им места нет. Мягко удалённый набор в ответ
 * не попадает — тем же правилом, что у остальных читателей `user_grants`.
 */
export async function addonsOfUser(tx: Tx, userId: string): Promise<RoleAddon[]> {
  const codes = await grantCodesByUserIds(tx, [userId]);
  return systemAddonsOf(codes.get(userId) ?? []);
}

/**
 * Записывает выдачу и отзыв надстроек назначениями полномочий (ADR 0106, решение 9).
 *
 * **С шага 1d это и есть запись, а не отражение чужой.** До него функция звалась
 * `mirrorAddonGrants` и дублировала в `user_grants` то, что `replaceUserAddons` писала в
 * `user_role_addons`; теперь старая таблица не пишется вовсе, и единственный след выданной из
 * карточки надстройки — заведённая здесь строка назначения. Отсюда и цена ошибки: пропущенная
 * вставка означает не расхождение двух таблиц, а невыданное право.
 *
 * Зовётся только из `replaceUserAddons` и **той же транзакцией**: `tx` приходит снаружи, потому что
 * правку учётки составляют ещё пять действий рядом — область, работник, строка `users`,
 * `authVersion`, письмо. Собственный commit означал бы, что назначение переживает откат правки,
 * которая его и завела.
 *
 * Принимает **разницу**, а не итоговый набор, и свести это к «удалить всё и вставить заново», как
 * сделано у объектов и отделов, нельзя. У назначения собственная идентичность: `id` неизменяем, и
 * на него опирается откат будущего перевода ролей — он снимает ровно свои строки и не трогает
 * выданное позже вручную. Пересоздание при добавлении второй надстройки выдало бы первой новый
 * `id`, нового автора и новое время выдачи, то есть переписало бы историю выдачи, которой никто не
 * касался, — и откат перевода перестал бы находить свои строки.
 *
 * Набор ищется по коду: код надстройки и код системного набора совпадают, и держится это не
 * соглашением, а `SYSTEM_GRANT_CODES ... satisfies readonly RoleAddon[]` в контрактах. Фильтра по
 * `deleted_at` здесь нет: код уникален по всей таблице, поэтому строка находится одна, а системный
 * набор не удаляется вовсе.
 */
async function applyAddonGrants(
  tx: Tx,
  userId: string,
  toAdd: RoleAddon[],
  toRemove: RoleAddon[],
  actorUserId: string,
): Promise<void> {
  const codes = [...toAdd, ...toRemove];
  if (codes.length === 0) return;
  const rows = await tx
    .select({ id: grants.id, code: grants.code })
    .from(grants)
    .where(inArray(grants.code, codes));
  const grantIdByCode = new Map(rows.map((row) => [row.code, row.id]));

  // Отзыв идёт первым и по идентификаторам найденных наборов: удаляются ровно снятые назначения,
  // оставшиеся не пересоздаются.
  const removeIds = toRemove
    .map((addon) => grantIdByCode.get(addon))
    .filter((id): id is string => id !== undefined);
  if (removeIds.length > 0) {
    await tx
      .delete(userGrants)
      .where(and(eq(userGrants.userId, userId), inArray(userGrants.grantId, removeIds)));
  }

  if (toAdd.length === 0) return;
  const values = toAdd.map((addon) => {
    const grantId = grantIdByCode.get(addon);
    // Набора под кодом надстройки нет — значит миграция 0145 не накатана, а код, который её
    // требует, уже работает. Это сломанный выкат, а не рабочее состояние: деплой накатывает
    // миграции ДО перезапуска приложения, поэтому к первой же выдаче набор обязан существовать.
    //
    // Отсюда выбор — падать, а не пропускать молча. До шага 1d пропуск оставлял выдачу хотя бы в
    // старой таблице и подделывал сигнал сверки; теперь он не оставляет её нигде — администратор
    // видит сохранённую карточку, а прав у человека не появляется, и объяснить это будет нечем.
    // Отказ операции здесь дешевле тихо потерянного права.
    //
    // Отзыв (выше) при этом не падает: если набора нет, то и назначения на него быть не может —
    // снимать нечего, и упираться в отсутствующую строку каталога снятие доступа не должно.
    if (!grantId) {
      throw new Error(
        `Системный набор «${addon}» не найден в grants: миграция 0145 не накатана, ` +
          'выдать надстройку некуда',
      );
    }
    // `origin: 'manual'` — выдал администратор; `migration` зарезервирован за переводом ролей.
    // `granted_at` не проставляется вручную: умолчание базы — время начала транзакции, то есть тот
    // же момент, которым датированы и остальные правки этой карточки.
    return { userId, grantId, grantedBy: actorUserId, origin: 'manual' as const };
  });
  await tx
    .insert(userGrants)
    .values(values)
    // Повторная выдача уже выданного набора не заводит второго назначения и не переписывает
    // первое: пара «учётка + набор» под `UNIQUE`, и `DO NOTHING` оставляет прежнюю строку с её
    // `id` и временем. Разницу считает `replaceUserAddons`, и обычно такого кода в `toAdd` нет
    // вовсе; остаётся случай, когда назначение есть, а в разнице его не видно: мягко удалённый
    // набор читатели пропускают (`grantCodesByUserIds`), и без `DO NOTHING` правка учётки падала бы
    // на ограничении — из-за набора, которого администратор в форме и не видел.
    .onConflictDoNothing({ target: [userGrants.userId, userGrants.grantId] });
}

/**
 * Заменяет набор надстроек учётки целиком — тем же приёмом, что объекты и отделы: клиент
 * присылает то, что должно остаться, сервер считает разницу. Возвращает `true`, если набор
 * изменился, — по этому ответу маршрут гасит выданные токены: надстройка меняет набор прав, а не
 * область, но access-токен сверяется с `authVersion` на каждом запросе одинаково в обоих случаях.
 *
 * Совместимость с ролью проверяет маршрут: она зависит от роли, которая правится той же ручкой, и
 * ответ обязан назвать поле формы, а не прийти общим 400 из глубины сервиса.
 *
 * **Пишет только назначения (ADR 0106, шаг 1d).** Прежняя `user_role_addons` не заполняется и не
 * чистится: с этого релиза она мёртвая и ждёт удаления (1e). Снаружи путь не изменился — старый
 * портал шлёт тот же `addons`, и надстройка, выданная из него, по-прежнему даёт права: читаются
 * они с шага 1c уже из назначений. Записью занимается `applyAddonGrants`, и идёт она разницей, а
 * не «снести и вставить заново», — почему именно так, сказано там же.
 *
 * **Разница считается от назначений** (`addonsOfUser`), а не от старой таблицы, и это не деталь
 * реализации: состояние обязано читаться оттуда же, куда пишется. Читай мы `user_role_addons`,
 * разница выходила бы «ничего не менялось» — то есть снятая надстройка возвращалась бы при первой
 * же правке карточки, а выданную нельзя было бы снять, и оба раза молча.
 *
 * **Требует блокировки строки учётки снаружи.** Разница считается от прочитанного здесь `before`, и
 * между чтением и записью не должно втиснуться второе изменение набора: оба вызова этой функции
 * идут после `SELECT … FOR UPDATE` по строке учётки (`routes/users.ts`). Без блокировки две
 * одновременные правки посчитали бы разницу от одного и того же состояния, и вторая молча вернула
 * бы снятую первой надстройку.
 */
export async function replaceUserAddons(
  tx: Tx,
  userId: string,
  addons: RoleAddon[],
  actorUserId: string,
): Promise<boolean> {
  const next = [...new Set(addons)];
  const before = new Set(await addonsOfUser(tx, userId));
  const toAdd = next.filter((addon) => !before.has(addon));
  const toRemove = [...before].filter((addon) => !next.includes(addon));
  if (toAdd.length === 0 && toRemove.length === 0) return false;

  await applyAddonGrants(tx, userId, toAdd, toRemove, actorUserId);
  return true;
}

/**
 * Смена площадки отдела (ADR 0062) меняет область **всем** его учёткам — и сотрудникам, и
 * руководителям, — поэтому `authVersion` поднимается каждой: это не правка набора из карточки,
 * где меняют конкретных людей, а правка того, что этот набор означает.
 *
 * Поднимается здесь, в транзакции с самой привязкой: access-токен сверяется с `authVersion` на
 * каждом запросе и иначе дожил бы до истечения с прежней областью. Возвращает учётки, чьи
 * refresh-сессии обязан отозвать маршрут — сервис в сессии не ходит.
 */
export async function markDepartmentScopeChanged(tx: Tx, departmentId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: userDepartments.userId })
    .from(userDepartments)
    .where(eq(userDepartments.departmentId, departmentId));
  const userIds = rows.map((r) => r.userId);
  if (userIds.length === 0) return [];
  await tx
    .update(users)
    .set({ authVersion: sql`${users.authVersion} + 1`, updatedAt: new Date() })
    .where(inArray(users.id, userIds));
  return userIds;
}

/*
 * ── Руководитель отдела: признак связи, а не имя роли (§11.1 плана, миграция 0149) ──────────────
 *
 * До этапа 5 реформы прав «кто руководитель этого отдела» спрашивалось у роли:
 * `users.role = 'department_head'` стояло здесь в четырёх запросах. Роль отвечает на другой вопрос
 * — «что человек может», — и реформа готовится роли сливать: после слияния карточка отдела
 * опустела бы МОЛЧА, ни одного права не изменив и ни одного теста доступа не покрасив.
 *
 * Признак живёт в строке связи (`user_departments.is_head`), потому что руководство — свойство
 * связи, а не человека: один и тот же сотрудник бывает руководителем ПТО и рядовым участником
 * снабжения. Ролью, которая у учётки одна, это не выражается вовсе.
 *
 * Роль `department_head` при этом остаётся, и права её не меняются: это развязывание, а не
 * слияние. Прав признак не даёт и в расчёте доступа не участвует — ось области у отдельских ролей
 * прежняя (`DEPARTMENT_SCOPED_ROLES`), и виза заявки отдела считается ролью, как считалась.
 */

/**
 * Руководители отделов (ADR 0040) — привязки с признаком `is_head`, прочитанные со стороны
 * справочника. Своего хранилища у связи нет: это та же `user_departments`. Отсюда и правило показа
 * — признак спрашивается в запросе, а не подразумевается: в отделе сидят и сотрудники, и
 * руководитель, а карточка отдела отвечает только про вторых.
 *
 * Роль учётки запрос не спрашивает намеренно: держатель признака показывается руководителем при
 * любой роли, а роль «Руководитель отдела» без признака — не показывается. Иначе перевод ролей
 * снова стал бы правкой справочника.
 */
export async function headsByDepartmentIds(
  departmentIds: string[],
): Promise<Map<string, DepartmentHeadRefDto[]>> {
  const map = new Map<string, DepartmentHeadRefDto[]>();
  if (departmentIds.length === 0) return map;
  const rows = await db
    .select({
      departmentId: userDepartments.departmentId,
      id: users.id,
      fullName: users.fullName,
    })
    .from(userDepartments)
    .innerJoin(users, eq(userDepartments.userId, users.id))
    .where(
      and(
        inArray(userDepartments.departmentId, departmentIds),
        eq(userDepartments.isHead, true),
        // Удалённая учётка из карточки отдела исчезает: привязка остаётся в БД и вернётся вместе
        // с восстановлением записи — тем же правилом, что и операторы у объекта.
        sql`${users.deletedAt} IS NULL`,
      ),
    )
    .orderBy(users.fullName);
  for (const row of rows) {
    const list = map.get(row.departmentId) ?? [];
    list.push({ id: row.id, fullName: row.fullName });
    map.set(row.departmentId, list);
  }
  return map;
}

/** Роли отдельской оси словами — их перечисляют оба текста отказа и подсказка поля. */
const departmentRolesText = DEPARTMENT_SCOPED_ROLES.map((r) => `«${roleLabels[r]}»`).join(' или ');

/** Короткая подсказка под полем: в форме места на объяснение нет, оно уходит в текст ошибки. */
const departmentAxisHint = `Руководителем отдела может быть учётка роли ${departmentRolesText}`;

/**
 * Почему эту учётку нельзя назначить руководителем — причиной, а не запретом: администратор выбрал
 * живого человека из справочника, и «нельзя» без объяснения читается как поломка формы.
 *
 * Учётка без роли названа заявкой: у нерассмотренной заявки нет ни области, ни доступа, и совет ей
 * другой — сначала рассмотреть.
 */
function offAxisHeadIssue(fullName: string, role: Role | null): string {
  if (!role) {
    return `«${fullName}» — учётка без роли, то есть нерассмотренная заявка на регистрацию: отделов у неё нет вовсе. Рассмотрите заявку, назначьте роль ${departmentRolesText} и повторите`;
  }
  return `«${fullName}» работает в роли «${roleLabels[role]}», а отделы бывают только у ролей ${departmentRolesText}: набор отделов такой учётке обнуляется при каждом сохранении её карточки, и руководство ушло бы вместе с ним — от правки, которая его не касалась. Сначала переведите учётку на роль отдела`;
}

/**
 * Заменяет набор руководителей отдела со стороны справочника. Трогает только связи с признаком
 * `is_head`: в той же таблице лежат привязки сотрудников отдела, и «замена набора» из карточки
 * отдела снимала бы то, чего человек не выбирал и не мог выбрать.
 *
 * **Имя роли кандидата больше не проверяется** — это и есть развязывание (§11.1 плана). Прежний
 * отказ ««Иванов» — не руководитель отдела» выражал не правило доступа, а то, что руководство
 * хранилось ролью: признак прав не даёт, а область отдела учётке и так выдают из её карточки.
 * Сотрудник отдела (`department`) руководителем назначается наравне с `department_head`, и перевод
 * ролей в отказ сервера не упрётся. Проверка «учётка существует и не в архиве» осталась: привязать
 * несуществующего нельзя.
 *
 * **Ось области при этом проверяется, и это не возврат прежнего отказа.** Роль решает, есть ли у
 * учётки ось отдела вообще (`isDepartmentScopedRole`, `resolveDepartmentIds` в `routes/users.ts`):
 * у роли вне этой оси набор отделов обнуляется при **каждом** сохранении карточки — «объекты и
 * отделы вместе не встречаются» держится именно обнулением чужого набора. Прими мы такое
 * назначение — его отменила бы первая же правка телефона, то есть правка, руководства не
 * касавшаяся, и отменила бы молча. Отказ спрашивает ось, а не имя роли, — тем же условием сужает
 * выбор карточка отдела (`useDepartmentHeadOptions`), и правило тут одно на портал и на сервер.
 *
 * Обратный ход — перевод действующего руководителя на роль вне отдельской оси — связь тоже уносит,
 * но там это не тихо: администратор сам меняет ось, поле отделов уходит из формы вместе с ролью, а
 * в журнале учётки снятый отдел называется с пометкой «(руководитель)» (`user-audit-diff.ts`).
 *
 * **Снятие руководства удаляет связь целиком, а не гасит признак.** Так это работало до
 * развязывания — карточка отдела удаляла строку, — и цена другого выбора не косметическая:
 * оставленная связь сохранила бы человеку область видимости отдела после того, как его от
 * руководства освободили, то есть тихо расширила бы доступ шагом, который доступа не касается.
 * Кто должен остаться в отделе рядовым, задаётся из карточки учётки — там же, где задают участие.
 *
 * Возвращает учётки, у которых сменилась связь: правка карточки справочника меняет то, какие
 * заявки человек видит, и его выданные токены обязаны погаснуть так же, как при правке из карточки
 * учётки. Гасит их маршрут — сервис не ходит в сессии. Назначение руководителем того, кто уже
 * состоял в отделе, области не меняет, но в набор затронутых попадает: лишний отзыв токена дешевле
 * забытого, а связь у него всё равно изменилась.
 */
export async function replaceDepartmentHeads(
  tx: Tx,
  departmentId: string,
  userIds: string[],
  actorUserId: string,
): Promise<string[]> {
  const ids = [...new Set(userIds)];
  if (ids.length > 0) {
    const rows = await tx
      .select({ id: users.id, role: users.role, fullName: users.fullName })
      .from(users)
      .where(and(inArray(users.id, ids), sql`${users.deletedAt} IS NULL`));
    const found = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = found.get(id);
      if (!row) {
        throw err.badRequest('Учётная запись не найдена', {
          headUserIds: 'Учётная запись не найдена',
        });
      }
      if (!isDepartmentScopedRole(row.role)) {
        const issue = offAxisHeadIssue(row.fullName, row.role);
        throw err.badRequest(issue, { headUserIds: departmentAxisHint });
      }
    }
  }

  const before = await tx
    .select({ userId: userDepartments.userId })
    .from(userDepartments)
    .where(and(eq(userDepartments.departmentId, departmentId), eq(userDepartments.isHead, true)));
  const beforeIds = new Set(before.map((r) => r.userId));
  const affected = [...new Set([...beforeIds, ...ids])].filter(
    (id) => beforeIds.has(id) !== ids.includes(id),
  );
  if (affected.length === 0) return [];

  const removed = [...beforeIds].filter((id) => !ids.includes(id));
  if (removed.length > 0) {
    await tx.delete(userDepartments).where(
      and(
        eq(userDepartments.departmentId, departmentId),
        inArray(userDepartments.userId, removed),
        // Сотрудников отдела не трогаем: карточка отдела про них не спрашивала.
        eq(userDepartments.isHead, true),
      ),
    );
  }
  if (ids.length > 0) {
    await tx
      .insert(userDepartments)
      .values(ids.map((userId) => ({ userId, departmentId, isHead: true, createdBy: actorUserId })))
      // Человек уже состоял в отделе сотрудником — ставим признак, не переписывая строку: автор и
      // время привязки описывают участие, которое старше назначения, и переписать их значило бы
      // подменить историю связи, к которой карточка отдела не обращалась.
      .onConflictDoUpdate({
        target: [userDepartments.userId, userDepartments.departmentId],
        set: { isHead: true },
      });
  }
  // Область сменилась — выданные токены обязаны погаснуть. `authVersion` поднимается здесь, в той
  // же транзакции, что и привязка: access-токен сверяется с ним на каждом запросе, и отзыва одних
  // refresh-сессий не хватило бы — прежний токен жил бы до своего истечения.
  await tx
    .update(users)
    .set({ authVersion: sql`${users.authVersion} + 1`, updatedAt: new Date() })
    .where(inArray(users.id, affected));
  return affected;
}
