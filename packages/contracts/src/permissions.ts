import {
  OPERATOR_STATUS_TRANSITIONS,
  requestStatusRollbacks,
  requestStatusTransitions,
  ROLES,
  type RequestStatus,
  type Role,
} from './enums';

/**
 * Единая модель прав портала (ADR 0021).
 *
 * Право — это «что роль может делать», область видимости («над какими строками») задаётся
 * отдельно: штаб работает со своим объектом, оператор — с заявками своего контрагента.
 * Смешивать их в одном списке нельзя: право проверяется до запроса в БД (preHandler), а
 * область — по конкретной строке, и ошибка тут даёт либо 403 на своей же заявке, либо
 * доступ к чужой.
 *
 * Матрица живёт в общем пакете, потому что источник правды должен быть один: API проверяет
 * права на каждом маршруте, портал по той же матрице решает, показывать ли пункт меню и
 * кнопку. Разъехавшиеся списки ролей — это либо кнопка, ведущая в 403, либо действие,
 * которое видно, но запрещено на сервере (или, что хуже, наоборот).
 */
export const PERMISSIONS = [
  // Справочники — единый модуль: доступ выдаётся на весь раздел, а не на отдельную вкладку.
  // Чтение нужно всем ролям: без него не заполнить форму заявки (объект, тип ТС, тип контейнера).
  'directories.read',
  'directories.write',

  // Вывоз мусора
  'wasteRequests.read',
  'wasteRequests.create',
  'wasteRequests.update',
  'wasteRequests.delete',
  'wasteRequests.status',
  'wasteRequests.assignOperator',

  // Заказ ТС
  'vehicleRequests.read',
  'vehicleRequests.create',
  'vehicleRequests.update',
  'vehicleRequests.delete',
  'vehicleRequests.status',
  /** Виза руководителя строительства: без неё заявку не берут в работу (ADR 0025). */
  'vehicleRequests.approve',

  // Действия над удалёнными и закрытыми записями — общие для заявок и справочников
  /** Видеть удалённые записи (архив): списки с includeDeleted, карточка удалённой заявки. */
  'archive.read',
  'archive.restore',
  /** Вернуть закрытую («Выполнена»/«Отменена») заявку в предыдущий статус. */
  'requests.rollbackStatus',
  /** Удаление записи насовсем, минуя пометку «удалена»: восстановить её уже нечем. */
  'records.purge',

  // Файлы: удаление чужого файла, не привязанного к заявке (свой удаляет и автор загрузки).
  'files.manageAny',

  // Администрирование
  'users.manage',
  'audit.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const DIRECTORY_PERMISSIONS = ['directories.read', 'directories.write'] as const;

const WASTE_REQUEST_PERMISSIONS = [
  'wasteRequests.read',
  'wasteRequests.create',
  'wasteRequests.update',
  'wasteRequests.delete',
  'wasteRequests.status',
  'wasteRequests.assignOperator',
] as const;

/**
 * Ведение заявок на технику. Визы (`vehicleRequests.approve`) здесь нет намеренно: согласование —
 * решение заказчика со стороны объекта, а не того, кто заявку обрабатывает (ADR 0025).
 */
const VEHICLE_REQUEST_PERMISSIONS = [
  'vehicleRequests.read',
  'vehicleRequests.create',
  'vehicleRequests.update',
  'vehicleRequests.delete',
  'vehicleRequests.status',
] as const;

/**
 * Права ролей. Перечислены полностью и явно, без наследования «роль X = роль Y плюс N прав»:
 * при наследовании новое право у базовой роли расходится по производным незаметно, а здесь
 * каждое расширение доступа видно в диффе строкой.
 *
 * «Менеджер» и «Диспетчер» сейчас совпадают по правам: по решению заказчика диспетчер ведёт
 * справочники наравне с менеджером, а заявки они и раньше вели одинаково. Роли оставлены
 * раздельными — они различаются организационно, и расходятся при первом же новом праве.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Администратор — единственный, кто работает с архивом, откатами и учётками.
  admin: [...PERMISSIONS],

  manager: [
    ...DIRECTORY_PERMISSIONS,
    ...WASTE_REQUEST_PERMISSIONS,
    ...VEHICLE_REQUEST_PERMISSIONS,
    'files.manageAny',
  ],

  dispatcher: [
    ...DIRECTORY_PERMISSIONS,
    ...WASTE_REQUEST_PERMISSIONS,
    ...VEHICLE_REQUEST_PERMISSIONS,
    'files.manageAny',
  ],

  // Штаб — заказчик со стороны объекта: заявки заводит и правит (в пределах своего объекта),
  // но их ход — «в работе», «выполнена» — решают те, кто исполняет.
  shtab: [
    'directories.read',
    'wasteRequests.read',
    'wasteRequests.create',
    'wasteRequests.update',
    'wasteRequests.delete',
    'vehicleRequests.read',
    'vehicleRequests.create',
    'vehicleRequests.update',
    'vehicleRequests.delete',
  ],

  // Руководитель строительства (ADR 0025, 0031): вторая роль заказчика на объекте. Заявки обоих
  // модулей заводит и правит наравне со штабом — и вывоз мусора, и технику; ход заявок, как и у
  // штаба, решают те, кто их исполняет. Своё у него одно — виза: без неё заявку на технику не
  // берут в работу.
  rukstroy: [
    'directories.read',
    'wasteRequests.read',
    'wasteRequests.create',
    'wasteRequests.update',
    'wasteRequests.delete',
    'vehicleRequests.read',
    'vehicleRequests.create',
    'vehicleRequests.update',
    'vehicleRequests.delete',
    'vehicleRequests.approve',
  ],

  // Оператор — внешний исполнитель вывоза (ADR 0010): видит заявки своего контрагента и
  // закрывает их. Модуль «Заказ ТС» ему недоступен целиком.
  operator: ['directories.read', 'wasteRequests.read', 'wasteRequests.status'],
};

// Проверка прав идёт на каждом запросе, поэтому списки сразу разложены по множествам.
const ROLE_PERMISSION_SETS = new Map<Role, ReadonlySet<Permission>>(
  ROLES.map((role) => [role, new Set(ROLE_PERMISSIONS[role])]),
);

/**
 * Есть ли у роли право. Учётка без роли не может ничего: доступ выдаётся ролью, и пока её
 * не назначили, пользователь для портала — никто (активировать такую учётку API не даёт).
 */
export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSION_SETS.get(role)?.has(permission) ?? false;
}

