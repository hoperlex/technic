import { z } from 'zod';

// ── Роли ──
export const ROLES = [
  'admin',
  'manager',
  'dispatcher',
  'shtab',
  'rukstroy',
  'commandant',
  /**
   * Площадка (ADR 0112) — целевая роль реформы доступа: одна объектная роль вместо трёх. Заведена
   * до перевода учёток и до этого перевода никому не назначена: наборы «Заказ техники» и «Виза
   * объекта» объявляют её совместимой ролью (`grant_roles`), а строку с несуществующим значением
   * enum база не примет — значит роль обязана существовать раньше каталога, который на неё
   * ссылается.
   */
  'site',
  'department',
  'department_head',
  'operator',
  'observer',
  // Водитель (ADR 0102) — работник справочника, получивший вход в свой кабинет. Прав основного
  // портала у роли нет вовсе: она открывает `/driver` и ничего больше.
  'driver',
  // Служба главного механика: обе роли смотрят парк целиком и своей оси области не имеют — ОГМ
  // отвечает за технику компании, а не за площадку. Различаются одним: главный механик ведёт
  // водителей и списывает испорченные бланки, механик только смотрит.
  'mechanic',
  'chief_mechanic',
] as const;
export const roleSchema = z.enum(ROLES);
export type Role = (typeof ROLES)[number];

export const roleLabels: Record<Role, string> = {
  admin: 'Администратор',
  manager: 'Менеджер',
  dispatcher: 'Диспетчер',
  shtab: 'Штаб',
  rukstroy: 'Руководитель строительства',
  // Комендант — третий заказчик на объекте, но только по мусору: должность на площадке так и
  // называется, и подпись повторяет её, а не описывает набор прав.
  commandant: 'Комендант',
  // «Площадка», а не «Сотрудник объекта»: подпись называет место работы, потому что должностей за
  // ролью стоит несколько — штаб, руководитель строительства и комендант различаются не ролью, а
  // выданными полномочиями (план §9). Назови роль одной из должностей — и две другие читались бы
  // в списке учёток как понижение.
  site: 'Площадка',
  // Подписи по образцу «Штаба»: роль называет подразделение, а не должность внутри него.
  department: 'Отдел',
  department_head: 'Руководитель отдела',
  // Модуль в подписи не назван намеренно: что именно исполняет учётка — вывоз мусора или
  // аренду техники — решает тип её контрагента, а не роль (ADR 0038).
  operator: 'Оператор (внешний исполнитель)',
  observer: 'Наблюдатель',
  // Должность в подписи не названа: кабинет открыт машинисту и трактористу наравне с водителем
  // (ADR 0102), а «водитель» — как эту роль зовут в парке.
  driver: 'Водитель',
  // Должность, как её зовут в парке; «главный механик» — он же глава ОГМ, и подпись повторяет
  // штатное название, а не перечисляет права.
  mechanic: 'Механик',
  chief_mechanic: 'Главный механик',
};

export const roleColors: Record<Role, string> = {
  admin: 'magenta',
  manager: 'geekblue',
  dispatcher: 'cyan',
  shtab: 'orange',
  rukstroy: 'purple',
  // Комендант работает на той же площадке, что штаб, но в одном модуле — цвет своей, отдельной
  // пометки: в списке учёток эти две роли различают глазами.
  commandant: 'lime',
  // Свой цвет, а не оранжевый штаба: до этапа 8 обе роли живут рядом, и одинаковая пометка в
  // списке учёток означала бы, что перевод уже случился. `pink` — последний свободный пресет
  // палитры: остальные двенадцать разобраны ролями выше, и повтор читался бы как «та же служба».
  site: 'pink',
  // Отдел — заказчик со стороны офиса; цвета своей пары, но той же логики «сотрудник — светлее,
  // руководитель — насыщеннее», что у штаба и руководителя строительства.
  department: 'gold',
  department_head: 'volcano',
  operator: 'green',
  // Серый: роль ничего не ведёт, и в списке учёток она не должна спорить с теми, кто ведёт.
  observer: 'default',
  // Синий — цвет рейса в гараже: водитель и есть тот, кто в этом рейсе едет.
  driver: 'blue',
  // Пара службы главного механика — та же логика, что у штаба с руководителем: сотрудник светлее,
  // главный насыщеннее. Цвета свободные: `gold` и `volcano` уже заняты отделом, и повтор в списке
  // учёток читался бы как «та же служба».
  mechanic: 'yellow',
  chief_mechanic: 'red',
};

