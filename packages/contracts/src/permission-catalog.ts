import {
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  isPersonScopedRole,
  type Role,
} from './enums';
import { can, PERMISSIONS, type AccessSubject, type Permission } from './permissions';

/**
 * Витринная часть модели доступа (`docs/permissions-tab-plan.md`): как назвать право человеку, к
 * какому модулю портала оно относится и что именно разрешает делать.
 *
 * Отдельным файлом от матрицы намеренно. `permissions.ts` отвечает на вопрос «кому», и читают его
 * ради этого; каталог отвечает «как это показать», и смешанные в одном файле, два ответа заставили
 * бы перечитывать двести строк обоснований ради подписи. Зависимость односторонняя: каталог знает
 * про матрицу, матрица про каталог — нет.
 *
 * `Record` по всем правам, а не список: новое право в `PERMISSIONS` обязано получить подпись и
 * модуль, иначе не соберётся сборка. Молча пропущенное право означало бы вкладку «Права», которая
 * о нём не рассказывает, — то есть витрину, врущую ровно там, где по ней принимают решение.
 */

/**
 * Модули портала — так, как их видит человек, а не так, как разложены маршруты. Совпадают с
 * разделами меню всюду, где раздел есть; там, где права живут поперёк разделов (архив, файлы,
 * администрирование), модуль называет предмет, а не страницу.
 */
