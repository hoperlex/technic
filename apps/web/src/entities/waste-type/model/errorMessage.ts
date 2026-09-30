import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  name: 'Название',
  isActive: 'Активен',
};

export const wasteTypeErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
