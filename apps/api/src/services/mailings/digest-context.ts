import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  type AudienceMode,
  DIGEST_TABLE_ROW_LIMIT,
  type DigestRequestScope,
} from '@technic/contracts';
import type { Principal } from '../../auth/principal';
import { vehicleRequests } from '../../db/schema';
import { vehicleRequestVisibilityWhere } from '../../lib/access';

/**
 * Область видимости получателя сводки (ADR 0078, ADR 0093).
 *
 * Главное правило письма: в нём нет ничего, чего человек не увидел бы, открыв портал под собой.
 * Поэтому строки не «фильтруются под роль» — они строятся ровно тем же условием, каким модуль
 * ограничивает свой список: те же функции из `lib/access.ts`, тот же `Principal`.
 *
 * Выбранная в расписании роль — фильтр получателей, а не выдача прав. Совпадение роли не добавляет
 * человеку ни строчки: нет права на модуль — письмо не собирается вовсе.
 */

export interface DigestContext {
  principal: Principal;
  /** Окно данных, календарными датами включительно: `from` — первый день, `to` — последний. */
  windowFrom: string;
  windowTo: string;
  /** Чьи заявки показывать. */
  requestScope: DigestRequestScope;
  /** Как заданы площадки и отделы рассылки; при `all` перечни пусты и в условие не идут. */
  scopeMode: AudienceMode;
  objectIds: string[];
  departmentIds: string[];
}

/** Строк таблицы печатается не больше лимита: письмо — повод открыть портал, а не выгрузка. */
export function limitRows<T>(rows: T[]): T[] {
  return rows.slice(0, DIGEST_TABLE_ROW_LIMIT);
}

/**
 * Условие видимости заявок на технику для этого получателя, вместе с охватом расписания.
 *
 * Три сужения подряд, и порядок здесь не декоративный: сначала своя область получателя, потом —
 * охват. Ни одно из них не расширяет предыдущее, поэтому «все площадки рассылки» никогда не
 * покажет человеку больше, чем его собственный список площадок.
 */
export function vehicleRequestScope(ctx: DigestContext): SQL | undefined {
  return and(
    // Удалённые в письмо не попадают никогда: право на архив есть только у администратора, а
    // сводка — не журнал удалений.
    isNull(vehicleRequests.deletedAt),
    vehicleRequestVisibilityWhere(
      ctx.principal,
      vehicleRequests.objectId,
      vehicleRequests.departmentId,
    ),
    lessorScope(ctx.principal),
    requestScopeWhere(ctx),
  );
}

/**
 * Охват заявок (ADR 0093): чьи заявки показывать внутри области получателя.
 *
 * `author` — только заведённые им самим. `scope` — вся его область, отмеченные площадки при этом не
 * участвуют: они отбирают получателей, а не данные. `all` — область, пересечённая с отмеченными
 * площадками и отделами; при режиме «все» пересекать не с чем, и условия нет.
 */
function requestScopeWhere(ctx: DigestContext): SQL | undefined {
  if (ctx.requestScope === 'author') return eq(vehicleRequests.createdBy, ctx.principal.id);
  if (ctx.requestScope !== 'all' || ctx.scopeMode !== 'selected') return undefined;

  // Пустой набор в `inArray` drizzle разворачивает в `false`; собираем условие только из
  // непустых половин, иначе отмеченные площадки без единого отдела вынесли бы из письма всё.
  const parts: SQL[] = [];
  if (ctx.objectIds.length > 0) parts.push(inArray(vehicleRequests.objectId, ctx.objectIds));
  if (ctx.departmentIds.length > 0) {
    parts.push(inArray(vehicleRequests.departmentId, ctx.departmentIds));
  }
  // Отмечено «перечисленные», но перечень пуст — такого состояния контракт не допускает; если оно
  // всё же случилось, честнее показать пусто, чем всё.
  if (parts.length === 0) return sql`false`;
  return parts.length === 1 ? parts[0] : or(...parts);
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
