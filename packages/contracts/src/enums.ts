import { z } from 'zod';

// ── Роли ──
export const ROLES = ['admin', 'manager', 'dispatcher', 'shtab', 'operator'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = (typeof ROLES)[number];

export const roleLabels: Record<Role, string> = {
  admin: 'Администратор',
  manager: 'Менеджер',
  dispatcher: 'Диспетчер',
  shtab: 'Штаб',
  operator: 'Оператор (вывоз мусора)',
};

export const roleColors: Record<Role, string> = {
  admin: 'magenta',
  manager: 'geekblue',
  dispatcher: 'cyan',
  shtab: 'orange',
  operator: 'green',
};

/** Роли, которым доступна страница «Справочники». */
export const REFERENCE_MANAGER_ROLES: readonly Role[] = ['admin', 'manager'];
/** Роли, которые ведут заявки: создают, редактируют и меняют статусы без ограничения оператора. */
export const STATUS_CHANGE_ROLES: readonly Role[] = ['admin', 'manager', 'dispatcher'];

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

/** Статусы, доступные роли из текущего статуса (пустой список — смена статуса запрещена). */
export function allowedStatusTransitions(from: RequestStatus, role: Role): RequestStatus[] {
  if (role === 'operator') return OPERATOR_STATUS_TRANSITIONS[from];
  if (!STATUS_CHANGE_ROLES.includes(role)) return [];
  return role === 'admin'
    ? [...requestStatusTransitions[from], ...requestStatusRollbacks[from]]
    : requestStatusTransitions[from];
}

export function canTransitionStatus(from: RequestStatus, to: RequestStatus, role: Role): boolean {
  return allowedStatusTransitions(from, role).includes(to);
}

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
  waste_removal: 'Вывоз мусора (самосвалами)',
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
export const CONTAINER_TYPE_SEED = [
  { code: 'container_8', name: 'Контейнер 8 м³', sortOrder: 10, type: 'cont' },
  { code: 'container_20', name: 'Контейнер 20 м³', sortOrder: 20, type: 'cont' },
  { code: 'container_27', name: 'Контейнер 27 м³', sortOrder: 30, type: 'cont' },
  { code: 'container_25_heavy', name: 'Контейнер 25 м³ для тяжёлых грузов', sortOrder: 40, type: 'cont' },
  { code: 'dump_truck_25', name: 'Самосвал 25 м³', sortOrder: 50, type: 'truck' },
  { code: 'dump_truck_36', name: 'Самосвал 36 м³', sortOrder: 60, type: 'truck' },
] as const;

// ── Статусы файлов ──
export const FILE_STATUSES = ['pending', 'active', 'deleted'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];
