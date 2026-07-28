import type {
  ContainerTypeDto,
  CounterpartyDto,
  CreateContainerTypeInput,
  CreateCounterpartyInput,
  CreateObjectInput,
  CreateUserInput,
  CreateVehicleInput,
  CreateVehicleRequestInput,
  CreateVehicleTypeInput,
  CreateWasteTariffInput,
  CreateWasteTypeInput,
  DownloadUrlDto,
  FileDisposition,
  FileDto,
  ListResult,
  ObjectDto,
  RequestStatus,
  RequestType,
  UpdateContainerTypeInput,
  UpdateCounterpartyInput,
  UpdateObjectInput,
  UpdateUserInput,
  UpdateVehicleInput,
  UpdateVehicleRequestInput,
  UpdateVehicleTypeInput,
  UpdateWasteTariffInput,
  UpdateWasteTypeInput,
  UploadSessionDto,
  UserDto,
  VehicleDto,
  VehicleKindDto,
  VehicleModelDto,
  VehicleRequestDto,
  VehicleRequestSummaryDto,
  VehicleTypeDto,
  WasteRequestDto,
  WasteRequestHistoryEntryDto,
  WasteRequestSummaryDto,
  WasteRequestVehicleInput,
  WasteTariffDto,
  WasteTypeDto,
  ResolvedWasteTariffDto,
} from '@technic/contracts';
import { apiFetch } from './client';

type Query = Record<string, unknown>;

export const usersApi = {
  list: (q: Query) => apiFetch<ListResult<UserDto>>('/users', { query: q }),
  create: (body: CreateUserInput) => apiFetch<UserDto>('/users', { method: 'POST', body }),
  update: (id: string, body: UpdateUserInput) =>
    apiFetch<UserDto>(`/users/${id}`, { method: 'PATCH', body }),
  setPassword: (id: string, newPassword: string) =>
    apiFetch<{ ok: boolean }>(`/users/${id}/password`, { method: 'POST', body: { newPassword } }),
  remove: (id: string) => apiFetch<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),
};

export const objectsApi = {
  list: (q: Query) => apiFetch<ListResult<ObjectDto>>('/objects', { query: q }),
  create: (body: CreateObjectInput) => apiFetch<ObjectDto>('/objects', { method: 'POST', body }),
  update: (id: string, body: UpdateObjectInput) =>
    apiFetch<ObjectDto>(`/objects/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<ObjectDto>(`/objects/${id}`, { method: 'DELETE' }),
};

export const counterpartiesApi = {
  list: (q: Query) => apiFetch<ListResult<CounterpartyDto>>('/counterparties', { query: q }),
  create: (body: CreateCounterpartyInput) =>
    apiFetch<CounterpartyDto>('/counterparties', { method: 'POST', body }),
  update: (id: string, body: UpdateCounterpartyInput) =>
    apiFetch<CounterpartyDto>(`/counterparties/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<{ ok: boolean }>(`/counterparties/${id}`, { method: 'DELETE' }),
  restore: (id: string) =>
    apiFetch<CounterpartyDto>(`/counterparties/${id}/restore`, { method: 'POST' }),
};

export const containerTypesApi = {
  list: (q: Query) => apiFetch<ListResult<ContainerTypeDto>>('/container-types', { query: q }),
  create: (body: CreateContainerTypeInput) =>
    apiFetch<ContainerTypeDto>('/container-types', { method: 'POST', body }),
  // Удаления нет: деактивация через update({ isActive: false }).
  update: (id: string, body: UpdateContainerTypeInput) =>
    apiFetch<ContainerTypeDto>(`/container-types/${id}`, { method: 'PATCH', body }),
};

export const vehicleKindsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleKindDto>>('/vehicle-kinds', { query: q }),
};

export const vehicleTypesApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleTypeDto>>('/vehicle-types', { query: q }),
  create: (body: CreateVehicleTypeInput) =>
    apiFetch<VehicleTypeDto>('/vehicle-types', { method: 'POST', body }),
  // Только описательные поля (типа) + isActive (подтипа). Структурные поля неизменяемы.
  update: (id: string, body: UpdateVehicleTypeInput) =>
    apiFetch<VehicleTypeDto>(`/vehicle-types/${id}`, { method: 'PATCH', body }),
};