/** Все права роли — для отладки и для страницы учёток. */
export function permissionsFor(role: Role | null | undefined): readonly Permission[] {
  return role ? ROLE_PERMISSIONS[role] : [];
}

/** Роли, у которых есть указанное право (используется в подсказках интерфейса и тестах). */
export function rolesWith(permission: Permission): Role[] {
  return ROLES.filter((role) => can(role, permission));
}

/**
 * Роли с собственным коридором статусов: право «менять статус» у них есть, но не на весь
 * рабочий цикл. Таблица, а не исключение в коде: следующая такая роль добавляется строкой.
 */
const ROLE_STATUS_TRANSITIONS: Partial<Record<Role, Record<RequestStatus, RequestStatus[]>>> = {
  // Оператор закрывает то, что сам выполнил; подтверждать и отменять — решения заказчика (ADR 0010).
  operator: OPERATOR_STATUS_TRANSITIONS,
};

/** Смена статуса хотя бы в одном модуле — общий предикат для правил перехода. */
function canChangeAnyStatus(role: Role): boolean {
  return can(role, 'wasteRequests.status') || can(role, 'vehicleRequests.status');
}

/**
 * Статусы, доступные роли из текущего статуса (пустой список — смена статуса запрещена).
 * Живёт рядом с матрицей, а не с таблицами переходов: «кто может» — это право, а таблицы
 * переходов описывают только «что за чем идёт».
 */
export function allowedStatusTransitions(from: RequestStatus, role: Role): RequestStatus[] {
  if (!canChangeAnyStatus(role)) return [];
  const ownCorridor = ROLE_STATUS_TRANSITIONS[role];
  if (ownCorridor) return ownCorridor[from];
  return can(role, 'requests.rollbackStatus')
    ? [...requestStatusTransitions[from], ...requestStatusRollbacks[from]]
    : requestStatusTransitions[from];
}

export function canTransitionStatus(from: RequestStatus, to: RequestStatus, role: Role): boolean {
  return allowedStatusTransitions(from, role).includes(to);
}
