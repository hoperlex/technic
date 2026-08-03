import {
  isCounterpartyScopedRole,
  OPERATOR_STATUS_TRANSITIONS,
  requestStatusRollbacks,
  requestStatusTransitions,
  roleLabels,
  ROLES,
  VEHICLE_REQUEST_TYPES,
  type RequestStatus,
  type Role,
  type VehicleRequestType,
} from './enums';
import {
  COUNTERPARTY_TYPES,
  counterpartyTypeLabels,
  type CounterpartyType,
} from './counterparties';

/**
 * Единая модель прав портала (ADR 0021, дополнена ADR 0038).
 *
 * Право — это «что учётка может делать», область видимости («над какими строками») задаётся
 * отдельно: штаб работает со своим объектом, внешний исполнитель — с заявками своего
 * контрагента. Смешивать их в одном списке нельзя: право проверяется до запроса в БД
 * (preHandler), а область — по конкретной строке, и ошибка тут даёт либо 403 на своей же
 * заявке, либо доступ к чужой.
 *
 * Права выдаются не роли, а **субъекту доступа** — паре «роль + тип контрагента учётки»
 * (ADR 0038). У всех ролей, кроме внешнего исполнителя, контрагента нет и субъект совпадает с
 * ролью; у исполнителя тип контрагента решает, в каком модуле он работает: оператор вывоза
 * ведёт заявки вывоза, арендодатель ТС — заявки на технику. Роль отвечает «кем человек работает
 * в портале», тип контрагента — «по какому предмету»; вторая роль-близнец на каждый модуль
 * дублировала бы первое ради второго.
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

  // Водители (ADR 0037). Отдельно от справочников: в карточке водителя лежат персональные
  // данные — СНИЛС, номер удостоверения, — и открывать их каждому, кому нужен список типов ТС,
  // нельзя. По той же причине права нет ни у наблюдателя, ни у объектных ролей.
  'drivers.read',
  'drivers.write',

  // Путевые листы (ADR 0037). Журнал учёта и аннулирование — своими правами: в листе те же
  // персональные данные, что в карточке водителя, а испорченный бланк списывает не всякий, кто
  // берёт заявки в работу. Выдача отдельного права не имеет: лист рождается переводом заявки в
  // работу, и разрешает его `vehicleRequests.status`.
  'waybills.read',
  'waybills.cancel',

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

/**
 * Ведение водителей (ADR 0037). Идёт вместе со справочниками у тех, кто обрабатывает заявки:
 * водителя выбирают при переводе заявки в работу, и заводит его тот же человек, который
 * выписывает путевой лист.
 */
const DRIVER_PERMISSIONS = ['drivers.read', 'drivers.write'] as const;

