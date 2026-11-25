import { and, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import {
  isServiceWasteTypeCode,
  isServiceWasteTypeId,
  SERVICE_WASTE_TYPE_CODES,
  SNOW_COST_AT_COMPLETION_MESSAGE,
  SNOW_WASTE_TYPE_ID,
  SNOW_WASTE_TYPE_NAME,
  wasteTypeDuplicateMessage,
} from '@technic/contracts';
// Only to derive the transaction type: the module needs no pool, and its pure checks must be
// importable without a running database.
import type { db } from '../db/client';
import { wasteTypes, type WasteTypeRow } from '../db/schema';
import { type AppError, err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';

// Waste types (ADR 0017). The portal has no separate directory tab for them: a type is created
// together with its first price and edited from the tariff row, so the rules of creating it live
// next to the price list.
//
// The application does NOT copy the name normalization: both the check and the unique index rely on
// the SQL function `waste_type_name_key` (the ADR 0007 §2 technique). The contracts' twin exists
// only for the instant hint in the form; the source of truth is the database.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** A connection that reads: the pool and a transaction both fit. */
type Reader = Pick<Tx, 'select' | 'execute'>;

// ── The reserved service type «Снег» (snow-removal plan, S2, S10; migration 0429) ──
//
// The row exists for snow requests only: the server puts it on them, and nobody picks, prices,
// renames or purges it. Every directory entry point refuses it in this module's words before the
// database does; the SQL guards of migration 0429 stay the backstop for whatever bypasses the API
// (the previous release in the deploy window, a hand-written query) and answer only with a
// constraint name.

/**
 * Waste types a person may choose or edit: every row but the service types. Picker, tariff editor
 * and registry filter all read `GET /waste-types`, so excluding the rows there hides them from all
 * three. Both identities are excluded: the contracts list service types by code
 * (`SERVICE_WASTE_TYPE_CODES`), and the reserved id is the one the SQL guards hold.
 */
export function editableWasteTypes(): SQL {
  return and(
    ne(wasteTypes.id, SNOW_WASTE_TYPE_ID),
    notInArray(wasteTypes.code, [...SERVICE_WASTE_TYPE_CODES]),
  )!;
}

/** Refusal of any edit or purge of the service row: it is never renamed, deactivated or removed. */
export const SERVICE_WASTE_TYPE_LOCKED_MESSAGE = `«${SNOW_WASTE_TYPE_NAME}» — служебный тип заявок «Вывоз снега»: его ставит портал, и в справочнике его не переименовывают, не отключают и не удаляют`;

/**
 * Refusal of a name whose database key equals the reserved one. The reserved row already holds that
 * key under `waste_types_name_key_unique`, so without this text the person would read «такой тип уже
 * есть — выберите его в списке» about a type that no list offers.
 */
export const RESERVED_WASTE_TYPE_NAME_MESSAGE = `Название «${SNOW_WASTE_TYPE_NAME}» занято служебным типом заявок «Вывоз снега». ${SNOW_COST_AT_COMPLETION_MESSAGE}`;

/** The service row by either identity. UUIDs compare case-insensitively, codes after trimming. */
export function isServiceWasteTypeRow(row: { id: string; code: string }): boolean {
  return isServiceWasteTypeId(row.id) || isServiceWasteTypeCode(row.code);
}

/**
 * Field refusal of an edit of the service row, put on every field the request tried to change: the
 * form shows a field error next to its field, and a request that touched only `isActive` would
 * otherwise get a refusal marked on a field it never sent.
 */
export function serviceWasteTypeEditRefusal(fields: readonly string[]): AppError {
  const marked = fields.length > 0 ? fields : ['name'];
  return err.validation(
    Object.fromEntries(marked.map((field) => [field, SERVICE_WASTE_TYPE_LOCKED_MESSAGE])),
  );
}

/**
 * Does the name belong to the reserved service type? Asked of the database's own
 * `waste_type_name_key`, the function behind the unique index, and compared with the key of the
 * literal name rather than with the seeded row: the answer must not depend on the row being present.
 */
export async function isReservedWasteTypeName(conn: Reader, name: string): Promise<boolean> {
  const res = await conn.execute<{ reserved: boolean }>(
    sql`SELECT waste_type_name_key(${name}) = waste_type_name_key(${SNOW_WASTE_TYPE_NAME}) AS reserved`,
  );
  return res.rows[0]?.reserved === true;
}

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** Длина основы кода: остаток отведён под числовой суффикс при совпадении. */
const CODE_BASE_MAX = 40;

/**
 * Код типа из его названия: «Бетонный бой» → `betonnyy_boy`. Код — системный идентификатор
 * (на него ссылаются seed-миграции), человек его больше не вводит: с исчезновением справочника
 * форма спрашивает только название.
 */
export function wasteTypeCodeFromName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split('')
    .map((ch) => (/[a-z0-9]/.test(ch) ? ch : (TRANSLIT[ch] ?? '_')))
    .join('')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, CODE_BASE_MAX)
    .replace(/_$/, '');
  // Формат кода (CHECK waste_types_code_format_check) требует начала с латинской буквы:
  // название из одних цифр или иероглифов такой основы не даёт.
  return /^[a-z]/.test(base) ? base : `wt_${base}`.replace(/_$/, '');
}

