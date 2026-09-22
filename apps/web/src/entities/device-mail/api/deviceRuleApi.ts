import type {
  DeviceMailSampleDto,
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
  /**
   * Письма, на которых правило есть чем проверить.
   *
   * СПИСОК, А НЕ ВВОД ИДЕНТИФИКАТОРА. Проверять можно лишь письмо с сохранённым сырьём, и снаружи
   * это не видно никак: набранный вручную UUID разобранного или вычищенного письма отвечал бы
   * отказом, который человек прочитал бы как ошибку своего правила. Отбор «у кого сырьё есть»
   * держит сервер — здесь второй копии этого условия нет.
   *
   * Без параметров и без курсора: сервер отдаёт последние `DEVICE_RULE_SAMPLE_LIMIT` писем, новые
   * сверху. Это не реестр писем, а выбор образца — за полным списком идут в очередь.
   */
  samples: () => apiFetch<{ items: DeviceMailSampleDto[] }>(`${PATH}/samples`),
};
