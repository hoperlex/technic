import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { warehousesApi } from './warehousesApi';
import { warehouseKeys } from './keys';

/**
 * Склады для выбора адреса (ADR 0069). Справочник небольшой и запрашивается целиком: поиск идёт на
 * клиенте, и список открывается без запроса на каждую букву.
 *
 * Склады приостановленного поставщика в список не попадают, хотя сами активны: деактивация
 * поставщика склады не гасит, но возить к тому, с кем не работают, незачем — и сервер такой адрес
 * на запись не примет. Опознаётся склад адресом, метка необязательна, поэтому в подписи вместо
 * пустой метки встаёт наименование поставщика: строка «— адрес» не назвала бы ничего.
 */
export const warehouseOptionsQuery = () =>
  queryOptions({
    queryKey: warehouseKeys.options(),
    queryFn: () =>
      warehousesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        isActive: 'true',
        sortBy: 'address',
        sortOrder: 'asc',
      }),
    select: (r) =>
      r.items
        .filter((w) => w.supplier.isActive)
        .map((w) => ({
          value: w.id,
          address: w.address,
          label: `${w.name || w.supplier.name} — ${w.address}`,
        })),
  });
