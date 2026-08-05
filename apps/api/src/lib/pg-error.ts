/**
 * Ошибка PostgreSQL из-под драйвера и ORM.
 *
 * Драйвер кладёт в ошибку код (`23503` — ссылка, `23505` — уникальность), имя таблицы-источника и
 * имя ограничения — по ним отказ БД переводится в человеческий 409. Но drizzle оборачивает
 * исходную ошибку в свою (`DrizzleQueryError`), и на верхнем объекте этих полей уже нет: они
 * лежат в `cause`. Проверка `e.code === '23503'` на обёртке молча не срабатывает, и вместо
 * «на запись ссылаются заявки» человек получает «внутреннюю ошибку сервера».
 *
 * Отсюда обход всей цепочки причин, а не одного уровня: обёрток может стать больше, а признак
 * «это ошибка БД» — всегда один и тот же код из пяти символов.
 */

export interface PgErrorInfo {
  code?: string;
  /** Таблица-источник ссылки в отказе по внешнему ключу. */
  table?: string;
  /** Имя нарушенного ограничения — им различают уникальные индексы одной таблицы. */
  constraint?: string;
}

/** Глубина обхода: страховка от кольца в `cause`, а не ограничение по существу. */
const MAX_DEPTH = 5;

export function pgErrorOf(e: unknown): PgErrorInfo | undefined {
  let current: unknown = e;
  for (let depth = 0; depth < MAX_DEPTH && current; depth += 1) {
    const candidate = current as PgErrorInfo & { cause?: unknown };
    // Код PostgreSQL — пять символов SQLSTATE: по нему обёртка отличается от самой ошибки БД.
    if (typeof candidate.code === 'string' && candidate.code.length === 5) {
      return { code: candidate.code, table: candidate.table, constraint: candidate.constraint };
    }
    current = candidate.cause;
  }
  return undefined;
}
