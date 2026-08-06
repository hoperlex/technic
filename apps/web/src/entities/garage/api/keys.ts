import { createQueryKeys, type Query } from '@shared/api';

/**
 * Ключи запросов гаража.
 *
 * Семейства разведены по вкладкам, а не по «списку и сводке»: у техники и водителей свои фильтры,
 * и общий ключ гасил бы соседнюю вкладку при каждой смене фильтра на текущей. День среза приходит
 * внутри параметров — по нему TanStack Query и различает запросы, поэтому переключение даты
 * показывает уже загруженный день мгновенно, а незагруженный тянет один раз.
 */
export const garageKeys = createQueryKeys('garage', {
  vehicles: (params: Query) => ['vehicles', params],
  vehiclesSummary: (params: Query) => ['vehicles-summary', params],
  drivers: (params: Query) => ['drivers', params],
  driversSummary: (params: Query) => ['drivers-summary', params],
});
