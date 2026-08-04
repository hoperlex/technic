import type {
  CreateDepartmentInput,
  DepartmentDto,
  UpdateDepartmentInput,
} from '@technic/contracts';
import { apiFetch, createListApi, createRemoveApi, createWriteApi } from '@shared/api';

/**
 * Справочник отделов (ADR 0040) — вторая ось области рядом с объектной.
 *
 * Набор умений тот же, что у объектов, и по той же причине: `remove` деактивирует и возвращает
 * саму запись — отдел остаётся в списке выключенным, потому что на него ссылаются уже заведённые
 * заявки. Удаление насовсем — отдельная ручка с отдельным правом `records.purge` (ADR 0060):
 * у деактивации и у сноса из базы разная необратимость, и перепутать их в вызове нельзя.
 */
export const departmentsApi = {
  ...createListApi<DepartmentDto>('/departments'),
  ...createWriteApi<DepartmentDto, CreateDepartmentInput, UpdateDepartmentInput>('/departments'),
  ...createRemoveApi<DepartmentDto>('/departments'),
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/departments/${id}/purge`, { method: 'DELETE' }),
};
