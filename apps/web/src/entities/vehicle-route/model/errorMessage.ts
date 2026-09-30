import { errorMessage } from '@shared/lib';

const VEHICLE_ROUTE_ERROR_LABELS: Record<string, string> = {
  vehicleId: 'Техника',
  driverId: 'Водитель',
  date: 'Дата рейса',
  requestId: 'Заявка',
  requestIds: 'Заявки',
  points: 'Точки маршрута',
  pointId: 'Точка маршрута',
  address: 'Адрес',
  arrivalTime: 'Время прибытия',
  responsibleName: 'Ответственный',
  responsiblePhone: 'Телефон ответственного',
  comment: 'Комментарий',
  reason: 'Причина',
  targetRouteId: 'Целевой рейс',
  trailerIds: 'Прицепы',
};

export const vehicleRouteErrorMessage = (error: unknown): string =>
  errorMessage(error, VEHICLE_ROUTE_ERROR_LABELS);
