import type {
  CreateVehicleTrailerInput,
  HitchTrailerInput,
  HitchTrailerResultDto,
  UpdateVehicleTrailerInput,
  VehicleTrailerDto,
} from '@technic/contracts';
import { apiFetch, type ListResult, type Query } from '@shared/api';

/**
 * Прицепной реестр (план `docs/vehicle-trailers-plan.md`). Отдельная ручка, а не ветка техники:
 * прицеп не лежит в `vehicles` и не должен попадать в списки заказываемой техники (Р7).
 *
 * Своим слайсом, а не строкой в общем `api/resources`, по той же причине, по какой прицеп — своя
 * таблица: у реестра есть и ручки, и ключи кэша, и живут они рядом, а не в разных концах портала.
 */
export const vehicleTrailersApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleTrailerDto>>('/vehicle-trailers', { query: q }),
  create: (body: CreateVehicleTrailerInput) =>
    apiFetch<VehicleTrailerDto>('/vehicle-trailers', { method: 'POST', body }),
  update: (id: string, body: UpdateVehicleTrailerInput) =>
    apiFetch<VehicleTrailerDto>(`/vehicle-trailers/${id}`, { method: 'PATCH', body }),
  remove: (id: string) =>
    apiFetch<{ ok: boolean }>(`/vehicle-trailers/${id}`, { method: 'DELETE' }),
  restore: (id: string) =>
    apiFetch<VehicleTrailerDto>(`/vehicle-trailers/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем — только из архива (ADR 0060). */
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/vehicle-trailers/${id}/purge`, { method: 'DELETE' }),
  /**
   * Привязка меняется командой, а не полем в теле правки (план §4.2.1): слот уникален, и «поставь
   * в занятый слот» правкой карточки упёрлось бы в UNIQUE вместо результата. Переназначение —
   * один вызов: прежнюю привязку и вытесненного жильца сервер находит сам, под блокировкой.
   */
  hitch: (id: string, body: HitchTrailerInput) =>
    apiFetch<HitchTrailerResultDto>(`/vehicle-trailers/${id}/hitch`, { method: 'POST', body }),
  unhitch: (id: string) =>
    apiFetch<VehicleTrailerDto>(`/vehicle-trailers/${id}/unhitch`, { method: 'POST' }),
};