export const vehicleModelsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleModelDto>>('/vehicle-models', { query: q }),
};

export const vehiclesApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleDto>>('/vehicles', { query: q }),
  create: (body: CreateVehicleInput) => apiFetch<VehicleDto>('/vehicles', { method: 'POST', body }),
  update: (id: string, body: UpdateVehicleInput) =>
    apiFetch<VehicleDto>(`/vehicles/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<{ ok: boolean }>(`/vehicles/${id}`, { method: 'DELETE' }),
  restore: (id: string) => apiFetch<VehicleDto>(`/vehicles/${id}/restore`, { method: 'POST' }),
};

export const vehicleRequestsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleRequestDto>>('/vehicle-requests', { query: q }),
  /** Счётчики заявок по статусам — сводка над списком; сужается объектом и типом заявки. */
  summary: (q: Query) =>
    apiFetch<VehicleRequestSummaryDto>('/vehicle-requests/summary', { query: q }),
  get: (id: string) => apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}`),
  create: (body: CreateVehicleRequestInput) =>
    apiFetch<VehicleRequestDto>('/vehicle-requests', { method: 'POST', body }),
  update: (id: string, body: UpdateVehicleRequestInput) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}`, { method: 'PATCH', body }),
  /** `comment` уходит в историю статусов; при отмене это обязательная причина. */
  changeStatus: (id: string, status: RequestStatus, version: number, comment = '') =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/status`, {
      method: 'PATCH',
      body: { status, comment, version },
    }),
  remove: (id: string) =>
    apiFetch<{ ok: boolean; mode: string }>(`/vehicle-requests/${id}`, { method: 'DELETE' }),
  restore: (id: string) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/restore`, { method: 'POST' }),
};

export interface WasteRequestPayload {
  objectId: string;
  requestType: RequestType;
  containerTypeId?: string;
  wasteTypeId?: string;
  volumeM3?: number;
  /** Контрагент-оператор вывоза; можно назначить позже (ADR 0010). */
  operatorCounterpartyId?: string;
  deliveryAt: string;
  comment?: string;
  fileIds?: string[];
}

export interface WasteRequestUpdatePayload {
  objectId?: string;
  requestType?: RequestType;
  containerTypeId?: string | null;
  wasteTypeId?: string | null;
  volumeM3?: number | null;
  operatorCounterpartyId?: string | null;
  /** Машины заявки (ADR 0011): новые строки и операции над заведёнными. */
  addVehicles?: WasteRequestVehicleInput[];
  markDeletedVehicleIds?: string[];
  restoreVehicleIds?: string[];
  /** Полное удаление — только администратору. */
  deleteVehicleIds?: string[];
  deliveryAt?: string;
  comment?: string;
  addFileIds?: string[];
  removeFileIds?: string[];
  version: number;
}

export const wasteTypesApi = {
  list: (q: Query) => apiFetch<ListResult<WasteTypeDto>>('/waste-types', { query: q }),
  create: (body: CreateWasteTypeInput) =>
    apiFetch<WasteTypeDto>('/waste-types', { method: 'POST', body }),
  // Удаления нет: деактивация через update({ isActive: false }) — на тип ссылаются заявки.
  update: (id: string, body: UpdateWasteTypeInput) =>
    apiFetch<WasteTypeDto>(`/waste-types/${id}`, { method: 'PATCH', body }),
};

export const wasteTariffsApi = {
  list: (q: Query) => apiFetch<ListResult<WasteTariffDto>>('/waste-tariffs', { query: q }),
  /** Тариф под пару «тип мусора × техника» — предпросмотр цены в форме заявки. */
  resolve: (wasteTypeId: string, containerTypeId: string) =>
    apiFetch<ResolvedWasteTariffDto>('/waste-tariffs/resolve', {
      query: { wasteTypeId, containerTypeId },
    }),
  create: (body: CreateWasteTariffInput) =>
    apiFetch<WasteTariffDto>('/waste-tariffs', { method: 'POST', body }),
  /** Правка цены не переписывает суммы оформленных заявок: в них снимок тарифа (ADR 0009). */
  update: (id: string, body: UpdateWasteTariffInput) =>
    apiFetch<WasteTariffDto>(`/waste-tariffs/${id}`, { method: 'PATCH', body }),
};

export const wasteRequestsApi = {
  list: (q: Query) => apiFetch<ListResult<WasteRequestDto>>('/waste-requests', { query: q }),
  /** Наличие контейнеров на площадках (присутствующие заявки установки). */
  present: (q: Query) =>
    apiFetch<ListResult<WasteRequestDto>>('/waste-requests/present', { query: q }),
  /** Счётчики заявок по статусам — сводка над списком; сужается только фильтром по объекту. */
  summary: (q: Query) => apiFetch<WasteRequestSummaryDto>('/waste-requests/summary', { query: q }),
  get: (id: string) => apiFetch<WasteRequestDto>(`/waste-requests/${id}`),
  /** События заявки в хронологическом порядке: создание, правки, смены статусов (ADR 0012). */
  history: (id: string) => apiFetch<WasteRequestHistoryEntryDto[]>(`/waste-requests/${id}/history`),
  create: (body: WasteRequestPayload) =>
    apiFetch<WasteRequestDto>('/waste-requests', { method: 'POST', body }),
  update: (id: string, body: WasteRequestUpdatePayload) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}`, { method: 'PATCH', body }),
  /** Назначение/снятие оператора вывоза; предмет заявки и тариф не пересчитываются (ADR 0010). */
  assignOperator: (id: string, operatorCounterpartyId: string | null, version: number) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/operator`, {
      method: 'PATCH',
      body: { operatorCounterpartyId, version },
    }),
  /**
   * `comment` уходит в историю статусов; при отмене это обязательная причина.
   * `vehicles` принимаются только при закрытии заявки — факт вывоза фиксируется тем же
   * запросом, что и статус (ADR 0011).
   */
  changeStatus: (
    id: string,
    status: RequestStatus,
    version: number,
    comment = '',
    vehicles: WasteRequestVehicleInput[] = [],
  ) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/status`, {
      method: 'PATCH',
      body: { status, comment, vehicles, version },
    }),
  remove: (id: string) =>
    apiFetch<{ ok: boolean; mode: string }>(`/waste-requests/${id}`, { method: 'DELETE' }),
  restore: (id: string) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/restore`, { method: 'POST' }),
};

export const filesApi = {
  createUploadSession: (filename: string, contentType: string, size: number) =>
    apiFetch<UploadSessionDto>('/files/upload-session', {
      method: 'POST',
      body: { filename, contentType, size },
    }),
  complete: (id: string) => apiFetch<FileDto>(`/files/${id}/complete`, { method: 'POST' }),
  downloadUrl: (id: string, disposition: FileDisposition = 'attachment') =>
    apiFetch<DownloadUrlDto>(`/files/${id}/download`, { query: { disposition } }),
  remove: (id: string) => apiFetch<{ ok: boolean }>(`/files/${id}`, { method: 'DELETE' }),

  /** Полный цикл загрузки: session → PUT в S3 → complete. */
  async upload(file: File): Promise<FileDto> {
    const contentType = file.type || 'application/octet-stream';
    const session = await filesApi.createUploadSession(file.name, contentType, file.size);
    const put = await fetch(session.uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': contentType },
    });
    if (!put.ok) throw new Error(`Ошибка загрузки в хранилище (${put.status})`);
    return filesApi.complete(session.fileId);
  },

  /**
   * Скачивание. Ссылка ведёт на ответ с `Content-Disposition: attachment`, поэтому переход
   * по ней сохраняет файл и не уводит со страницы — новая вкладка для этого не нужна.
   */
  async download(id: string): Promise<void> {
    const { url } = await filesApi.downloadUrl(id, 'attachment');
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
  },

  /**
   * Просмотр во вкладке (фото талона, PDF). Вкладку открываем до запроса за ссылкой: открытие
   * после `await` браузер считает непользовательским и блокирует как всплывающее окно.
   */
  async openInline(id: string): Promise<void> {
    const tab = window.open('', '_blank');
    // Открытая нами вкладка не должна иметь доступа к странице портала через opener.
    if (tab) tab.opener = null;
    try {
      const { url } = await filesApi.downloadUrl(id, 'inline');
      if (tab) tab.location.replace(url);
      else window.open(url, '_blank', 'noopener');
    } catch (e) {
      tab?.close();
      throw e;
    }
  },
};
