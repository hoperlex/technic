import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { counterparties, persons, users } from '../db/schema';
import {
  constructionObjectIdsExpr,
  departmentIdsExpr,
  departmentObjectIdsExpr,
  grantCodesExpr,
  grantPermissionsExpr,
  systemAddonsOf,
} from '../services/user-scopes';
import {
  isPermission,
  isPersonScopedRole,
  type AccessSubject,
  type CounterpartyType,
  type Permission,
  type Role,
  type RoleAddon,
} from '@technic/contracts';

/** Принципал — субъект доступа (ADR 0038): права спрашиваются у пары «роль + тип контрагента». */
export interface Principal extends AccessSubject {
  id: string;
  email: string;
  lastName: string;
  firstName: string;
  middleName: string;
  /** Считается базой из частей ФИО (ADR 0034). */
  fullName: string;
  /** Телефон учётки (ADR 0043): контакт заявителя в заявке на обслуживание подставляется из него. */
  phone: string;
  role: Role | null;
  isActive: boolean;
  mustChangePassword: boolean;
  /**
   * Объекты учётки (ADR 0039): область видимости объектной роли. Набор, а не один объект —
   * штаб ведёт несколько площадок. Пустой набор у объектной роли означает «не видит ничего»
   * (`placeObjectVisibilityWhere`), а не «видит всё»: активировать такую учётку API не даёт.
   */
  constructionObjectIds: string[];
  /**
   * Отделы учётки (ADR 0040): вторая ось области. Заполнена всегда одна из двух — отдел это
   * офис, объект это площадка, и роль работает ровно на одной из осей.
   */
  departmentIds: string[];
  /**
   * Площадки отделов учётки (ADR 0062) — производная область: в её пределах роль отдела ведёт
   * вывоз мусора наравне со штабом. Считается из справочника на каждом запросе вместе с ролью:
   * объект правится в карточке отдела, и кэшировать его в токене нельзя по той же причине, по
   * которой там не хранится роль.
   */
  departmentObjectIds: string[];
  /** Контрагент учётки (ADR 0010): у внешнего исполнителя задаёт, чьи заявки ему видны. */
  counterpartyId: string | null;
  /**
   * Человек, которому принадлежит учётка (ADR 0008). У роли `driver` это четвёртая ось области
   * (ADR 0102), самая узкая: строка кабинета видна, если она про этого человека.
   *
   * Предиката области у неё нет намеренно — она держится тем, что кабинет **не принимает
   * `personId` ни в пути, ни в теле, ни в фильтре** и берёт его отсюда: параметра, который надо
   * сверять с областью, просто нет, и разойтись проверке с ним не с чем.
   *
   * У прочих ролей связь бывает заполнена и ни на что не влияет: она справочная.
   */
  personId: string | null;
  /**
   * Тип контрагента (ADR 0038): у внешнего исполнителя определяет модуль, в котором он работает,
   * — вывоз мусора у оператора, заказ ТС у арендодателя. Читается из справочника на каждом
   * запросе вместе с ролью: смена типа контрагента меняет права учётки, и кэшировать её в токене
   * нельзя по той же причине, по которой там не хранится роль.
   */
  counterpartyType: CounterpartyType | null;
  /**
   * Коды назначаемых полномочий учётки (ADR 0106): что ей выдано. Читаются из БД на каждом запросе
   * вместе с ролью и типом контрагента — набор меняет права, и кэшировать его в токене нельзя по
   * той же причине, по которой там не хранится роль.
   *
   * Строки, а не `SystemGrantCode`: рядом с двумя системными в базе лежат наборы, собранные
   * администратором, и сузить тип значило бы соврать про содержимое.
   *
   * Отвечают на «что выдано», а не «что действует»: совместимость с ролью здесь не спрашивается
   * (`grantCodesExpr`), и держатель набора, которому сменили роль, остаётся в этом списке, прав по
   * нему не получая. Читает коды **область** — сквозная виза ИТ (`hasModuleWideScope` в
   * `lib/access.ts`); права приходят отдельным полем.
   */
  grantCodes: string[];
  /**
   * Права, которые дают учётке её наборы, — четвёртый источник субъекта доступа (`can`). Массив
   * всегда, пусть и пустой: «наборов нет» не должно отличаться в коде от «наборы есть».
   *
   * Гейт совместимости с ролью стоит в самом выражении (`grantPermissionsExpr`, соединение с
   * `grant_roles`), поэтому здесь лежит уже действующий набор прав, а не выданный.
   *
   * **Единственное место портала, где строка из базы становится `Permission`.** Право хранится
   * текстом, и выкат, снявший его из словаря, оставляет в `grant_permissions` строку-сироту: её
   * отсеивает `isPermission` при сборке принципала. Дальше по коду фильтровать нечего — тип это и
   * обещает.
   */
  grantPermissions: Permission[];
  /**
   * Надстройки роли (ADR 0086): пометки рядом с ролью в ответах API. Массив всегда, пусть и пустой.
   *
   * С шага 1c это **производное** поле — пересечение `grantCodes` с системными кодами
   * (`systemAddonsOf`), а не отдельный запрос в `user_role_addons`. Источник у прав один, и второй
   * ответ на «что учётке выдано» разошёлся бы с ним ровно в тот момент, когда таблицы разъедутся.
   *
   * Оставлено потому, что поле читают ответы API (`AuthUser.addons`, карточка и список учёток) и
   * форма правки присылает его обратно; `can` тоже по-прежнему его спрашивает — на переходных шагах
   * 1a–1d одна выдача видна и надстройкой, и набором, и оба источника отвечают на право одинаково.
   * Уходит вместе с `role-addons.ts` на шаге 1e.
   */
  addons: RoleAddon[];
  authVersion: number;
}

