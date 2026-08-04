import type { UpdateWasteTypeInput, WasteTypeDto } from '@technic/contracts';
import { apiFetch, createListApi } from '@shared/api';

/**
 * Справочник типов мусора: что вывозят с площадки.
 *
 * Заведения здесь нет — и это правило портала, а не забытая ручка: тип рождается вместе с первой
 * ценой на него (ADR 0017), его заводит `wasteTariffsApi.create` той же транзакцией, что и позицию
 * прайса. Отдельный `create` позволил бы завести тип, который нельзя ни выбрать в заявке, ни
 * оценить, — и справочник копил бы такие.
 *
 * Обычного удаления тоже нет: на тип ссылаются заявки и позиции прайса, выбытие — через
 * `update({ isActive: false })`. Деактивированный тип администратор сносит насовсем (ADR 0060).
 */
export const wasteTypesApi = {
  ...createListApi<WasteTypeDto>('/waste-types'),
  update: (id: string, body: UpdateWasteTypeInput) =>
    apiFetch<WasteTypeDto>(`/waste-types/${id}`, { method: 'PATCH', body }),
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/waste-types/${id}/purge`, { method: 'DELETE' }),
};
