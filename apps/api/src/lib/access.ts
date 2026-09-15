import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import {
  actsAsRequestCustomer,
  actsAsServiceExecutorOnly,
  actsForCounterparty,
  allowedVehicleRequestTypes,
  type ArchiveFilter,
  can,
  canActOnServiceRequest,
  canChangeRequestAsCustomer,
  canOrderVehicleRequestType,
  canPickAnyServiceSubject,
  canTransitionStatus,
  type CounterpartyType,
  hasGrantCode,
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
  OFFICE_EQUIPMENT_OPERATOR_GRANT,
  serviceRequestStatusLabels,
  type ServiceRequestStatus,
  type VehicleRequestType,
  vehicleRequestTypeLabels,
  placeObjectScopeIds,
  weeklyApprovalPermission,
} from '@technic/contracts';
import type { Principal } from '../auth/principal';
/*
 * Схема — единственная связь этого модуля с базой, и она только описательная: таблица и её колонки
 * подставляются в `sql`-выражение третьей оси. Клиент БД (`db/client`) сюда не приезжает намеренно —
 * предикаты области проверяются юнит-тестами без соединения, а импорт клиента поднимал бы пул
 * в каждом таком прогоне.
 */
import {
  officeEquipmentCandidates,
  serviceRequestExecutors,
  serviceRequestPastExecutors,
  serviceRequests,
  vehicleRequests,
  waybillRequests,
  waybills,
} from '../db/schema';
import { err, type AppError } from './errors';
import { serviceDenied } from './service-access-denied';

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

/**
 * Своя запись контрагента или отказ — общий разбор для проверок по конкретной строке.
 *
 * ОТКАЗ СОБИРАЕТ ВЫЗЫВАЮЩИЙ, а не эта функция: разбор один на три модуля (вывоз, заказ ТС,
 * обслуживание), а помечен причиной и адресом заявки должен быть только отказ модуля обслуживания
 * (Р6 плана аудита исполнителей) — соседям такое событие не заведено, и писать его за них значило
 * бы завести аудит, которого никто не просил. Умолчание оставляет соседей ровно такими, какими они
 * были.
 */
function assertCounterpartyScope(
  p: Principal,
  type: CounterpartyType,
  counterpartyId: string | null,
  message: string,
  deny: (message: string) => AppError = err.forbidden,
): void {
  if (!isCounterpartyScopedRole(p.role)) return;
  if (!actsForCounterparty(p, type) || counterpartyId !== p.counterpartyId) throw deny(message);
}

/**
 * Ограничение видимости по **площадке записи**: объектная роль («Штаб», «Комендант», ADR 0025)
 * видит записи своих объектов, роль отдела — записи площадок своего отдела (ADR 0062, набором —
 * ADR 0144), остальные — все.
 *
 * Имя называет **ось, а не модуль**: так работают «Вывоз мусора» и «Механизация», у которых
 * площадка есть у каждой записи. В «Заказе ТС» иначе — там заказчиком бывает сам отдел
 * (ADR 0062 п. 3), и применить эту функцию значило бы молча отдать роли отдела объектные заявки
 * на технику; у того модуля своя — `vehicleRequestVisibilityWhere`.
 *
 * Пустая область означает «не видит ничего», а не «видит всё»: у роли отдела без площадки это
 * рабочее состояние, а у объектной роли — состояние, которого API не допускает, но выборка не
 * должна зависеть от того, удержалась ли та проверка.
 */
export function placeObjectVisibilityWhere(
  p: Principal,
  objectIdColumn: AnyColumn,
): SQL | undefined {
  const ids = placeObjectScopeIds(p);
  if (ids === null) return undefined;
  return ids.length > 0 ? inArray(objectIdColumn, ids) : eq(objectIdColumn, NEVER_MATCH);
}

/**
 * Видимость заявок вывоза для оператора (ADR 0010): только заявки, назначенные его контрагенту.
 * Отдельно от placeObjectVisibilityWhere — колонка оператора есть только у «Вывоза мусора».
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
 * Отдельно от `placeObjectVisibilityWhere`, и не только из-за колонок: роль отдела здесь
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
 * Работа с конкретной площадкой: объектная роль — только со своими объектами, роль отдела — только
 * с площадками своего отдела (ADR 0062, набором — ADR 0144).
 *
 * Отказ здесь, а не в отсутствии прав: права на модуль у обеих ролей как раз есть, и без этой
 * проверки заявку заводили бы на любой объект компании.
 *
 * `moduleLabel` — **подпись модуля в сообщении об отказе**, а не украшение. Сообщение о доступе
 * это разговор с человеком, и «ведёт вывоз мусора» говорит ему, куда именно он не попал; общее
 * «работает только со своими площадками» отвечало бы вопросом на вопрос. Параметром, а не зашитой
 * строкой, потому что спрашивающих модулей стало двое.
 */
/**
 * Подписи модулей для `assertPlaceObjectScope`. Здесь, а не в каждом маршруте: текст отказа один на
 * модуль, и разъехавшиеся формулировки читались бы как разные правила.
 */
export const WASTE_SCOPE_LABEL = 'вывоз мусора';
export const MECH_SCOPE_LABEL = 'механизацию';

