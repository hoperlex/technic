import { errorMessage } from '@shared/lib';

const VEHICLE_REQUEST_ERROR_LABELS: Record<string, string> = {
  objectId: 'Объект строительства',
  constructionObjectId: 'Объект строительства',
  requestType: 'Тип заявки',
  vehicleTypeId: 'Тип техники',
  vehicleCategoryId: 'Категория техники',
  vehicleId: 'Техника',
  driverId: 'Водитель',
  machinistId: 'Машинист',
  dateFrom: 'Дата начала',
  dateTo: 'Дата окончания',
  scheduledAt: 'Время подачи',
  workStartTime: 'Начало работы',
  workEndTime: 'Окончание работы',
  trips: 'Ездки',
  loadingLocation: 'Адрес погрузки',
  unloadingLocation: 'Адрес разгрузки',
  volumeM3: 'Объём',
  weightTons: 'Вес',
  responsibleName: 'Ответственный',
  responsiblePhone: 'Телефон ответственного',
  comment: 'Комментарий',
  completion: 'Фактические данные',
  reason: 'Причина',
  status: 'Статус',
  approved: 'Согласование',
  fileIds: 'Файлы',
  date: 'Дата',
};

export const vehicleRequestErrorMessage = (error: unknown): string =>
  errorMessage(error, VEHICLE_REQUEST_ERROR_LABELS);
