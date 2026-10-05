import { useEffect, useEffectEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { VehicleRequestDto, VehicleRequestRollbackPreviewDto } from '@technic/contracts';
import { isApiError } from '@shared/api';
import {
  vehicleRequestErrorMessage as errorMessage,
  vehicleRequestsApi,
} from '@entities/vehicle-request';
import { RollbackConsequences } from '../ui/RollbackConsequences';

/**
 * Разговор окна возврата заявки в «Новую» с сервером (ADR 0211): спросить последствия на открытии,
 * подтвердить их отпечатком, а на отказ двери — спросить заново и сказать, что они изменились.
 *
 * Почему окно не собирает перечень само, объяснено в ADR 0211: правило «что стирает откат» жило в
 * двух носителях, сервер его исполнял, портал пересказывал, и пересказ разошёлся в обе стороны —
 * молчал о днях, сменах, досрочном и ЭСМ-2 и обещал убрать перегон, который остаётся. Здесь
 * портал не считает ничего: он показывает присланный план и возвращает его отпечаток.
 */

/**
 * Отказ двери по устаревшему отпечатку своего кода не имеет — это 409 с общим `version_conflict`
 * (ADR 0211 решение 4), и отличить его от обычного расхождения версий нечем. Поэтому ответ на
 * любой 409 здесь один и честен в оба случая: спросить последствия заново. Разъехалась версия —
 * предпросмотр откажет тем же 409, и его текст встанет в окно вместо перечня.
 */
const STALE_REASON =
  'Данные изменились с того момента, как вы их смотрели, — вот что снимет возврат теперь. Прочитайте и подтвердите заново.';

interface Input {
  /** Заявка открытого окна; `null` — окна нет, и спрашивать нечего. */
  target: VehicleRequestDto | null;
}

export function useRollbackConsequences({ target }: Input) {
  /**
   * Показанные последствия и версия, под которую они посчитаны. Пара неизменна: отпечаток
   * подтверждает ровно тот план, который человек прочёл, и уехать он обязан с той же версией —
   * иначе дверь сверяла бы отпечаток одного состояния с версией другого.
   */
  const [shown, setShown] = useState<{
    preview: VehicleRequestRollbackPreviewDto;
    version: number;
  } | null>(null);
  const [staleReason, setStaleReason] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async (v: { request: VehicleRequestDto; stale: string | null }) => ({
      ...v,
      version: v.request.version,
      preview: await vehicleRequestsApi.rollbackPreview(v.request.id, v.request.version),
    }),
    onSuccess: ({ preview, version, stale }) => {
      setFailure(null);
      setStaleReason(stale);
      setShown({ preview, version });
    },
    /*
     * Отказ показывается в самом окне, а не тостом: тост исчезает, а решение «стирать ли работу»
     * человек принимает именно здесь и именно сейчас. Прежний перечень при этом снимается — он
     * описывал состояние, которого сервер уже не подтвердил.
     */
    onError: (e) => {
      setShown(null);
      setFailure(errorMessage(e));
    },
  });

  /*
   * Последствия спрашиваются на каждое открытие и заново: между вчерашним просмотром и сегодняшним
   * нажатием план меняется, не тронув заявку (по перегону выписали лист, лист аннулировали своей
   * ручкой, появился черновик смены, неделя стала отработанной), а `version` ни одного из этих
   * случаев не ловит.
   */
  const targetId = target?.id ?? null;
  const ask = useEffectEvent((_id: string | null) => {
    setShown(null);
    setStaleReason(null);
    setFailure(null);
    if (target) mut.mutate({ request: target, stale: null });
  });
  // Зависимость — идентификатор заявки: перерисовка той же заявки приходит новым объектом и
  // спрашивала бы план по кругу.
  useEffect(() => ask(targetId), [targetId]);

  return {
    /**
     * Версия, под которую посчитаны показанные последствия, — её и шлёт подтверждение. Нет
     * предпросмотра — нет и ответа: версию берёт сама заявка, и возврат идёт, как шёл до этой
     * работы (отпечаток у двери необязателен).
     */
    version: shown?.version,
    /** Отпечаток прочитанного плана; `undefined` — подтверждать нечего, и дверь его не спросит. */
    fingerprint: shown?.preview.fingerprint,
    /**
     * Ответ ещё в пути. Окно отдаёт это в `confirmLoading`: пока последствий нет, нажатие не
     * должно уходить — обещать человеку нечего, а стёрлось бы всё.
     */
    pending: mut.isPending,
    /**
     * Разобрать отказ двери. 409 — не ошибка, а вопрос: последствия изменились между просмотром и
     * нажатием, и правильный ответ окна — свежий перечень с объяснением, а не тост «повторите».
     * Возвращает `true`, когда отказ взят на себя, чтобы вызывающий тост промолчал. Кругов не
     * будет: каждый требует нового нажатия.
     */
    recheck: (error: unknown) => {
      if (!target || !isApiError(error) || error.status !== 409) return false;
      mut.mutate({ request: target, stale: STALE_REASON });
      return true;
    },
    node: target ? (
      <RollbackConsequences
        request={target}
        preview={shown?.preview ?? null}
        failure={failure}
        staleReason={staleReason}
        onRetry={() => mut.mutate({ request: target, stale: staleReason })}
      />
    ) : null,
  };
}
