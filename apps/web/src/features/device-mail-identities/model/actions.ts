import { App } from 'antd';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { DeviceIdentityApplyResultDto, DeviceIdentityCreateInput } from '@technic/contracts';
import { deviceIdentityApi, deviceMailKeys } from '@entities/device-mail';
import { deviceTelemetryKeys } from '@entities/device-telemetry';
import { errorMessage } from '@shared/lib';

/**
 * Actions of the identity-key registry (plan `docs/office-equipment-mail-identity-ui-plan.md`,
 * §6.1).
 *
 * THE SAME IS INVALIDATED AS AFTER PARSING A MESSAGE, for the same reason: creating a key applies
 * the accumulated messages — exactly what "bind" does in the queue. The queue shrinks, and the
 * message snapshots land as observations and events of the LIVE device card: leave telemetry
 * fresh, and the «Показания и события» block open next to it would keep claiming the device has
 * sent no mail, right after its mail was parsed.
 *
 * It invalidates by ITS OWN call, not through a function of the neighbouring parsing slice, and
 * the missing shared home is not an oversight. Slices of one layer do not see each other
 * (`boundaries/dependencies`, rule 2 of `docs/adr/0228-frontend-architecture.md`), and there is
 * nowhere to move the shared part down: the function invalidates the roots of TWO DIFFERENT
 * entities, `device-mail` and `device-telemetry`, so `entities` is closed by the same neighbour
 * ban and `shared` by the ban on knowing domain keys (rule 4 of the same decision). Both moves
 * were tried and rejected by lint; there is no need to repeat the experiment. The network poll of
 * a device (`features/device-poll`) names what goes stale by its own call too — there the root is
 * one, telemetry, and it is invalidated only once a reading is written. Until a shared home
 * exists, each scenario names its own staleness; the known price is that a third root has to be
 * added in each of them.
 */

/**
 * Что устаревает от применения ключа. Одной функцией на все три действия слайса, а не строками в
 * каждом: забытая строка проявилась бы не отказом, а тем, что «иногда не обновляется».
 *
 * Гасится корень телеметрии целиком: какая именно карточка получила снимки, реестр не знает — ключ
 * подбирает письма пачкой и мог тронуть десятки карточек.
 */
function invalidateAfterIdentityAction(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: deviceMailKeys.root });
  void qc.invalidateQueries({ queryKey: deviceTelemetryKeys.root });
}

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
      invalidateAfterIdentityAction(qc);
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
      invalidateAfterIdentityAction(qc);
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
      invalidateAfterIdentityAction(qc);
    },
    onError: (error) => message.error(errorMessage(error)),
  });
}
