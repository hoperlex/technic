import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  autoPartReceiptInvalidation,
  type AutoPartReceiptCacheChange,
} from '@entities/auto-part-receipt';
import { isApiError } from '@shared/api';
import { errorMessage } from '@shared/lib';

/**
 * Общее у четырёх мутаций чека (план `docs/auto-part-receipts-plan.md`, Р12, Р18): версия, отказ
 * по ней и гашение кэша.
 *
 * Мутаций четыре — правка, пометка на удаление, её снятие и удаление, — и живут они в трёх файлах:
 * форма, карточка и окно пометки. Версию спрашивают все четыре, а значит все четыре получают 409,
 * и объяснять его должны одними словами: два разных текста про один и тот же отказ читались бы как
 * две разные поломки.
 *
 * Своей матрицы инвалидации здесь нет и не заводится: ключи считает слайс сущности
 * (`autoPartReceiptInvalidation`, Р18), а этот модуль только зовёт по ним клиент запросов —
 * знать, у кого он, слою сущностей неоткуда.
 */

/**
 * 409 словами. «Перечитайте» — единственный работающий совет: та же кнопка с той же версией даст
 * тот же отказ, и повторять её незачем.
 */
export const RECEIPT_VERSION_CONFLICT_MESSAGE =
  'Чек изменился, пока карточка была открыта — перечитайте его и повторите';

/**
 * 409, у которых причина не в версии: пометку успели поставить или снять из другого окна. Сервер
 * договаривает такой отказ сам («Чек уже помечен к удалению — обновите карточку»), и подменять его
 * общим текстом про версию значило бы объяснять не то, что случилось.
 */
const DOMAIN_CONFLICTS = new Set(['receipt_already_marked', 'receipt_not_marked']);

export function isReceiptVersionConflict(e: unknown): boolean {
  return isApiError(e) && e.status === 409 && !DOMAIN_CONFLICTS.has(e.code);
}

/** Отказ словами: про версию — своими, про остальное — серверными. */
export function receiptErrorText(e: unknown): string {
  return isReceiptVersionConflict(e) ? RECEIPT_VERSION_CONFLICT_MESSAGE : errorMessage(e);
}

/**
 * Машины, которых коснулась запись чека (Р18). Считается по **двум** наборам строк сразу — тем,
 * что были в чеке до правки, и тем, что уходят на сервер: машина, у которой строку отобрали,
 * иначе продолжала бы показывать её в окне «Запчасти машины» и в своём итоге.
 *
 * Оба набора описываются одним полем, поэтому и функция одна: у строки ответа и у строки редактора
 * `vehicleId` устроен одинаково — идентификатор либо «не отнесено».
 */
export function receiptVehicleIds(
  lines: readonly { vehicleId: string | null }[],
): readonly string[] {
  return lines.flatMap((line) => (line.vehicleId ? [line.vehicleId] : []));
}

/**
 * Погасить всё, что изменила мутация чека.
 *
 * ```ts
 * const invalidate = useReceiptInvalidation();
 * invalidate({ kind: 'write', id, vehicleIds: receiptVehicleIds([...was, ...now]) });
 * ```
 */
export function useReceiptInvalidation(): (change: AutoPartReceiptCacheChange) => void {
  const qc = useQueryClient();
  return useCallback(
    (change: AutoPartReceiptCacheChange) => {
      for (const queryKey of autoPartReceiptInvalidation(change)) {
        void qc.invalidateQueries({ queryKey });
      }
    },
    [qc],
  );
}
