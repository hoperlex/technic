import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  lastName: 'Фамилия',
  firstName: 'Имя',
  middleName: 'Отчество',
  phone: 'Телефон',
  snils: 'СНИЛС',
  personnelNo: 'Табельный номер',
  email: 'Email',
  comment: 'Комментарий',
  series: 'Серия',
  number: 'Номер',
  issuedOn: 'Дата выдачи',
  expiresOn: 'Действительно до',
  categoryIds: 'Категории',
  deletePrevious: 'Предыдущий документ',
};

export const driverErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
