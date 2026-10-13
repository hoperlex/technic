import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * Order mode: by days (linear equipment) or by weeks of standing on a site.
 *
 * The norm is ADR 0100 §1: the flag is read **live** by joining the ordered type; a request holds
 * no snapshot. The linear-switch workaround added exactly one exception: a request caught by a
 * switch carries a snapshot (`vehicle_requests.is_linear_frozen`, migration 0137) and is run by
 * it until it leaves "В работе".
 *
 * Hence the single mode expression for the whole portal:
 *
 *     coalesce(vehicle_requests.is_linear_frozen, vehicle_types.is_linear)
 *
 * **There must be no second such place.** The flag has seven independent readers: the request
 * DTO, trip packing, order days, the ESM-2 mode, two different garage queries and the mailing
 * digest. A forgotten reader does not fail loudly - it silently puts the request back on the live
 * mode: a frozen order stops occupying its vehicle, the garage shows it free, and a second order
 * lands on the same days. So a request query must never touch `vehicleTypes.isLinear`; the
 * `linear-mode-readers` test guards this.
 *
 * Three forms because there are three ways to ask: a drizzle expression, raw SQL and values that
 * are already read. They cannot drift apart - all three write the same formula.
 *
 * This module and the snapshot columns are permanent. The owner decided on 2026-10-12 (survey
 * S-13, ADR 0107 "Owner decision") to keep switching linearity under live orders as a feature of
 * the type directory, which cancelled the cleanup chain that would have dropped the columns and
 * returned the seven readers to a direct directory read. Removing the snapshot is a new decision,
 * not leftover work: do not read the old hotfix plan's section 9 as a to-do list.
 */
export function requestIsLinearSql(isLinearFrozen: PgColumn, typeIsLinear: PgColumn): SQL<boolean> {
  return sql<boolean>`coalesce(${isLinearFrozen}, ${typeIsLinear})`;
}

/**
 * То же выражение для сырого SQL, где таблицы названы алиасами: `specialBusyExists` в гараже
 * собирает `EXISTS` строкой и подставить в него колонки drizzle нечем.
 *
 * Алиасы передаются вызывающим, потому что имя алиаса — часть его запроса: `ga_r`/`ga_vt` у
 * занятости, свои у следующего читателя. Возвращается кусок выражения, а не условие целиком:
 * одному нужно `NOT (…)`, другому равенство `false`.
 */
export function requestIsLinearRawSql(requestAlias: string, typeAlias: string): SQL<boolean> {
  return sql<boolean>`coalesce(${sql.raw(requestAlias)}.is_linear_frozen, ${sql.raw(typeAlias)}.is_linear)`;
}

/**
 * TS-двойник для мест, где обе величины уже прочитаны: DTO, сверки, правила контрактов.
 *
 * `isLinearFrozen` — значение колонки заявки как есть, включая `null` (снимка нет — читаем
 * справочник). Отдельного «а вдруг undefined» здесь нет намеренно: неизвестное значение снимка —
 * это не «нет снимка», а недочитанная строка, и молчаливо подставлять справочник в таком месте
 * значит вернуть ровно ту ошибку, ради которой модуль и заведён.
 */
export function requestIsLinear(input: {
  isLinearFrozen: boolean | null;
  typeIsLinear: boolean;
}): boolean {
  return input.isLinearFrozen ?? input.typeIsLinear;
}
