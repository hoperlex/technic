import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  type: 'Тип',
  name: 'Наименование',
  inn: 'ИНН',
  synonyms: 'Синонимы',
  objectIds: 'Объекты',
  email: 'Email',
  comment: 'Комментарий',
  isActive: 'Активен',
};

export const counterpartyErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
