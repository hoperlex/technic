import { z } from 'zod';

// ── Роли ──
export const ROLES = ['admin', 'manager', 'dispatcher', 'shtab'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = (typeof ROLES)[number];

export const roleLabels: Record<Role, string> = {
  admin: 'Администратор',
  manager: 'Менеджер',
  dispatcher: 'Диспетчер',
  shtab: 'Штаб',
};

export const roleColors: Record<Role, string> = {
  admin: 'magenta',
  manager: 'geekblue',
  dispatcher: 'cyan',
  shtab: 'orange',
};

/** Роли, которым доступна страница «Справочники». */
export const REFERENCE_MANAGER_ROLES: readonly Role[] = ['admin', 'manager'];
/** Роли, которые меняют статусы заявок. */
export const STATUS_CHANGE_ROLES: readonly Role[] = ['admin', 'manager', 'dispatcher'];

// ── Статусы заявки ──
export const REQUEST_STATUSES = ['new', 'confirmed', 'done', 'cancelled'] as const;
export const requestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const requestStatusLabels: Record<RequestStatus, string> = {
  new: 'Новая',
  confirmed: 'Подтверждена',
  done: 'Выполнена',
  cancelled: 'Отменена',
};

export const requestStatusColors: Record<RequestStatus, string> = {
  new: 'blue',
  confirmed: 'gold',
  done: 'green',
  cancelled: 'red',
};

/** Разрешённые переходы статусов (терминальные не переоткрываются). */
export const requestStatusTransitions: Record<RequestStatus, RequestStatus[]> = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

export function canTransitionStatus(from: RequestStatus, to: RequestStatus): boolean {
  return requestStatusTransitions[from].includes(to);
}

// ── Типы заявок (операции с контейнерами / вывоз) ──
export const REQUEST_TYPES = ['container_install', 'container_replace', 'waste_removal'] as const;
export const requestTypeSchema = z.enum(REQUEST_TYPES);
export type RequestType = (typeof REQUEST_TYPES)[number];

export const requestTypeLabels: Record<RequestType, string> = {
  container_install: 'Установка контейнера',
  container_replace: 'Замена контейнера',
  waste_removal: 'Вывоз мусора',
};

export const requestTypeColors: Record<RequestType, string> = {
  container_install: 'green',
  container_replace: 'gold',
  waste_removal: 'blue',
};

/** Минимальный объём вывоза мусора (м³). */
export const MIN_WASTE_VOLUME_M3 = 8;

// ── Типы контейнеров (управляемый справочник; данные в БД) ──
export const CONTAINER_TYPE_SEED = [
  { code: 'container_8', name: 'Контейнер 8 м³', sortOrder: 10 },
  { code: 'container_20', name: 'Контейнер 20 м³', sortOrder: 20 },
  { code: 'container_27', name: 'Контейнер 27 м³', sortOrder: 30 },
  { code: 'container_25_heavy', name: 'Контейнер 25 м³ для тяжёлых грузов', sortOrder: 40 },
] as const;

// ── Типы машин (самосвалы; управляемый справочник) ──
export const MACHINE_TYPE_SEED = [
  { code: 'dump_truck_25', name: 'Самосвал 25 м³', sortOrder: 10 },
  { code: 'dump_truck_36', name: 'Самосвал 36 м³', sortOrder: 20 },
] as const;

// ── Статусы файлов ──
export const FILE_STATUSES = ['pending', 'active', 'deleted'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];