/**
 * A free code derived from the name: a taken stem gets a numeric suffix. A service code counts as
 * taken even when no row holds it: «Snow» spelled in Latin derives `snow`, which the CHECK of
 * migration 0429 reserves for the service row alone.
 */
async function freeWasteTypeCode(conn: Reader, name: string): Promise<string> {
  const base = wasteTypeCodeFromName(name);
  const rows = await conn
    .select({ code: wasteTypes.code })
    .from(wasteTypes)
    .where(sql`${wasteTypes.code} = ${base} OR ${wasteTypes.code} LIKE ${`${base}\\_%`}`);
  const taken = new Set(rows.map((r) => r.code));
  const isFree = (code: string) => !taken.has(code) && !isServiceWasteTypeCode(code);
  if (isFree(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}_${i}`;
    if (isFree(candidate)) return candidate;
  }
}

/**
 * Тип с тем же нормализованным названием. Ключ считает БД той же функцией, что стоит за UNIQUE, —
 * иначе смысл индекса разошёлся бы с проверкой.
 */
export async function findWasteTypeByName(
  conn: Reader,
  name: string,
): Promise<{ id: string; name: string } | undefined> {
  const [row] = await conn
    .select({ id: wasteTypes.id, name: wasteTypes.name })
    .from(wasteTypes)
    .where(sql`${wasteTypes.nameKey} = waste_type_name_key(${name})`);
  return row;
}

/**
 * The name is free. Spelling variations («Бетонный бой» / «бетонный-бой») are not a new type but the
 * same one: a second row would split the pair «type × machinery» into two prices. The error field
 * comes from the caller: `wasteTypeName` of the tariff form on creation, `name` on rename.
 *
 * The reserved name is refused first and in its own words (`reservedMessage`, by default
 * `RESERVED_WASTE_TYPE_NAME_MESSAGE`): the duplicate text would send the person to a list that
 * never offers the service type.
 */
export async function assertWasteTypeNameFree(
  conn: Reader,
  name: string,
  opts: { field: string; excludeId?: string; reservedMessage?: string },
): Promise<void> {
  if (await isReservedWasteTypeName(conn, name)) {
    throw err.validation({
      [opts.field]: opts.reservedMessage ?? RESERVED_WASTE_TYPE_NAME_MESSAGE,
    });
  }
  const clash = await findWasteTypeByName(conn, name);
  if (clash && clash.id !== opts.excludeId) {
    throw err.validation({ [opts.field]: wasteTypeDuplicateMessage(clash.name) });
  }
}

/**
 * Creating a type. Similar names are deliberately not checked here: similarity is a warning of the
 * form, not a ban (ADR 0017 §4), and the decision stays with the person.
 *
 * A type is only ever created together with its first price (ADR 0017 §2), so the reserved name here
 * is an attempt to price snow, and the refusal says why snow has no price list (S6).
 */
export async function createWasteType(
  tx: Tx,
  name: string,
  field = 'wasteTypeName',
): Promise<WasteTypeRow> {
  await assertWasteTypeNameFree(tx, name, {
    field,
    reservedMessage: SNOW_COST_AT_COMPLETION_MESSAGE,
  });
  const code = await freeWasteTypeCode(tx, name);
  const [created] = await tx.insert(wasteTypes).values({ code, name }).returning();
  return created!;
}

/**
 * Гонка двух одинаковых названий доходит до UNIQUE в БД: 23505 без разбора превратился бы в 500,
 * хотя человеку нужно то же сообщение, что и при обычном дубле.
 */
export function asWasteTypeNameConflict(e: unknown, field: string): unknown {
  // Через `pgErrorOf`: drizzle оборачивает ошибку драйвера в свою, и на верхнем объекте кода уже
  // нет — проверка молчала бы, а гонка вместо подсказки давала бы 500.
  const pg = pgErrorOf(e);
  if (pg?.code === '23505' && pg.constraint === 'waste_types_name_key_unique') {
    return err.validation({
      [field]: 'Такой тип только что завели — обновите список и выберите его',
    });
  }
  return e;
}

/**
 * The guards of migration 0429 answering instead of the API: `waste_types_service_snow_check`
 * (23514), `waste_tariffs_not_service_type_check` (23514) and the no-delete trigger on the reserved
 * row (`restrict_violation`, 23001). The entry points refuse first, by the fixed reserved identity,
 * so a race should not reach these; but a request the portal meant to refuse must never come back
 * as a 500 with a constraint name in the log only. `field` marks the form field the refusal belongs
 * to. Any other error is returned unchanged for the next mapper.
 */
export function asServiceWasteTypeRefusal(e: unknown, field: string): unknown {
  const pg = pgErrorOf(e);
  if (pg?.code === '23514' && pg.constraint === 'waste_types_service_snow_check') {
    return err.validation({ [field]: SERVICE_WASTE_TYPE_LOCKED_MESSAGE });
  }
  if (pg?.code === '23514' && pg.constraint === 'waste_tariffs_not_service_type_check') {
    return err.validation({ [field]: SNOW_COST_AT_COMPLETION_MESSAGE });
  }
  // Only the trigger of migration 0429 raises 23001 on `waste_types`: a foreign key refusal, the
  // other way a purge fails, arrives as 23503 and is translated by `directory-purge.ts`.
  if (pg?.code === '23001') return err.conflict(SERVICE_WASTE_TYPE_LOCKED_MESSAGE);
  return e;
}
