import type { CreateObjectInput, ObjectDto, UpdateObjectInput } from '@technic/contracts';
import { apiFetch, createListApi, createWriteApi } from '@shared/api';

/**
 * Справочник объектов строительства.
 *
 * Список и запись собраны фабриками — они у всех справочников одинаковы. Дальше начинаются
 * различия, ради которых фабрики и остались маленькими: `remove` возвращает саму запись, а не
 * признак успеха (список показывает её же, уже деактивированной), а удаление насовсем — отдельная
 * ручка с отдельным правом (ADR 0060): у них разная необратимость, и перепутать их нельзя.
 */
export const objectsApi = {
  ...createListApi<ObjectDto>('/objects'),
  ...createWriteApi<ObjectDto, CreateObjectInput, UpdateObjectInput>('/objects'),
  remove: (id: string) => apiFetch<ObjectDto>(`/objects/${id}`, { method: 'DELETE' }),
  purge: (id: string) => apiFetch<{ ok: boolean }>(`/objects/${id}/purge`, { method: 'DELETE' }),
};