/** Журнал путевых листов ведут те же, кто выписывает листы и ведёт водителей (ADR 0037). */
const WAYBILL_PERMISSIONS = ['waybills.read', 'waybills.cancel'] as const;

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
    ...DRIVER_PERMISSIONS,
    ...WAYBILL_PERMISSIONS,
    ...WASTE_REQUEST_PERMISSIONS,
    ...VEHICLE_REQUEST_PERMISSIONS,
    'files.manageAny',
  ],

  dispatcher: [
    ...DIRECTORY_PERMISSIONS,
    ...DRIVER_PERMISSIONS,
    ...WAYBILL_PERMISSIONS,
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

  // Комендант — третий заказчик на объекте, но только по мусору: контейнеры и вывоз на площадке
  // ведёт он, а техника заказывается через штаб и руководителя строительства. Устроен как штаб
  // без модуля «Заказ ТС» — так же ограничен своими объектами и так же не ведёт ход заявок.
  // Отдельная роль, а не «штаб, которому не показали вкладку»: модуль закрывается правом на
  // чтение, и иначе комендант видел бы чужой заказ техники по прямой ссылке.
  commandant: [
    'directories.read',
    'wasteRequests.read',
    'wasteRequests.create',
    'wasteRequests.update',
    'wasteRequests.delete',
  ],

  // Отдел (ADR 0040) — заказчик со стороны офиса. Устроен как штаб, но в одном модуле: заявки на
  // технику заводит и правит, вывоза мусора не ведёт вовсе — мусор вывозят с площадки, а не из
  // кабинета, и права на модуль у роли нет. Чем именно ограничен заказ (только грузоперевозки) —
  // это область строк, а не право: перечень типов заявки задан отдельной таблицей (ADR 0040).
  department: [
    'directories.read',
    'vehicleRequests.read',
    'vehicleRequests.create',
    'vehicleRequests.update',
    'vehicleRequests.delete',
  ],

  // Руководитель отдела (ADR 0040): та же пара «заказчик и визирующий», что «Штаб» и
  // «Руководитель строительства» на объекте. Отличается от сотрудника отдела ровно одним правом —
  // визой, — и совпадение остального закреплено тестом-сравнением, а не перечислением.
  department_head: [
    'directories.read',
    'vehicleRequests.read',
    'vehicleRequests.create',
    'vehicleRequests.update',
    'vehicleRequests.delete',
    'vehicleRequests.approve',
  ],

  // Внешний исполнитель (ADR 0010, ADR 0038) — единственная роль, чьи права роль задаёт не
  // целиком: модульные права приходят из типа его контрагента (COUNTERPARTY_TYPE_PERMISSIONS).
  // Здесь остаётся только общее для любого исполнителя: без чтения справочников не отрисовать
  // ни фильтр, ни название типа ТС в списке.
  operator: ['directories.read'],

  // Наблюдатель (ADR 0033) — сквозной просмотр обоих модулей без единого действия: заявки всех
  // объектов видны, но ни завести, ни изменить, ни продвинуть по статусу их нельзя. Объекта у
  // роли нет намеренно: она заводится ради общей картины по компании, а не работы на площадке.
  observer: ['directories.read', 'wasteRequests.read', 'vehicleRequests.read'],
};

/**
 * Права, которые даёт тип контрагента учётки внешнего исполнителя (ADR 0038). Каждый тип —
 * один модуль портала, и набор в нём один и тот же: видеть свои заявки и закрывать
 * выполненное. Заводить, править и удалять заявки исполнитель не может ни в одном модуле —
 * заказчик и исполнитель разведены, и это граница модели, а не особенность вывоза мусора.
 *
 * Record по всем типам, а не по тем, у кого учётки есть: новый тип контрагента обязан здесь
 * появиться строкой и ответить на вопрос «а этот что исполняет». Пустой список — «учёток у
 * такого контрагента не бывает»: генподрядчик и подрядчик живут в справочнике как реквизиты
 * договора, работают в портале их сотрудники под собственными ролями.
 */
export const COUNTERPARTY_TYPE_PERMISSIONS: Record<CounterpartyType, readonly Permission[]> = {
  general_contractor: [],
  contractor: [],
  // Оператор вывоза (ADR 0010): видит заявки, назначенные его контрагенту, и закрывает их.
  operator: ['wasteRequests.read', 'wasteRequests.status'],
  // Арендодатель ТС (ADR 0038): видит заявки, на которые вышла его техника, и закрывает их.
  vehicle_lessor: ['vehicleRequests.read', 'vehicleRequests.status'],
  // Поставщик (ADR 0051) — сторона договора поставки: в портале за него никто не работает, его
  // склады ведут изнутри. Пустой список, как у генподрядчика и подрядчика; появится у поставщика
  // свой модуль — он будет строкой здесь, а не новой ролью.
  supplier: [],
};

/**
 * Типы контрагентов, к которым можно привязать учётку. Выводятся из матрицы, а не
 * перечисляются вторым списком: тип без прав — контрагент, за который в портале никто не
 * работает, и учётка на нём означала бы вход без единого действия.
 */
export const COUNTERPARTY_TYPES_WITH_ACCOUNTS = COUNTERPARTY_TYPES.filter(
  (type) => COUNTERPARTY_TYPE_PERMISSIONS[type].length > 0,
);

