import type {
  ContainerTypeDto,
  CreateContainerTypeInput,
  UpdateContainerTypeInput,
} from '@technic/contracts';
import { apiFetch, createListApi, createWriteApi } from '@shared/api';

/**
 * Справочник типов контейнеров и машин вывоза: чем мусор увозят с площадки.
 *
 * Обычного удаления нет намеренно, и это не пробел фабрик: на тип ссылаются заявки и позиции
 * прайса, поэтому из обращения его выводят правкой — `update({ isActive: false })`. Единственное
 * настоящее удаление — `purge` (ADR 0060): деактивация оставляет тип в базе навсегда, а заведённый
 * по ошибке код убирает оттуда только администратор с правом `records.purge`.
 */
export const containerTypesApi = {
  ...createListApi<ContainerTypeDto>('/container-types'),
  ...createWriteApi<ContainerTypeDto, CreateContainerTypeInput, UpdateContainerTypeInput>(
    '/container-types',
  ),
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/container-types/${id}/purge`, { method: 'DELETE' }),
};
