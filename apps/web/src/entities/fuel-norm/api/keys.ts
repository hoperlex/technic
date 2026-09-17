import { createQueryKeys, type Query } from '@shared/api';

/**
 * Ключи запросов норм расхода.
 *
 * Настройки сверки стоят своим ключом, а не внутри списка: их читает и окно норм, и — после
 * правки — обязана перечитать сводка гаража, у которой свой ключ и свой период. Общий ключ
 * заставил бы сводку перезапрашиваться на каждое листание справочника.
 */
export const fuelNormKeys = createQueryKeys('fuel-norms', {
  list: (params: Query) => ['list', params],
  settings: () => ['settings'],
  count: () => ['count'],
});
