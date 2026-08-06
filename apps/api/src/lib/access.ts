import { eq, inArray, isNotNull, isNull, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  actsForCounterparty,
  allowedVehicleRequestTypes,
  type ArchiveFilter,
  can,
  canOrderVehicleRequestType,
  canTransitionStatus,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isPlaceScopedRole,
  requestStatusLabels,
  roleLabels,
  type CounterpartyType,
  vehicleRequestTypeLabels,
  type Permission,
  type RequestStatus,
  type VehicleRequestType,
  wasteObjectScopeIds,
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
 * Переход статуса заявки с учётом прав (един для «Вывоза мусора» и «Заказа ТС»). Откат
 * закрытой заявки — право администратора, поэтому 403, а не 400: переход существует,
 * но не для этой учётки.
 */
export function assertTransitionAllowed(
  p: Principal,
  from: RequestStatus,
  to: RequestStatus,
): void {
  if (canTransitionStatus(from, to, p)) return;
  // Учётка без роли до сюда не доходит — её отсекает право на маршруте. Но объяснять отказ
  // разбором переходов ей нечем: у неё нет ни одного, и «только администратор» было бы ложью.
  if (!p.role) throw err.forbidden('Недостаточно прав для смены статуса');
  // У внешнего исполнителя коридор один, поэтому «недопустимый переход» ему ничего не объясняет.
  if (isCounterpartyScopedRole(p.role)) {
    throw err.forbidden(
      `${roleLabels[p.role]} может только отметить заявку «${requestStatusLabels.confirmed}» выполненной`,
    );
  }
  if (canTransitionStatus(from, to, { role: 'admin' })) {
    throw err.forbidden('Вернуть заявку в предыдущий статус может только администратор');
  }
  throw err.badRequest(
    `Недопустимый переход статуса: «${requestStatusLabels[from]}» → «${requestStatusLabels[to]}»`,
  );
}
