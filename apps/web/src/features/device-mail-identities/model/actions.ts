import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeviceIdentityApplyResultDto, DeviceIdentityCreateInput } from '@technic/contracts';
import { deviceIdentityApi } from '@entities/device-mail';
import { invalidateAfterDeviceMailAction } from '@features/device-mail-review';
import { errorMessage } from '@shared/lib';

/**
 * Действия реестра ключей (план `docs/office-equipment-mail-identity-ui-plan.md`, §6.1).
 *
 * ГАСИТСЯ ТО ЖЕ, ЧТО И ПОСЛЕ РАЗБОРА ПИСЬМА, и гасится ЧУЖОЙ функцией — той, что написана в
 * соседнем слайсе разбора. Причина простая: заведение ключа применяет накопленные письма, то есть
 * делает ровно то же, что «привязать» в очереди, и два списка устаревшего разошлись бы на первой
 * же правке. Своя копия здесь была бы вторым носителем одного правила.
 */

/** Итог применения словами. Ноль писем — законный исход: ключ завели заранее, писем ещё нет. */
export function applySummary(result: DeviceIdentityApplyResultDto): string {
  return result.appliedMessages === 0
    ? 'Ключ заведён. Писем этого аппарата в очереди не было — новые опознаются сами'
    : `Ключ заведён. Применено писем: ${result.appliedMessages}, показаний: ${result.observations}, событий: ${result.events}`;
}

export const SKIPPED_NOTICE = 'Письма без читаемого разбора остались в очереди';

/** «Добавить ключ» — из карточки аппарата или из реестра. */
export function useDeviceIdentityCreate(onDone?: () => void) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DeviceIdentityCreateInput) => deviceIdentityApi.create(body),
    onSuccess: (result) => {
      message.success(applySummary(result));
      if (result.skippedMessages > 0) message.warning(SKIPPED_NOTICE);
      invalidateAfterDeviceMailAction(qc);
      onDone?.();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
}

/**
 * «Снять» — необратимо в одну сторону. Сообщение называет ПОСЛЕДСТВИЕ, а не «готово»: записанные
 * показания остаются в карточке, и человек, ожидавший отката, должен узнать об этом здесь, а не
 * через неделю по счётчику.
 */
export function useDeviceIdentityRevoke(onDone?: () => void) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      deviceIdentityApi.revoke(id, { note }),
    onSuccess: () => {
      message.success('Привязка снята: новые письма по этому ключу опознаваться не будут');
      invalidateAfterDeviceMailAction(qc);
      onDone?.();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
}

/** «Применить к очереди»: второй заход тем же отбором — для писем, пришедших после заведения. */
export function useDeviceIdentityApply() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deviceIdentityApi.apply(id),
    onSuccess: (result) => {
      message.success(
        result.appliedMessages === 0
          ? 'Непривязанных писем с этим ключом нет'
          : `Применено писем: ${result.appliedMessages}, показаний: ${result.observations}, событий: ${result.events}`,
      );
      if (result.skippedMessages > 0) message.warning(SKIPPED_NOTICE);
      invalidateAfterDeviceMailAction(qc);
    },
    onError: (error) => message.error(errorMessage(error)),
  });
}