/**
 * Роли, работающие в пределах одного объекта строительства (ADR 0025): и видимость заявок,
 * и правки ограничены объектом учётки, поэтому объект у них обязателен — без него роль не
 * ограничена ничем и одновременно не видит ничего. Список здесь, а не в проверках доступа:
 * по нему и API требует объект при активации, и форма учётки показывает поле.
 *
 * Четыре имени вместо трёх — состояние перехода, а не целевое (план §11): `site` (ADR 0112) заведена
 * до перевода учёток, и до этапа 8 старые три живут рядом с ней. После перевода список сожмётся до
 * одной роли, и ось наконец совпадёт с ролью один к одному — как у `PERSON_SCOPED_ROLES` сегодня.
 *
 * Строка `site` здесь — единственное, что понадобилось слою области от новой роли: правила недельных
 * заявок спрашивают ось (`roleScopeAxis`), а не имя роли, и оттого приняли её без правки кода.
 */
export const OBJECT_SCOPED_ROLES = ['shtab', 'rukstroy', 'commandant', 'site'] as const;

export function isObjectScopedRole(role: Role | null | undefined): boolean {
  return !!role && (OBJECT_SCOPED_ROLES as readonly string[]).includes(role);
}

/**
 * Роли, работающие в пределах отдела (ADR 0040). Отдел — офисное подразделение, и с объектами
 * строительства он не пересекается: учётка привязана либо к объектам, либо к отделам, третьего
 * не дано. Поэтому это не расширение объектной оси, а вторая такая же — со своим списком.
 *
 * Список здесь, рядом с объектными ролями и ролями от контрагента, по той же причине: по нему
 * API требует отделы при активации, а форма учётки показывает поле.
 */
export const DEPARTMENT_SCOPED_ROLES = ['department', 'department_head'] as const;

export function isDepartmentScopedRole(role: Role | null | undefined): boolean {
  return !!role && (DEPARTMENT_SCOPED_ROLES as readonly string[]).includes(role);
}

/**
 * Работает ли роль в пределах подразделения — объекта или отдела. Нужен там, где правило одно на
 * обе оси: «правит заявку только пока она Новая», «область обязательна при активации», «поле
 * области в форме учётки». Перечислять две оси в каждом таком месте значит забыть одну из них
 * при появлении третьей.
 */
export function isPlaceScopedRole(role: Role | null | undefined): boolean {
  return isObjectScopedRole(role) || isDepartmentScopedRole(role);
}

/**
 * Роли, работающие от контрагента (ADR 0038): контрагент задаёт им и область видимости («чьи
 * заявки видны»), и сам модуль работы — он следует из типа контрагента. Отсюда обязательность
 * контрагента при активации и запрет менять тип контрагента, пока на нём висят учётки.
 *
 * Список здесь, рядом с объектными ролями, по той же причине: по нему API требует контрагента,
 * форма учётки показывает поле, а матрица прав знает, у кого спрашивать тип контрагента.
 */
export const COUNTERPARTY_SCOPED_ROLES = ['operator'] as const;

/**
 * Роли, работающие от карточки человека (ADR 0102) — четвёртая ось области после объектов,
 * отделов и контрагента, и самая узкая: видно только то, что про самого работника.
 *
 * Список здесь, рядом с остальными осями, по той же причине: по нему форма учётки требует
 * человека при активации, а API — при восстановлении из архива. Отличие от прочих осей одно:
 * область не описывается предикатом в `lib/access.ts`, она описывается отсутствием параметра —
 * `personId` кабинет не принимает вовсе и берёт из принципала.
 */
export const PERSON_SCOPED_ROLES = ['driver'] as const;

export function isPersonScopedRole(role: Role | null | undefined): boolean {
  return !!role && (PERSON_SCOPED_ROLES as readonly string[]).includes(role);
}