export function counterpartyTypeHasAccounts(
  type: CounterpartyType | null | undefined,
): type is CounterpartyType {
  return !!type && COUNTERPARTY_TYPE_PERMISSIONS[type].length > 0;
}

/**
 * Кому проверяется право: роль плюс тип контрагента учётки. Принимать сюда одну роль нельзя —
 * у внешнего исполнителя роль без контрагента отвечает только за общую часть прав, и вызов
 * `can(role, ...)` молча возвращал бы «нет» на его собственный модуль. Поэтому субъект —
 * объект: и принципал на сервере, и текущий пользователь на портале подходят под него как есть.
 */
export interface AccessSubject {
  role: Role | null;
  /** Тип контрагента учётки; у ролей вне `COUNTERPARTY_SCOPED_ROLES` не читается. */
  counterpartyType?: CounterpartyType | null;
}

// Проверка прав идёт на каждом запросе, поэтому списки сразу разложены по множествам.
const ROLE_PERMISSION_SETS = new Map<Role, ReadonlySet<Permission>>(
  ROLES.map((role) => [role, new Set(ROLE_PERMISSIONS[role])]),
);

const COUNTERPARTY_PERMISSION_SETS = new Map<CounterpartyType, ReadonlySet<Permission>>(
  COUNTERPARTY_TYPES.map((type) => [type, new Set(COUNTERPARTY_TYPE_PERMISSIONS[type])]),
);

/**
 * Есть ли у субъекта право. Учётка без роли не может ничего: доступ выдаётся ролью, и пока её
 * не назначили, пользователь для портала — никто (активировать такую учётку API не даёт).
 * Исполнитель без контрагента — то же самое в своём модуле: без контрагента неизвестно ни что
 * он исполняет, ни чьи заявки видит, поэтому модульных прав у него нет (активировать такую
 * учётку API тоже не даёт).
 */
export function can(subject: AccessSubject | null | undefined, permission: Permission): boolean {
  const role = subject?.role;
  if (!role) return false;
  if (ROLE_PERMISSION_SETS.get(role)?.has(permission)) return true;
  if (!isCounterpartyScopedRole(role)) return false;
  const type = subject?.counterpartyType;
  return !!type && (COUNTERPARTY_PERMISSION_SETS.get(type)?.has(permission) ?? false);
}

/**
 * Работает ли учётка от контрагента указанного типа (ADR 0038) — то есть исполняет ли она
 * заявки этого модуля. Предикат, а не сравнение с ролью: «оператор вывоза» — это роль
 * исполнителя плюс контрагент-оператор, и одна роль без типа означает уже не то же самое.
 */
export function actsForCounterparty(
  subject: AccessSubject | null | undefined,
  type: CounterpartyType,
): boolean {
  return isCounterpartyScopedRole(subject?.role) && subject?.counterpartyType === type;
}

/** Все права субъекта — для отладки и для страницы учёток. */
export function permissionsFor(subject: AccessSubject | null | undefined): readonly Permission[] {
  const role = subject?.role;
  if (!role) return [];
  return PERMISSIONS.filter((permission) => can(subject, permission));
}

/**
 * Все различимые субъекты доступа: роли без контрагента как есть, роль от контрагента —
 * по разу на каждый тип контрагента с учётками. Список нужен там, где перебирают «всех, кто
 * бывает в портале»: тесты матрицы, обратный поиск по праву.
 */
export const ACCESS_PROFILES: readonly AccessSubject[] = ROLES.flatMap((role) =>
  isCounterpartyScopedRole(role)
    ? COUNTERPARTY_TYPES_WITH_ACCOUNTS.map((counterpartyType) => ({ role, counterpartyType }))
    : [{ role }],
);

/** Субъекты, у которых есть указанное право (обратный поиск: подсказки интерфейса и тесты). */
export function profilesWith(permission: Permission): AccessSubject[] {
  return ACCESS_PROFILES.filter((subject) => can(subject, permission));
}

