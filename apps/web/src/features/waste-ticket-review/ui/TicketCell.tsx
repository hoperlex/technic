import { App, Button, Tooltip } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { wasteTicketAutoConfirmReady, type WasteRequestDto } from '@technic/contracts';
import { wasteRequestKeys } from '@entities/waste-request';
import { wasteTicketsApi } from '@entities/waste-ticket';
import { errorMessage } from '../../../utils/format';
import { TicketBadge } from './TicketBadge';

/**
 * Ячейка колонки «Талоны» в списке заявок (план `docs/waste-ticket-auto-confirm-plan.md`, Р27).
 *
 * Решает ячейка, а не страница: у сошедшейся заявки вместо разбивки значка стоит кнопка, и один
 * клик закрывает разбор целиком, не открывая карточку. Во всех прочих случаях — прежний
 * `TicketBadge`: значки не меняются вовсе (Р6), ранжировать их «по важности» заказчик отказался.
 *
 * ПОКАЗЫВАТЬ ЛИ КНОПКУ, РЕШАЕТ НЕ ПОРТАЛ, а `wasteTicketAutoConfirmReady` — та же функция, по
 * которой сервер отказывает (Р16, Р17). Своё правило здесь означало бы кнопку, которая предлагает
 * то, что кончается ошибкой: у строки списка нет ни спорных полей талона, ни живых предложений
 * перераспознавания, и «на глаз» готовность по значку не определить.
 *
 * Кнопка без надписи (требование заказчика): колонка узкая, а число подтверждаемых талонов человек
 * читает в подсказке — там же, где и обещание «всё сошлось».
 */
export function TicketCell({ request }: { request: WasteRequestDto }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const badge = request.ticketBadge;

  const confirm = useMutation({
    mutationFn: (fingerprint: string) => wasteTicketsApi.confirmReady(request.id, { fingerprint }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
      // Число берётся из ответа, а не из значка: сервер подтверждает под замком заявки и знает,
      // сколько талонов на самом деле легло, — значок же показывал обещание.
      message.success(`Подтверждено талонов: ${res.confirmed}`);
    },
    onError: async (e) => {
      // Список гасится и на отказе — это отдельное требование Р27, а не копия успешной ветки.
      // Сервер отвечает 409 ровно тогда, когда сверка успела измениться: оставь мы строку как
      // была, в ней осталась бы кнопка, которой только что отказали, и человек жал бы её снова.
      await qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
      message.error(errorMessage(e));
    },
  });

  if (!badge || !wasteTicketAutoConfirmReady(badge, request.status)) {
    return <TicketBadge badge={badge} />;
  }

  return (
    <Tooltip title={`Подтвердить талоны: ${badge.confirmable} — всё сошлось`}>
      <Button
        size="small"
        icon={<CheckOutlined />}
        aria-label="Подтвердить талоны"
        // Второй клик недопустим (Р26): пакет подтверждается целиком, и повторный запрос либо
        // получил бы 409 по чужому отпечатку, либо — успей первый пройти — показал бы отказ там,
        // где всё уже сделано.
        loading={confirm.isPending}
        disabled={confirm.isPending}
        // Отпечаток берётся из строки в момент клика: подтверждается ровно тот набор талонов,
        // который человек видел, а не тот, что окажется в кэше к ответу сервера (Р23).
        onClick={() => confirm.mutate(badge.confirmableFingerprint)}
      />
    </Tooltip>
  );
}
