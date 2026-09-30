import { errorMessage } from '@shared/lib';

const LABELS: Record<string, string> = {
  operatorCounterpartyId: 'Оператор',
  wasteTypeId: 'Тип мусора',
  wasteTypeName: 'Новый тип мусора',
  containerKind: 'Вид техники',
  containerTypeId: 'Тип машины/контейнера',
  pricePerContainer: 'Цена за контейнер',
  pricePerM3: 'Цена за м³',
  note: 'Пункт прайса',
  isActive: 'Действует',
};

export const wasteTariffErrorMessage = (error: unknown): string => errorMessage(error, LABELS);
