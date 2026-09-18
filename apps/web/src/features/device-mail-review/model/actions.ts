import { App } from 'antd';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { deviceMessageStatusLabels, type DeviceMailBindResultDto } from '@technic/contracts';
import { deviceMailApi, deviceMailKeys } from '@entities/device-mail';
import { deviceTelemetryKeys } from '@entities/device-telemetry';
import { errorMessage } from '@shared/lib';

/**
 * Что устаревает от разбора письма (план `docs/office-equipment-mail-telemetry-plan.md`, §10).
 *
 * ОЧЕРЕДЬ — очевидно: решённая строка из неё уходит, а отметка просмотра убирает даже ту, которую
 * решить нечем.
 *
 * ТЕЛЕМЕТРИЯ КАРТОЧКИ — не очевидно, и потому написано. Привязка применяет снимки разбора: письма
 * становятся наблюдениями и событиями ЖИВОЙ карточки (Р20). Не погаси её здесь — открытый рядом
 * блок «Показания и события» того самого аппарата продолжал бы уверять, что тот «ещё не присылал
 * писем», ровно после того, как его почту разобрали. Гасится корень целиком: какая именно карточка
 * получила снимки, экран очереди не знает — пачка по опознающему ключу могла тронуть их десятки.
 *
 * Одной функцией на все три действия, а не строками в каждом: забытая строка проявилась бы не
 * отказом, а тем, что «иногда не обновляется».
 */
export function invalidateAfterDeviceMailAction(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: deviceMailKeys.root });
  void qc.invalidateQueries({ queryKey: deviceTelemetryKeys.root });
}

/**
 * Итог привязки словами. ПРОПУЩЕННЫЕ ПИСЬМА НАЗЫВАЮТСЯ ОТДЕЛЬНО И ГРОМКО: отбор их взял, а снимка у
 * них нет или он нечитаем (`skippedMessages` контракта). Молчание здесь оставило бы человека в
 * уверенности, что очередь разобрана, — при том что эти строки в ней остались.
 */
export function bindSummary(result: DeviceMailBindResultDto): string {
  const parts = [
    `Применено писем: ${result.appliedMessages}`,
    `показаний: ${result.observations}`,
    `событий: ${result.events}`,
  ];
  return parts.join(', ');
}

export const SKIPPED_NOTICE = 'Письма без читаемого разбора остались в очереди';

/** Применять было нечего: письмо разобрали раньше. Привязка ключа при этом сохранена. */
export const ALREADY_APPLIED_NOTICE =
  'Письмо уже разобрано — применять было нечего; привязка ключа сохранена';

/** «Привязать к аппарату»: одна транзакция сервера, один ответ человеку. */
export function useDeviceMailBind(messageId: string | null, onDone?: () => void) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof deviceMailApi.bind>[1]) => {
      if (!messageId) throw new Error('привязка без выбранного письма');
      return deviceMailApi.bind(messageId, body);
    },
    onSuccess: (result) => {
      /*
       * НОЛЬ ПРИМЕНЁННЫХ — НЕ УСПЕХ И НЕ ОШИБКА, а гонка: строку уже разобрал коллега (или это
       * второе нажатие того же человека). Сама привязка ключа при этом сохранена и работать будет,
       * но бодрое «Применено писем: 0, показаний: 0, событий: 0» зелёной галочкой человек прочитал
       * бы как «сработало, только пусто», и пошёл бы искать, куда делись показания.
       */
      if (result.appliedMessages === 0) message.info(ALREADY_APPLIED_NOTICE);
      else message.success(bindSummary(result));
      // Предупреждение ВТОРЫМ сообщением, а не хвостом первого: успех и потеря — разные новости, и
      // слитые в одну строку, они читаются как один успех.
      if (result.skippedMessages > 0) message.warning(SKIPPED_NOTICE);
      invalidateAfterDeviceMailAction(qc);
      onDone?.();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
}

/** «Отметить просмотренным»: закрывающий след очереди (§10, «у `stuck`-строки есть …»). */
export function useDeviceMailReviewed() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => deviceMailApi.markReviewed(messageId),
    onSuccess: () => {
      message.success('Письмо отмечено просмотренным');
      invalidateAfterDeviceMailAction(qc);
    },
    onError: (error) => message.error(errorMessage(error)),
  });
}

/**
 * «Игнорировать»: письмо разбирать не надо.
 *
 * ОТДЕЛЬНОЙ МУТАЦИЕЙ ОТ ОТМЕТКИ ПРОСМОТРА, потому что это разные решения. Отметка говорит «строку
 * видели, решить её нечем»; отбрасывание говорит «разбирать не надо» и меняет СТАТУС — только этим
 * письмо выходит из отбора пачки, который идёт по статусу. Слей их в одну кнопку — и мусор со
 * снимком, закрытый «просмотрено», применился бы при будущей привязке того же серийника молча.
 */
export function useDeviceMailIgnore() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => deviceMailApi.ignore(messageId),
    onSuccess: () => {
      message.success('Письмо отброшено');
      invalidateAfterDeviceMailAction(qc);
    },
    onError: (error) => message.error(errorMessage(error)),
  });
}

/**
 * «Перечитать»: разбор нынешними правилами (Р26).
 *
 * Исход называется вслух — им и отвечают на вопрос, ради которого нажимали: разобралось ли письмо
 * после правки профиля. «Готово» без исхода заставило бы искать ту же строку глазами в перечитанной
 * очереди.
 */
export function useDeviceMailReparse() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => deviceMailApi.reparse(messageId),
    onSuccess: (result) => {
      message.success(`Письмо перечитано: ${deviceMessageStatusLabels[result.status]}`);
      invalidateAfterDeviceMailAction(qc);
    },
    onError: (error) => message.error(errorMessage(error)),
  });
}
