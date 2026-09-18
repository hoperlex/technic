import type {
  DeviceParseRuleDto,
  DeviceParseRuleInput,
  DeviceParseRulePreviewDto,
  DeviceParseRulePreviewInput,
} from '@technic/contracts';
import { apiFetch } from '@shared/api';

const PATH = '/device-mail/rules';

/**
 * Правила разбора (план `docs/office-equipment-mail-identity-ui-plan.md`, §6.2).
 *
 * Список целиком, без курсора: правил десятки, а не тысячи, и порядок у них задан человеком —
 * листать то, что читают как один набор, значило бы прятать середину.
 */
export const deviceRuleApi = {
  list: () => apiFetch<{ items: DeviceParseRuleDto[] }>(PATH),
  create: (body: DeviceParseRuleInput) =>
    apiFetch<DeviceParseRuleDto>(PATH, { method: 'POST', body }),
  update: (id: string, body: DeviceParseRuleInput) =>
    apiFetch<DeviceParseRuleDto>(`${PATH}/${id}`, { method: 'PATCH', body }),
  remove: (id: string) => apiFetch<{ ok: true }>(`${PATH}/${id}`, { method: 'DELETE' }),
  /** Проверка черновика на живом письме: ничего не пишет и ни на что не влияет. */
  preview: (body: DeviceParseRulePreviewInput) =>
    apiFetch<DeviceParseRulePreviewDto>(`${PATH}/preview`, { method: 'POST', body }),
};
