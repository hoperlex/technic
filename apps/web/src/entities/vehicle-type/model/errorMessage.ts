import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  kindId: 'Вид техники',
  code: 'Код',
  name: 'Наименование',
  description: 'Описание',
  sortOrder: 'Порядок сортировки',
  isActive: 'Активен',
  isPassenger: 'Легковой тип',
  isLinear: 'Линейный тип',
  maintenanceByOdometer: 'Учёт ТО по пробегу',
  specId: 'Характеристика',
  backfillValue: 'Значение существующих категорий',
  values: 'Характеристики',
  shortName: 'Короткое имя',
  unit: 'Единица измерения',
  decimals: 'Знаков после запятой',
  minValue: 'Минимум',
  maxValue: 'Максимум',
};

export const vehicleTypeErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
