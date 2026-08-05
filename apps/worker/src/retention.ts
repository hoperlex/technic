/**
 * Срок хранения отклонённых заявок на регистрацию (ADR 0063 решение 7).
 *
 * Удаляется строка, у которой сошлись три признака: она в архиве дольше срока, у неё нет роли и
 * она не активна. Вместе это означает ровно одно — заявка на регистрацию, которой отказали (или
 * которую удалили нерассмотренной) и которая в портале ничего не делала. Учётка с ролью под
 * условие не подходит никогда: её судьбу решает человек, а не таймер.
 *
 * Отдельным модулем от цикла воркера, потому что это единственная его часть, которую нужно
 * проверять на живой схеме: условие отбора здесь — это и есть всё решение.
 */

export interface RetentionClient {
  query<R extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** Псевдоним, а не `interface`: строку из БД принимает только тип с индексной сигнатурой. */
export type ExpiredRegistration = { id: string; email: string };

export interface RetentionResult {
  purged: ExpiredRegistration[];
  /** Строки, которые удержали внешние ключи: таких быть не должно, но молчать о них нельзя. */
  skipped: ExpiredRegistration[];
}

/**
 * Одна порция уборки. Порция ограничена по той же причине, что и у очистки незавершённых
 * загрузок: разовое удаление накопившегося не должно держать транзакцию.
 *
 * Клиент нужен выделенный (не пул): удаление и запись в журнал идут одной транзакцией — иначе
 * от учётки не осталось бы ни строки, ни следа. Каждая строка удаляется под своим SAVEPOINT:
 * ссылка, которой сегодня не бывает, иначе роняла бы всю порцию — и роняла бы каждый час.
 */
export async function purgeExpiredRegistrations(
  client: RetentionClient,
  opts: { ttlDays: number; limit?: number },
): Promise<RetentionResult> {
  const limit = opts.limit ?? 200;
  const candidates = await client.query<ExpiredRegistration>(
    `SELECT id, email FROM users
      WHERE deleted_at < now() - ($1 || ' days')::interval
        AND role IS NULL
        AND is_active = false
      ORDER BY deleted_at
      LIMIT $2`,
    [String(opts.ttlDays), limit],
  );
  const result: RetentionResult = { purged: [], skipped: [] };
  if (candidates.rows.length === 0) return result;

  await client.query('BEGIN');
  try {
    for (const row of candidates.rows) {
      await client.query('SAVEPOINT purge_user');
      try {
        await client.query('DELETE FROM users WHERE id = $1', [row.id]);
        // Журнал — единственное, что останется от строки: `audit_log.actor_user_id` объявлен
        // ON DELETE SET NULL, и события самой учётки после удаления остаются без актора.
        // Актора у этой записи нет и по существу: удалил срок, а не человек.
        await client.query(
          `INSERT INTO audit_log (action, entity_type, entity_id, metadata)
           VALUES ('user.purge_expired', 'user', $1,
                   jsonb_build_object('email', $2::text, 'ttlDays', $3::int))`,
          [row.id, row.email, opts.ttlDays],
        );
        await client.query('RELEASE SAVEPOINT purge_user');
        result.purged.push(row);
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT purge_user');
        if ((e as { code?: string }).code === '23503') {
          result.skipped.push(row);
          continue;
        }
        throw e;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  return result;
}
