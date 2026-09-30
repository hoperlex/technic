import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  ownership: 'Принадлежность',
  classificationKey: 'Тип/категория ТС',
  lessorId: 'Арендодатель',
  description: 'Описание',
  pricePerHour: 'Цена за час',
  pricePerShift: 'Цена за смену',
  shiftHours: 'Часов в смене',
  status: 'Статус',
  vehicleModelId: 'Марка/модель',
  registrationNumber: 'Госномер',
  passportNumber: 'ПТС / ПСМ',
  note: 'Примечание',
};

export const vehicleErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