/** Человекочитаемое имя субъекта: у исполнителя оно называет предмет работы, а не роль. */
export function accessProfileLabel(subject: AccessSubject): string {
  if (subject.role && isCounterpartyScopedRole(subject.role) && subject.counterpartyType) {
    return `${roleLabels[subject.role]} — ${counterpartyTypeLabels[subject.counterpartyType]}`;
  }
  return subject.role ? roleLabels[subject.role] : 'Без роли';
}

/**
 * Роли, которым в модуле «Заказ ТС» доступны не все типы заявки (ADR 0040). Отдел заказывает
 * только грузоперевозки: спецтехника выходит на площадку, а площадки у отдела нет.
 *
 * Таблица, а не право `vehicleRequests.freight` и не `if` по имени роли. Право отвечает «что
 * учётка делает», а здесь ограничение по признаку самой строки — это область; в матрице оно
 * завело бы колонку-исключение, которую пришлось бы читать при каждом новом типе заявки.
 * Отсутствие роли в таблице означает «доступны все типы» — так новый тип заявки открывается
 * всем, кроме тех, кому его закрыли осознанно, строкой здесь.
 */
const ROLE_VEHICLE_REQUEST_TYPES: Partial<Record<Role, readonly VehicleRequestType[]>> = {
  department: ['freight_transport'],
  department_head: ['freight_transport'],
};

/** Типы заявки на технику, доступные субъекту (пустой список невозможен: роли без модуля сюда не доходят). */
export function allowedVehicleRequestTypes(
  subject: AccessSubject | null | undefined,
): readonly VehicleRequestType[] {
  const own = subject?.role ? ROLE_VEHICLE_REQUEST_TYPES[subject.role] : undefined;
  return own ?? VEHICLE_REQUEST_TYPES;
}

export function canOrderVehicleRequestType(
  subject: AccessSubject | null | undefined,
  requestType: VehicleRequestType,
): boolean {
  return allowedVehicleRequestTypes(subject).includes(requestType);
}

/**
 * Роли с собственным коридором статусов: право «менять статус» у них есть, но не на весь
 * рабочий цикл. Таблица, а не исключение в коде: следующая такая роль добавляется строкой.
 */
const ROLE_STATUS_TRANSITIONS: Partial<Record<Role, Record<RequestStatus, RequestStatus[]>>> = {
  // Внешний исполнитель закрывает то, что сам выполнил; подтверждать и отменять — решения
  // заказчика (ADR 0010). Коридор один на оба модуля: закрытие выполненного — это одно и то же
  // действие, что у вывоза мусора, что у аренды техники, поэтому таблица по роли, а не по типу
  // контрагента.
  operator: OPERATOR_STATUS_TRANSITIONS,
};

/** Смена статуса хотя бы в одном модуле — общий предикат для правил перехода. */
function canChangeAnyStatus(subject: AccessSubject): boolean {
  return can(subject, 'wasteRequests.status') || can(subject, 'vehicleRequests.status');
}

/**
 * Статусы, доступные субъекту из текущего статуса (пустой список — смена статуса запрещена).
 * Живёт рядом с матрицей, а не с таблицами переходов: «кто может» — это право, а таблицы
 * переходов описывают только «что за чем идёт».
 */
export function allowedStatusTransitions(
  from: RequestStatus,
  subject: AccessSubject,
): RequestStatus[] {
  if (!canChangeAnyStatus(subject)) return [];
  const ownCorridor = subject.role ? ROLE_STATUS_TRANSITIONS[subject.role] : undefined;
  if (ownCorridor) return ownCorridor[from];
  return can(subject, 'requests.rollbackStatus')
    ? [...requestStatusTransitions[from], ...requestStatusRollbacks[from]]
    : requestStatusTransitions[from];
}

export function canTransitionStatus(
  from: RequestStatus,
  to: RequestStatus,
  subject: AccessSubject,
): boolean {
  return allowedStatusTransitions(from, subject).includes(to);
}
