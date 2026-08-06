import type {
  GarageDriverListDto,
  GarageDriversSummaryDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
} from '@technic/contracts';
import { apiFetch, type Query } from '@shared/api';

/**
 * Гараж (ADR 0076): срез дня по технике и водителям. Фабрики списка сюда не годятся — у обеих
 * вкладок ответ шире страницы (`onDate` рядом с items), и своей карточки у записей нет: строка
 * ведёт в чужой модуль, а не открывает окно.
 */
export const garageApi = {
  vehicles: (query: Query) => apiFetch<GarageVehicleListDto>('/garage/vehicles', { query }),
  vehiclesSummary: (query: Query) =>
    apiFetch<GarageVehiclesSummaryDto>('/garage/vehicles/summary', { query }),
  drivers: (query: Query) => apiFetch<GarageDriverListDto>('/garage/drivers', { query }),
  driversSummary: (query: Query) =>
    apiFetch<GarageDriversSummaryDto>('/garage/drivers/summary', { query }),
};
