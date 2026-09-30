import { errorMessage } from '@shared/lib';

const WEEKLY_REQUEST_ERROR_LABELS: Record<string, string> = {
  objectId: 'Объект строительства',
  constructionObjectId: 'Объект строительства',
  weekStart: 'Начало недели',
  items: 'Состав заявки',
  vehicleId: 'Техника',
  vehicleTypeId: 'Тип техники',
  action: 'Решение по технике',
  dateFrom: 'Дата начала',
  dateTo: 'Дата окончания',
  comment: 'Комментарий',
  reason: 'Причина',
  status: 'Статус',
  approved: 'Согласование',
};

export const weeklyRequestErrorMessage = (error: unknown): string =>
  errorMessage(error, WEEKLY_REQUEST_ERROR_LABELS);
