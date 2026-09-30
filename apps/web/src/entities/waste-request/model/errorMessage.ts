import { errorMessage } from '@shared/lib';

const WASTE_REQUEST_ERROR_LABELS: Record<string, string> = {
  objectId: 'Объект строительства',
  requestType: 'Тип заявки',
  containerTypeId: 'Тип машины/контейнера',
  wasteTypeId: 'Тип мусора',
  volumeM3: 'Объём',
  weightTons: 'Вес',
  operatorCounterpartyId: 'Оператор вывоза',
  deliveryAt: 'Дата доставки',
  comment: 'Комментарий',
  completion: 'Фактические данные',
  ownerMismatchReason: 'Причина вывоза чужого контейнера',
  containerGroupKey: 'Контейнер',
  containersCount: 'Количество контейнеров',
  removedOn: 'Дата вывоза',
  totalCost: 'Стоимость',
  ticketIds: 'Талоны',
  operatorComment: 'Примечание исполнителя',
  reason: 'Причина',
  status: 'Статус',
};

export const wasteRequestErrorMessage = (error: unknown): string =>
  errorMessage(error, WASTE_REQUEST_ERROR_LABELS);
