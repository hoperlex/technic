import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  kind: 'Тип ТС',
  registrationNumber: 'Госномер',
  model: 'Марка',
  vin: 'VIN',
  passportNumber: 'ПТС',
  manufacturedYear: 'Год выпуска',
  color: 'Цвет',
  maxMassKg: 'Максимальная масса',
  curbMassKg: 'Масса без нагрузки',
  status: 'Состояние',
  ownerId: 'Собственник',
  note: 'Примечание',
  vehicleId: 'Машина',
  position: 'Слот бланка',
};

export const vehicleTrailerErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
