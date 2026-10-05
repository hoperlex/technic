import { useState } from 'react';
import { App } from 'antd';
import { useMutation } from '@tanstack/react-query';
import {
  type AnnulWeeklyRequestBody,
  weeklyAnnulPermission,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { weeklyRequestsApi } from '@entities/weekly-request';

/**
 * Обвязка аннулирования недельной заявки (ADR 0218): открыто ли окно, доступна ли кнопка и что
 * сказать человеку об итоге.
 *
 * Своим модулем, а не частью страницы: страница и без этого держит сборку состава, подачу, визу,
 * проведение задним числом и снятие, — а бюджет длины файла здесь не формальность, он и есть
 * единственный сторож против того, чтобы шестой сценарий дописали в тот же файл седьмым.
 *
 * Правило доступности кнопки живёт в контрактах (`weeklyAnnulPermission`): ветвь права зависит от
 * снимаемых дней, а их знает только сервер, поэтому кнопка показывается по **объединению** двух
 * ветвей, а что именно потребуется — говорит предпросмотр в окне. Второй перечень прав на клиенте
 * предлагал бы кнопку, которой ручка отвечает отказом.
 */
export function useWeeklyAnnul(params: {
  request: WeeklyVehicleRequestDto | undefined;
  /** Удалось: страница снимает объяснения прошлого отказа и перечитывает связанные выдачи. */
  onSettled: () => void;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  // Право и сообщение берутся здесь, а не приходят пропсами: это хук, и пара лишних параметров у
  // него означала бы, что страница решает то, что решает он.
  const { can } = useAuth();
  const { message } = App.useApp();

  const mutation = useMutation({
    mutationFn: (body: AnnulWeeklyRequestBody) => weeklyRequestsApi.annul(params.request!.id, body),
    onSuccess: (result) => {
      setOpen(false);
      // Итог — числами, а не «готово»: человек только что согласился сжечь номера бланков, и
      // отчёт о том, что именно развернули, он обязан увидеть, не открывая историю.
      const parts = [
        result.shortened.length > 0 ? `сроков возвращено: ${result.shortened.length}` : null,
        result.cancelled.length > 0 ? `заказов отменено: ${result.cancelled.length}` : null,
        result.esm2.cancelled > 0 ? `листов аннулировано: ${result.esm2.cancelled}` : null,
      ].filter((part) => part !== null);
      message.success(
        parts.length > 0 ? `Неделя аннулирована — ${parts.join(', ')}` : 'Неделя аннулирована',
      );
      params.onSettled();
    },
    onError: params.onError,
  });

  const available =
    params.request?.status === 'applied' &&
    [...weeklyAnnulPermission(false), ...weeklyAnnulPermission(true)].some(can);

  return {
    /** Заявка для окна; `null` — окно закрыто. */
    target: open && params.request ? params.request : null,
    /** Обработчик кнопки; `null` — кнопки нет вовсе. */
    onOpen: available ? () => setOpen(true) : null,
    onClose: () => setOpen(false),
    onAnnul: (body: AnnulWeeklyRequestBody) => mutation.mutate(body),
    pending: mutation.isPending,
  };
}
