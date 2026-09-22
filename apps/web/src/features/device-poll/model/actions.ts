import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { devicePollWroteValue, type DevicePollTargetDto } from '@technic/contracts';
import { devicePollApi, devicePollKeys } from '@entities/device-poll';
import { deviceTelemetryKeys } from '@entities/device-telemetry';
import { errorMessage } from '@shared/lib';

/**
 * Нажатие «Получить данные» (решение `docs/adr/0205-device-network-poll.md`).
 *
 * ОТВЕТ КЛАДЁТСЯ В КЭШ НАПРЯМУЮ, а не перечитывается запросом: сервер вернул ровно ту цель, какой
 * она стала после опроса, и второй запрос за тем же ответом лишь добавил бы кадр, в котором
 * карточка показывает прошлую попытку.
 *
 * ТЕЛЕМЕТРИЯ КАРТОЧЕК ГАСИТСЯ ТОЛЬКО КОГДА ПОКАЗАНИЕ ЗАПИСАНО. Опрос чаще всего ничего не пишет
 * (молчание, чужой серийник, нет счётчика), и гасить на каждое нажатие значило бы перечитывать
 * блоки показаний всех открытых карточек ради ответа «ничего не изменилось».
 */
export function useDevicePoll() {
  const { message } = App.useApp();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (key: string) => devicePollApi.poll(key),
    onSuccess: (target: DevicePollTargetDto) => {
      qc.setQueryData<{ items: DevicePollTargetDto[] }>(devicePollKeys.targets(), (prev) =>
        prev
          ? { items: prev.items.map((item) => (item.key === target.key ? target : item)) }
          : { items: [target] },
      );

      const attempt = target.lastAttempt;
      if (!attempt) return;
      // Исход объясняет сам сервер: текст собран там, где известны и адрес, и ответ аппарата, и
      // причина отказа. Второй разбор исходов на портале разошёлся бы с первым.
      if (devicePollWroteValue(attempt.outcome)) {
        message.success(attempt.message);
        void qc.invalidateQueries({ queryKey: deviceTelemetryKeys.root });
      } else {
        message.warning(attempt.message);
      }
    },
    onError: (error) => message.error(errorMessage(error)),
  });
}
