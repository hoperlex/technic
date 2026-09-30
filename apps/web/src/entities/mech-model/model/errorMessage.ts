import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  code: 'Код',
  name: 'Название',
  sortOrder: 'Порядок сортировки',
  isActive: 'Активна',
};

export const mechModelErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
