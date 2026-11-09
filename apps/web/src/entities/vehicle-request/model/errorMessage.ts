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
  cargoName: 'Что везём',
  loadingLocation: 'Адрес погрузки',
  unloadingLocation: 'Адрес разгрузки',
  volumeM3: 'Объём',
  // The trip field reads «Масса, т»; a different word in the error sent people looking for a field
  // that does not exist.
  weightTons: 'Масса',
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

/**
 * With reasons: a requester must see why a field was refused, not only which one (ADR 0247).
 */
export const vehicleRequestErrorMessage = (error: unknown): string =>
  errorMessage(error, VEHICLE_REQUEST_ERROR_LABELS, { reasons: true });
