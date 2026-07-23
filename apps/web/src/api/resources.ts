import type {
  ContainerTypeDto,
  CreateContainerTypeInput,
  CreateObjectInput,
  CreateUserInput,
  DownloadUrlDto,
  FileDto,
  ListResult,
  ObjectDto,
  RequestStatus,
  RequestType,
  UpdateContainerTypeInput,
  UpdateObjectInput,
  UpdateUserInput,
  UploadSessionDto,
  UserDto,
  WasteRequestDto,
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

export const containerTypesApi = {
  list: (q: Query) => apiFetch<ListResult<ContainerTypeDto>>('/container-types', { query: q }),
  create: (body: CreateContainerTypeInput) =>
    apiFetch<ContainerTypeDto>('/container-types', { method: 'POST', body }),
  update: (id: string, body: UpdateContainerTypeInput) =>
    apiFetch<ContainerTypeDto>(`/container-types/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<ContainerTypeDto>(`/container-types/${id}`, { method: 'DELETE' }),
};

export interface WasteRequestPayload {
  objectId: string;
  requestType: RequestType;
  containerTypeId?: string;
  installRequestId?: string;
  volumeM3?: number;
  deliveryAt: string;
  comment?: string;
  fileIds?: string[];
}

export interface WasteRequestUpdatePayload {
  objectId?: string;
  requestType?: RequestType;
  containerTypeId?: string | null;
  installRequestId?: string | null;
  volumeM3?: number | null;
  deliveryAt?: string;
  comment?: string;
  addFileIds?: string[];
  removeFileIds?: string[];
  version: number;
}

export const wasteRequestsApi = {
  list: (q: Query) => apiFetch<ListResult<WasteRequestDto>>('/waste-requests', { query: q }),
  get: (id: string) => apiFetch<WasteRequestDto>(`/waste-requests/${id}`),
  create: (body: WasteRequestPayload) =>
    apiFetch<WasteRequestDto>('/waste-requests', { method: 'POST', body }),
  update: (id: string, body: WasteRequestUpdatePayload) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}`, { method: 'PATCH', body }),
  changeStatus: (id: string, status: RequestStatus, version: number) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/status`, {
      method: 'PATCH',
      body: { status, version },
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
  downloadUrl: (id: string) => apiFetch<DownloadUrlDto>(`/files/${id}/download`),
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

  async download(id: string): Promise<void> {
    const { url } = await filesApi.downloadUrl(id);
    window.open(url, '_blank', 'noopener');
  },
};
