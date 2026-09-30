import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  code: 'Код',
  name: 'Название',
  type: 'Тип',
  sortOrder: 'Порядок сортировки',
  isActive: 'Активен',
};

export const containerTypeErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
