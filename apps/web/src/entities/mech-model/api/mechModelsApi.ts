import type { CreateMechModelInput, MechModelDto, UpdateMechModelInput } from '@technic/contracts';
import { apiFetch, createListApi, createWriteApi } from '@shared/api';

/**
 * Справочник моделей малой механизации: то, что берут в аренду, — виброплиты, компрессоры,
 * станки, тепловые пушки (план `docs/mechanization-models-directory-plan.md`).
 *
 * Обычного удаления нет, и это не пробел фабрик: на модель ссылаются заявки на механизацию, и из
 * обращения её выводят правкой — `update({ isActive: false })`. Единственное настоящее удаление —
 * `purge` (ADR 0060): деактивация оставляет модель в базе навсегда, а заведённую по ошибке строку
 * убирает оттуда только администратор с правом `records.purge`.
 */
export const mechModelsApi = {
  ...createListApi<MechModelDto>('/mech-models'),
  ...createWriteApi<MechModelDto, CreateMechModelInput, UpdateMechModelInput>('/mech-models'),
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/mech-models/${id}/purge`, { method: 'DELETE' }),
};