export function isCounterpartyScopedRole(role: Role | null | undefined): boolean {
  return !!role && (COUNTERPARTY_SCOPED_ROLES as readonly string[]).includes(role);
}

// Кто что может — в permissions.ts (ADR 0021): здесь только словари статусов и типов, чтобы
// списки ролей не расходились по файлам.

// ── Статусы заявки ──
export const REQUEST_STATUSES = ['new', 'confirmed', 'done', 'cancelled'] as const;
export const requestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

// Значение `confirmed` осталось от прежней формулировки статуса; переименовалась только подпись.
export const requestStatusLabels: Record<RequestStatus, string> = {
  new: 'Новая',
  confirmed: 'В работе',
  done: 'Выполнена',
  cancelled: 'Отменена',
};

export const requestStatusColors: Record<RequestStatus, string> = {
  new: 'blue',
  confirmed: 'gold',
  done: 'green',
  cancelled: 'red',
};

/**
 * Рабочий цикл заявки линейный: «Новая» → «В работе» → «Выполнена». Отменить можно только
 * незакрытую заявку; «Выполнена» и «Отменена» терминальны — назад заявку не возвращают.
 */
export const requestStatusTransitions: Record<RequestStatus, RequestStatus[]> = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

/**
 * Откат заявки назад по циклу — право администратора: взяли в работу, закрыли или отменили по
 * ошибке, а завести новую заявку вместо исправления означало бы потерять её номер и историю.
 *
 * Возврат из «В работе» в «Новую» отличается от остальных откатов тем, что **стирает работу**
 * (`transitionResetsWork`): назначенную технику, факт, рейс и визу. Прочие откаты, наоборот,
 * прежние данные берегут — повторное закрытие обходится уже предъявленным фактом.
 */
export const requestStatusRollbacks: Record<RequestStatus, RequestStatus[]> = {
  new: [],
  confirmed: ['new'],
  done: ['confirmed'],
  cancelled: ['new'],
};

/**
 * Стирает ли переход всё, что заявка нажила в работе.
 *
 * Такой переход один — возврат «В работе» → «Новая». Заявка после него должна выглядеть как
 * только что заведённая: иначе «Новая» с назначенной машиной, рейсом и визой означала бы, что
 * заявку и не снимали с работы. Отмена так не поступает — отменённая заявка остаётся историей
 * того, чем её собирались выполнять, и её ещё могут откатить обратно.
 *
 * Одна функция на портал и API: сервер по ней решает, что стереть, портал — что перечислить
 * человеку до нажатия. Разойдись они — сброс оказался бы неожиданностью.
 */
export function transitionResetsWork(from: RequestStatus, to: RequestStatus): boolean {
  return from === 'confirmed' && to === 'new';
}

/**
 * Единственный переход оператора (ADR 0010): взятую в работу заявку закрывает тот, кто её
 * выполнил. Подтверждать, отменять и откатывать заявки оператор не может — это решения заказчика.
 */
export const OPERATOR_STATUS_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  new: [],
  confirmed: ['done'],
  done: [],
  cancelled: [],
};

/**
 * Отмена заявки требует причины: заявка закрывается без результата, и без объяснения
 * ни автор, ни следующий диспетчер не поймут, почему.
 *
 * Того же требует возврат в «Новую» из работы: он стирает назначенную технику, факт и рейс, и
 * без объяснения в истории осталась бы пара переходов, по которой не понять, что случилось —
 * ошиблись машиной, отказался исполнитель или заявку завели не тому объекту. Исходный статус
 * необязателен: схема тела запроса знает только целевой (`from` ей взять неоткуда), а сервер и
 * портал спрашивают с обоими.
 */
export function statusChangeRequiresReason(to: RequestStatus, from?: RequestStatus): boolean {
  return to === 'cancelled' || (!!from && transitionResetsWork(from, to));
}

// ── Типы заявок (операции с контейнерами / вывоз) ──
export const REQUEST_TYPES = [
  'container_install',
  'container_replace',
  'container_removal',
  'waste_removal',
  'metal_removal',
] as const;
export const requestTypeSchema = z.enum(REQUEST_TYPES);
export type RequestType = (typeof REQUEST_TYPES)[number];

