import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  code: 'Код',
  name: 'Название',
  sortOrder: 'Порядок',
  isActive: 'Активен',
  equipmentTypeId: 'Тип техники',
  modelId: 'Модель',
  serialNumber: 'Серийный номер',
  inventoryNumber: 'Инвентарный номер',
  objectId: 'Объект',
  departmentId: 'Отдел',
  location: 'Место установки',
  purchasedOn: 'Дата покупки',
  warrantyUntil: 'Гарантия до',
  comment: 'Комментарий',
};

export const officeEquipmentErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
