import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  code: 'Код',
  name: 'Название',
  constructionObjectIds: 'Площадки',
  headUserIds: 'Руководители',
  isActive: 'Активен',
};

export const departmentErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
