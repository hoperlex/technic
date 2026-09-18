import type { DeviceTelemetryCardDto } from '@technic/contracts';
import { apiFetch } from '@shared/api';

/**
 * Что спрашивают у блока «Показания и события»: продолжение ленты и размер страницы. Оба
 * необязательны — сервер сам подставит первую страницу и свои двадцать строк.
 */
export type DeviceTelemetryParams = {
  cursor?: string;
  pageSize?: number;
};

const PATH = '/office-equipment';

/**
 * Телеметрия аппарата одной ручкой: последние значения метрик и страница ленты событий.
 *
 * Ручка одна, потому что этого просит замороженный контракт (`DeviceTelemetryCardDto`). Курсор
 * едет ей же: продолжение ленты — тот же вопрос про тот же аппарат, а метрики портал берёт из
 * первой страницы.
 */
export const deviceTelemetryApi = {
  card: (equipmentId: string, query: DeviceTelemetryParams = {}) =>
    apiFetch<DeviceTelemetryCardDto>(`${PATH}/${equipmentId}/telemetry`, { query }),
};
