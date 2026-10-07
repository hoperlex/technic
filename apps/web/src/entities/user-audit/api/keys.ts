import { createQueryKeys, type Query } from '@shared/api';

/**
 * Ключи запросов журнала изменений учётных записей (ADR 0109).
 *
 * Audit entries use this root. The current account card at the end of a path uses
 * `userAccountKeys.detail`, so account writes invalidate it with the rest of the account data.
 */
export const userAuditKeys = createQueryKeys('audit', {
  list: (params: Query) => ['list', params],
});
