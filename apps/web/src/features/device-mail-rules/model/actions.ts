import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeviceParseRuleInput } from '@technic/contracts';
import { deviceMailKeys, deviceRuleApi } from '@entities/device-mail';
import { errorMessage } from '@shared/lib';

/**
 * Действия над правилами разбора (план `docs/office-equipment-mail-identity-ui-plan.md`, §6.2).
 *
 * ГАСИТСЯ ТОЛЬКО НАБОР ПРАВИЛ, а не очередь и не телеметрия: правка правила меняет то, как будут
 * прочитаны БУДУЩИЕ письма, и ни одной уже записанной строки не трогает. Перечитывание разобранного
 * в этот этап не входит вовсе — разобранных писем ещё нет.
 */
function invalidateRules(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: deviceMailKeys.rules() });
}

export function useDeviceRuleSave(id: string | null, onDone?: () => void) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DeviceParseRuleInput) =>
      id ? deviceRuleApi.update(id, body) : deviceRuleApi.create(body),
    onSuccess: () => {
      message.success(id ? 'Правило изменено' : 'Правило заведено');
      invalidateRules(qc);
      onDone?.();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
}

/**
 * Удаление — только для правила, при жизни которого писем не разбирали. Остальные выключают:
 * выключенное объясняет, почему письма прочитаны именно так (решение заказчика 18.09.2026).
 */
export function useDeviceRuleRemove() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deviceRuleApi.remove(id),
    onSuccess: () => {
      message.success('Правило удалено');
      invalidateRules(qc);
    },
    onError: (error) => message.error(errorMessage(error)),
  });
}

/** Проверка черновика на живом письме: ничего не пишет, поэтому и мутацией гасить нечего. */
export function useDeviceRulePreview() {
  const { message } = App.useApp();
  return useMutation({
    mutationFn: deviceRuleApi.preview,
    onError: (error) => message.error(errorMessage(error)),
  });
}
