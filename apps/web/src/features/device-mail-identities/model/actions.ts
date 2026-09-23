import { App } from 'antd';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { DeviceIdentityApplyResultDto, DeviceIdentityCreateInput } from '@technic/contracts';
import { deviceIdentityApi, deviceMailKeys } from '@entities/device-mail';
import { deviceTelemetryKeys } from '@entities/device-telemetry';
import { errorMessage } from '@shared/lib';

/**
 * Действия реестра ключей (план `docs/office-equipment-mail-identity-ui-plan.md`, §6.1).
 *
 * ГАСИТСЯ ТО ЖЕ, ЧТО И ПОСЛЕ РАЗБОРА ПИСЬМА, и по той же причине: заведение ключа применяет
 * накопленные письма — делает ровно то, что «привязать» в очереди. Очередь от этого редеет, а
 * снимки писем ложатся наблюдениями и событиями ЖИВОЙ карточки: не погаси телеметрию — и открытый
 * рядом блок «Показания и события» продолжал бы уверять, что аппарат ещё не присылал писем, ровно
 * после того, как его почту разобрали.
 *
 * Гасит СВОИМ вызовом, а не функцией соседнего слайса разбора, и общего носителя у них нет не по
 * недосмотру. Слайсы одного слоя друг друга не видят (`boundaries/dependencies`, п. 2 решения
 * `docs/adr/draft-frontend-architecture.md`), а спустить общее вниз некуда: функция гасит корни
 * ДВУХ РАЗНЫХ сущностей — `device-mail` и `device-telemetry`, — и в `entities` её кладёт тот же
 * запрет (сосед по слою), а в `shared` — запрет знать доменные ключи (п. 4 того же решения). Оба
 * переноса пробовались и отбиты линтом, повторять опыт не нужно. Так же, своим вызовом, называет
 * устаревшее и опрос аппарата по сети (`features/device-poll`) — там корень один, телеметрия, и
 * гасится он, только когда показание записано. Пока общего дома нет, каждый сценарий называет своё
 * устаревание сам; цена известна: появится третий корень — дописывать придётся в каждом из них.
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
