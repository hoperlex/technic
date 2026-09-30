import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  supplierId: 'Поставщик',
  address: 'Адрес',
  name: 'Метка',
  contactPerson: 'Контактное лицо',
  contactPhone: 'Телефон',
  comment: 'Комментарий',
  isActive: 'Активен',
};

export const warehouseErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
