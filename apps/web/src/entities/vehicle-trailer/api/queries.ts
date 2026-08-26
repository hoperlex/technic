import { queryOptions } from '@tanstack/react-query';
import { trailerKeys } from './keys';
import { vehicleTrailersApi } from './vehicleTrailersApi';

/**
 * Состав машины: что стоит в её слотах. Спрашивают его двое — окно привязки (под выбранную там
 * машину) и карточка самой машины, — и вопрос у них дословно один, поэтому ключ и параметры общие:
 * два ключа под один вопрос дали бы два ответа, расходящихся ровно на время между запросами.
 *
 * Ручка отбирает **по одной машине** (`hitchedVehicleId`, контракт списка), и это же определяет,
 * где вопрос уместен: в карточке — один запрос на открытие, в колонке списка — по запросу на
 * строку. Отсюда и `enabled`: без машины спрашивать нечего.
 *
 * `pageSize: 10` при двух слотах — не запас на вырост, а признание того, что страницу ручка
 * требует всегда: больше двух живых привязок у машины не бывает (`UNIQUE (hitched_vehicle_id,
 * hitch_position)` и слоты 1|2), а лишнее в ответе покажет наследство, легшее в базу помимо
 * портала.
 *
 * Порядок ответа — `createdAt` сервера; по слотам список расставляет показ (`VehicleTrailersField`).
 */
export const trailerSlotsQuery = (vehicleId: string | undefined) =>
  queryOptions({
    queryKey: trailerKeys.slots(vehicleId),
    queryFn: () => vehicleTrailersApi.list({ page: 1, pageSize: 10, hitchedVehicleId: vehicleId }),
    enabled: !!vehicleId,
  });
