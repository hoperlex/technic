import { queryOptions } from '@tanstack/react-query';
import { trailerKeys } from './keys';
import { vehicleTrailersApi } from './vehicleTrailersApi';

export const trailerListQuery = (params: Parameters<typeof vehicleTrailersApi.list>[0]) =>
  queryOptions({
    queryKey: trailerKeys.list(params),
    queryFn: () => vehicleTrailersApi.list(params),
  });

/**
 * Состав машины: что стоит в её слотах. Спрашивают его двое — окно привязки (под выбранную там
 * машину) и карточка самой машины, — и вопрос у них дословно один, поэтому ключ и параметры общие:
 * два ключа под один вопрос дали бы два ответа, расходящихся ровно на время между запросами.
 *
 * Ручка отбирает **по одной машине** (`hitchedVehicleId`, контракт списка), и это же определяет,
 * где вопрос уместен: в карточке — один запрос на открытие, в колонке списка — по запросу на
 * строку. Отсюда и `enabled`: без машины спрашивать нечего.
 *
 * Страницу ручка требует всегда, а размер её выбирает не спрашивающий: допустимы только
 * `PAGE_SIZES` контракта (50|100|200|500), и `pageSize: 10`, стоявший здесь по числу слотов,
 * ручка отклоняла с 400 — «Прицепы за машиной» в карточке техники показывали ошибку вместо
 * состава. Берётся наименьший допустимый: больше двух живых привязок у машины не бывает
 * (`UNIQUE (hitched_vehicle_id, hitch_position)` и слоты 1|2), а лишнее в ответе покажет
 * наследство, легшее в базу помимо портала.
 *
 * Порядок ответа — `createdAt` сервера; по слотам список расставляет показ (`VehicleTrailersField`).
 */
export const trailerSlotsQuery = (vehicleId: string | undefined) =>
  queryOptions({
    queryKey: trailerKeys.slots(vehicleId),
    queryFn: () => vehicleTrailersApi.list({ page: 1, pageSize: 50, hitchedVehicleId: vehicleId }),
    enabled: !!vehicleId,
  });

/**
 * Параметры списка выбора: весь живой реестр одной страницей, по госномеру.
 *
 * Отбор по состоянию ручке не отдан намеренно: `status` у неё — равенство, а нужно «кроме
 * списанных», и вторым запросом это стоило бы двух ответов на один вопрос. Архива в ответе не
 * бывает вовсе — удалённых ручка отдаёт только по `includeDeleted`, которого здесь нет.
 */
const PICKER_PARAMS = {
  page: 1,
  pageSize: 200,
  sortBy: 'registrationNumber',
  sortOrder: 'asc',
} as const;

/**
 * Route forms share one cached, registration-ordered trailer page. The server only supports an
 * exact status filter, so this observer removes retired and deleted units locally while historical
 * trailer slots keep their saved snapshot (R11). The picker is enabled by its caller when needed.
 */
export const trailerPickerQuery = () => {
  const base = trailerListQuery(PICKER_PARAMS);
  return {
    queryKey: base.queryKey,
    queryFn: base.queryFn,
    staleTime: 5 * 60 * 1000,
    select: (page: Awaited<ReturnType<typeof vehicleTrailersApi.list>>) =>
      page.items.filter((t) => t.status !== 'retired' && !t.deletedAt),
  };
};
