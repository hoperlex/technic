import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { wasteTypesApi } from './wasteTypesApi';
import { wasteTypeKeys } from './keys';

/**
 * Типы мусора для выпадающих списков. Справочник маленький и берётся целиком: поиск по нему идёт
 * на клиенте, там же проверяется похожесть названия при заведении нового типа.
 *
 * `pricedOnly` обязателен и умолчания не имеет: «обычного» вида у этого справочника нет — заявка
 * спрашивает то, что можно выбрать (действующий тип с действующей ценой), а прайс — всё
 * заведённое. Умолчание молча ошиблось бы в одном из двух мест.
 *
 * Без `select`: потребителям нужен сам тип целиком — признак активности рисуется в списке
 * пометкой, а по названиям идёт поиск двойников.
 */
export const wasteTypeOptionsQuery = ({ pricedOnly }: { pricedOnly: boolean }) =>
  queryOptions({
    queryKey: wasteTypeKeys.options({ pricedOnly }),
    queryFn: () =>
      wasteTypesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
        ...(pricedOnly ? { isActive: 'true', hasActiveTariff: 'true' } : {}),
      }),
  });
