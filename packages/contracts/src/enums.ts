import { z } from 'zod';

// ── Роли ──
export const ROLES = ['admin', 'manager', 'dispatcher', 'shtab', 'rukstroy', 'operator'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = (typeof ROLES)[number];

export const roleLabels: Record<Role, string> = {
  admin: 'Администратор',
  manager: 'Менеджер',
  dispatcher: 'Диспетчер',
  shtab: 'Штаб',
  rukstroy: 'Руководитель строительства',
  operator: 'Оператор (вывоз мусора)',
};

export const roleColors: Record<Role, string> = {
  admin: 'magenta',
  manager: 'geekblue',
  dispatcher: 'cyan',
  shtab: 'orange',
  rukstroy: 'purple',
  operator: 'green',
};

/**
 * Роли, работающие в пределах одного объекта строительства (ADR 0025): и видимость заявок,
 * и правки ограничены объектом учётки, поэтому объект у них обязателен — без него роль не
 * ограничена ничем и одновременно не видит ничего. Список здесь, а не в проверках доступа:
 * по нему и API требует объект при активации, и форма учётки показывает поле.
 */
export const OBJECT_SCOPED_ROLES = ['shtab', 'rukstroy'] as const;

export function isObjectScopedRole(role: Role | null | undefined): boolean {
  return !!role && (OBJECT_SCOPED_ROLES as readonly string[]).includes(role);
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
 * Откат закрытой заявки — право администратора: закрыли или отменили по ошибке, а завести
 * новую заявку вместо исправления означало бы потерять её номер и историю.
 */
export const requestStatusRollbacks: Record<RequestStatus, RequestStatus[]> = {
  new: [],
  confirmed: [],
  done: ['confirmed'],
  cancelled: ['new'],
};

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
 */
export function statusChangeRequiresReason(to: RequestStatus): boolean {
  return to === 'cancelled';
}

// ── Типы заявок (операции с контейнерами / вывоз) ──
export const REQUEST_TYPES = [
  'container_install',
  'container_replace',
  'container_removal',
  'waste_removal',
] as const;
export const requestTypeSchema = z.enum(REQUEST_TYPES);
export type RequestType = (typeof REQUEST_TYPES)[number];

export const requestTypeLabels: Record<RequestType, string> = {
  container_install: 'Установка нового контейнера',
  container_replace: 'Замена полного контейнера на пустой',
  container_removal: 'Снятие контейнера (вывоз без замены)',
  waste_removal: 'Вывоз мусора (разовый объём)',
};

export const requestTypeColors: Record<RequestType, string> = {
  container_install: 'green',
  container_replace: 'gold',
  container_removal: 'volcano',
  waste_removal: 'blue',
};

/** Буква типа заявки для человекочитаемого номера (№ = «<num>-<буква>»). */
export const requestTypeShort: Record<RequestType, string> = {
  container_install: 'У',
  container_replace: 'З',
  container_removal: 'Сн',
  waste_removal: 'ВМ',
};

/** Минимальный объём вывоза мусора (м³). */
export const MIN_WASTE_VOLUME_M3 = 8;

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
