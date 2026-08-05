import { and, eq, isNull, ne } from 'drizzle-orm';
import type { db } from '../db/client';
import { users } from '../db/schema';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';

/**
 * Занятость адреса учётки (ADR 0063). Отдельным модулем, потому что вопрос задают из трёх мест —
 * саморегистрация, создание учётки администратором, восстановление из архива, — а ответ должен
 * быть один: адрес занимает **действующая** учётка, архивная его освобождает.
 *
 * Разойдись эти три проверки, и расхождение выглядело бы не ошибкой, а особенностью: в одном
 * входе адрес свободен, в другом занят, и оба ответа правдоподобны.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const EMAIL_TAKEN = 'Пользователь с таким email уже существует';

/**
 * Проверка перед вставкой или восстановлением. `exceptId` — сама восстанавливаемая учётка: её
 * собственный адрес занятым не считается.
 *
 * Проверка не отменяет обработку `23505` (`asEmailConflict`): между `SELECT` и `INSERT` адрес
 * может занять параллельный запрос, и удержать это может только сам индекс.
 */
export async function assertEmailFree(
  tx: Tx,
  email: string,
  opts: { exceptId?: string; message?: string } = {},
): Promise<void> {
  const dup = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.email, email),
        isNull(users.deletedAt),
        opts.exceptId ? ne(users.id, opts.exceptId) : undefined,
      ),
    );
  if (dup.length > 0) throw err.conflict(opts.message ?? EMAIL_TAKEN);
}

/**
 * Гонка двух регистраций с одним адресом доходит до частичного UNIQUE в БД. Без разбора `23505`
 * превратился бы в 500 «внутренняя ошибка сервера», хотя человеку нужно ровно то же сообщение,
 * что и при обычном дубле, — и то же, что он получил бы секундой раньше.
 */
export function asEmailConflict(e: unknown, message = EMAIL_TAKEN): unknown {
  // Разбор идёт по цепочке причин: drizzle прячет ошибку драйвера внутрь своей.
  const pg = pgErrorOf(e);
  if (pg?.code === '23505' && pg.constraint === 'users_email_unique') {
    return err.conflict(message);
  }
  return e;
}