/**
 * Загружает актуального пользователя из БД (не доверяем роли из старого JWT).
 * Возвращает null, если пользователь удалён или деактивирован.
 */
export async function loadPrincipal(userId: string): Promise<Principal | null> {
  const [row] = await db
    .select({
      u: users,
      counterpartyType: counterparties.type,
      // Карточка человека берётся тем же запросом, а не вторым по факту роли: роль до запроса
      // неизвестна, и «сходить ещё раз, если водитель» означало бы второй круг к базе на каждом
      // запросе кабинета — самого частого клиента портала.
      personDeletedAt: persons.deletedAt,
      constructionObjectIds: constructionObjectIdsExpr,
      departmentIds: departmentIdsExpr,
      departmentObjectIds: departmentObjectIdsExpr,
      grantCodes: grantCodesExpr,
      grantPermissions: grantPermissionsExpr,
    })
    .from(users)
    .leftJoin(counterparties, eq(users.counterpartyId, counterparties.id))
    .leftJoin(persons, eq(users.personId, persons.id))
    .where(eq(users.id, userId));
  if (!row) return null;
  const u = row.u;
  if (u.deletedAt || !u.isActive) return null;
  // Уволенный водитель кабинета не открывает (ADR 0102, Р2). Увольнение закрывает карточку
  // (`persons.deleted_at`), а учётку не трогает — и без этой проверки человек смотрел бы задания
  // и телефоны заказчиков ещё две недели, пока жив выданный refresh-токен. Спрашивается на каждом
  // запросе по той же причине, по которой в токене не лежит роль: состояние меняется без нас.
  if (isPersonScopedRole(u.role) && (!u.personId || row.personDeletedAt)) return null;
  const grantCodes = row.grantCodes;
  return {
    id: u.id,
    email: u.email,
    lastName: u.lastName,
    firstName: u.firstName,
    middleName: u.middleName,
    fullName: u.fullName,
    phone: u.phone,
    role: u.role,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    constructionObjectIds: row.constructionObjectIds,
    departmentIds: row.departmentIds,
    departmentObjectIds: row.departmentObjectIds,
    counterpartyId: u.counterpartyId,
    personId: u.personId,
    counterpartyType: row.counterpartyType,
    grantCodes,
    // Граница «база → код»: право-сирота (снятое из словаря выкатом) дальше не проходит. Отказ
    // молчаливый намеренно — такой строки нет ни на одном маршруте, доступа она не даёт, и ронять
    // из-за неё каждый запрос держателя набора нельзя.
    grantPermissions: row.grantPermissions.filter(isPermission),
    addons: systemAddonsOf(grantCodes),
    authVersion: u.authVersion,
  };
}
