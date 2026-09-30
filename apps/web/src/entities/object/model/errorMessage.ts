import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  code: 'Код',
  name: 'Название',
  address: 'Адрес',
  operatorIds: 'Операторы вывоза',
  isActive: 'Активен',
};

export const objectErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
