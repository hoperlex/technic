import type {
  CreateFuelNormInput,
  FuelNormSettingsDto,
  UpdateFuelNormInput,
  UpdateFuelNormSettingsInput,
  VehicleFuelNormDto,
} from '@technic/contracts';
import { apiFetch, createListApi, type Query } from '@shared/api';

/**
 * Нормы расхода топлива по машинам (план `docs/fuel-norms-plan.md`, §2).
 *
 * Запись здесь своя, а не из фабрики, по одной причине: **заведение с уже занятой датой не
 * ошибка, а правка версии того же дня** (Р7а) — сервер перезаписывает её и отвечает тем же
 * идентификатором. Фабрика `createWriteApi` обещала бы `201` и новую строку, а окно в обоих
 * случаях делает одно и то же: перечитывает список.
 *
 * Настройки сверки (границы зимы и допуск) живут рядом, потому что правит их тот же человек и то
 * же окно. В ответе сводки и карточки допуск приезжает своим полем — читателю статистики эта ручка
 * не нужна и права на неё у него может не быть.
 */
export const fuelNormsApi = {
  ...createListApi<VehicleFuelNormDto>('/vehicle-fuel-norms'),
  create: (body: CreateFuelNormInput) =>
    apiFetch<{ id: string }>('/vehicle-fuel-norms', { method: 'POST', body }),
  update: (id: string, body: UpdateFuelNormInput) =>
    apiFetch<{ id: string }>(`/vehicle-fuel-norms/${id}`, { method: 'PATCH', body }),
  /** Снятие версии — мягкое и необратимое (Р7б): окно спрашивает подтверждение до вызова. */
  remove: (id: string) =>
    apiFetch<null>(`/vehicle-fuel-norms/${id}`, { method: 'DELETE' }),
  count: () => apiFetch<{ total: number }>('/vehicle-fuel-norms/count'),
  settings: () => apiFetch<FuelNormSettingsDto>('/vehicle-fuel-norms/settings/current'),
  saveSettings: (body: UpdateFuelNormSettingsInput) =>
    apiFetch<FuelNormSettingsDto>('/vehicle-fuel-norms/settings/current', { method: 'PUT', body }),
  list: (query: Query) =>
    apiFetch<{ items: VehicleFuelNormDto[]; total: number; page: number; pageSize: number }>(
      '/vehicle-fuel-norms',
      { query },
    ),
};
