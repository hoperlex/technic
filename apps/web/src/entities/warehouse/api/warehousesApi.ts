import type { CreateWarehouseInput, UpdateWarehouseInput, WarehouseDto } from '@technic/contracts';
import { createListApi, createRemoveApi, createWriteApi } from '@shared/api';

/**
 * Справочник складов поставщиков (ADR 0051).
 *
 * Умения кончаются на удалении, и это не недоделка: удаление здесь настоящее — ссылок на склад
 * пока нет, и ошибочный адрес вычищают, а не держат выключенным в списках. Отсюда и ответ
 * `{ ok }` вместо карточки (возвращать нечего), и отсутствие `purge`: второй шаг нужен там, где
 * первый только гасит запись.
 */
export const warehousesApi = {
  ...createListApi<WarehouseDto>('/warehouses'),
  ...createWriteApi<WarehouseDto, CreateWarehouseInput, UpdateWarehouseInput>('/warehouses'),
  ...createRemoveApi<{ ok: boolean }>('/warehouses'),
};
