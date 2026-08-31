import { eq, inArray, isNotNull, isNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  actsForCounterparty,
  allowedVehicleRequestTypes,
  type ArchiveFilter,
  can,
  canOrderVehicleRequestType,
  canTransitionStatus,
  type CounterpartyType,
  hasModuleWideScope,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isPlaceScopedRole,
  isServiceRequestDeletable,
  isServiceRequestEditable,
  isWeeklyWeekOverdue,
  type Permission,
  type RequestModule,
  type RequestStatus,
  requestStatusLabels,
  roleLabels,
  roleScopeAxis,
  type ServiceExecutorsRow,
  serviceRequestStatusLabels,
  type ServiceRequestStatus,
  type VehicleRequestType,
  vehicleRequestTypeLabels,
  wasteObjectScopeIds,
  weeklyApprovalPermission,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
import { err } from './errors';

const NEVER_MATCH = '00000000-0000-0000-0000-000000000000';

/**
 * Доступ проверяется в два слоя (ADR 0021):
 *  - право — «что учётка может делать» (матрица в @technic/contracts: роль плюс тип контрагента,
 *    ADR 0038), проверяется до запроса в БД: `app.requirePermission(...)` на маршруте либо
 *    `assertCan(...)` в обработчике, если право зависит от содержимого запроса;
 *  - область — «над какими строками», проверяется по конкретной записи: штаб работает со своим
 *    объектом, внешний исполнитель — с заявками своего контрагента.
 * Здесь живёт второй слой и те проверки прав, которые нельзя сделать на маршруте.
 */

/** Право, проверяемое внутри обработчика (когда оно зависит от тела запроса или от записи). */
export function assertCan(p: Principal, permission: Permission, message?: string): void {
  if (!can(p, permission)) throw err.forbidden(message);
}

/**
 * Ограничение видимости для внешнего исполнителя (ADR 0010, 0038): в своём модуле он видит
 * строки своего контрагента, в чужом — не видит ничего.
 *
 * Ветка «чужой модуль» существует не ради отказа в правах (их и так нет — маршрут закрыт правом
 * модуля), а ради того, чтобы ограничение видимости нельзя было обойти новым правом: право и
 * область выдаются по отдельности, и «право есть, а область не написана» означает доступ ко
 * всем строкам сразу.
 */
function counterpartyVisibilityWhere(
  p: Principal,
  type: CounterpartyType,
  counterpartyColumn: AnyColumn,
): SQL | undefined {
  if (!isCounterpartyScopedRole(p.role)) return undefined;
  const own = actsForCounterparty(p, type) ? (p.counterpartyId ?? NEVER_MATCH) : NEVER_MATCH;
  return eq(counterpartyColumn, own);
}

/** Своя запись контрагента или отказ — общий разбор для проверок по конкретной строке. */
function assertCounterpartyScope(
  p: Principal,
  type: CounterpartyType,
  counterpartyId: string | null,
  message: string,
): void {
  if (!isCounterpartyScopedRole(p.role)) return;
  if (!actsForCounterparty(p, type) || counterpartyId !== p.counterpartyId)
    throw err.forbidden(message);
}

/**
 * Ограничение видимости заявок **вывоза мусора** по области учётки: объектная роль («Штаб»,
 * «Комендант», ADR 0025) видит заявки своих объектов, роль отдела — заявки площадки своего отдела
 * (ADR 0062), остальные — все.
 *
 * Имя называет модуль намеренно: у роли отдела объектная область есть только здесь, а в «Заказе
 * ТС» её заказчик — отдел (ADR 0062 п. 3). Применить эту функцию там значило бы молча отдать
 * роли отдела объектные заявки на технику; у того модуля своя — `vehicleRequestVisibilityWhere`.
 *
 * Пустая область означает «не видит ничего», а не «видит всё»: у роли отдела без площадки это
 * рабочее состояние, а у объектной роли — состояние, которого API не допускает, но выборка не
 * должна зависеть от того, удержалась ли та проверка.
 */
export function wasteRequestVisibilityWhere(
  p: Principal,
  objectIdColumn: AnyColumn,
): SQL | undefined {
  const ids = wasteObjectScopeIds(p);
  if (ids === null) return undefined;
  return ids.length > 0 ? inArray(objectIdColumn, ids) : eq(objectIdColumn, NEVER_MATCH);
}

/**
 * Видимость заявок вывоза для оператора (ADR 0010): только заявки, назначенные его контрагенту.
 * Отдельно от wasteRequestVisibilityWhere — колонка оператора есть только у «Вывоза мусора».
 */
export function operatorVisibilityWhere(p: Principal, operatorColumn: AnyColumn): SQL | undefined {
  return counterpartyVisibilityWhere(p, 'operator', operatorColumn);
}

/**
 * Видимость заявок на технику для арендодателя (ADR 0038): только заявки, на которые вышла его
 * техника. Колонка — `vehicles.lessor_id` назначенной машины, поэтому запрос обязан быть
 * соединён с назначением: своего поля исполнителя у заявки ТС нет, и роль арендодателя в заявке
 * появляется вместе с назначением машины (ADR 0027).
 *
 * Следствие, принятое сознательно: «Новую» заявку арендодатель не видит — до назначения она
 * ничья. Это и есть разница с вывозом мусора, где исполнителя можно проставить заранее.
 */
export function lessorVisibilityWhere(p: Principal, lessorColumn: AnyColumn): SQL | undefined {
  return counterpartyVisibilityWhere(p, 'vehicle_lessor', lessorColumn);
}

/**
 * Удалённая запись видна только тем, кому открыт архив; остальным её как бы нет — 404, а не
 * 403: сам факт существования удалённой заявки под известным id тоже не их дело. Проверять
 * это обязан каждый маршрут, отдающий запись по id: список удалённые скрывает, а карточка,
 * история и карточка справочника получают строку напрямую и без этой проверки отдают архив
 * любому, кто знает id.
 */
export function assertArchiveVisible(
  p: Principal,
  deletedAt: Date | string | null,
  notFoundMessage: string,
): void {
  if (deletedAt && !can(p, 'archive.read')) throw err.notFound(notFoundMessage);
}

/**
 * Условие списка по архиву (ADR 0070): что делать с удалёнными строками — скрыть, показать
 * вместе с живыми или показать только их (вкладка «Архив»).
 *
 * Право спрашивается здесь, а не на маршруте: список открыт всем, кто читает модуль, и запрещать
 * нужно не запрос, а расширение выдачи. Без `archive.read` любое значение параметра означает
 * «без архива» — не 403: подобранный в адресной строке параметр не должен ни отдавать чужое, ни
 * отвечать «такое бывает».
 */
export function archiveWhere(
  p: Principal,
  filter: ArchiveFilter,
  deletedAtColumn: AnyColumn,
): SQL | undefined {
  if (!can(p, 'archive.read')) return isNull(deletedAtColumn);
  if (filter === 'only') return isNotNull(deletedAtColumn);
  return filter === 'include' ? undefined : isNull(deletedAtColumn);
}

/**
 * Заказчик заявки на технику (ADR 0040): объект строительства **или** отдел — заполнено ровно
 * одно поле. Один тип на все проверки области в модуле, чтобы «чья это заявка» не отвечалось
 * в каждом маршруте заново.
 */
export interface RequestCustomer {
  objectId: string | null;
  departmentId: string | null;
}

/**
 * Видимость заявок на технику по области учётки (ADR 0025, ADR 0040). Ось у роли одна: объектная
 * сравнивается с объектом заявки, отдельская — с её отделом. Пустой набор означает «не видит
 * ничего», а не «видит всё»: активировать такую учётку API не даёт, но выборка не должна
 * зависеть от того, удержалась ли эта проверка.
 *
 * Отдельно от `wasteRequestVisibilityWhere`, и не только из-за колонок: роль отдела здесь
 * сравнивается со **своим отделом**, а площадка отдела (ADR 0062) в этот модуль не приходит —
 * заявку на технику отдел заводит от себя, и заказчиков у неё по-прежнему двое на выбор.
 */
export function vehicleRequestVisibilityWhere(
  p: Principal,
  objectIdColumn: AnyColumn,
  departmentIdColumn: AnyColumn,
): SQL | undefined {
  if (isObjectScopedRole(p.role)) {
    const ids = p.constructionObjectIds;
    return ids.length > 0 ? inArray(objectIdColumn, ids) : eq(objectIdColumn, NEVER_MATCH);
  }
  if (isDepartmentScopedRole(p.role)) {
    const ids = p.departmentIds;
    return ids.length > 0 ? inArray(departmentIdColumn, ids) : eq(departmentIdColumn, NEVER_MATCH);
  }
  return undefined;
}

/**
 * Может ли учётка визировать эту заявку (ADR 0025, ADR 0040): право визы плюс область —
 * руководитель строительства отвечает за свои объекты, руководитель отдела за свои отделы, и
 * чужие заявки не согласовывает ни тот, ни другой. Предикат, а не проверка с отказом: им же
 * решается, снимать ли визу при правке заявки.
 */
export function canApproveRequest(p: Principal, customer: RequestCustomer): boolean {
  if (!can(p, 'vehicleRequests.approve')) return false;
  if (isObjectScopedRole(p.role)) {
    return !!customer.objectId && p.constructionObjectIds.includes(customer.objectId);
  }
  if (isDepartmentScopedRole(p.role)) {
    return !!customer.departmentId && p.departmentIds.includes(customer.departmentId);
  }
  return true;
}

/**
 * Визируется ли заявка сразу, самим фактом заведения её автором (ADR 0025 п. 5, ADR 0032).
 *
 * Это не то же, что право визировать. Виза — ответ объекта «техника нужна и по средствам», и
 * сама собой она случается только у того, кто за объект отвечает: у руководителя строительства
 * на своём объекте. Администратор право визы сохраняет, но заводит заявку не за себя — за того,
 * кто до портала не добрался; согласование этим не состоялось, и его заявка ждёт визы наравне с
 * остальными. Иначе на вопрос «кто согласовал» портал отвечал бы именем того, кто решения не
 * принимал, — и обойти визу можно было бы просьбой завести заявку.
 */
export function approvesOwnRequestOnCreate(p: Principal, customer: RequestCustomer): boolean {
  return isPlaceScopedRole(p.role) && canApproveRequest(p, customer);
}

/**
 * Работа с конкретным объектом в модуле «Вывоз мусора»: объектная роль — только со своими
 * объектами, роль отдела — только с площадкой своего отдела (ADR 0062).
 *
 * Отказ здесь, а не в отсутствии прав: права на модуль у обеих ролей как раз есть, и без этой
 * проверки заявку заводили бы на любой объект компании. Имя называет модуль по той же причине,
 * что и у `wasteRequestVisibilityWhere`: в «Заказе ТС» область роли отдела — другая.
 */
export function assertWasteObjectScope(p: Principal, objectId: string): void {
  const ids = wasteObjectScopeIds(p);
  if (ids === null) return;
  if (ids.includes(objectId)) return;
  // Пустая область у роли отдела — рабочее состояние, а не чужой объект: площадки у отдела нет
  // вовсе. «Работает только со своими объектами» на это отвечало бы загадкой — своих ноль.
  if (isDepartmentScopedRole(p.role) && ids.length === 0) {
    throw err.forbidden(
      `${roleLabels[p.role!]} ведёт вывоз мусора только на площадке своего отдела`,
    );
  }
  throw err.forbidden(`${roleLabels[p.role!]} работает только со своими объектами`);
}

/**
 * Заявка на технику принадлежит области учётки (ADR 0040): объектная роль работает со своими
 * объектами, отдельская — со своими отделами, остальные не ограничены. Заявка чужой оси для
 * обеих ролей чужая: у заявки отдела объекта нет вовсе, и «объект не мой» здесь — не придирка,
 * а единственно верный ответ.
 */
export function assertRequestScope(p: Principal, customer: RequestCustomer): void {
  if (isObjectScopedRole(p.role)) {
    if (!customer.objectId || !p.constructionObjectIds.includes(customer.objectId)) {
      throw err.forbidden(`${roleLabels[p.role!]} работает только со своими объектами`);
    }
    return;
  }
  if (isDepartmentScopedRole(p.role)) {
    if (!customer.departmentId || !p.departmentIds.includes(customer.departmentId)) {
      throw err.forbidden(`${roleLabels[p.role!]} работает только со своими отделами`);
    }
  }
}

/**
 * Тип заявки доступен роли (ADR 0040): отдел заказывает только грузоперевозки — спецтехника
 * выходит на площадку, а площадки у отдела нет. 403, а не 422: дело не в состоянии заявки, а в
 * том, что этой учётке такой заказ не положен вовсе.
 */
export function assertVehicleRequestTypeAllowed(
  p: Principal,
  requestType: VehicleRequestType,
): void {
  if (canOrderVehicleRequestType(p, requestType)) return;
  throw err.forbidden(
    `${roleLabels[p.role!]} заказывает только: ${allowedVehicleRequestTypes(p)
      .map((t) => `«${vehicleRequestTypeLabels[t]}»`)
      .join(', ')}`,
  );
}

/**
 * Может ли учётка подтверждать смены этой заявки: круг «кто мог бы её завести» — право на
 * заведение, разрешённый тип заказа и своя область.
 *
 * Подпись под днём работы ставит заказчик: он один видит, во сколько машина вышла и сколько
 * простояла. Отдельного права для этого нет по той же причине, что и у досрочного завершения
 * (ADR 0044 п. 3) — состав ролей у существующего ровно тот, кому действие и нужно: площадка,
 * диспетчер, менеджер, администратор. Арендодателю и наблюдателю оно недоступно: первый —
 * вторая сторона в споре о часах, второй не ведёт ничего.
 *
 * Предикат, а не проверка с отказом: тем же условием портал решает, показывать ли чекбокс.
 */
export function canConfirmShifts(
  p: Principal,
  request: RequestCustomer & { requestType: VehicleRequestType },
): boolean {
  if (!can(p, 'vehicleRequests.create')) return false;
  if (!canOrderVehicleRequestType(p, request.requestType)) return false;
  if (isObjectScopedRole(p.role)) {
    return !!request.objectId && p.constructionObjectIds.includes(request.objectId);
  }
  if (isDepartmentScopedRole(p.role)) {
    return !!request.departmentId && p.departmentIds.includes(request.departmentId);
  }
  return true;
}

/**
 * Смены подтверждает тот, кто мог бы завести эту заявку (`canConfirmShifts`); остальным — 403.
 */
export function assertShiftApprover(
  p: Principal,
  request: RequestCustomer & { requestType: VehicleRequestType },
): void {
  if (canConfirmShifts(p, request)) return;
  throw err.forbidden('Смены подтверждает заказчик этой заявки');
}

/**
 * Со стороны заказчика — объекта или отдела — правят и удаляют только заявку, которую ещё не
 * взяли в работу: после «В работе» за заявкой стоят договорённости с исполнителем, и менять её
 * задним числом нельзя. Ограничение по состоянию записи, а не по действию, поэтому это область,
 * а не право. Правило одно на обе оси, отсюда `isPlaceScopedRole` (ADR 0040).
 */
export function assertObjectRoleEditable(
  p: Principal,
  status: RequestStatus,
  action: string,
): void {
  if (isPlaceScopedRole(p.role) && status !== 'new') {
    throw err.forbidden(`${roleLabels[p.role!]} может ${action} заявку только в статусе «Новая»`);
  }
}

/** Оператор вывоза работает только с заявками своего контрагента (проверка конкретной заявки). */
export function assertOperatorScope(p: Principal, operatorCounterpartyId: string | null): void {
  assertCounterpartyScope(
    p,
    'operator',
    operatorCounterpartyId,
    'Оператор работает только с заявками своего контрагента',
  );
}

/**
 * Арендодатель работает только с заявками, на которые вышла его техника (ADR 0038). Проверяется
 * арендодатель назначенной машины: у заявки без назначения его нет вовсе — такая заявка ничья, и
 * доступ к ней исполнителю закрыт.
 */
export function assertLessorScope(p: Principal, assignedLessorId: string | null): void {
  assertCounterpartyScope(
    p,
    'vehicle_lessor',
    assignedLessorId,
    'Арендодатель работает только с заявками, на которые назначена его техника',
  );
}

/**
 * Единица оргтехники со стороны области (ADR 0085): где стоит и за каким отделом числится. Оба
 * реквизита — свои колонки карточки, и «чья это техника» отвечается ими вместе, а не по очереди.
 */
export interface OfficeEquipmentPlace {
  objectId: string;
  /** `null` — не закреплена ни за кем; такую единицу справочник и открывают, чтобы разметить. */
  ownerDepartmentId: string | null;
}

/**
 * Видимость справочника оргтехники по области учётки (ADR 0085, план Р5/Р7). Оси те же две, что у
 * заявок на технику, но правило у второй другое, поэтому и функция своя, а не
 * `vehicleRequestVisibilityWhere`: общее имя обещало бы одинаковое поведение.
 *
 * Объектная роль сравнивается с объектом, на котором техника стоит: штаб отвечает за свою
 * площадку, и принтер соседней ему не виден.
 *
 * Роль отдела видит технику своих отделов **и технику без владельца**. Второе — не послабление, а
 * смысл справочника: `owner_department_id IS NULL` означает «не размечена», и спрятать такую
 * единицу от того, кто единственный может её разметить, значит закрыть разметку навсегда. На
 * область заявок это не влияет — у заявки свой заказчик (Р5).
 *
 * Пустой набор означает «не видит ничего», а не «видит всё»: у объектной роли это состояние,
 * которого API не допускает, но выборка не должна зависеть от того, удержалась ли та проверка. У
 * роли отдела пустой набор оставляет ровно неразмеченную технику — «своих» отделов у неё ноль, и
 * выдать ей весь парк компании было бы тихим расширением доступа.
 */
export function officeEquipmentScopeWhere(
  p: Principal,
  objectIdColumn: AnyColumn,
  ownerDepartmentIdColumn: AnyColumn,
): SQL | undefined {
  // Сквозная область модуля (план модернизации, Р54): согласующий от ИТ решает по всему парку
  // компании, и сузить ему справочник до своей площадки значило бы дать право, которым нельзя
  // воспользоваться. Расширение модульное — в вывозе мусора и заказе ТС он остаётся собой.
  //
  // Спрашивается по кодам наборов (ADR 0106, шаг 1c), а не по надстройкам: источник области тот же,
  // что источник прав, и расходиться им нельзя. Расширение по-прежнему кодовое свойство конкретного
  // системного набора — собрать «видеть чужой объект» в конструкторе нечем (`GRANT_MODULE_WIDE_SCOPE`
  // типизирован системными кодами).
  if (hasModuleWideScope(p.grantCodes, 'officeEquipment')) return undefined;
  if (isObjectScopedRole(p.role)) {
    const ids = p.constructionObjectIds;
    return ids.length > 0 ? inArray(objectIdColumn, ids) : eq(objectIdColumn, NEVER_MATCH);
  }
  if (isDepartmentScopedRole(p.role)) {
    const ids = p.departmentIds;
    const unassigned = isNull(ownerDepartmentIdColumn);
    return ids.length > 0 ? or(inArray(ownerDepartmentIdColumn, ids), unassigned) : unassigned;
  }
  return undefined;
}

/**
 * Конкретная единица оргтехники принадлежит области учётки (ADR 0085) — то же правило, что в
 * `officeEquipmentScopeWhere`, но по одной записи: список чужое прячет, а карточка, правка и
 * удаление получают строку по id и без этой проверки отдали бы её любому, кто знает id.
 *
 * Проверяется на обеих сторонах правки: и на нынешнем месте единицы, и на целевом — перенос на
 * чужой объект это тот же выход за область, только в другую сторону (Р7).
 */
export function assertOfficeEquipmentScope(p: Principal, place: OfficeEquipmentPlace): void {
  // Тем же источником, что в `officeEquipmentScopeWhere`: список и карточка обязаны отвечать
  // одинаково, иначе единица либо прячется от того, кому открыта, либо открывается по прямой ссылке.
  if (hasModuleWideScope(p.grantCodes, 'officeEquipment')) return;
  if (isObjectScopedRole(p.role)) {
    if (!p.constructionObjectIds.includes(place.objectId)) {
      throw err.forbidden(`${roleLabels[p.role!]} работает только со своими объектами`);
    }
    return;
  }
  if (isDepartmentScopedRole(p.role)) {
    // Техника без владельца доступна роли отдела намеренно: разметить её больше некому.
    if (place.ownerDepartmentId === null) return;
    if (!p.departmentIds.includes(place.ownerDepartmentId)) {
      throw err.forbidden(`${roleLabels[p.role!]} работает только с техникой своих отделов`);
    }
  }
}

/**
 * Заявка на обслуживание оргтехники: чья она (ADR 0085 §8).
 *
 * Область считается по **заказчику заявки**, а не по справочнику: у заявки три снимка — объект
 * техники, отдел, от имени которого её завели, и отдел-владелец единицы на момент заведения. Роль
 * отдела видит заявку, если совпал любой из двух отделов: подавший её сотрудник и отдел, за которым
 * закреплена техника, оба имеют к ней отношение.
 *
 * `NULL` в отдельских колонках означает «к отделам не относится» (заявку завёл штаб на площадочную
 * технику), а не «видна всем»: снимок разметкой справочника не догоняется, и «ничья» заявка иначе
 * осталась бы видна каждому отделу навсегда.
 */
export function serviceRequestScopeWhere(
  p: Principal,
  objectIdColumn: AnyColumn,
  customerDepartmentIdColumn: AnyColumn,
  equipmentDepartmentIdColumn: AnyColumn,
): SQL | undefined {
  // Согласующий от ИТ видит заявки всей компании (Р54): виза решает, звать ли внешний сервис, и
  // принимается она по всем площадкам разом. В соседних модулях его область прежняя. Источник —
  // коды наборов (ADR 0106, шаг 1c), как и у справочника выше.
  if (hasModuleWideScope(p.grantCodes, 'serviceRequests')) return undefined;
  if (isObjectScopedRole(p.role)) {
    const ids = p.constructionObjectIds;
    return ids.length > 0 ? inArray(objectIdColumn, ids) : eq(objectIdColumn, NEVER_MATCH);
  }
  if (isDepartmentScopedRole(p.role)) {
    const ids = p.departmentIds;
    if (ids.length === 0) return eq(customerDepartmentIdColumn, NEVER_MATCH);
    return or(inArray(customerDepartmentIdColumn, ids), inArray(equipmentDepartmentIdColumn, ids));
  }
  return undefined;
}

/**
 * Видимость заявок для сервисной компании (ADR 0038, ADR 0085): только те, что назначены её
 * контрагенту. Отсюда следствие, принятое сознательно: **«Новую» заявку сервис не видит** — до
 * назначения исполнителя в ней нет, и заявка ничья.
 */
export function serviceExecutorVisibilityWhere(
  p: Principal,
  serviceCounterpartyColumn: AnyColumn,
): SQL | undefined {
  return counterpartyVisibilityWhere(p, 'service', serviceCounterpartyColumn);
}

/** Заявка на обслуживание: то, чем определяется её принадлежность области учётки. */
export interface ServiceRequestPlace {
  objectId: string;
  customerDepartmentId: string | null;
  equipmentDepartmentId: string | null;
}

/**
 * Конкретная заявка принадлежит области учётки — то же правило, что в `serviceRequestScopeWhere`,
 * но по одной записи: список чужое прячет, а карточка, правка и ход заявки получают строку по id и
 * без этой проверки отдали бы её любому, кто знает id.
 */
export function assertServiceRequestScope(p: Principal, place: ServiceRequestPlace): void {
  // Тем же источником, что в `serviceRequestScopeWhere`, и по той же причине.
  if (hasModuleWideScope(p.grantCodes, 'serviceRequests')) return;
  if (isObjectScopedRole(p.role)) {
    if (!p.constructionObjectIds.includes(place.objectId)) {
      throw err.forbidden(`${roleLabels[p.role!]} работает только со своими объектами`);
    }
    return;
  }
  if (isDepartmentScopedRole(p.role)) {
    const own = (id: string | null): boolean => !!id && p.departmentIds.includes(id);
    if (!own(place.customerDepartmentId) && !own(place.equipmentDepartmentId)) {
      throw err.forbidden(`${roleLabels[p.role!]} работает только с заявками своих отделов`);
    }
  }
}

/**
 * Видна ли заявка учётке **со стороны заказчика** — ролью отдела или ролью площадки (ADR 0141,
 * §3.1). Ответ уходит фактом `inCustomerScope` в `ServiceChatFacts`, а по нему считается аудитория
 * адресата «Заявителю»: она шире автора намеренно — чтобы вопрос не завис, пока автор в отпуске.
 *
 * Источник тот же, что у `serviceRequestScopeWhere` и `assertServiceRequestScope`: те же две оси
 * (`isObjectScopedRole` / `isDepartmentScopedRole`) и те же наборы областей принципала. Своё
 * правило рядом с ними разошлось бы молча — подсветка «Заявителю» загоралась бы у одних, а сама
 * заявка была бы видна другим.
 *
 * **Сквозной области здесь нет, и это не забытая ветка.** `hasModuleWideScope` открывает согласующему
 * от ИТ заявки всей компании (Р54), но открывает их **набором**, а не отделом и не площадкой: он
 * видит заявку не потому, что она его. Считай мы такую видимость стороной заказчика, ИТ-служба
 * получала бы яркую метку на каждую реплику «Заявителю» по всей компании — то есть бейдж, который
 * невозможно погасить работой, и ровно у той стороны, у которой есть собственный адресат.
 *
 * Область сервисной компании (`serviceExecutorVisibilityWhere`) сюда тоже не входит: подрядчик — это
 * сторона `service`, и совпадать со стороной заказчика он не должен ни при каком назначении.
 */
export function inServiceRequestCustomerScope(p: Principal, place: ServiceRequestPlace): boolean {
  if (isObjectScopedRole(p.role)) return p.constructionObjectIds.includes(place.objectId);
  if (isDepartmentScopedRole(p.role)) {
    const own = (id: string | null): boolean => !!id && p.departmentIds.includes(id);
    return own(place.customerDepartmentId) || own(place.equipmentDepartmentId);
  }
  return false;
}

/**
 * То же правило предикатом выборки — для счётчика непрочитанного, который не может перебрать заявки
 * поштучно (ADR 0141, §3.5): он считает их сразу по всей области субъекта.
 *
 * Две записи одного правила — цена того, что одна отвечает по строке, а другая внутри SQL; держатся
 * они рядом и читаются вместе. Расхождение между ними означало бы, что бейдж считает не то, что
 * подсвечивает карточка.
 */
export function serviceRequestCustomerScopeWhere(
  p: Principal,
  objectIdColumn: AnyColumn,
  customerDepartmentIdColumn: AnyColumn,
  equipmentDepartmentIdColumn: AnyColumn,
): SQL {
  if (isObjectScopedRole(p.role)) {
    const ids = p.constructionObjectIds;
    return ids.length > 0 ? inArray(objectIdColumn, ids) : sql`false`;
  }
  if (isDepartmentScopedRole(p.role)) {
    const ids = p.departmentIds;
    if (ids.length === 0) return sql`false`;
    return or(inArray(customerDepartmentIdColumn, ids), inArray(equipmentDepartmentIdColumn, ids))!;
  }
  return sql`false`;
}

/**
 * Со стороны заказчика правят заявку, которую ещё никому не отдали: после назначения за ней стоят
 * договорённости с исполнителем, и менять её предмет задним числом нельзя. Правило то же, что в
 * двух действующих модулях (`assertObjectRoleEditable`), а решает его предикат контрактов
 * (`isServiceRequestEditable`) — одним ответом на сервер и портал.
 *
 * **Спрашивается СТРОКА, а не статус** (план упрощения цикла, Р14). Пока назначение было переходом
 * в «Назначенную», «ещё не отдали» и «статус `new`» совпадали, и хватало одного статуса. После
 * слияния статус потерял вторую службу: «Новой» зовётся и заявка с назначенным исполнителем, — и
 * условие, оставленное на статусе, молча открыло бы правку там, где исполнитель заявку уже прочитал
 * и по ней договорился. Молча — потому что ошибка не падает, а расширяет доступ.
 *
 * Состав исполнителей приходит **параметром**, а не вычисляется здесь: поимённые строки лежат в
 * `service_request_executors`, эта функция синхронна и в базу не ходит, а обработчик заявку и так
 * читает. Догадываться о составе по статусу — ровно та ошибка, ради которой сигнатура и менялась.
 */
export function assertServiceRequestEditable(
  p: Principal,
  row: ServiceExecutorsRow & { status: ServiceRequestStatus },
  action: string,
): void {
  if (isPlaceScopedRole(p.role) && !isServiceRequestEditable(row)) {
    throw err.forbidden(
      `${roleLabels[p.role!]} может ${action} заявку только до назначения сервиса`,
    );
  }
}

/**
 * Удаление заявки площадочной ролью — **своё** правило, а не «то же, что правка» (В20 плана
 * переработки цикла). Удалять можно и заявку с назначенным исполнителем: работа по ней не
 * начиналась, исполнителя ей просто назначили, — а править её уже нельзя, предмет заявки
 * исполнитель прочитал и по нему договорился.
 *
 * Поэтому **статуса здесь достаточно, а строка не передаётся**, и это проверено, а не совпало
 * (Р14): удаляли «Новую» и «Назначенную» — то есть заявку до того, как за неё взялись, — оба
 * состояния после слияния зовутся «Новой», и один `new` покрывает ровно тот же набор заявок, что
 * покрывала прежняя пара. Разница с правкой ровно в этом: правке нужен ещё и состав исполнителей,
 * удалению — нет.
 *
 * Отдельной функцией, потому что условие у этих двух решений разное и живёт оно в контрактах
 * (`isServiceRequestDeletable`): переиспользуй мы `assertServiceRequestEditable`, два разных
 * решения заказчика держались бы на одном перечне и разъехались бы на первой же правке любого из
 * них.
 */
export function assertServiceRequestDeletable(p: Principal, status: ServiceRequestStatus): void {
  if (isPlaceScopedRole(p.role) && !isServiceRequestDeletable(status)) {
    throw err.forbidden(
      `${roleLabels[p.role!]} удаляет заявку, пока по ней не начали работать — «${serviceRequestStatusLabels[status]}» уже дальше`,
    );
  }
}

// ── Недельная заявка на технику (ADR 0085) ──
//
// Область пишется парой «право + ось» (план реформы §11), а не перечислением ролей по именам.
// Причина не в красоте: имя роли переживает саму роль. Слияние площадочных ролей в одну (§15,
// этапы 7–9) оставит условие `role === 'shtab' || role === 'rukstroy'` синтаксически целым, а по
// смыслу пустым — и модуль молча закроется перед теми, кто его ведёт.
//
// Пара читается так: право отвечает «положено ли вообще» — у коменданта недельных прав нет, и
// объектная ось модуля ему не открывает; ось отвечает «над какими площадками». Ось у роли одна
// (`roleScopeAxis`), и спрашивается она тем же классификатором, что барьер выдачи наборов
// (`GRANT_SCOPE_MATRIX`) и витрина: второй разбор ролей по спискам разошёлся бы с первым — и
// разошёлся бы в сторону «оси не нашли, значит ограничений нет».
//
// Ветка «оси нет — все площадки» безопасна ровно потому, что право спрошено первым: у диспетчера и
// менеджера площадок нет, и неделю они ведут везде; водитель и внешний исполнитель до этой ветки не
// доходят — у них своя ось, и по ней ответ «ни одной». Последняя ветка модуля — «не видит ничего»,
// а не «видит всё»: ради неё область и считается отдельно от `vehicleRequestVisibilityWhere`.

/**
 * Область **чтения** недельной заявки — описанием, а не готовым SQL, и вот почему: у одной из
 * ветвей условие выражается не колонкой заявки, а её составом (арендодатель), то есть требует
 * таблиц и подзапроса. Здесь живёт решение о доступе, в `services/weekly-request-access.ts` — его
 * перевод в SQL; один и тот же перевод обслуживает и ленту списка, и проверку доступа к карточке,
 * поэтому разойтись им нечем.
 *
 * Чтение шире ведения (`WEEKLY_REQUEST_PERMISSIONS`): документ переехал в общий список «Заказ
 * автотехники» и объясняет продления заказов, которые эти субъекты и так видят. Поэтому правом в
 * паре стоит `weeklyRequests.read`, а не право ведения: у наблюдателя, обеих ролей отдела и
 * арендодателя есть только оно, а видеть неделю они должны.
 */
export type WeeklyRequestReadScope =
  /** Все площадки: офис ведёт неделю везде, наблюдатель (ADR 0033) её везде читает. */
  | { kind: 'all' }
  /** Свои площадки объектной роли (ADR 0039) и площадки отдела учётки (ADR 0062). */
  | { kind: 'objects'; objectIds: readonly string[] }
  /** Заявки, в составе которых стоит техника этого арендодателя (ADR 0038). */
  | { kind: 'lessor'; counterpartyId: string }
  /** Ни одной: права нет либо ось им не выражается — модуль субъекту закрыт. */
  | { kind: 'none' };

export function weeklyRequestReadScope(p: Principal): WeeklyRequestReadScope {
  // Право спрашивается здесь, а не только на маршруте: недельные строки живут в общем списке
  // «Заказ автотехники», и у того, кому недели не положены, они обязаны исчезнуть из выдачи — а не
  // закрыть ему весь список. Учётка без роли отсекается тем же вопросом: прав у неё нет ни одного.
  if (!can(p, 'weeklyRequests.read')) return { kind: 'none' };
  switch (roleScopeAxis(p.role)) {
    case 'object':
      return { kind: 'objects', objectIds: p.constructionObjectIds };
    // У отдела своей объектной оси нет, а площадка есть — производной областью из справочника
    // (`departmentObjectIds`, ADR 0062). Считать её здесь подзапросом по `departments` незачем:
    // принципал приносит её готовой на каждом запросе, тем же способом, каким её читает вывоз мусора.
    case 'department':
      return { kind: 'objects', objectIds: p.departmentObjectIds };
    // Единственный фактор видимости арендодателя — его техника в составе; площадка ему не
    // принадлежит ни в каком смысле, и по объекту его область не выражается вовсе. Исполнитель
    // другого предмета и арендодатель без контрагента не видят ни одной недели: «контрагент не
    // назван» — это не «ограничений нет».
    case 'counterparty':
      return actsForCounterparty(p, 'vehicle_lessor') && p.counterpartyId
        ? { kind: 'lessor', counterpartyId: p.counterpartyId }
        : { kind: 'none' };
    // Ось человека (ADR 0102) недельным документом не выражается: неделя принадлежит площадке, а не
    // работнику. Ветка стоит затем, чтобы право, попавшее к водителю, открыло ему пустоту, а не
    // недели всей компании.
    case 'person':
      return { kind: 'none' };
    case 'none':
      return { kind: 'all' };
  }
}

/**
 * Видит ли субъект **весь** состав недельной заявки. Ложь означает не «меньше прав», а другой
 * вопрос: арендодателю документ открывают его же строки, и показывать рядом с ними чужие заказы,
 * машины и сроки — значит отдать ему парк площадки. Тем же ответом закрывается `payload` истории:
 * события несут размер состава и номера заказов отдельно от строк.
 */
export function seesWholeWeeklyRequest(p: Principal): boolean {
  return weeklyRequestReadScope(p).kind !== 'lessor';
}

/**
 * Ведёт ли учётка неделю этой площадки **по области** — вторая половина пары. Право спрашивается
 * рядом и у каждого действия своё: ведение — стражем маршрута, виза — `canApproveWeeklyRequest`.
 *
 * Оси, кроме объектной, недельным документом не выражаются, и ответ у них «ни одной», а не «без
 * ограничений»: неделю собирает площадка, а у отдела своей площадки в этом модуле нет (ADR 0062 п. 3
 * — заказчиком там выступает сам отдел), у арендодателя и водителя её нет вовсе. Этим модуль и
 * отличается от `assertRequestScope`, где роль без площадочной оси не ограничена ничем.
 */
function managesWeeklyRequestObject(p: Principal, objectId: string): boolean {
  // Учётка без роли прав не имеет вовсе, и «своей оси нет» у неё означает не «все площадки», а «ни
  // одной»: досюда она доходит, только если проверка права на маршруте не удержалась.
  if (!p.role) return false;
  switch (roleScopeAxis(p.role)) {
    case 'object':
      return p.constructionObjectIds.includes(objectId);
    case 'none':
      return true;
    case 'department':
    case 'counterparty':
    case 'person':
      return false;
  }
}

/**
 * Неделя заявки глазами проверок доступа: ею решается, каким правом эта неделя визируется
 * (`weeklyApprovalPermission`). Пара, а не одна дата: «просрочена» — это отношение недели к
 * сегодняшнему дню, и второй источник «сегодня» внутри предиката разошёлся бы с тем, по которому
 * маршрут уже посчитал всё остальное.
 */
export interface WeeklyRequestWeek {
  weekStart: string;
  /** Сегодня по МСК (`moscowDateKeyOf`) — тем же поясом границы считает портал. */
  today: string;
}

/**
 * Может ли учётка визировать недельную заявку этой площадки: право визы плюс область — то же
 * правило, что у заявок ТС (`canApproveRequest`). Предикат, а не проверка с отказом: им же
 * решается, применяется ли заявка сразу при подаче.
 *
 * Право зависит от самой недели, и это единственное, чем виза просроченной отличается от обычной:
 * у будущей спрашивается `weeklyRequests.approve`, у начавшейся или прошедшей — право прошлого
 * (`weeklyApprovalPermission`, ADR 0101). Выбор живёт в контрактах, потому что тем же выбором
 * портал решает, показывать ли кнопку.
 *
 * Неделя необязательна намеренно: вопрос «ведёт ли эта учётка визу недельных заявок вообще»
 * задают и без конкретного документа (витрина доступа, сверка области), и ответом на него остаётся
 * прежнее правило будущей недели.
 */
export function canApproveWeeklyRequest(
  p: Principal,
  objectId: string,
  week?: WeeklyRequestWeek,
): boolean {
  const permission = week
    ? weeklyApprovalPermission(week.weekStart, week.today)
    : 'weeklyRequests.approve';
  return can(p, permission) && managesWeeklyRequestObject(p, objectId);
}

/**
 * Применяется ли заявка сразу, самой подачей (план Р8) — как `approvesOwnRequestOnCreate` у
 * заявок ТС (ADR 0032).
 *
 * Условие — объектная ось, а не право визы: подписью площадки виза становится только у того, кто за
 * площадку отвечает. Администратор право визы сохраняет, но действует не за объект, и «кто
 * согласовал неделю» отвечалось бы именем того, кто решения не принимал. Виза недельной заявки к
 * тому же необратима — она той же транзакцией двигает сроки.
 *
 * Просроченная неделя подачей не применяется никогда, кому бы ни принадлежала. Проведение такой
 * недели требует причины, ключа операции и записи в журнал коррекций (ADR 0101), а тело подачи их
 * не несёт и нести не должно: заведение и подача о прошлом ничего не утверждают. Ответ здесь
 * `false` — и заявка спокойно доходит до визы, где всё это спрашивается явно.
 */
export function approvesOwnWeeklyRequest(
  p: Principal,
  objectId: string,
  week?: WeeklyRequestWeek,
): boolean {
  if (week && isWeeklyWeekOverdue(week.weekStart, week.today)) return false;
  return isObjectScopedRole(p.role) && canApproveWeeklyRequest(p, objectId, week);
}

/**
 * Недельная заявка принадлежит области учётки (план §10). Право проверено маршрутом — у каждого
 * действия своё (`create`, `update`, `approve`), — поэтому здесь остаётся ровно область.
 *
 * Отдельно от `assertRequestScope`: там роль без объектной и отдельской оси не ограничена вовсе, и
 * применить его здесь значило бы открыть модуль тому, у кого площадки нет, — стоит появиться праву.
 */
export function assertWeeklyRequestScope(p: Principal, objectId: string): void {
  if (managesWeeklyRequestObject(p, objectId)) return;
  if (isObjectScopedRole(p.role)) {
    throw err.forbidden(`${roleLabels[p.role!]} работает только со своими объектами`);
  }
  // Отказ называет роль, а не перечисляет тех, кому модуль открыт: перечень пришлось бы править
  // при каждом слиянии ролей, а «эта учётка неделю не ведёт» верно при любом их составе.
  throw err.forbidden(
    p.role ? `${roleLabels[p.role]} не ведёт недельные заявки` : 'Недельные заявки ведёт площадка',
  );
}

/**
 * Переход статуса заявки с учётом прав. Модуль обязателен: с ADR 0135 коридоры «Вывоза мусора» и
 * «Заказа ТС» разошлись — у вывоза за «Выполнена» идёт «Завершена», у техники «Выполнена»
 * терминальна. Откат закрытой заявки — право администратора, поэтому 403, а не 400: переход
 * существует, но не для этой учётки.
 */
export function assertTransitionAllowed(
  p: Principal,
  from: RequestStatus,
  to: RequestStatus,
  module: RequestModule,
): void {
  if (canTransitionStatus(from, to, p, module)) return;
  // Учётка без роли до сюда не доходит — её отсекает право на маршруте. Но объяснять отказ
  // разбором переходов ей нечем: у неё нет ни одного, и «только администратор» было бы ложью.
  if (!p.role) throw err.forbidden('Недостаточно прав для смены статуса');
  // Завершение отпирает разбор талонов, а не ведение цикла (ADR 0135), и отказ называет именно
  // его: у того, кто ведёт статусы, но бумагу не разбирает, коридор здесь кончается — и «переход
  // недопустим» соврало бы, будто такого хода нет вовсе.
  if (to === 'completed' && module === 'waste') {
    throw err.forbidden(
      `Заявку завершает тот, кто разбирает талоны, — «${requestStatusLabels.completed}» ставится после разбора бумаги`,
    );
  }
  // У внешнего исполнителя коридор один, поэтому «недопустимый переход» ему ничего не объясняет.
  if (isCounterpartyScopedRole(p.role)) {
    throw err.forbidden(
      `${roleLabels[p.role]} может только отметить заявку «${requestStatusLabels.confirmed}» выполненной`,
    );
  }
  if (canTransitionStatus(from, to, { role: 'admin' }, module)) {
    // Отказ называет **право**, а не роль. Прежний текст говорил «может только администратор», и
    // это перестало быть правдой дважды: сперва откат получил диспетчер, а с ADR 0106 право
    // приезжает ещё и назначенным набором — то есть кому угодно, кому его выдали. Роль в таком
    // сообщении устаревает молча и объясняет отказ неверно тому, кто как раз собирается право
    // получить.
    throw err.forbidden(
      'Возврат заявки в предыдущий статус — отдельное право, и у этой учётки его нет',
    );
  }
  throw err.badRequest(
    `Недопустимый переход статуса: «${requestStatusLabels[from]}» → «${requestStatusLabels[to]}»`,
  );
}
