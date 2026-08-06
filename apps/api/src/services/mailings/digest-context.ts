import { and, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import {
  can,
  canUse,
  DIGEST_SECTION_ROW_LIMIT,
  type DigestSection,
  GLOBAL_ONLY_DIGEST_SECTIONS,
  isObjectScopedRole,
  isDepartmentScopedRole,
} from '@technic/contracts';
import type { Principal } from '../../auth/principal';
import { vehicleRequests, wasteRequests } from '../../db/schema';
import {
  operatorVisibilityWhere,
  vehicleRequestVisibilityWhere,
  wasteRequestVisibilityWhere,
} from '../../lib/access';

/**
 * Область видимости получателя дайджеста (ADR 0078).
 *
 * Главное правило письма: в нём нет ничего, чего человек не увидел бы, открыв портал под собой.
 * Поэтому раздел не «фильтруется под роль» — он строится ровно тем же условием, каким модуль
 * ограничивает свой список: те же функции из `lib/access.ts`, тот же `Principal`.
 *
 * Выбранная в расписании роль — фильтр получателей, а не выдача прав. Совпадение роли не добавляет
 * человеку ни строчки: если у него нет права на модуль, раздел этого модуля в его письме
 * отсутствует целиком.
 */

export interface DigestContext {
  principal: Principal;
  /** Период событий: предыдущий полный день или предыдущая полная неделя. */
  periodStart: string;
  periodEnd: string;
  /** Горизонт разделов «ближайшие»: от даты запуска вперёд. */
  upcomingFrom: string;
  upcomingTo: string;
  /** Площадки, вычтенные администратором из рассылки. */
  excludedObjectIds: string[];
  /** Отделы, вычтенные администратором из рассылки. */
  excludedDepartmentIds: string[];
}

export interface DigestRow {
  /** Строка письма целиком: раздел сам решает, что в ней важно. */
  text: string;
}

export interface DigestSectionResult {
  title: string;
  /** Сколько записей всего — печатается даже когда строк больше лимита. */
  total: number;
  rows: DigestRow[];
  /** Куда идти за остальным; пусто — экрана под этот раздел нет. */
  link?: string;
}

export type DigestSectionProvider = (ctx: DigestContext) => Promise<DigestSectionResult | null>;

/** Строк в разделе печатается не больше лимита: письмо — повод открыть портал, а не выгрузка. */
export function limitRows<T>(rows: T[]): T[] {
  return rows.slice(0, DIGEST_SECTION_ROW_LIMIT);
}

/**
 * Доступен ли раздел получателю. Проверяется до запроса: раздел, который человеку не положен, не
 * должен даже пытаться собрать данные — иначе «пусто» и «нельзя» стали бы одним состоянием.
 *
 * Разделы путевых листов и рейсов идут только тем, у кого нет ни объектной, ни отделовой оси: в
 * портале у этих модулей нет области видимости вовсе, и сузить их под площадку нечем.
 */
export function sectionAllowed(section: DigestSection, principal: Principal): boolean {
  if (GLOBAL_ONLY_DIGEST_SECTIONS.includes(section)) {
    const scoped =
      (principal.role !== null && isObjectScopedRole(principal.role)) ||
      (principal.role !== null && isDepartmentScopedRole(principal.role)) ||
      principal.counterpartyId !== null;
    return !scoped && can(principal, 'waybills.read');
  }
  if (section.startsWith('vehicle_')) return can(principal, 'vehicleRequests.read');
  if (section.startsWith('waste_')) return canUse(principal, 'wasteRequests.read');
  return false;
}

/**
 * Условие видимости заявок на технику для этого получателя, вместе с исключёнными областями.
 *
 * Исключение вычитается, а не добавляется: администратор может убрать площадку из рассылки, но не
 * может показать человеку то, чего он в портале не видит.
 */
export function vehicleRequestScope(ctx: DigestContext): SQL | undefined {
  const visibility = vehicleRequestVisibilityWhere(
    ctx.principal,
    vehicleRequests.objectId,
    vehicleRequests.departmentId,
  );
  const excludedObjects =
    ctx.excludedObjectIds.length > 0
      ? or(
          isNull(vehicleRequests.objectId),
          notInArray(vehicleRequests.objectId, ctx.excludedObjectIds),
        )
      : undefined;
  const excludedDepartments =
    ctx.excludedDepartmentIds.length > 0
      ? or(
          isNull(vehicleRequests.departmentId),
          notInArray(vehicleRequests.departmentId, ctx.excludedDepartmentIds),
        )
      : undefined;
  return and(
    // Удалённые в письмо не попадают никогда: право на архив есть только у администратора, а
    // сводка — не журнал удалений.
    isNull(vehicleRequests.deletedAt),
    visibility,
    excludedObjects,
    excludedDepartments,
    lessorScope(ctx.principal),
  );
}

/**
 * Заявки арендодателя: своей колонки исполнителя у заявки ТС нет, принадлежность определяется
 * назначенной техникой. Условие повторяет `assignedLessorWhere` из маршрутов заявок — там оно не
 * экспортировано, а расходиться этим двум местам нельзя: разойдясь, они покажут в письме заявки
 * чужого арендодателя.
 */
function lessorScope(principal: Principal): SQL | undefined {
  if (principal.counterpartyType !== 'vehicle_lessor') return undefined;
  const lessorId = principal.counterpartyId;
  if (!lessorId) return sql`false`;
  return sql`EXISTS (
    SELECT 1 FROM vehicle_request_assignments vra
    JOIN vehicles v ON v.id = vra.vehicle_id
    WHERE vra.request_id = ${vehicleRequests.id} AND v.lessor_id = ${lessorId}
  )`;
}

/** Условие видимости заявок на вывоз мусора для этого получателя. */
export function wasteRequestScope(ctx: DigestContext): SQL | undefined {
  const excludedObjects =
    ctx.excludedObjectIds.length > 0
      ? notInArray(wasteRequests.objectId, ctx.excludedObjectIds)
      : undefined;
  return and(
    isNull(wasteRequests.deletedAt),
    wasteRequestVisibilityWhere(ctx.principal, wasteRequests.objectId),
    operatorVisibilityWhere(ctx.principal, wasteRequests.operatorCounterpartyId),
    excludedObjects,
  );
}

/** Незакрытая заявка — «Новая» или «В работе»: остальные два статуса терминальные. */
export function openStatuses(column: typeof vehicleRequests.status | typeof wasteRequests.status) {
  return inArray(column, ['new', 'confirmed']);
}

/** Границы суток по часовому поясу портала: `timestamptz` сравнивается моментами, а не датами. */
export function dayBounds(dateOnly: string, timeZone: string): { from: Date; to: Date } {
  // Смещение зоны берётся у самой даты: у зон с переводом часов оно разное в разные дни.
  const probe = new Date(`${dateOnly}T12:00:00Z`);
  const offsetMinutes = zoneOffset(probe, timeZone);
  const from = new Date(new Date(`${dateOnly}T00:00:00Z`).getTime() - offsetMinutes * 60_000);
  const to = new Date(new Date(`${dateOnly}T23:59:59.999Z`).getTime() - offsetMinutes * 60_000);
  return { from, to };
}

function zoneOffset(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return (asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000;
}

/**
 * Отсекает «создание» из истории статусов: переход «— → Новая» пишется при заведении заявки, и без
 * этого условия заведённые за день посчитались бы дважды — и как новые, и как сменившие статус.
 */
export function realStatusChange(fromStatusColumn: unknown): SQL {
  return sql`${fromStatusColumn} IS NOT NULL`;
}
