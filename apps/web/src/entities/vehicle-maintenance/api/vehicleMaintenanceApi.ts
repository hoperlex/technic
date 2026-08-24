import type {
  MaintenanceBody,
  MaintenanceUpdateBody,
  MaintenanceVoidInput,
  VehicleMaintenanceDto,
  VehicleMaintenanceSummaryDto,
} from '@technic/contracts';
import { apiFetch, type Query } from '@shared/api';

/**
 * Клиент модуля техобслуживания (план «Показания техники», §6): сводка, пакетное состояние,
 * история и ведение записей.
 *
 * Формы ответов сюда не переписываются — они описаны в `@technic/contracts` (Р20), и сервер отдаёт
 * ровно их. Своего DTO показаний здесь нет ни одного, и это не упущение: сводка ТО самодостаточна
 * (Р14а) и последний одометр несёт сама (Р14б) — модуль показаний ей не нужен вовсе.
 */

/** Общий префикс модуля: своя ветка и свои два права, а не хвост `/vehicle-readings` (Р14). */
const BASE = '/vehicle-maintenance';

/**
 * Ответ пакетного состояния. Единственный тип слайса не из контрактов: обёртку сервер собирает
 * прямо в ручке, и общего имени у неё пока нет. День среза приходит в ответе, потому что его мог
 * посчитать сервер (Р16) — подпись колонки обязана называть тот день, по которому шёл отбор.
 */
export interface MaintenanceSnapshotDto {
  on: string;
  items: VehicleMaintenanceSummaryDto[];
}

export const vehicleMaintenanceApi = {
  /**
   * Сводка машины на день среза: основание расчёта, последнее ТО, пробег с него, флаги доверия и
   * готовое состояние. Портал состояние не пересчитывает (Р24) — он его показывает.
   */
  summary: (vehicleId: string, query: Query = {}) =>
    apiFetch<VehicleMaintenanceSummaryDto>(`${BASE}/vehicles/${vehicleId}/summary`, { query }),
  /** То же состояние по списку машин — для колонки страницы гаража: сотня машин одним расчётом. */
  snapshot: (query: Query) => apiFetch<MaintenanceSnapshotDto>(`${BASE}/snapshot`, { query }),
  /** Журнал записей машины целиком, свежие сверху (Р30): страниц у него нет — их десятки за жизнь. */
  history: (vehicleId: string) =>
    apiFetch<{ items: VehicleMaintenanceDto[] }>(`${BASE}/vehicles/${vehicleId}/history`),
  /** Завести запись. Машина — в адресе: в теле её нет, чтобы не было двух мест для рассогласования. */
  create: (vehicleId: string, body: MaintenanceBody) =>
    apiFetch<VehicleMaintenanceDto>(`${BASE}/vehicles/${vehicleId}`, { method: 'POST', body }),
  /**
   * Правка — с версией, которую видел правящий (Р30). Она в теле, а не в адресе: PATCH и так идёт
   * телом, и разносить два обязательных значения по разным местам незачем.
   */
  update: (id: string, body: MaintenanceUpdateBody) =>
    apiFetch<VehicleMaintenanceDto>(`${BASE}/${id}`, { method: 'PATCH', body }),
  /**
   * Аннулирование акта с причиной (план `docs/auto-parts-plan.md`, Р6). Отдельная ручка, а не
   * поле правки: у неё своё тело, свой отказ и своё складское последствие — все строки акта
   * возвращаются на склад одной транзакцией. Ответ — тот же акт, уже с подписью и причиной.
   */
  void: (id: string, body: MaintenanceVoidInput) =>
    apiFetch<VehicleMaintenanceDto>(`${BASE}/${id}/void`, { method: 'POST', body }),
  /** Удаление — версией в адресе: тела у DELETE нет, а сносить чужую правку вслепую нельзя (Р30). */
  remove: (id: string, version: number) =>
    apiFetch<{ ok: true }>(`${BASE}/${id}`, { method: 'DELETE', query: { version } }),
};
