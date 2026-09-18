import type {
  DeviceIdentityApplyResultDto,
  DeviceIdentityCreateInput,
  DeviceIdentityDto,
  DeviceIdentityKind,
  DeviceIdentityRevokeInput,
  DeviceTelemetryPageDto,
} from '@technic/contracts';
import { apiFetch } from '@shared/api';

const PATH = '/device-mail/identities';

/** Отбор реестра: продолжение, размер страницы и три необязательных сужения. */
export interface DeviceIdentityParams extends Record<string, unknown> {
  cursor?: string;
  pageSize?: number;
  kind?: DeviceIdentityKind;
  equipmentId?: string;
  search?: string;
  includeRevoked?: boolean;
}

/**
 * Реестр ключей опознания (план `docs/office-equipment-mail-identity-ui-plan.md`, §6.1).
 *
 * `createListApi` не разворачивается по той же причине, что и у очереди: лента с курсором, а не
 * страничный список со счётчиком.
 *
 * ЧИСЛО ЗАТРОНУТЫХ ПИСЕМ СПРАШИВАЕТСЯ У СЕРВЕРА, а не считается здесь: пачка ищется по
 * нормализованной подсказке внутри снимков всех накопленных писем, а у экрана на руках одна
 * страница.
 */
export const deviceIdentityApi = {
  list: (query: DeviceIdentityParams = {}) =>
    apiFetch<DeviceTelemetryPageDto<DeviceIdentityDto>>(PATH, { query }),
  targets: (query: { kind: DeviceIdentityKind; value: string }) =>
    apiFetch<{ messages: number; batch: boolean }>(`${PATH}/targets`, { query }),
  create: (body: DeviceIdentityCreateInput) =>
    apiFetch<DeviceIdentityApplyResultDto>(PATH, { method: 'POST', body }),
  revoke: (id: string, body: DeviceIdentityRevokeInput) =>
    apiFetch<{ ok: true }>(`${PATH}/${id}/revoke`, { method: 'POST', body }),
  apply: (id: string) =>
    apiFetch<DeviceIdentityApplyResultDto>(`${PATH}/${id}/apply`, { method: 'POST' }),
};