export const PERMISSION_MODULES = [
  'directories',
  'drivers',
  'waybills',
  'waste',
  'vehicle',
  'weekly',
  'service',
  'officeEquipment',
  'garage',
  'driverCabinet',
  'vehicleReadings',
  /**
   * Техобслуживание — свой модуль витрины, а не пара прав внутри «Показаний техники» (Р14). Модуль
   * закрывается своим чтением, и лежи эти права в чужом, витрина рассказывала бы, что журнал ТО
   * открывается доступом к показаниям, — то есть ровно то смешение, которого решение избегает.
   */
  'vehicleMaintenance',
  'records',
  'files',
  'admin',
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export const permissionModuleLabels: Record<PermissionModule, string> = {
  directories: 'Справочники',
  drivers: 'Водители',
  waybills: 'Путевые листы',
  waste: 'Вывоз мусора',
  vehicle: 'Заказ ТС',
  weekly: 'Недельная заявка',
  service: 'Орг.техника: заявки',
  officeEquipment: 'Орг.техника: справочник',
  garage: 'Гараж',
  driverCabinet: 'Кабинет водителя',
  vehicleReadings: 'Показания техники',
  vehicleMaintenance: 'Техобслуживание',
  records: 'Архив и откаты',
  files: 'Файлы',
  admin: 'Администрирование',
};

/**
 * Вид действия — колонки сетки «модуль × действие». Их семь, и седьмое (`manage`) собирает то, что
 * в четыре первых не укладывается: назначение исполнителя, аннулирование бланка, выгрузку
 * справочника. Разводить каждый такой случай в свою колонку значило бы получить сетку из двадцати
 * пустых столбцов ради трёх заполненных клеток.
 */
export const PERMISSION_ACTIONS = [
  'read',
  'create',
  'update',
  'delete',
  'status',
  'approve',
  'manage',
] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const permissionActionLabels: Record<PermissionAction, string> = {
  read: 'Чтение',
  create: 'Создание',
  update: 'Правка',
  delete: 'Удаление',
  status: 'Ход',
  approve: 'Согласование',
  manage: 'Особые',
};

export interface PermissionCatalogEntry {
  module: PermissionModule;
  action: PermissionAction;
  /**
   * Подпись глаголом от лица учётки: «Заводит заявку», а не «Создание заявки». Витрину читают
   * строкой «что человек может», и отглагольное существительное в этой строке спотыкается.
   */
  label: string;
}

export const PERMISSION_CATALOG: Record<Permission, PermissionCatalogEntry> = {
  'directories.read': {
    module: 'directories',
    action: 'read',
    label: 'Читает справочники',
  },
  'directories.write': { module: 'directories', action: 'update', label: 'Ведёт справочники' },
  'directories.export': {
    module: 'directories',
    action: 'manage',
    label: 'Выгружает справочник в файл',
  },
  'directories.import': {
    module: 'directories',
    action: 'manage',
    label: 'Загружает справочник из файла',
  },

  'wasteRequests.read': { module: 'waste', action: 'read', label: 'Видит заявки на вывоз' },
  'wasteRequests.create': { module: 'waste', action: 'create', label: 'Заводит заявку на вывоз' },
  'wasteRequests.update': { module: 'waste', action: 'update', label: 'Правит заявку на вывоз' },
  'wasteRequests.delete': { module: 'waste', action: 'delete', label: 'Удаляет заявку на вывоз' },
  'wasteRequests.status': {
    module: 'waste',
    action: 'status',
    label: 'Двигает заявку на вывоз по статусам',
  },
  'wasteRequests.assignOperator': {
    module: 'waste',
    action: 'manage',
    label: 'Назначает исполнителя вывоза',
  },
  'wasteRequests.operatorComment': {
    module: 'waste',
    action: 'manage',
    label: 'Пишет примечание исполнителя',
  },

  'vehicleRequests.read': { module: 'vehicle', action: 'read', label: 'Видит заказы техники' },
  'vehicleRequests.create': { module: 'vehicle', action: 'create', label: 'Заводит заказ техники' },
  'vehicleRequests.update': { module: 'vehicle', action: 'update', label: 'Правит заказ техники' },
  'vehicleRequests.delete': { module: 'vehicle', action: 'delete', label: 'Удаляет заказ техники' },
  'vehicleRequests.status': {
    module: 'vehicle',
    action: 'status',
    label: 'Двигает заказ по статусам',
  },
  'vehicleRequests.approve': {
    module: 'vehicle',
    action: 'approve',
    label: 'Визирует заказ техники',
  },

  'weeklyRequests.read': { module: 'weekly', action: 'read', label: 'Видит недельные заявки' },
  'weeklyRequests.create': {
    module: 'weekly',
    action: 'create',
    label: 'Заводит недельную заявку',
  },
  'weeklyRequests.update': { module: 'weekly', action: 'update', label: 'Правит состав недели' },
  'weeklyRequests.approve': {
    module: 'weekly',
    action: 'approve',
    label: 'Визирует недельную заявку',
  },

  'drivers.read': { module: 'drivers', action: 'read', label: 'Читает карточки водителей' },
  'drivers.write': { module: 'drivers', action: 'update', label: 'Ведёт справочник водителей' },

  'waybills.read': { module: 'waybills', action: 'read', label: 'Читает журнал путевых листов' },
  'waybills.cancel': { module: 'waybills', action: 'manage', label: 'Аннулирует путевой лист' },
  'waybills.files': { module: 'waybills', action: 'manage', label: 'Подшивает документы к листу' },
  'waybills.issueBlank': {
    module: 'waybills',
    action: 'manage',
    label: 'Выписывает лист без заявок',
  },
  'waybills.correct': {
    module: 'waybills',
    action: 'manage',
    label: 'Исправляет документы задним числом',
  },
  'waybills.correctBeyondLimit': {
    module: 'waybills',
    action: 'manage',
    label: 'Исправляет задним числом старше 30 дней',
  },

  'serviceRequests.read': {
    module: 'service',
    action: 'read',
    label: 'Видит заявки на обслуживание',
  },
  'serviceRequests.create': {
    module: 'service',
    action: 'create',
    label: 'Заводит заявку на обслуживание',
  },
  'serviceRequests.update': {
    module: 'service',
    action: 'update',
    label: 'Правит заявку на обслуживание',
  },
  'serviceRequests.delete': {
    module: 'service',
    action: 'delete',
    label: 'Удаляет заявку на обслуживание',
  },
  'serviceRequests.assign': {
    module: 'service',
    action: 'manage',
    label: 'Назначает сервисную компанию',
  },
  'serviceRequests.estimate': { module: 'service', action: 'manage', label: 'Ведёт смету ремонта' },
  'serviceRequests.approveEstimate': {
    module: 'service',
    action: 'approve',
    label: 'Согласует смету ремонта',
  },
  'serviceRequests.approveIt': {
    module: 'service',
    action: 'approve',
    label: 'Визирует заявку от отдела ИТ',
  },
  'serviceRequests.status': {
    module: 'service',
    action: 'status',
    label: 'Двигает заявку на обслуживание по статусам',
  },
  'serviceRequests.files': {
    module: 'service',
    action: 'manage',
    label: 'Подшивает документы к заявке',
  },

  'officeEquipment.read': {
    module: 'officeEquipment',
    action: 'read',
    label: 'Читает справочник оргтехники',
  },
  'officeEquipment.write': {
    module: 'officeEquipment',
    action: 'update',
    label: 'Ведёт справочник оргтехники',
  },

  'garage.read': { module: 'garage', action: 'read', label: 'Смотрит день гаража' },
  'driverCabinet.read': {
    module: 'driverCabinet',
    action: 'read',
    label: 'Открывает своё задание на дату',
  },
  'driverCabinet.submit': {
    module: 'driverCabinet',
    action: 'create',
    label: 'Передаёт свои показания',
  },
  'vehicleReadings.read': {
    module: 'vehicleReadings',
    action: 'read',
    label: 'Смотрит показания парка',
  },
  'vehicleReadings.write': {
    module: 'vehicleReadings',
    action: 'manage',
    label: 'Правит показания и принимает день',
  },
  'vehicleMaintenance.read': {
    module: 'vehicleMaintenance',
    action: 'read',
    label: 'Смотрит журнал ТО техники',
  },
  'vehicleMaintenance.write': {
    module: 'vehicleMaintenance',
    action: 'update',
    label: 'Ведёт журнал ТО техники',
  },

  'archive.read': { module: 'records', action: 'read', label: 'Видит удалённые записи' },
  'archive.restore': { module: 'records', action: 'manage', label: 'Возвращает запись из архива' },
  'requests.rollbackStatus': {
    module: 'records',
    action: 'status',
    label: 'Откатывает статус заявки',
  },
  'records.purge': { module: 'records', action: 'delete', label: 'Удаляет запись насовсем' },

  'files.manageAny': { module: 'files', action: 'manage', label: 'Удаляет чужие файлы' },

  'users.manage': { module: 'admin', action: 'manage', label: 'Ведёт учётные записи' },
  'audit.read': { module: 'admin', action: 'read', label: 'Читает журнал действий' },
  'mailings.read': { module: 'admin', action: 'read', label: 'Смотрит рассылки' },
  'mailings.manage': { module: 'admin', action: 'manage', label: 'Настраивает рассылки' },
};

/** Права модуля в порядке объявления — строки сетки собираются по нему, а не по алфавиту. */
export const PERMISSIONS_BY_MODULE: Record<PermissionModule, readonly Permission[]> =
  PERMISSION_MODULES.reduce(
    (acc, module) => {
      acc[module] = PERMISSIONS.filter((p) => PERMISSION_CATALOG[p].module === module);
      return acc;
    },
    {} as Record<PermissionModule, Permission[]>,
  );

/**
 * Право, которым модуль открывается целиком. Модули закрываются чтением (ADR 0021): нет его — нет
 * и раздела, а остальные права в нём недостижимы. У «Файлов» своего чтения нет — модуль состоит из
 * одного административного права, и открывающим считается оно.
 */
export const MODULE_ENTRY_PERMISSION: Record<PermissionModule, Permission> = {
  directories: 'directories.read',
  drivers: 'drivers.read',
  waybills: 'waybills.read',
  waste: 'wasteRequests.read',
  vehicle: 'vehicleRequests.read',
  weekly: 'weeklyRequests.read',
  service: 'serviceRequests.read',
  officeEquipment: 'officeEquipment.read',
  garage: 'garage.read',
  driverCabinet: 'driverCabinet.read',
  vehicleReadings: 'vehicleReadings.read',
  vehicleMaintenance: 'vehicleMaintenance.read',
  records: 'archive.read',
  files: 'files.manageAny',
  admin: 'users.manage',
};

/**
 * Что субъект делает в модуле: не видит вовсе, только смотрит или ещё и действует. Три состояния,
 * а не флаг: «видит» и «работает» — разные ответы, и в витрине их путать нельзя.
 */
export type ModuleAccess = 'none' | 'read' | 'write';

export function moduleAccess(
  subject: AccessSubject | null | undefined,
  module: PermissionModule,
): ModuleAccess {
  const granted = PERMISSIONS_BY_MODULE[module].filter((p) => can(subject, p));
  if (granted.length === 0) return 'none';
  return granted.some((p) => PERMISSION_CATALOG[p].action !== 'read') ? 'write' : 'read';
}

/**
 * Ограничения области субъекта — словами (ADR 0021 §5, ADR 0039, 0040, 0062, 0070, 0102).
 *
 * Это витрина второго слоя доступа, который живёт в `apps/api/src/lib/access.ts`, и повторять его
 * механику здесь нечем: правило — текст, а не предикат по строке. Чтобы витрина не разошлась с
 * моделью молча, применимость правил задана теми же предикатами ролей, что и сам слой
 * (`isObjectScopedRole` и соседние), а полнота набора закреплена тестом: роль с областью обязана
 * получить хотя бы одно правило.
 */
export interface AccessScopeRule {
  applies: (subject: AccessSubject) => boolean;
  text: string;
}

const SCOPE_RULES: readonly AccessScopeRule[] = [
  {
    applies: (s) => isObjectScopedRole(s.role),
    text: 'Видит только записи своих объектов',
  },
  {
    applies: (s) => isDepartmentScopedRole(s.role),
    text: 'Видит только заявки своих отделов; вывоз мусора — по площадкам этих отделов',
  },
  {
    applies: (s) => isDepartmentScopedRole(s.role),
    text: 'Заказывает только грузоперевозки: спецтехника выходит на площадку, а площадки у отдела нет',
  },
  {
    applies: (s) => isObjectScopedRole(s.role) || isDepartmentScopedRole(s.role),
    text: 'Правит и удаляет заявку только в статусе «Новая»',
  },
  {
    applies: (s) => isCounterpartyScopedRole(s.role) && s.counterpartyType === 'operator',
    text: 'Видит только заявки на вывоз, назначенные его контрагенту',
  },
  {
    applies: (s) => isCounterpartyScopedRole(s.role) && s.counterpartyType === 'vehicle_lessor',
    text: 'Видит только заказы, на которые назначена его техника; «Новую» заявку — нет',
  },
  {
    applies: (s) => isCounterpartyScopedRole(s.role) && s.counterpartyType === 'service',
    text: 'Видит только заявки на обслуживание, назначенные его компании',
  },
  /**
   * Четвёртая ось — работник справочника (ADR 0102 §5), и она самая узкая из четырёх. Правило здесь
   * такое же текстовое, как соседние, хотя предиката в `lib/access.ts` у оси нет: область держится
   * тем, что кабинет не принимает `personId` вовсе. Витрине от этого не легче — не скажи она про
   * область ничего, водитель показался бы видящим всё, что открывают его права.
   */
  {
    applies: (s) => isPersonScopedRole(s.role),
    text: 'Видит только своё задание и свои показания: другого работника кабинет не спрашивает',
  },
  {
    applies: (s) => !!s.role && !can(s, 'archive.read'),
    text: 'Удалённые записи недоступны: по прямой ссылке — «не найдено»',
  },
];

/** Область не ограничена ничем: роль без своей оси и с доступом к архиву (сегодня — администратор). */
export const UNSCOPED_TEXT = 'Областью не ограничен: видит записи всех объектов и отделов';

export function describeAccessScope(subject: AccessSubject | null | undefined): readonly string[] {
  if (!subject?.role) return ['Роль не назначена: доступа в портал нет'];
  const rules = SCOPE_RULES.filter((rule) => rule.applies(subject)).map((rule) => rule.text);
  return rules.length > 0 ? rules : [UNSCOPED_TEXT];
}

/**
 * Роли, у которых область задаётся набором в учётке, — им витрина показывает сам набор. Осей
 * четыре, ровно по спискам ролей из `enums.ts`: объекты, отделы, контрагент и работник справочника
 * (ADR 0102). `null` означает «своей оси у роли нет», и пропущенная здесь ось превращается в это
 * же `null` — то есть в витрину, которая печатает учётке «Все записи» вместо её области.
 */
export function scopeAxisOf(
  role: Role | null | undefined,
): 'object' | 'department' | 'counterparty' | 'person' | null {
  if (isObjectScopedRole(role)) return 'object';
  if (isDepartmentScopedRole(role)) return 'department';
  if (isCounterpartyScopedRole(role)) return 'counterparty';
  if (isPersonScopedRole(role)) return 'person';
  return null;
}
