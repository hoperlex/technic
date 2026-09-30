import { errorMessage } from '@shared/lib';

const GRANT_ERROR_LABELS: Record<string, string> = {
  code: 'Код',
  name: 'Наименование',
  description: 'Описание',
  permissions: 'Права',
  roles: 'Роли',
  operation: 'Действие',
  grantId: 'Полномочие',
  expectedVersion: 'Версия',
  expectedImpactHash: 'Подтверждённые последствия',
};

/** Human-readable validation fields for grant catalog and assignment mutations. */
export function grantErrorMessage(error: unknown): string {
  return errorMessage(error, GRANT_ERROR_LABELS);
}
