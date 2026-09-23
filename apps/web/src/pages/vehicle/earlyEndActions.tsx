import { useState } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type DecideVehicleEarlyEndBody,
  isPlaceScopedRole,
  type RequestVehicleEarlyEndInput,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDto,
} from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { waybillKeys } from '@entities/waybill';
import { ReasonModal } from '../../components/CancelReasonModal';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { VehicleEarlyEndApproveModal } from './VehicleEarlyEndApproveModal';
import { reassignStaleReason } from './ReassignPreview';

/**
 * Действия досрочного завершения — одни на обе вкладки заказа ТС (ADR 0044).
 *
 * Своим файлом, а не куском `shared.tsx`: там общие поля форм, ячейки и подписи, а здесь три
 * мутации, два окна и правило «кто визирует сам за себя». Разъедься эти действия по вкладкам, они
 * разошлись бы и по поведению — в одном месте спрашивали бы подтверждение отказа, в другом нет.
 *
 * ЧТО ИЗМЕНИЛОСЬ С ADR 0178. Обе применяющие ветви — запрос визирующего и виза по чужому запросу —
 * идут теперь каноном команд истории и требуют отпечатка последствий. Отсюда два окна вместо
 * одного: окно запроса показывает последствия вторым шагом, а виза, которая раньше уходила прямо
 * из строки списка, получила своё окно. Отказ и отзыв остались как были: они ничего не применяют.
 */
export function useEarlyEnd() {
  const { message, modal } = App.useApp();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const [target, setTarget] = useState<SpecialEquipmentRequestDto | null>(null);

  /**
   * Сокращённый срок переписывает и путевые листы: сервер сводит ЭСМ-2 заявки заново (ADR 0037),
   * и журнал листов без этого показывает смены, которых уже нет.
   */
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
    void qc.invalidateQueries({ queryKey: waybillKeys.root });
    void qc.invalidateQueries({ queryKey: garageKeys.root });
  };

  const requestMut = useMutation({
    mutationFn: (v: { id: string; body: RequestVehicleEarlyEndInput }) =>
      vehicleRequestsApi.requestEarlyEnd(v.id, v.body),
    onSuccess: (res) => {
      // Сообщение называет то, что произошло на самом деле: запрос визирующего сервер применяет
      // сразу, и «отправлено на визу» было бы неправдой.
      const applied =
        res.requestType === 'special_equipment' && res.earlyEnd?.status === 'approved';
      message.success(applied ? 'Срок заявки сокращён' : 'Запрос отправлен на визу');
      setTarget(null);
      invalidate();
    },
    /*
     * «Последствия изменились» — не ошибка, а вопрос, и отвечает на него окно: оно спрашивает план
     * заново и показывает пересчитанный перечень с объяснением, почему вернулось. Тост здесь был бы
     * вторым голосом о том же — и увёл бы глаз от экрана, на который человеку и надо смотреть.
     */
    onError: (e) => {
      if (reassignStaleReason(e)) return;
      message.error(errorMessage(e));
    },
  });

  const decideMut = useMutation({
    mutationFn: (v: { id: string; body: DecideVehicleEarlyEndBody }) =>
      vehicleRequestsApi.decideEarlyEnd(v.id, v.body),
    onSuccess: (_res, v) => {
      message.success(v.body.approved ? 'Досрочное завершение согласовано' : 'Запрос отклонён');
      setRejectTarget(null);
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => vehicleRequestsApi.cancelEarlyEnd(id),
    onSuccess: () => {
      message.success('Запрос отозван');
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /** Своя виза применяется сразу — тем же правилом, что и при заведении заявки (ADR 0032). */
  const approvesOwn = isPlaceScopedRole(user?.role ?? null) && can('vehicleRequests.approve');

  /**
   * Отказ спрашивает причину: заявка остаётся на заказанном сроке, и это надо объяснить.
   *
   * Окно — общий `ReasonModal`, а не `confirm` со своим полем внутри: у самодельного поля отказ
   * «причина не заполнена» показывался тостом поверх окна и не помечал ничего (ADR 0094).
   */
  const [rejectTarget, setRejectTarget] = useState<VehicleRequestDto | null>(null);

  /** Заявка, по запросу которой ставят визу: у окна свой предпросмотр и свой отпечаток (Р19). */
  const [approveTarget, setApproveTarget] = useState<SpecialEquipmentRequestDto | null>(null);

  const withdraw = (r: VehicleRequestDto) =>
    modal.confirm({
      title: `Отозвать запрос на досрочное завершение ${r.displayNumber}?`,
      content: 'Срок заявки останется прежним.',
      okText: 'Отозвать',
      cancelText: 'Отмена',
      onOk: () => cancelMut.mutateAsync(r.id),
    });

  return {
    /** Заявка, для которой открыто окно запроса. */
    target,
    /** Окно отказа: рисуется тем, кто хуком пользуется, — хук сам ничего не монтирует. */
    node: (
      <ReasonModal
        open={!!rejectTarget}
        title={
          rejectTarget
            ? `Отклонить досрочное завершение ${rejectTarget.displayNumber}`
            : 'Отклонить досрочное завершение'
        }
        label="Причина отказа"
        placeholderHint="Например: техника ещё нужна на объекте"
        okText="Отклонить"
        danger
        confirmLoading={decideMut.isPending}
        onCancel={() => setRejectTarget(null)}
        onSubmit={(reason) =>
          rejectTarget &&
          decideMut.mutate({
            id: rejectTarget.id,
            body: { approved: false, comment: reason, version: rejectTarget.version },
          })
        }
      />
    ),
    /**
     * Окно визы: последствия чужого запроса, посчитанные **для визирующего** (Р19, Р26).
     *
     * Оно и есть то, чего у визы не было: раньше «Согласовать» уходило прямо из строки списка, и
     * человек ставил визу, не видя, что она сожжёт и что погасит. Ответ обезличен — числами и
     * датами, без номеров бланков: прав на журнал листов у визирующего нет вовсе.
     */
    approveNode: (
      <VehicleEarlyEndApproveModal
        request={approveTarget}
        confirmLoading={decideMut.isPending}
        onCancel={() => setApproveTarget(null)}
        onSubmit={(body) => {
          if (!approveTarget) return undefined;
          return decideMut.mutateAsync({ id: approveTarget.id, body }).then(() => {
            setApproveTarget(null);
          });
        }}
      />
    ),
    open: setTarget,
    close: () => setTarget(null),
    approvesOwn,
    /*
     * `mutateAsync`, а не `mutate`: окно ждёт ответа сервера — 409 «последствия изменились» лечится
     * повторным показом, и узнать об отказе обязано именно оно (Р17, ADR 0178).
     */
    submit: (body: RequestVehicleEarlyEndInput) =>
      target ? requestMut.mutateAsync({ id: target.id, body }) : undefined,
    /** Виза идёт своим окном: она применяет срок, и последствия обязана показать до нажатия. */
    approve: setApproveTarget,
    reject: setRejectTarget,
    withdraw,
    pending: requestMut.isPending || decideMut.isPending || cancelMut.isPending,
  };
}