export const requestTypeLabels: Record<RequestType, string> = {
  container_install: 'Установка нового контейнера',
  container_replace: 'Замена полного контейнера на пустой',
  container_removal: 'Снятие контейнера (вывоз без замены)',
  waste_removal: 'Вывоз мусора (разовый объём)',
  metal_removal: 'Вывоз металлолома',
};

export const requestTypeColors: Record<RequestType, string> = {
  container_install: 'green',
  container_replace: 'gold',
  container_removal: 'volcano',
  waste_removal: 'blue',
  metal_removal: 'purple',
};

/**
 * Буква типа в номере заявок, заведённых до префикса «М-» (№ = «<num>-<буква>», миграция 0064).
 * Новых таких номеров не появляется — суффикс остаётся только у прежних заявок.
 *
 * У металлолома (ADR 0067) буква не используется ни разу: тип появился после префикса, и все его
 * заявки нумеруются «М-<num>». Стоит она здесь только потому, что перечень полон по типам —
 * пропуск означал бы, что у какого-то типа номера нет вовсе.
 */
export const requestTypeShort: Record<RequestType, string> = {
  container_install: 'У',
  container_replace: 'З',
  container_removal: 'Сн',
  waste_removal: 'ВМ',
  metal_removal: 'МЛ',
};

/** Минимальный объём вывоза мусора (м³). */
export const MIN_WASTE_VOLUME_M3 = 8;

// ── Тип заявки на технику ──
// Здесь, рядом с остальными перечнями, а не в vehicle-requests.ts: по типу заявки задан коридор
// ролей отдела (`allowedVehicleRequestTypes`, ADR 0040), а матрица прав лежит ниже по импортам —
// vehicle-requests.ts сам импортирует permissions.ts, и обратная ссылка замкнула бы круг.
export const VEHICLE_REQUEST_TYPES = ['special_equipment', 'freight_transport'] as const;
export const vehicleRequestTypeSchema = z.enum(VEHICLE_REQUEST_TYPES);
export type VehicleRequestType = (typeof VEHICLE_REQUEST_TYPES)[number];

export const vehicleRequestTypeLabels: Record<VehicleRequestType, string> = {
  special_equipment: 'Техника для работы на объекте',
  freight_transport: 'Грузоперевозка',
};

export const vehicleRequestTypeColors: Record<VehicleRequestType, string> = {
  special_equipment: 'geekblue',
  freight_transport: 'green',
};

// ── Вид записи справочника: контейнер или самосвал ──
export const CONTAINER_KINDS = ['cont', 'truck'] as const;
export const containerKindSchema = z.enum(CONTAINER_KINDS);
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

export const containerKindLabels: Record<ContainerKind, string> = {
  cont: 'Контейнер',
  truck: 'Самосвал',
};

export const containerKindColors: Record<ContainerKind, string> = {
  cont: 'blue',
  truck: 'orange',
};

// ── Типы контейнеров и машин (единый справочник; данные в БД) ──
// Контейнер 25 м³ для тяжёлых грузов выведен из обихода (миграция 0041): в справочнике он
// остаётся неактивным — на него ссылаются заведённые заявки.
export const CONTAINER_TYPE_SEED = [
  { code: 'container_8', name: 'Контейнер 8 м³', sortOrder: 10, type: 'cont' },
  { code: 'container_20', name: 'Контейнер 20 м³', sortOrder: 20, type: 'cont' },
  { code: 'container_27', name: 'Контейнер 27 м³', sortOrder: 30, type: 'cont' },
  { code: 'container_38', name: 'Контейнер 38 м³', sortOrder: 40, type: 'cont' },
  { code: 'dump_truck_25', name: 'Самосвал 25 м³', sortOrder: 50, type: 'truck' },
  { code: 'dump_truck_36', name: 'Самосвал 36 м³', sortOrder: 60, type: 'truck' },
] as const;

// ── Статусы файлов ──
export const FILE_STATUSES = ['pending', 'active', 'deleted'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];
