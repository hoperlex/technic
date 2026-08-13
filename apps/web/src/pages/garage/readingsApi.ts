import type {
  DriverReportState,
  ReadingSourceKind,
  VehicleReadingDto,
  VehicleReadingStatsRow,
} from '@technic/contracts';
import { apiDownload, apiFetch, createQueryKeys, type Query } from '@shared/api';
import type { FileRef } from '../../components/FileLinks';

/**
 * Журнал показаний машины и сводка по парку (ADR 0103, Р27) — читающая часть модуля показаний,
 * которую показывает гараж.
 *
 * Клиент живёт рядом с экранами, а не в `entities`, по той же причине, что и типы ниже: этап
 * «Гараж и сводка» не трогает ни `packages/contracts`, ни чужие слайсы. Формы ответа описаны здесь
 * в точности так, как их отдаёт `services/readings-stats.ts`; переезд в контракты — отдельный шаг,
 * и с ним эти объявления уходят целиком.
 */

/** Строка журнала: чей день, какая смена и что с показанием. */
export interface VehicleReadingJournalRow {
  itemId: string;
  reportId: string;
  reportDate: string;
  shiftOrder: number;
  reportState: DriverReportState;
  sourceKind: ReadingSourceKind;
  sourceId: string;
  /** «Р-142» либо номер бланка ЭСМ-2 — как источник зовут в его модуле. */
  sourceLabel: string;
  personId: string;
  personName: string;
  /** Пусто — смена была, а показания по ней нет: ровно то, ради чего журнал и открывают. */
  reading: VehicleReadingDto | null;
  files: FileRef[];
  edits: { event: string; changedAt: string; changedByName: string; reason: string }[];
}

export interface VehicleReadingJournalDto {
  vehicleId: string;
  vehicleLabel: string;
  from: string;
  to: string;
  items: VehicleReadingJournalRow[];
  /** Хвост периода обрезан пределом сервера: период стоит сузить. */
  truncated: boolean;
}

export interface VehicleReadingStatsDto {
  items: VehicleReadingStatsRow[];
  from: string;
  to: string;
}

/**
 * Общий с модулем показаний адрес: журнал и сводка — его данные, гараж их только показывает
 * (Р27). Регистрируется тем же префиксом, что и остальные ручки показаний.
 */
const BASE = '/vehicle-readings';

export const readingsApi = {
  journal: (vehicleId: string, query: Query) =>
    apiFetch<VehicleReadingJournalDto>(`${BASE}/journal/${vehicleId}`, { query }),
  stats: (query: Query) => apiFetch<VehicleReadingStatsDto>(`${BASE}/stats`, { query }),
  /** Выгрузка книгой: имя файла приходит от сервера, здесь только запасное. */
  exportStats: (query: Query) =>
    apiDownload(`${BASE}/stats/export`, 'Показания техники.xlsx', { query }),
};

export const readingsKeys = createQueryKeys('vehicle-readings', {
  journal: (vehicleId: string, params: Query) => ['journal', vehicleId, params],
  stats: (params: Query) => ['stats', params],
});
