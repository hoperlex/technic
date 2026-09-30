import { errorMessage } from '@shared/lib';
import { serviceChatErrorLabels } from './fieldLabels';

const SERVICE_REQUEST_ERROR_LABELS: Record<string, string> = {
  ...serviceChatErrorLabels,
  officeEquipmentId: 'Оргтехника',
  equipmentCandidate: 'Сообщение о технике',
  objectId: 'Объект',
  objectOverridden: 'Техника находится не на своём объекте',
  kind: 'Чем помочь',
  consumables: 'Номенклатура',
  consumableId: 'Позиция номенклатуры',
  requestedQuantity: 'Количество',
  description: 'Описание',
  customerDepartmentId: 'Отдел-заказчик',
  responsibleName: 'Ответственный',
  responsiblePhone: 'Телефон ответственного',
  comment: 'Комментарий',
  warrantyClaim: 'Гарантийный случай',
  isUrgent: 'Срочная заявка',
  urgencyReason: 'Причина срочности',
  fileIds: 'Файлы',
  serviceCounterpartyId: 'Сервисная компания',
  userIds: 'Исполнители',
  reason: 'Причина',
  note: 'Примечание',
  outcome: 'Решение по спору',
  resolution: 'Решение',
  completedOn: 'Дата выполнения',
  items: 'Работы',
  actualQuantity: 'Фактическое количество',
  warrantyUntil: 'Гарантия до',
  adjustmentAmount: 'Корректировка суммы',
  adjustmentReason: 'Причина корректировки',
  status: 'Статус',
  serviceComment: 'Комментарий службы',
};

export const serviceRequestErrorMessage = (error: unknown): string =>
  errorMessage(error, SERVICE_REQUEST_ERROR_LABELS);
