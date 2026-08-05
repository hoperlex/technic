import { sql } from 'drizzle-orm';
import { wasteTypeDuplicateMessage } from '@technic/contracts';
// Только для вывода типа транзакции: связь с пулом не нужна, чистые проверки должны быть
// импортируемы без поднятой БД.
import type { db } from '../db/client';
import { wasteTypes, type WasteTypeRow } from '../db/schema';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';

// Типы мусора (ADR 0017). Отдельного справочника в интерфейсе нет: тип заводится вместе с первой
// ценой и правится в строке тарифа, поэтому и правила его заведения живут рядом с прайсом.
//
// Нормализацию названия приложение НЕ дублирует: и проверка, и уникальный индекс опираются на
// SQL-функцию waste_type_name_key (приём ADR 0007 §2). Двойник в контрактах существует только
// ради мгновенной подсказки в форме — источник истины здесь, в БД.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Читающее соединение: подходит и пул, и транзакция. */
type Reader = Pick<Tx, 'select'>;

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

/** Свободный код на основе названия: занятая основа получает числовой суффикс. */
async function freeWasteTypeCode(conn: Reader, name: string): Promise<string> {
  const base = wasteTypeCodeFromName(name);
  const rows = await conn
    .select({ code: wasteTypes.code })
    .from(wasteTypes)
    .where(sql`${wasteTypes.code} = ${base} OR ${wasteTypes.code} LIKE ${`${base}\\_%`}`);
  const taken = new Set(rows.map((r) => r.code));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
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
 * Название свободно. Вариации написания («Бетонный бой» / «бетонный-бой») — не новый тип, а тот же
 * самый: вторая строка развалила бы пару «тип × техника» на две цены. Поле ошибки задаётся вызовом:
 * при заведении это `wasteTypeName` формы тарифа, при переименовании — `name`.
 */
export async function assertWasteTypeNameFree(
  conn: Reader,
  name: string,
  opts: { field: string; excludeId?: string },
): Promise<void> {
  const clash = await findWasteTypeByName(conn, name);
  if (clash && clash.id !== opts.excludeId) {
    throw err.validation({ [opts.field]: wasteTypeDuplicateMessage(clash.name) });
  }
}

/**
 * Заведение типа. Похожие названия здесь не проверяются намеренно: похожесть — предупреждение
 * формы, а не запрет (ADR 0017 §4), и решение остаётся за человеком.
 */
export async function createWasteType(
  tx: Tx,
  name: string,
  field = 'wasteTypeName',
): Promise<WasteTypeRow> {
  await assertWasteTypeNameFree(tx, name, { field });
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