export function assertPlaceObjectScope(p: Principal, objectId: string, moduleLabel: string): void {
  const ids = placeObjectScopeIds(p);
  if (ids === null) return;
  if (ids.includes(objectId)) return;
  // Пустая область у роли отдела — рабочее состояние, а не чужой объект: площадки у отдела нет
  // вовсе. «Работает только со своими объектами» на это отвечало бы загадкой — своих ноль.
  if (isDepartmentScopedRole(p.role) && ids.length === 0) {
    throw err.forbidden(
      `${roleLabels[p.role!]} ведёт ${moduleLabel} только на площадке своего отдела`,
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
 * ПЛОЩАДКА единицы оргтехники — своя ли она учётке (план
 * `docs/office-equipment-request-subject-plan.md`, Р2).
 *
 * Это НЕ `assertOfficeEquipmentScope`, срезанный до объекта, и путать их нельзя. Тот отвечает «чья
 * это карточка» и у роли отдела спрашивает ВЛАДЕЛЬЦА; здесь вопрос другой — «стоит ли аппарат там,
 * где работает эта учётка», и отдельская ось отвечает на него площадками своих отделов
 * (`departmentObjectIds`, ADR 0062), ровно как при сообщении о технике (`resolveCandidateObject`).
 *
 * Ради чего заведён отдельный ответ. У роли отдела аппарат сплошь и рядом чужой ТОЛЬКО по
 * владельцу, стоя при этом на своей площадке: карточка вне области, а объект — тот самый. Одним
 * `officeEquipmentScopeWhere` этот случай неотличим от «чужая площадка», и форма заявки включала бы
 * поправку объекта там, где поправлять нечего.
 *
 * Не бросает, а отвечает: признак уезжает в выдачу к каждой строке, и «нет» здесь — не отказ, а
 * содержание плашки. Отказом это условие не становится нигде — дверь заявки сторожит свой разбор.
 *
 * Сквозная область модуля (ADR 0106, шаг 1c) и роли без осей отвечают «своя»: у первых парк открыт
 * целиком, у вторых объектной оси нет вовсе, и «чужая площадка» им нечем предъявить.
 */
export function officeEquipmentObjectInOwnScope(p: Principal, objectId: string): boolean {
  if (hasModuleWideScope(p.grantCodes, 'officeEquipment')) return true;
  if (isObjectScopedRole(p.role)) return p.constructionObjectIds.includes(objectId);
  if (isDepartmentScopedRole(p.role)) return p.departmentObjectIds.includes(objectId);
  return true;
}

/**
 * Заявка на обслуживание оргтехники: чья она **со стороны заказчика** (ADR 0085 §8).
 *
 * Область считается по **заказчику заявки**, а не по справочнику: у заявки три снимка — объект
 * техники, отдел, от имени которого её завели, и отдел-владелец единицы на момент заведения. Роль
 * отдела видит заявку, если совпал любой из двух отделов: подавший её сотрудник и отдел, за которым
 * закреплена техника, оба имеют к ней отношение.
 *
 * `NULL` в отдельских колонках означает «к отделам не относится» (заявку завёл штаб на площадочную
 * технику), а не «видна всем»: снимок разметкой справочника не догоняется, и «ничья» заявка иначе
 * осталась бы видна каждому отделу навсегда.
 *
 * **Это ОДНА ось из трёх, и в запрос она не ставится напрямую нигде** (план аудита исполнителей,
 * Р2): видимость заявки целиком собирает `serviceRequestVisibilityWhere` ниже, и он же —
 * единственный читатель этой функции.
 *
 * НЕ ЭКСПОРТИРУЕТСЯ, как и вторая ось. Пока имя было видно снаружи, запрос собирали из осей вручную
 * в шести местах, и две сборки вышли неполными: карточка единицы и её история держали одну ось —
 * заказчика, — а недостающую подпирали внешним фактом «сервисной компании закрыт справочник
 * оргтехники» (находка Н4). Такое правило верно, пока верно СОСЕДНЕЕ; закрытый экспорт делает
 * «собрать оси врозь» невозможным, а не «не принятым». Проверки по одной строке — `assertServiceRequestScope`
 * ниже (заведение заявки, у которой строки ещё нет) и `assertServiceRequestVisible` (всё остальное).
 */
function serviceRequestScopeWhere(
  p: Principal,
  objectIdColumn: AnyColumn,
  customerDepartmentIdColumn: AnyColumn,
  equipmentDepartmentIdColumn: AnyColumn,
): SQL | undefined {
  // Согласующий от ИТ видит заявки всей компании (Р54): виза решает, звать ли внешний сервис, и
  // принимается она по всем площадкам разом. В соседних модулях его область прежняя. Источник —
  // коды наборов (ADR 0106, шаг 1c), как и у справочника выше.
  //
  // ЧИТАЕТСЯ КАРТА ТОЛЬКО ПРИ ВЫКЛЮЧЕННОМ РУБИЛЬНИКЕ (план свободного объёма работ, Р3): развилка
  // включённого ключа зовёт `serviceRequestRoleAxisWhere` напрямую, минуя эту строку. Это и есть
  // главное свойство выпуска A — при включённом ключе поведение уже равно тому, каким оно станет
  // после уборки карты в выпуске B, и разойтись им негде.
  if (hasModuleWideScope(p.grantCodes, 'serviceRequests')) return undefined;
  return serviceRequestRoleAxisWhere(
    p,
    objectIdColumn,
    customerDepartmentIdColumn,
    equipmentDepartmentIdColumn,
  );
}

/**
 * Ось **роли** заявки — без сквозной карты модуля: объектная роль видит свои площадки, роль отдела
 * — свои отделы, роль без оси не сужается ничем.
 *
 * Выделена из `serviceRequestScopeWhere` ради развилки Р3: при включённом рубильнике карта области
 * не спрашивается вовсе, а ось роли нужна двум веткам развилки — «Ведению» и всем остальным.
 * Скопируй мы три строки в развилку вместо вызова, у модуля появилось бы второе описание того, чем
 * заявка принадлежит роли, — ровно та ошибка, которую убирала находка Н4 плана аудита исполнителей.
 */
function serviceRequestRoleAxisWhere(
  p: Principal,
  objectIdColumn: AnyColumn,
  customerDepartmentIdColumn: AnyColumn,
  equipmentDepartmentIdColumn: AnyColumn,
): SQL | undefined {
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
 *
 * НЕ ЭКСПОРТИРУЕТСЯ (Р2), как и ось заказчика выше. Ось подрядчика — половина правила, и половиной
 * она не спрашивается нигде: единственный её читатель — `serviceRequestVisibilityWhere`.
 */
function serviceExecutorVisibilityWhere(
  p: Principal,
  serviceCounterpartyColumn: AnyColumn,
): SQL | undefined {
  return counterpartyVisibilityWhere(p, 'service', serviceCounterpartyColumn);
}

/**
 * Область сервисной компании по одной записи: она работает только с назначенными ей заявками
 * (ADR 0038). Пара к `serviceExecutorVisibilityWhere` и, как она, приватная: список чужое прячет, а
 * карточка и ход заявки получают запись по id — и без этой проверки отдали бы её любому
 * исполнителю, который знает id.
 *
 * Приехала из `routes/service-requests.ts` вместе с решением Р2: жить рядом со второй половиной
 * правила ей полезнее, чем рядом с обработчиками, — обе половины теперь читаются вместе и
 * спрашиваются одной парой.
 */
function assertServiceExecutorScope(
  p: Principal,
  serviceCounterpartyId: string | null,
  entityId?: string,
): void {
  assertCounterpartyScope(
    p,
    'service',
    serviceCounterpartyId,
    'Сервисная компания работает только с назначенными ей заявками',
    // Отказ помечен причиной и заявкой — по нему хук модуля пишет `serviceRequest.access_denied`
    // (Р6). Текст и код ответа те же: `ServiceAccessDenied` — наследник `AppError` с тем же 403.
    (message) => serviceDenied.scope(message, entityId),
  );
}

/**
 * Третья ось видимости: **субъект назван поимённо в `service_request_executors` этой заявки**
 * (план аудита исполнителей, Р1).
 *
 * ЗАЧЕМ ОНА ВООБЩЕ. До неё право «выполнять работу» и область «какие строки видно» были одним и тем
 * же: `serviceRequests.execute` приезжал единственным набором, у которого сквозная область модуля, —
 * и исполнитель видел либо все заявки компании, либо (если набор разделить) ни одной, включая
 * собственные назначенные. Назначить сисадмина площадки на заявку соседнего объекта было можно:
 * строка вставлялась, письмо-задание уходило, в карточке он числился исполнителем — и получал 403
 * на свою же заявку (Н1.2). Ось разводит понятия: право отвечает «положено ли чинить», назначение —
 * «эту ли заявку», и одно больше не подменяет другое.
 *
 * СПРАШИВАЕТСЯ ТОЛЬКО У НОСИТЕЛЯ `execute`, и это половина инварианта И1, а не оптимизация: строка
 * назначения переживает отзыв набора (она историческая, и стирать её нельзя — по ней написана
 * переписка и подписаны бумаги), поэтому одна строка без права означала бы, что переведённый
 * сисадмин продолжает видеть заявку тем же токеном. Право читается из БД на каждом запросе
 * (`loadPrincipal`), так что отзыв закрывает ось следующим же запросом.
 *
 * СЫРЫМ `sql`, А НЕ `exists(db.select(...))`: этому модулю клиент БД не нужен ни для чего другого, а
 * тянуть сюда `db/client` значило бы поднимать пул соединений в каждом юнит-тесте предикатов.
 * Форма та же, что у соседнего счётчика непрочитанного (`addressedToMeSql`), и она же лечит ловушку
 * перезаписи списка столбцов: внутрь `sql`-объекта переписывание drizzle не заходит
 * (`office-equipment-sql-correlation.test.ts`).
 */
export function serviceRequestNamedExecutorWhere(
  p: Principal,
  idColumn: AnyColumn = serviceRequests.id,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${serviceRequestExecutors}
     WHERE ${serviceRequestExecutors.requestId} = ${idColumn}
       AND ${serviceRequestExecutors.userId} = ${p.id}
  )`;
}

/**
 * **След снятия: субъект вёл эту заявку раньше** — третье слагаемое области чтения
 * исполнительского профиля (план свободного объёма работ, Р5; ответ В6 заказчика от 09.09.2026 —
 * «заявки, с которых его сняли»).
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ТАБЛИЦА, А НЕ ФЛАГ В `service_request_executors`. Живое назначение читают 65 раз
 * в восьми файлах — письма, чат, аудитория, файлы, DTO, предикаты, очередь «Ждут меня», — и мягкое
 * снятие означало бы, что каждое из этих мест обязано помнить про `removed_at IS NULL`. Забытый
 * фильтр в любом из них — это снятый исполнитель, которому продолжают приходить задания.
 *
 * ЧИТАЕТСЯ ТОЛЬКО ОБЛАСТЬЮ ЧТЕНИЯ, и это половина решения Р7: бывший исполнитель заявку видит и
 * читает переписку, но не действует. В `assertServiceRequestActionable` следа нет и быть не должно
 * — приедь он туда, «смотреть» и «распоряжаться» снова слились бы в один вопрос.
 *
 * СЫРЫМ `sql` и с тем же обоснованием, что у соседа выше: клиент БД в этот модуль не тянут, а
 * внутрь `sql`-объекта переписывание списка столбцов у drizzle не заходит. Запрос закрывается
 * индексом `service_request_past_executors_user_idx` (`user_id, request_id`) без обращения к
 * таблице.
 *
 * ПРАВА ЗДЕСЬ НЕ СПРАШИВАЮТСЯ, в отличие от живого назначения. У живой строки гейт по
 * `serviceRequests.execute` держит инвариант И1: переведённый сисадмин не должен видеть заявку
 * тем же токеном. У следа этот довод не работает в обе стороны — держатель одного ИТ-набора
 * `execute` не имеет вовсе (Н2), а заявки, с которых его сняли, ответ В6 обещает ему прямо. Само
 * слагаемое при этом живёт ТОЛЬКО внутри развилки Р3, то есть спрашивается лишь у того, кто в
 * модуле исполнитель и никто больше.
 */
export function serviceRequestPastExecutorWhere(
  p: Principal,
  idColumn: AnyColumn = serviceRequests.id,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${serviceRequestPastExecutors}
     WHERE ${serviceRequestPastExecutors.requestId} = ${idColumn}
       AND ${serviceRequestPastExecutors.userId} = ${p.id}
  )`;
}

/**
 * Колонки заявки, по которым считается видимость. Значение по умолчанию — сама таблица модуля:
 * все сегодняшние читатели спрашивают её напрямую, и заставлять каждого перечислять пять колонок
 * значило бы вернуть ровно тот способ, которым правило и размножилось (Н4) — с перепутанной
 * колонкой, которую компилятор не поймает: у drizzle все они `AnyColumn`.
 *
 * Параметр всё же есть: заявка бывает нужна под псевдонимом (соединение таблицы с самой собой,
 * подзапрос-производная), и без него такому запросу пришлось бы завести шестую копию правила.
 */
export interface ServiceRequestVisibilityColumns {
  id: AnyColumn;
  objectId: AnyColumn;
  customerDepartmentId: AnyColumn;
  equipmentDepartmentId: AnyColumn;
  serviceCounterpartyId: AnyColumn;
  /**
   * Автор заявки (`created_by`) — вторая ось области исполнительского профиля (Р3, ответ В6:
   * «заявки, заведённые им самим»). Обязательная, а не необязательная: у псевдонима она есть
   * всегда, а забытая означала бы, что сисадмин перестал видеть собственную заявку ровно в той
   * витрине, где о колонке не вспомнили. Индекс под ось завела миграция 0299.
   */
  createdBy: AnyColumn;
}

const SERVICE_REQUEST_COLUMNS: ServiceRequestVisibilityColumns = {
  id: serviceRequests.id,
  objectId: serviceRequests.equipmentObjectId,
  customerDepartmentId: serviceRequests.customerDepartmentId,
  equipmentDepartmentId: serviceRequests.equipmentDepartmentId,
  serviceCounterpartyId: serviceRequests.serviceCounterpartyId,
  createdBy: serviceRequests.createdBy,
};

/**
 * **Видимость заявки на обслуживание — весь ответ целиком** (план аудита исполнителей, Р2): заказчик
 * ∨ подрядчик ∨ поимённое назначение. Одна функция на список, счётчики, витрины, файлового стража и
 * журнал расходников — до неё каждый из них собирал условие сам, и две сборки из пяти вышли
 * неполными (Н4): открой кому-нибудь `officeEquipment.read`, и история ремонтов единицы отдала бы
 * заявки всех подрядчиков без единой ошибки в логе.
 *
 * ПОЧЕМУ ПЕРВЫЕ ДВЕ ОСИ СОЕДИНЕНЫ ЧЕРЕЗ `and`, А ТРЕТЬЯ ЧЕРЕЗ `or`. Первые две — сужения, и каждая
 * молчит там, где не про неё: у роли площадки ось подрядчика `undefined`, у оператора подрядчика —
 * ось заказчика. Соедини их `or`, и «молчание» одной оси открыло бы всё второй. Третья ось устроена
 * наоборот: она не сужает, а ДОБАВЛЯЕТ строки, которых по роли не видно, — назначенную заявку
 * соседнего объекта.
 *
 * ПУСТОЕ УСЛОВИЕ ОСТАЁТСЯ ПУСТЫМ. `undefined` от первых двух осей означает «сужать нечем» — сквозная
 * область набора, администратор, роль без оси, — и приписать к нему третью нельзя: `or(undefined, x)`
 * в drizzle равен `x`, то есть попытка расширить выдачу молча сузила бы её до одних назначенных.
 * Ветка выглядит лишней ровно до первого держателя сквозной области, у которого пропал бы список.
 */
export function serviceRequestVisibilityWhere(
  p: Principal,
  cols: ServiceRequestVisibilityColumns = SERVICE_REQUEST_COLUMNS,
): SQL | undefined {
  // Рубильник спрашивается ПЕРВЫМ и целиком заменяет правило, а не дополняет его (Р3, Р4). При
  // выключенном ключе ниже идёт сегодняшний ответ до единого условия — включая сквозную область
  // ИТ-набора: откат волны — это `UPDATE` одной строки, а не обратный выкат.
  if (p.serviceRequestExecutorScopeEnabled) {
    return executorScopeVisibilityWhere(p, cols);
  }
  const byRole = and(
    serviceRequestScopeWhere(
      p,
      cols.objectId,
      cols.customerDepartmentId,
      cols.equipmentDepartmentId,
    ),
    serviceExecutorVisibilityWhere(p, cols.serviceCounterpartyId),
  );
  if (byRole === undefined) return undefined;
  if (!can(p, 'serviceRequests.execute')) return byRole;
  return or(byRole, serviceRequestNamedExecutorWhere(p, cols.id))!;
}

/**
 * **Область при включённом рубильнике — развилка из четырёх веток** (план свободного объёма работ,
 * Р3, редакция 5).
 *
 * ```
 * admin                      → всё
 * держатель «Ведения»        → прежняя область его роли, без executor/past-расширения
 * actsAsServiceExecutorOnly  → назначен ∨ автор ∨ след снятия
 * остальные                  → как сегодня
 * ```
 *
 * КАРТА СКВОЗНОЙ ОБЛАСТИ (`hasModuleWideScope(…, 'serviceRequests')`) ЗДЕСЬ НЕ ЧИТАЕТСЯ ВОВСЕ, и
 * ради этого развилка написана целиком, а не как поправка к прежнему ответу. Свойство, которое она
 * обязана держать: при включённом ключе выпуск A отвечает ровно так же, как ответит выпуск B — тот,
 * что уберёт `serviceRequests` из обеих карт области. Оставь мы карту прочитанной хоть одной
 * веткой, выпуски разошлись бы на профиле **«ИТ + Ведение»**: в A он видел бы компанию по ещё живой
 * карте, а в B — область роли «Ведения», и parity-тест на обычном сисадмине этого не поймал бы.
 *
 * РАЗВИЛКА, А НЕ ДОБАВКА. Ветка исполнителя ЗАМЕНЯЕТ ось роли, а не сужает её: соединённая через
 * `and`, она вернула бы «своя площадка И назначенные», то есть отобрала бы у сисадмина ровно те
 * заявки соседних объектов, ради которых его и назначают. А `or` с осью роли, наоборот, вернул бы
 * ему всю свою площадку — то есть чужие заявки, которых ответ В3 ему не обещает.
 *
 * ВЕТКА «ВЕДЕНИЯ» ОТЛИЧАЕТСЯ ОТ «ОСТАЛЬНЫХ» ровно одним — у неё нет расширения назначением. Так это
 * записано в таблице Р3 («область «Ведения» — роль плюс её ось»): координатор модуля работает своей
 * площадкой и своим отделом, и назначение на чужую заявку области ему не расширяет. На сегодняшнем
 * каталоге это ни у кого ничего не отнимает — `serviceRequests.execute` набор «Ведения» не несёт
 * (§3.1 плана), и расширение у него не срабатывало и так, — но записано оно правилом, а не выводом
 * о составе каталога, который завтра поменяет миграция.
 */
function executorScopeVisibilityWhere(
  p: Principal,
  cols: ServiceRequestVisibilityColumns,
): SQL | undefined {
  // 1. Администратор. Ветка явная, хотя сегодня она совпала бы с «остальными»: ролей без оси
  //    предикат не сужает ничем. Н1 плана говорит, почему она обязана быть названной — право
  //    `serviceRequests.execute` у `admin` есть по построению, и любое правило «по праву» отобрало
  //    бы у него все заявки портала.
  if (p.role === 'admin') return undefined;

  const byRole = and(
    // Карта не спрашивается: ось роли берётся напрямую (см. заголовок).
    serviceRequestRoleAxisWhere(
      p,
      cols.objectId,
      cols.customerDepartmentId,
      cols.equipmentDepartmentId,
    ),
    serviceExecutorVisibilityWhere(p, cols.serviceCounterpartyId),
  );

  /*
   * 2. «Ведение» модуля — прежняя область его роли ПЛЮС ОСЬ АВТОРСТВА, без расширения назначением.
   *
   * ОСЬ АВТОРСТВА ЗДЕСЬ — ЧИНЕНИЕ НАХОДКИ Д2, а не добавка «на всякий случай». Профиль «ИТ +
   * Ведение» заводит заявку по всему парку: рубеж заведения пропускает его областью ПАРКА (Р9, В5 —
   * парк виден целиком), а область чтения вела его этой веткой, где оси авторства не было вовсе.
   * Итог — 201 на заведение и 403 на карточку той же заявки: человек отправил её на чужую площадку
   * и тут же перестал видеть, причём искать её было бы некому. Комментарий самого рубежа заведения
   * обещает обратное дословно: «Разойдись они однажды — человек отправил бы заявку и не увидел её в
   * списке».
   *
   * ПРАВИЛО, А НЕ ЗАПЛАТКА: **автор видит свою заявку всегда**. Заведение в этом модуле ШИРЕ чтения
   * по решению заказчика — область предмета (парк) и область ленты разведены намеренно, — и всякий
   * раз, когда первая шире второй, «завёл и не вижу» получается неизбежно. Ось авторства и есть то
   * место, которое эту разницу закрывает; у исполнительского профиля (ветка 3) она стоит по тому же
   * основанию, только пришла туда ответом В6.
   *
   * ПУСТОЕ УСЛОВИЕ ОСТАЁТСЯ ПУСТЫМ. `byRole === undefined` означает «сужать нечем» (роль без оси), и
   * `or(undefined, автор)` в drizzle равен одному автору — то есть попытка РАСШИРИТЬ область молча
   * сузила бы её до собственных заявок. Ветка выглядит лишней ровно до первого такого субъекта.
   */
  if (hasGrantCode(p, OFFICE_EQUIPMENT_OPERATOR_GRANT)) {
    return byRole === undefined ? undefined : or(byRole, eq(cols.createdBy, p.id))!;
  }

  // 3. Исполнительский профиль: назначен ∨ автор ∨ след снятия. Три слагаемых через `or`, потому
  //    что каждое ДОБАВЛЯЕТ заявки, которых по остальным не видно, — и ни одно не сужает.
  if (actsAsServiceExecutorOnly(p)) {
    return or(
      serviceRequestNamedExecutorWhere(p, cols.id),
      eq(cols.createdBy, p.id),
      serviceRequestPastExecutorWhere(p, cols.id),
    )!;
  }

  // 4. Остальные — сегодняшний ответ: две сужающие оси и расширение поимённым назначением. Пустое
  //    условие остаётся пустым по той же причине, что и в выключенной ветке: `or(undefined, x)` в
  //    drizzle равен `x`, то есть попытка расширить выдачу молча сузила бы её до одних назначенных.
  if (byRole === undefined) return undefined;
  if (!can(p, 'serviceRequests.execute')) return byRole;
  return or(byRole, serviceRequestNamedExecutorWhere(p, cols.id))!;
}

/** Заявка на обслуживание: то, чем определяется её принадлежность области учётки. */
export interface ServiceRequestPlace {
  /**
   * Площадка предмета. `null` — заявка без аппарата, заведённая ОТ ОТДЕЛА (Р6, Р8 плана
   * `office-equipment-consumables-and-purchase-plan.md`): места у неё нет ни откуда, и её область
   * считается отделом-заказчиком.
   *
   * Предикат выборки (`serviceRequestScopeWhere`) от этого не меняется — `IN (...)` по колонке
   * `NULL` и так не выбирает, — а вот проверки по ОДНОЙ строке ниже обязаны сказать это вслух:
   * `includes(null)` отвечает «нет» случайно, а не по правилу, и первая же правка сравнения
   * превратила бы случайность в дыру.
   */
  objectId: string | null;
  customerDepartmentId: string | null;
  equipmentDepartmentId: string | null;
}

/**
 * **Второй рубеж ЗАВЕДЕНИЯ заявки: попадёт ли получившаяся строка к самому автору** — ось роли,
 * снятая областью ПАРКА.
 *
 * Единственный её читатель — `POST /` (три разбора предмета в `routes/service-requests.ts`): строки
 * ещё нет, и область спрашивается по её ПРЕДМЕТУ — площадка единицы и отдел-заказчик; ни подрядчика,
 * ни назначения там не существует, и приписать их было бы нечему. Существующую строку проверяет
 * `assertServiceRequestVisible`, и правило у него теперь СВОЁ (см. тело обеих функций и находку Д1):
 * заведение и чтение отвечают на разные вопросы и опираются на разные карты.
 */
export function assertServiceRequestScope(
  p: Principal,
  place: ServiceRequestPlace,
  /**
   * Заявка, о которой идёт речь, — только ради журнала отказов (Р6). Отдельным параметром, а не
   * полем `place`: `place` — это ПРЕДМЕТ заявки, по которому считается область, и при заведении
   * строки ещё нет вовсе. Пустое значение поэтому не забывчивость вызывающего, а «заявки нет», и
   * такой отказ хук в журнал не пишет.
   */
  entityId?: string,
): void {
  /*
   * ОСНОВАНИЕ — ОБЛАСТЬ ПАРКА, А НЕ КАРТА ЛЕНТЫ ЗАЯВОК (план свободного объёма работ, Р9; находка
   * Д1 db-прогона).
   *
   * ЧТО ЛОВИЛА НАХОДКА. Три разбора предмета в `routes/service-requests.ts` перевели на
   * `canPickAnyServiceSubject` ещё выпуском A, а этот ВТОРОЙ РУБЕЖ — тот, что стоит поверх них и
   * спрашивает «попала ли получившаяся заявка к самому автору», — остался на карте заявок. Разницы
   * не было, пока оба ключа стоят у одного набора; но parity-тест Т21 снимает `serviceRequests` из
   * карты (имитируя выпуск B) — и заведение по аппарату чужой площадки, подбор заказчика заявки без
   * аппарата, площадка сообщения о технике и перенос аппарата отвечали 403 «работает только со
   * своими объектами» вместо 201. То есть выпуск, объявленный уборкой строки, менял продуктовые
   * правила ЗАВЕДЕНИЯ — ровно то, ради чего Р9 и написан. Первый рубеж пропускал, второй отбивал:
   * два рубежа одного правила разъехались основанием.
   *
   * ПОЧЕМУ ИМЕННО ПАРК. Заведение спрашивает про ПРЕДМЕТ будущей записи — площадку аппарата,
   * отдел-заказчика, площадку сообщения о технике, — то есть про справочник, из которого заявку
   * собирают, а не про ленту, где её потом ищут. Парк остаётся видимым целиком (ответ В5), и «вижу
   * аппарат, а завести по нему заявку не могу» — поломка сценария, а не сужение видимости заявок.
   *
   * ЭТА ФУНКЦИЯ — ТОЛЬКО ДЛЯ ЗАВЕДЕНИЯ, и это условие правки. Путь ЧТЕНИЯ
   * (`assertServiceRequestVisible`, выключенный рубильник) карту заявок спрашивает сам и напрямую:
   * подставь мы туда этот рубеж, выключенный ключ перестал бы означать сегодняшнее поведение — а он
   * обязан означать его буквально.
   */
  if (canPickAnyServiceSubject(p)) return;
  assertServiceRequestRoleAxis(p, place, entityId);
}

/**
 * Ось роли по одной строке — пара к `serviceRequestRoleAxisWhere` и выделена из соседа выше по той
 * же причине: развилка включённого рубильника (Р3) обязана обойтись без карты сквозной области, а
 * ось роли нужна двум её веткам. Отказы бросает она же — у площадочной роли и у роли отдела тексты
 * разные, и общий сказал бы человеку меньше, чем говорит сегодня.
 */
function assertServiceRequestRoleAxis(
  p: Principal,
  place: ServiceRequestPlace,
  entityId?: string,
): void {
  if (isObjectScopedRole(p.role)) {
    // Пустая площадка для объектной роли — ОТКАЗ, а не пропуск (Р6): заявка «от отдела» без
    // аппарата к её площадкам не относится никак, и «нет площадки» не значит «ничья, можно всем».
    if (place.objectId === null || !p.constructionObjectIds.includes(place.objectId)) {
      throw serviceDenied.scope(
        `${roleLabels[p.role!]} работает только со своими объектами`,
        entityId,
      );
    }
    return;
  }
  if (isDepartmentScopedRole(p.role)) {
    const own = (id: string | null): boolean => !!id && p.departmentIds.includes(id);
    if (!own(place.customerDepartmentId) && !own(place.equipmentDepartmentId)) {
      throw serviceDenied.scope(
        `${roleLabels[p.role!]} работает только с заявками своих отделов`,
        entityId,
      );
    }
  }
}

/** Существующая строка заявки в объёме, которым решается её видимость. */
export interface ServiceRequestVisibilityPlace extends ServiceRequestPlace {
  /**
   * Адрес самой строки. К правилу видимости он не относится ничем — и стоит здесь ровно потому, что
   * речь о СУЩЕСТВУЮЩЕЙ заявке: отказ по ней обязан попасть в журнал с её id (Р6), а брать id из
   * адреса запроса значило бы записывать в журнал не то, о чём судил страж, а то, что было в URL.
   */
  id: string;
  /** Кому заявка отдана: `null` — ничья, и подрядчик её не видит ни один (ADR 0085). */
  serviceCounterpartyId: string | null;
  /**
   * Кто завёл заявку — вторая ось области исполнительского профиля (Р3, ответ В6). Читается только
   * развилкой включённого рубильника; на выключенном ключе поле лежит здесь без единого читателя, и
   * это правильнее, чем необязательное: строку заявки собирает один вызывающий, и «забыл передать»
   * означало бы, что сисадмин потерял собственную заявку в тот день, когда рубильник включат.
   */
  createdBy: string;
}

/**
 * Факты назначения, которых по строке заявки не узнать: обе живут в отдельных таблицах, а этот
 * модуль в базу не ходит (его предикаты проверяются юнит-тестами без соединения).
 *
 * ФУНКЦИЯМИ, А НЕ ЗНАЧЕНИЯМИ, — чтобы поход стоил только тем, кому он нужен: на выключенном
 * рубильнике до `wasNamedExecutor` не доходит никто вовсе, а `isNamedExecutor` спрашивают лишь
 * носители `serviceRequests.execute` да исполнительский профиль. Вызывающий обязан их
 * ЗАПОМИНАТЬ — область чтения и область действий спрашивают одно и то же назначение, и без памяти
 * общий вход изменяющих ручек сходил бы за строкой дважды.
 */
export interface ServiceRequestExecutorFacts {
  /**
   * Есть ли ДЕЙСТВУЮЩАЯ строка в `service_request_executors` — без гейта по праву. Гейт ставит сама
   * область: у прежнего правила он есть (И1), у развилки Р3 его нет (Н2), и одно значение обязано
   * отвечать обоим — иначе «назначен» означало бы разное в двух соседних строках.
   */
  isNamedExecutor: () => Promise<boolean>;
  /**
   * Есть ли след снятия (`service_request_past_executors`). Спрашивается ТОЛЬКО областью чтения и
   * только внутри развилки Р3 — область действий о следе не знает намеренно (Р7).
   */
  wasNamedExecutor: () => Promise<boolean>;
}

/**
 * **Видна ли субъекту ЭТА заявка — весь ответ целиком**, вторая половина пары Р2: то же правило,
 * что в `serviceRequestVisibilityWhere`, но по одной строке. Список чужое прячет, а карточка,
 * история, переписка и всякий ход получают строку по id — и без этой проверки отдали бы её любому,
 * кто id знает (И4).
 *
 * ТРЕТЬЯ ОСЬ СПРАШИВАЕТСЯ ПЕРВОЙ, и порядок здесь смысловой, а не случайный: назначение расширяет
 * видимость, а две оси роли её сужают, и сужение обязано разбираться уже после того, как расширение
 * не сработало. Иначе назначенный на соседний объект получал бы отказ от первой же сужающей
 * проверки — то есть ровно находку Н1.2, ради которой ось и заведена.
 *
 * ФАКТ НАЗНАЧЕНИЯ ПРИХОДИТ ФУНКЦИЕЙ, А НЕ ЗНАЧЕНИЕМ. Он живёт в базе, а этот модуль в базу не ходит
 * (и не должен: его предикаты проверяются юнит-тестами без соединения). Функция, а не готовое
 * булево, — чтобы поход стоил только тем, кому он нужен: у кого нет `serviceRequests.execute`,
 * `&&` до неё не доходит вовсе, а это все заказчики, наблюдатели и операторы подрядчиков.
 *
 * ЦЕНА, ПРИНЯТАЯ СОЗНАТЕЛЬНО: у носителя `execute` строка спрашивается даже тогда, когда заявка ему
 * и так видна по роли. Сэкономить этот поход можно было бы, лишь записав «видна ли по роли» вторым,
 * булевым способом рядом с бросающими проверками, — то есть завести ещё одну копию правила ровно
 * там, где план их убирает. Запрос индексный (`service_request_executors_user_idx`) и один на ручку.
 *
 * ОТКАЗ БРОСАЮТ САМИ ОСИ, а не эта функция: у площадочной роли, роли отдела и подрядчика тексты
 * разные, и общий («Заявка недоступна») сказал бы человеку меньше, чем говорит сегодня.
 */
export async function assertServiceRequestVisible(
  p: Principal,
  place: ServiceRequestVisibilityPlace,
  facts: ServiceRequestExecutorFacts,
): Promise<void> {
  // Рубильник — первым вопросом, ровно как в предикате выборки: при включённом ключе ниже стоит
  // сегодняшний ответ целиком, а развилка Р3 живёт отдельной функцией (Р4).
  if (p.serviceRequestExecutorScopeEnabled) {
    await assertVisibleUnderExecutorScope(p, place, facts);
    return;
  }
  // ГЕЙТ ПО ПРАВУ ПЕРЕЕХАЛ СЮДА ИЗ ВЫЗЫВАЮЩЕГО и стал видимой половиной правила (И1): строка
  // назначения переживает отзыв набора, и «назначен» без действующего `serviceRequests.execute`
  // означал бы, что переведённый сисадмин продолжает видеть заявку тем же токеном. У развилки Р3
  // гейта нет, и это не забывчивость — см. `serviceRequestPastExecutorWhere` и Н2 плана.
  if (can(p, 'serviceRequests.execute') && (await facts.isNamedExecutor())) return;
  /*
   * Карта ЛЕНТЫ ЗАЯВОК спрашивается здесь прямо, а не через `assertServiceRequestScope` (находка Д1):
   * у того рубежа основание с выпуска A другое — область ПАРКА, — и он отвечает про ЗАВЕДЕНИЕ. Эта
   * же ветка обязана отвечать про ЧТЕНИЕ ровно так, как отвечала до волны: выключенный рубильник
   * означает сегодняшнее поведение буквально, включая сквозную область ИТ-набора. Пара к ней —
   * `serviceRequestScopeWhere`, где те же две строки стоят в том же порядке.
   */
  if (!hasModuleWideScope(p.grantCodes, 'serviceRequests')) {
    assertServiceRequestRoleAxis(p, place, place.id);
  }
  assertServiceExecutorScope(p, place.serviceCounterpartyId, place.id);
}

/**
 * Та же развилка из четырёх веток, что в `executorScopeVisibilityWhere`, но по одной строке. Две
 * записи одного правила — цена того, что одна отвечает внутри SQL, а другая по записи; держатся они
 * рядом и читаются вместе, а разойдись — карточка отдавала бы то, чего нет в списке.
 *
 * ПОРЯДОК ВНУТРИ ВЕТКИ ИСПОЛНИТЕЛЯ — ОТ ДЕШЁВОГО К ДОРОГОМУ, и он же смысловой: авторство лежит в
 * самой строке заявки, назначение и след — по походу в базу каждый. След спрашивается последним
 * намеренно: он редкий, а стоит столько же, сколько назначение.
 */
async function assertVisibleUnderExecutorScope(
  p: Principal,
  place: ServiceRequestVisibilityPlace,
  facts: ServiceRequestExecutorFacts,
): Promise<void> {
  // 1. Администратор — см. Н1: право `execute` у него по построению, и «по праву» отобрало бы у
  //    него все заявки портала.
  if (p.role === 'admin') return;
  const runsModule = hasGrantCode(p, OFFICE_EQUIPMENT_OPERATOR_GRANT);
  // 3. Исполнительский профиль: назначен ∨ автор ∨ след снятия — и больше ничего. Ветка стоит до
  //    сужающих осей по той же причине, по которой третья ось стояла первой в прежнем правиле: это
  //    ЗАМЕНА области, и, спроси мы ось роли раньше, назначенный на соседний объект получил бы
  //    отказ от неё, не дойдя до собственного назначения.
  if (actsAsServiceExecutorOnly(p)) {
    if (place.createdBy === p.id) return;
    if (await facts.isNamedExecutor()) return;
    if (await facts.wasNamedExecutor()) return;
    throw serviceDenied.scope(
      'Исполнитель работает со своими заявками: назначенными, заведёнными им самим и теми, с которых его сняли',
      place.id,
    );
  }
  // 2. «Ведение» модуля: ось авторства — вторая половина его области (находка Д2, довод целиком у
  //    той же ветки в `executorScopeVisibilityWhere`). Заведение в модуле шире чтения, и без этой
  //    строки профиль «ИТ + Ведение» заводил бы заявку на чужой площадке и тут же терял её.
  if (runsModule && place.createdBy === p.id) return;
  // 4. Остальные — сегодняшнее расширение назначением. 2. «Ведение» его не получает (таблица Р3),
  //    поэтому условие спрашивает `runsModule`: у него область — роль, её ось и авторство.
  if (!runsModule && can(p, 'serviceRequests.execute') && (await facts.isNamedExecutor())) return;
  /*
   * 2 и 4 — общий хвост: сужающие оси без карты сквозной области.
   *
   * ВЕТКЕ 4 ОСЬ АВТОРСТВА НЕ НУЖНА, И ЭТО ПРОВЕРЕНО, А НЕ ЗАБЫТО. У субъекта без наборов модуля
   * рубеж заведения (`assertServiceRequestScope`) спрашивает ту же ось роли, что и этот хвост:
   * `canPickAnyServiceSubject` отвечает ему «нет», и завести заявку мимо своей площадки или своего
   * отдела он не может вовсе — значит и потерять её не может. Приписать авторство «для симметрии»
   * значило бы РАСШИРИТЬ область: заявка, заведённая за сотрудника чужого отдела, стала бы видна
   * автору вопреки правилу, которого никто не менял.
   */
  assertServiceRequestRoleAxis(p, place, place.id);
  assertServiceExecutorScope(p, place.serviceCounterpartyId, place.id);
}

/**
 * **Область действий** — вторая из двух областей, разведённых решением Р7 (ответ В11 заказчика от
 * 09.09.2026: бывший исполнитель «смотрит и пишет в чат», и больше ничего).
 *
 * ЗАЧЕМ ВТОРАЯ ОБЛАСТЬ. «Видимость — это чтение» в модуле неверно: `assertScope` стоит не только на
 * карточке, но и внутри `requireEditable` — общего входа ВСЕХ изменяющих ручек. Расширь мы одну
 * лишь видимость следом снятия, и бывший исполнитель вместе с чтением получил бы назначение,
 * заморозку, отмену, объём работ и подшивку документов: дальше по коду его спрашивают о праве и
 * статусе, но не об отношении к заявке.
 *
 * СЛЕДА СНЯТИЯ ЗДЕСЬ НЕТ, И ЭТО ГЛАВНОЕ ЕЁ СВОЙСТВО: он расширяет чтение и только чтение. Приедь
 * он сюда четвёртым фактом, две области снова слились бы в одну.
 *
 * СУЖАЕТ ОНА РОВНО ОДНУ КАТЕГОРИЮ — исполнительский профиль (`actsAsServiceExecutorOnly` внутри
 * предиката). Вторая ветка предиката («все остальные — `true`») обязательна, и первые редакции
 * плана её теряли: правило «назначен ∨ автор», поставленное на общий вход без развилки, отобрало бы
 * правку у обычного коллеги с ролью площадки, который правит заявку своей площадки, автором не
 * будучи. Это была бы переделка всей модели действий под видом сужения одного профиля.
 *
 * НАЗНАЧЕННОГО ИСПОЛНИТЕЛЯ ОНА НЕ ТРОГАЕТ — и это условие связности, а не следствие: под
 * `requireEditable` живёт подшивка документов, а сисадмина штатно назначают на заявки чужих
 * площадок (ради этого у профиля второй набор). Действующее назначение открывает ветку сразу, и акт
 * по чужой площадке он подшивает ровно как сегодня.
 *
 * РЕШАЕТ КОНТРАКТ (`canActOnServiceRequest`), А ЗДЕСЬ — ТОЛЬКО ПРИЗНАКИ: тем же предикатом портал
 * считает доступность своих кнопок, и второе правило на сервере развело бы кнопку и ручку молча.
 *
 * ОТКАЗ — `side`, А НЕ `scope`, и разница не косметическая: заявка субъекту ВИДНА и достигнута
 * законно — следом снятия либо авторством, — а вот действие в ней принадлежит тому, кто её ведёт
 * сейчас. Тем же кодом отвечают оба стража стороны заказчика рядом.
 */
export async function assertServiceRequestActionable(
  p: Principal,
  row: ServiceRequestAuthorPlace,
  /**
   * Действующее поимённое назначение — функцией, а не значением, по той же причине, что и у
   * области чтения: этот модуль в базу не ходит, а поход обязан стоить только тому, кому он нужен.
   */
  isNamedExecutor: () => Promise<boolean>,
): Promise<void> {
  /*
   * ФИЛЬТР СТОИМОСТИ, А НЕ КОПИЯ ПРАВИЛА. Строка назначения спрашивается только у того, у кого
   * предикат вообще станет её смотреть, — то есть при включённом рубильнике и у исполнительского
   * профиля. Обе проверки читаются по одному субъекту, в базу не ходят и стоят ноль, а решение всё
   * равно принимает контракт ниже: убери фильтр — ответ не изменится ни на одном субъекте, изменится
   * только число запросов. Условие поэтому обязано ехать вместе с первыми двумя ветками предиката:
   * научись он спрашивать назначение у кого-то ещё — сюда приедет та же строка.
   */
  const asksAssignment = p.serviceRequestExecutorScopeEnabled && actsAsServiceExecutorOnly(p);
  const allowed = canActOnServiceRequest(p, {
    executorScopeEnabled: p.serviceRequestExecutorScopeEnabled,
    isAuthor: row.createdBy === p.id,
    isNamedExecutor: asksAssignment ? await isNamedExecutor() : false,
  });
  if (allowed) return;
  throw serviceDenied.side(
    'Заявка видна, но действует по ней тот, кто её ведёт сейчас, — назначенный исполнитель либо её автор',
    row.id,
  );
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
  // Пустая площадка — «не моя» (Р6), тем же правилом, что и у проверки выше: стороной заказчика
  // роль площадки становится по совпадению площадок, а совпадать с отсутствующей нечему.
  if (isObjectScopedRole(p.role)) {
    return place.objectId !== null && p.constructionObjectIds.includes(place.objectId);
  }
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

/** Строка заявки в объёме, которым решается сторона ЗАКАЗЧИКА: место плюс автор плюс адрес. */
export interface ServiceRequestAuthorPlace extends ServiceRequestPlace {
  /** Адрес строки — ради журнала отказов (Р6): страж судил о ней, её и надо записать. */
  id: string;
  /** Кто завёл заявку (`created_by`). */
  createdBy: string;
}

/**
 * **Страж стороны заказчика на изменяющих ручках** (план профилей оргтехники, Р6; план карточки
 * заявителя, §13): держатель набора «Заявитель» без своей оси меняет только те строки, которые
 * завёл сам.
 *
 * ЗАЧЕМ. У `manager` и `dispatcher` оси области нет, и `serviceRequestVisibilityWhere` им ничего не
 * сужает — заявки компании видны им целиком, и это действующая модель, а не дыра: чтение так
 * работает у всякой роли без оси. Дырой это становится ровно в момент, когда такой роли выдают
 * набор модуля: «видит все» превратилось бы в «правит и удаляет любую чужую „Новую“ и подшивает к
 * ней бумаги». Набор заводится ради своей заявки — им и ограничен.
 *
 * ПРАВИЛО ЖИВЁТ В КОНТРАКТАХ (`actsAsRequestCustomer`), А ЗДЕСЬ — ТОЛЬКО ПРИЗНАКИ. Ровно как у
 * остальных предикатов действий модуля: сервер считает по строке то, чего в субъекте нет
 * (авторство и попадание в область заказчика), а решает контракт — он же отвечает порталу. Своё
 * условие здесь развело бы кнопку и ручку молча.
 *
 * `inCustomerScope` спрашивается тем же `inServiceRequestCustomerScope`, что и подсветка адресата
 * «Заявителю»: у роли без оси он всегда ложен, но списывать это в константу нельзя — тогда правило
 * перестанет работать само в тот день, когда роль получит ось.
 *
 * ОТКАЗ — `side`, А НЕ `scope`, и разница не косметическая (`service-access-denied.ts`): заявка
 * субъекту ВИДНА и достигнута законно, а вот действие в ней принадлежит её автору. Хук журнала
 * пишет по этой причине событие `serviceRequest.access_denied` с адресом заявки — попытка править
 * чужую строку обязана оставлять след.
 */
export function assertActsAsRequestCustomer(p: Principal, row: ServiceRequestAuthorPlace): void {
  const allowed = actsAsRequestCustomer(p, {
    isAuthor: row.createdBy === p.id,
    inCustomerScope: inServiceRequestCustomerScope(p, row),
  });
  if (allowed) return;
  throw serviceDenied.side(
    `${roleLabels[p.role!]} по набору «Заявитель» ведёт только заявки, которые завёл сам`,
    row.id,
  );
}

/**
 * **Страж стороны заказчика на ДВУХ дверях — правке и удалении** (план профилей оргтехники,
 * находка Н8, решение заказчика 04.09.2026): держатель сквозной области модуля правит и удаляет
 * только свои заявки и заявки своей настоящей области.
 *
 * ПОЧЕМУ НЕ В `requireEditable`, ГДЕ УЖЕ СТОИТ СОСЕД. На общем входе изменяющих ручек живут
 * ЧЕТЫРЕ двери, и две из них — подшивка и снятие документов. Сисадмина штатно назначают
 * исполнителем на заявку чужой площадки (ради этого у профиля второй набор), и акт по ней он
 * обязан приложить: поставь мы это правило туда, назначенный исполнитель перестал бы прикладывать
 * документы к заявке, которую сам же чинит. Поэтому правило зовётся отсюда — с двух дверей, а не с
 * общего входа, — и на подшивке продолжает работать один лишь прежний страж авторства.
 *
 * ПРИЗНАКИ ТЕ ЖЕ И СЧИТАЮТСЯ ТЕМ ЖЕ. Авторство и `inServiceRequestCustomerScope` — ровно та пара,
 * которой решает сторону заказчика сосед выше и подсветка адресата «Заявителю»; решает же по ним
 * контракт (`canChangeRequestAsCustomer`), он же отвечает порталу. Своё условие здесь развело бы
 * кнопку и ручку молча.
 *
 * ОТКАЗ — `side`, как у соседа, и по той же причине: заявка субъекту ВИДНА и достигнута законно
 * (сквозной областью набора), а вот распоряжаться записью вправе её сторона заказчика. Хук журнала
 * пишет по этой причине `serviceRequest.access_denied` с адресом заявки — попытка править чужую
 * строку обязана оставлять след.
 */
function assertChangesRequestAsCustomer(
  p: Principal,
  row: ServiceRequestAuthorPlace,
  action: string,
): void {
  const allowed = canChangeRequestAsCustomer(p, {
    isAuthor: row.createdBy === p.id,
    inCustomerScope: inServiceRequestCustomerScope(p, row),
  });
  if (allowed) return;
  throw serviceDenied.side(
    `Сквозная область модуля показывает заявку, но ${action} её вправе сторона заказчика — тот, кто её завёл, либо его площадка или отдел`,
    row.id,
  );
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
  row: ServiceRequestAuthorPlace & ServiceExecutorsRow & { status: ServiceRequestStatus },
  action: string,
): void {
  /*
   * СТОРОНА — ПЕРВЫМ ВОПРОСОМ, СОСТОЯНИЕ — ВТОРЫМ (Н8). Правило живёт здесь, а не отдельной
   * проверкой в маршруте, ровно потому, что эта функция И ЕСТЬ дверь «правка заявки»: её называет
   * столбец «Держит» матрицы §5.1, её же называет манифест доступа строкой `PATCH /:id`, и зовёт
   * её один-единственный обработчик. Проверка, приписанная в маршруте рядом, была бы третьим
   * местом, о котором обязана помнить следующая изменяющая ручка, — а забытая, она открыла бы
   * дверь молча. Порядок вопросов тоже не случаен: «заявка не ваша» человеку полезнее, чем «её уже
   * отдали исполнителю», и в журнал отказов попадает именно попытка дотянуться до чужой строки.
   */
  assertChangesRequestAsCustomer(p, row, 'править');
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
 * Поэтому **на СОСТОЯНИЕ здесь по-прежнему отвечает один статус**, и это проверено, а не совпало
 * (Р14): удаляли «Новую» и «Назначенную» — то есть заявку до того, как за неё взялись, — оба
 * состояния после слияния зовутся «Новой», и один `new` покрывает ровно тот же набор заявок, что
 * покрывала прежняя пара. Разница с правкой ровно в этом: правке нужен ещё и состав исполнителей,
 * удалению — нет.
 *
 * СТРОКА ЖЕ ПОЯВИЛАСЬ В СИГНАТУРЕ РАДИ СТОРОНЫ, А НЕ РАДИ СОСТОЯНИЯ (Н8, решение заказчика
 * 04.09.2026): удаление — вторая из двух дверей, которые сузились, и держит её эта функция ровно
 * так же, как правку держит соседняя. Автор и место строки — то, чем сторона заказчика считается;
 * статусом её не выразить ничем.
 *
 * Отдельной функцией, потому что условие у этих двух решений разное и живёт оно в контрактах
 * (`isServiceRequestDeletable`): переиспользуй мы `assertServiceRequestEditable`, два разных
 * решения заказчика держались бы на одном перечне и разъехались бы на первой же правке любого из
 * них.
 */
export function assertServiceRequestDeletable(
  p: Principal,
  row: ServiceRequestAuthorPlace & { status: ServiceRequestStatus },
): void {
  // Сторона — первым вопросом, как и у правки: чужую заявку человеку не удалять ни в каком статусе.
  assertChangesRequestAsCustomer(p, row, 'удалить');
  if (isPlaceScopedRole(p.role) && !isServiceRequestDeletable(row.status)) {
    throw err.forbidden(
      `${roleLabels[p.role!]} удаляет заявку, пока по ней не начали работать — «${serviceRequestStatusLabels[row.status]}» уже дальше`,
    );
  }
}

// ── Кандидат на добавление оргтехники (план `docs/office-equipment-candidate-plan.md`, Р9) ──
//
// СООБЩЕНИЕ О ТЕХНИКЕ — НЕ ЗАПИСЬ СПРАВОЧНИКА, и отсюда всё устройство этих двух функций. Кандидат
// живёт своей таблицей (Р1), у него ДВЕ оси области сразу — площадка, где стоит аппарат, и
// подразделение автора снимком, — и ни одна из них не совпадает с осями парка: у карточки парка
// вторая ось это отдел-ВЛАДЕЛЕЦ, а у кандидата владельца нет вовсе (Р7). Поэтому предикат свой, а
// не переиспользованный `officeEquipmentScopeWhere`: общее имя обещало бы поведение, которого нет.
//
// ОСНОВАНИЯ «У МЕНЯ ЕСТЬ `officeEquipment.read`» ЗДЕСЬ НЕТ, И ЭТО ГЛАВНОЕ. Чтение парка открыто
// почти каждой роли портала, и видимость кандидата, построенная на нём, означала бы «видят все» —
// то есть ровно тот список, который вариант «неактивная карточка парка» и делал невозможным
// закрыть (Р1). Сообщение о технике до решения читают трое: тот, кто его отправил; тот, кому видна
// связанная заявка; тот, кто это сообщение проверяет.

/**
 * Колонки кандидата, по которым считается видимость. Значение по умолчанию — сама таблица: все
 * сегодняшние читатели спрашивают её напрямую. Параметр всё же есть — по той же причине, что у
 * `ServiceRequestVisibilityColumns`: кандидат бывает нужен под псевдонимом (соединение с самим
 * собой, подзапрос-производная), и без него такому запросу пришлось бы завести вторую копию
 * правила.
 */
export interface OfficeEquipmentCandidateVisibilityColumns {
  id: AnyColumn;
  createdBy: AnyColumn;
  objectId: AnyColumn;
  /** Снимок подразделения автора на момент отправки — отдельская ось проверяющего, а не сегодняшняя привязка учётки. */
  requesterDepartmentId: AnyColumn;
}

const CANDIDATE_COLUMNS: OfficeEquipmentCandidateVisibilityColumns = {
  id: officeEquipmentCandidates.id,
  createdBy: officeEquipmentCandidates.createdBy,
  objectId: officeEquipmentCandidates.objectId,
  requesterDepartmentId: officeEquipmentCandidates.requesterDepartmentId,
};

/**
 * Основание `review` Р9 отдельной функцией: **область проверяющего**, то есть «какие сообщения
 * лежат в МОЕЙ очереди».
 *
 * СПРАШИВАЕТСЯ ТОЛЬКО У ДЕРЖАТЕЛЯ `officeEquipment.review`, и право здесь не проверяется намеренно
 * — его проверяет страж маршрута (`GET /office-equipment-candidates`, `PATCH /:id`), а внутри
 * полного предиката ниже оно спрашивается явной веткой. Зашей мы `can` сюда, у функции стало бы два
 * ответа «пусто»: «прав нет» и «прав нет области», а различать их обязан вызывающий — первое
 * означает «этой двери у тебя нет», второе «дверь есть, за ней ничего».
 *
 * ОСИ РАЗНЫЕ У РАЗНЫХ РОЛЕЙ, и это не симметрия ради симметрии. Объектная роль отвечает за площадку
 * — она и видит сообщения со своей площадки. Отдельская роль отвечает за людей своего
 * подразделения, а не за чужие принтеры: её ось — снимок подразделения АВТОРА, потому что
 * отдел-владелец у кандидата ещё не назначен (его проставляет подтверждение, Р13) и назначить его
 * заявитель не может по построению.
 *
 * `NULL` В ОТДЕЛЬСКОЙ ОСИ НЕ ВИДЕН НИКОМУ ИЗ ОТДЕЛОВ — в отличие от `officeEquipmentScopeWhere`,
 * где «нет владельца» означает «не размечена, и размечать её больше некому». Здесь пустое значение
 * означает «у автора нет подразделений вовсе» (администратор, роль без привязок), а не «ничьё»:
 * такое сообщение разбирает проверяющий по объектной оси либо централизованный — и раздать его
 * каждому отделу компании значило бы отдать чужие площадки тому, кто про них не спрашивал.
 *
 * ПУСТОЙ НАБОР ОБЛАСТЕЙ ОСТАВЛЯЕТ ПУСТУЮ ОЧЕРЕДЬ, а не всю компанию, — тем же `NEVER_MATCH`, что у
 * соседей: состояние это ненормальное (объектная роль без площадок), но выборка не должна зависеть
 * от того, удержалась ли проверка, которая его не допускает.
 *
 * СКВОЗНОЙ ОБЛАСТИ НАБОРА (`hasModuleWideScope`) здесь нет, и это отличие от обоих соседей
 * осознанное. Сквозную область модуля `officeEquipment` несёт единственный набор — «Согласование
 * ИТ», — а `officeEquipment.review` ему не выдаётся ни системно, ни барьером требований: проверка
 * кончается записью в парк, и она требует `officeEquipment.write`, которого у ИТ-службы нет
 * намеренно (Р8, план профилей §5.2). Ветка под такого держателя описывала бы субъекта, которого
 * не существует, и проверить её было бы нечем. Появится он — решение принимается здесь, а не
 * дописыванием третьей копии правила по месту.
 */
export function officeEquipmentCandidateReviewWhere(
  p: Principal,
  cols: OfficeEquipmentCandidateVisibilityColumns = CANDIDATE_COLUMNS,
): SQL | undefined {
  if (isObjectScopedRole(p.role)) {
    const ids = p.constructionObjectIds;
    return ids.length > 0 ? inArray(cols.objectId, ids) : eq(cols.objectId, NEVER_MATCH);
  }
  if (isDepartmentScopedRole(p.role)) {
    const ids = p.departmentIds;
    return ids.length > 0
      ? inArray(cols.requesterDepartmentId, ids)
      : eq(cols.requesterDepartmentId, NEVER_MATCH);
  }
  // Роль без оси (диспетчер, менеджер) и администратор: очередь всей компании. Ровно на этой ветке
  // держится обещание плана, что у каждого сообщения есть адресат, — площадочного проверяющего на
  // каждом объекте не бывает, и централизованный держатель «Ведения» разбирает остальное.
  return undefined;
}

/**
 * **Видимость кандидата целиком** (Р9): `own` ∨ `related` ∨ `review`.
 *
 * ВСЕ ТРИ ЧЕРЕЗ `or`, потому что все три ДОБАВЛЯЮТ строки, а не сужают — этим предикат устроен
 * иначе, чем `serviceRequestVisibilityWhere`, где две оси сужают и потому соединены через `and`.
 * Автор видит своё сообщение, где бы он ни служил; участник видимой заявки видит её предмет;
 * проверяющий видит свою очередь. Ни одно из оснований не отменяет остальные.
 *
 * `own` — автор. Не «его площадка», а именно он: сообщение это свидетельство конкретного человека,
 * и переведённый на другой объект автор не должен терять ответ на вопрос «что стало с моей
 * заявкой».
 *
 * `related` — СВЯЗАННАЯ ЗАЯВКА ВИДИМА СМОТРЯЩЕМУ, и считается это единым предикатом заявки
 * (`serviceRequestVisibilityWhere`), а не прежней осью заказчика. Разница содержательна: заявку
 * заводят от лица подразделения, и ведёт её не один автор, а назначенный внутренний исполнитель и
 * оператор назначенной сервисной компании обязаны увидеть тот же предмет, который видят в заявке, —
 * иначе карточка заявки показывала бы им пустое место там, где стоит аппарат. Очередь проверки им
 * при этом не открывается: `GET /` спрашивает одно основание `review`.
 *
 * СЫРЫМ `EXISTS`, А НЕ `exists(db.select(...))` — по той же причине, что у третьей оси заявки: в
 * `sql`-объект переписывание списка столбцов drizzle не заходит, а собранный построителем
 * коррелированный подзапрос в односоставном запросе молча отдаёт не то условие
 * (`office-equipment-sql-correlation.test.ts`). Клиент БД сюда при этом не приезжает — модуль
 * проверяется юнит-тестами без соединения.
 *
 * МЯГКИЙ АРХИВ ЗАЯВКИ СВЯЗЬ НЕ РВЁТ (Р4): `deleted_at` в основании не спрашивается намеренно.
 * Отменённая или заархивированная заявка не отменяет сообщения о технике — проверяющий обязан
 * увидеть, что заявки уже нет, ДО того, как заведёт по ней карточку, а автор — что стало с его
 * сообщением.
 *
 * `review` — ветка выше, и добавляется она только держателю права. `undefined` от неё означает «у
 * этого проверяющего сужать нечем», и приписать к нему остальные основания нельзя: `or(undefined,
 * x)` в drizzle равен `x`, то есть централизованный проверяющий, у которого очередь всей компании,
 * молча получил бы вместо неё одни свои собственные сообщения.
 */
export function officeEquipmentCandidateScopeWhere(
  p: Principal,
  cols: OfficeEquipmentCandidateVisibilityColumns = CANDIDATE_COLUMNS,
): SQL | undefined {
  const requestVisible = serviceRequestVisibilityWhere(p);
  const related = sql`EXISTS (
    SELECT 1 FROM ${serviceRequests}
     WHERE ${serviceRequests.equipmentCandidateId} = ${cols.id}
       ${requestVisible === undefined ? sql`` : sql`AND (${requestVisible})`}
  )`;
  const bases: SQL[] = [eq(cols.createdBy, p.id), related];
  if (can(p, 'officeEquipment.review')) {
    const review = officeEquipmentCandidateReviewWhere(p, cols);
    if (review === undefined) return undefined;
    bases.push(review);
  }
  return or(...bases)!;
}

// ── Журнал путевых листов (ADR 0037, область — ADR 0192) ──

/**
 * Колонки листа, по которым считается область. Умолчание — сама таблица: все сегодняшние читатели
 * спрашивают её напрямую, а параметр оставлен для запроса, где лист приходит под псевдонимом
 * (журнал соединяет `waybills` сам с собой — заменённый лист и замена, ADR 0101).
 */
export interface WaybillVisibilityColumns {
  readonly id: AnyColumn;
  readonly sourceRequestId: AnyColumn;
}

const WAYBILL_COLUMNS: WaybillVisibilityColumns = {
  id: waybills.id,
  sourceRequestId: waybills.sourceRequestId,
};

/**
 * Какая заявка считается «своей» для области листа: та же пара осей, что у `vehicleRequestVisibilityWhere`,
 * плюс площадки отделов.
 *
 * ОТЛИЧИЕ ОТ «ЗАКАЗА ТС» ОБЪЯВЛЕНО РЕШЕНИЕМ Р3 (ADR 0192) и состоит в одном слагаемом. Там отдел
 * сравнивается только со **своим отделом**: заявку на технику отдел заводит от себя, и объектной
 * области у него в том модуле нет вовсе (ADR 0062 п. 3). Здесь к этому добавлены площадки его
 * отделов (ADR 0062, ADR 0144) — бумага по технике, работающей на площадке отдела, отделу нужна
 * ровно так же, как по технике, которую он заказал сам. Дизъюнкция, а не выбор одного из двух:
 * заявка отдела объекта не имеет, заявка площадки не имеет отдела, и сравнение по «обеим колонкам
 * сразу» не нашло бы ни одной.
 *
 * Пустая ось даёт `NEVER_MATCH`, а не отсутствие условия, — то же правило, что во всём файле:
 * «область не написана» означало бы доступ ко всем строкам сразу.
 */
function ownRequestScopeSql(
  p: Principal,
  objectColumn: AnyColumn,
  departmentColumn: AnyColumn,
): SQL | undefined {
  if (isObjectScopedRole(p.role)) {
    const ids = p.constructionObjectIds;
    return ids.length > 0 ? inArray(objectColumn, ids) : eq(objectColumn, NEVER_MATCH);
  }
  if (isDepartmentScopedRole(p.role)) {
    const own = p.departmentIds;
    const places = p.departmentObjectIds;
    const byDepartment = own.length > 0 ? inArray(departmentColumn, own) : undefined;
    const byPlace = places.length > 0 ? inArray(objectColumn, places) : undefined;
    // Обе оси пусты — «не видит ничего»: учётку роли отдела без единого отдела портал завести не
    // даёт (`users.ts`), но выборка не должна зависеть от того, удержалась ли та проверка.
    if (!byDepartment && !byPlace) return eq(departmentColumn, NEVER_MATCH);
    return or(byDepartment, byPlace)!;
  }
  return undefined;
}

/**
 * Видимость путевого листа (ADR 0192): площадка и отдел видят листы, выписанные по их заявкам.
 *
 * ОСЬ У ЛИСТА ПРОИЗВОДНАЯ — своей колонки заказчика у него нет. Отсюда два слагаемых, и оба
 * обязательны:
 *
 *  - **талоны** (`waybill_requests`) — заявки, которые машина выполняет по этому листу. Так устроены
 *    4-П и форма № 3: в листе до десяти слотов, и заказчики в них бывают разные;
 *  - **заявка-основание** (`waybills.source_request_id`) — недельный лист ЭСМ-2 (миграция 0087), у
 *    которого рейса нет вовсе, а есть заявка и период. Без этого слагаемого площадка не увидела бы
 *    ровно ту бумагу, которая заводится на неделю работы её машины.
 *
 * ЛИСТ ВИДЕН ЦЕЛИКОМ ТОМУ, ЧЕЙ В НЁМ ХОТЯ БЫ ОДИН ТАЛОН (решение Р2). `EXISTS`, а не «все талоны
 * мои»: бумага у рейса одна, и машина, заехавшая после моей площадки к соседу, не должна уносить
 * мой лист из моего журнала. Обратная сторона названа прямо: в таком листе видны номера чужих
 * заявок и наименования чужих объектов — и в печатной форме тоже, потому что печатается снимок
 * бланка целиком.
 *
 * ЛИСТ БЕЗ ЗАЯВОК НЕ ВИДЕН НИКОМУ ИЗ ПЛОЩАДОК, и это не пробел, а следствие производной оси:
 * у пустого бланка (ADR 0071) и у листа рейса-перегона считать область не по чему. Такой лист
 * остаётся диспетчерской — ей область не сужается ничем.
 *
 * УДАЛЁННАЯ ЗАЯВКА ОБЛАСТЬ НЕ ОТНИМАЕТ: `deleted_at` здесь не спрашивается намеренно. Лист —
 * бланк строгой отчётности, он пережил заявку и остаётся в журнале с номером и статусом; исчезни
 * он у площадки в момент, когда диспетчер удалил основание, — из журнала пропала бы бумага,
 * которая на объекте уже отработала.
 */
export function waybillVisibilityWhere(
  p: Principal,
  cols: WaybillVisibilityColumns = WAYBILL_COLUMNS,
): SQL | undefined {
  if (!isPlaceScopedRole(p.role)) return undefined;
  const own = ownRequestScopeSql(p, vehicleRequests.objectId, vehicleRequests.departmentId);
  // `undefined` от оси означает «сужать нечем», и до сюда такой субъект не доходит: роль с осью
  // площадки всегда получает условие, а роль без оси отсеяна строкой выше.
  if (own === undefined) return undefined;
  return sql`(
    EXISTS (
      SELECT 1 FROM ${waybillRequests}
        JOIN ${vehicleRequests} ON ${vehicleRequests.id} = ${waybillRequests.requestId}
       WHERE ${waybillRequests.waybillId} = ${cols.id}
         AND (${own})
    )
    OR EXISTS (
      SELECT 1 FROM ${vehicleRequests}
       WHERE ${vehicleRequests.id} = ${cols.sourceRequestId}
         AND (${own})
    )
  )`;
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
